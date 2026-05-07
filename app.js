// app.js — UI controller for the backtester. Config-driven so Level 1 and
// Level 2 share the same generation, binding and update code wherever
// possible.

(() => {
  // =====================================================================
  //  CONFIG: single source of truth for every parameter
  // =====================================================================

  // group: 'setup' = experiment env (NOT optimised), 'market' = strategy lever (optimised)
  const PARAM_DEFS = {
    sim_range: {
      group: "setup",
      isDateRange: true,
      label: "Simulation date range",
      description:
        "Restricts the simulation to ISPs in this window. All revenue, imbalance, robustness and sweep calculations use only the selected period; winsorization percentiles are also computed within it.",
      extremes: [
        ["Full dataset", "all 14 months — most statistically powerful"],
        [
          "Sub-period",
          "stress-test: does the strategy still win when the window excludes a known easy month?",
        ],
      ],
    },
    w_mfrr: {
      group: "setup",
      label: "Winsorize mFRR price (percentiles)",
      unit: "%",
      isWinsor: true,
      defaultLo: 10,
      defaultHi: 90,
      description:
        "Caps extreme mFRR clearing prices at the chosen percentiles within the simulation window. The 2025 data has a few −10 000 / +10 000 EUR/MWh outliers that would otherwise dominate.",
      extremes: [
        ["0 / 100", "no winsorization — raw outliers retained"],
        ["25 / 75", "very aggressive trimming — only the middle 50 % of values used"],
      ],
    },
    w_imb: {
      group: "setup",
      label: "Winsorize imbalance price (percentiles)",
      unit: "%",
      isWinsor: true,
      defaultLo: 10,
      defaultHi: 90,
      description:
        "Same idea as mFRR winsorization, applied to the Latvian imbalance price within the window.",
      extremes: [
        ["0 / 100", "no winsorization"],
        ["25 / 75", "aggressive trimming"],
      ],
    },
    X: {
      group: "market",
      label: "DA price threshold X",
      unit: "EUR/MWh",
      min: -100,
      max: 300,
      sliderStep: 1,
      numStep: 1,
      decimals: 0,
      description:
        "The DA clearing price below which the strategy holds energy back from DA and offers it to mFRR instead. Above X, the full forecast is sold to DA as usual.",
      extremes: [
        ["X = −100", "never withhold — always sell every MW to DA (= naïve strategy)"],
        ["X = 300", "always withhold — practically never use DA"],
      ],
    },
    Y: {
      group: "market",
      label: "Withhold fraction Y",
      unit: "0–1",
      min: 0,
      max: 1,
      sliderStep: 0.01,
      numStep: 0.05,
      decimals: 2,
      description:
        "When DA price is below X, the share of the forecast we hold back from DA. The withheld energy is offered as mFRR-up (we'll produce extra if the market wants it).",
      extremes: [
        ["Y = 0", "sell everything to DA even when price is low — no mFRR-up offer below X"],
        ["Y = 1", "withhold the entire forecast below X and offer it all to mFRR-up"],
      ],
    },
    Z: {
      group: "market",
      label: "ID trust coefficient Z",
      unit: "0–1",
      min: 0,
      max: 1,
      sliderStep: 0.01,
      numStep: 0.05,
      decimals: 2,
      description:
        "How much we trust the SciPHER intraday forecast revision (ID − DA). The trusted positive revision is offered as additional mFRR-up volume in every ISP, regardless of X. Negative revisions are not acted on (no buy-back modelled).",
      extremes: [
        ["Z = 0", "ignore the intraday forecast — only the DA forecast drives the decision"],
        [
          "Z = 1",
          "fully trust ID — offer the entire ID−DA revision (when positive) as extra mFRR-up",
        ],
      ],
    },
    theta_flat: {
      group: "market",
      label: "Flat penalty θ",
      unit: "EUR/MWh shortfall",
      min: 0,
      max: 100,
      sliderStep: 1,
      numStep: 1,
      decimals: 0,
      description:
        "An additional flat €/MWh charge applied to every shortfall MWh, on top of the imbalance price. Captures BSP penalties / risk aversion that the imbalance price alone doesn't reflect.",
      extremes: [
        ["θ = 0", "no extra penalty — only the imbalance price applies"],
        ["θ = 100", "very risk-averse — discourages any over-promising"],
      ],
    },
  };

  // Per-level configuration. naive = parameters used as the baseline that
  // every "vs. naïve" line compares against (always sell everything to DA).
  // paramKeys are listed in display order. Setup keys are rendered in the
  // top section; market keys in the (optimised) bottom section.
  const LEVEL_CONFIG = {
    1: {
      paramKeys: ["sim_range", "w_mfrr", "w_imb", "X", "Y"],
      naive: { X: 0, Y: 0, Z: 0 }, // only market params reset by Reset button
      defaults: {
        X: 30,
        Y: 1.0,
        w_mfrr_lo: 10,
        w_mfrr_hi: 90,
        w_imb_lo: 10,
        w_imb_hi: 90,
      },
      imbalanceDisabled: true,
      hasImbalance: false,
    },
    2: {
      paramKeys: ["sim_range", "w_mfrr", "w_imb", "X", "Y", "Z", "theta_flat"],
      naive: { X: 0, Y: 0, Z: 0 },
      defaults: {
        X: 30,
        Y: 1.0,
        Z: 1.0,
        theta_flat: 30,
        w_mfrr_lo: 10,
        w_mfrr_hi: 90,
        w_imb_lo: 10,
        w_imb_hi: 90,
      },
      imbalanceDisabled: false,
      hasImbalance: true,
    },
  };

  // Decomposition table column definitions (per level).
  const DECOMP_COLUMNS = {
    1: [
      { key: "DA", label: "DA revenue", type: "eur" },
      { key: "mFRR_up", label: "mFRR-up rev", type: "eur" },
      { key: "mFRR_dn", label: "mFRR-dn rev", type: "eur" },
    ],
    2: [
      { key: "DA", label: "DA revenue", type: "eur" },
      { key: "mFRR_up", label: "mFRR-up rev", type: "eur" },
      { key: "mFRR_dn", label: "mFRR-dn rev", type: "eur" },
      { key: "imb", label: "Imbalance cost", type: "eur-cost" },
      { key: "flat", label: "Flat penalty", type: "eur-cost" },
    ],
  };
  const COUNT_COLUMNS = {
    1: [
      { key: "up", label: "ISPs with mFRR-up", type: "int" },
      { key: "dn", label: "ISPs with mFRR-dn", type: "int" },
      { key: "wasted", label: "Withheld w/o activation", type: "int", help: "Below X, withheld but mFRR price between −1 and +1 — energy earns nothing." },
    ],
    2: [
      { key: "up", label: "ISPs with mFRR-up", type: "int" },
      { key: "dn", label: "ISPs with mFRR-dn", type: "int" },
      { key: "wasted", label: "Withheld w/o activation", type: "int", help: "Below X, withheld but no mFRR clearing — energy earns nothing." },
      { key: "short", label: "ISPs with shortfall", type: "int" },
      { key: "shortMWh", label: "Total shortfall (MWh)", type: "mwh" },
      { key: "shortAvg", label: "Avg cost / short ISP", type: "eur" },
    ],
  };

  // =====================================================================
  //  BOOTSTRAP
  // =====================================================================
  const D = Engine.init(WIND_DATA);
  console.log(`Loaded ${D.n} ISPs`);
  Engine.maybeWinsorize(10, 90, 10, 90);

  const startTs = Engine.tsAt(0);
  const endTs = Engine.tsAt(D.n - 1);
  const fmtDateOnly = (d) => d.toISOString().substring(0, 10);
  document.getElementById("data-range").textContent =
    `${fmtDateOnly(startTs)} → ${fmtDateOnly(endTs)} (${D.n.toLocaleString()} ISPs)`;
  const dataMinDate = fmtDateOnly(startTs);
  const dataMaxDate = fmtDateOnly(endTs);

  // =====================================================================
  //  STATE: per-level. Built from config defaults.
  // =====================================================================
  const state = {};
  for (const lvl of [1, 2]) {
    const cfg = LEVEL_CONFIG[lvl];
    state[lvl] = {
      params: { ...cfg.defaults },
      // Setup-only state (NOT mutated by Reset to naïve)
      simRange: { from: dataMinDate, to: dataMaxDate },
      // Time-series visualization range (clamped to simRange)
      tsRange: { from: null, to: null },
      lastSim: null,
      lastSweep: null,
    };
  }

  // =====================================================================
  //  GENERATE PARAMETER CARDS
  //  Each level fills its own #l{N}-params container from PARAM_DEFS.
  // =====================================================================
  function paramCardHTML(level, key) {
    const def = PARAM_DEFS[key];
    const cfg = LEVEL_CONFIG[level];
    const idBase = `l${level}-${key}`;

    // ---- date-range card ----
    if (def.isDateRange) {
      const from = state[level].simRange.from;
      const to = state[level].simRange.to;
      return `
        <div class="control sim-range">
          <label>${def.label}</label>
          <div class="slider-row two">
            <input type="date" id="${idBase}-from" value="${from}" min="${dataMinDate}" max="${dataMaxDate}">
            <span>→</span>
            <input type="date" id="${idBase}-to" value="${to}" min="${dataMinDate}" max="${dataMaxDate}">
            <button type="button" class="btn small" id="${idBase}-reset" title="Reset to full dataset">↻</button>
          </div>
          <div class="param-desc">
            <p>${def.description}</p>
            <ul class="extremes">
              ${def.extremes.map(([v, m]) => `<li><b>${v}:</b> ${m}</li>`).join("")}
            </ul>
          </div>
        </div>`;
    }

    // ---- winsor card ----
    if (def.isWinsor) {
      const disabled =
        key === "w_imb" && cfg.imbalanceDisabled ? "disabled" : "";
      const lo = cfg.defaults[`${key}_lo`];
      const hi = cfg.defaults[`${key}_hi`];
      return `
        <div class="control winsor">
          <label>${def.label}</label>
          <div class="slider-row two">
            <input type="number" id="${idBase}-lo" value="${lo}" min="0" max="50" step="1" ${disabled}>
            <span>/</span>
            <input type="number" id="${idBase}-hi" value="${hi}" min="50" max="100" step="1" ${disabled}>
          </div>
          <div class="param-desc">
            <p>${def.description}${cfg.imbalanceDisabled && key === "w_imb" ? " <em>Disabled in Level 1.</em>" : ""}</p>
            <ul class="extremes">
              ${def.extremes.map(([v, m]) => `<li><b>${v}:</b> ${m}</li>`).join("")}
            </ul>
          </div>
        </div>`;
    }

    // ---- numeric (slider+number) card ----
    const value = cfg.defaults[key];
    return `
      <div class="control">
        <label for="${idBase}">${def.label}<span class="unit">${def.unit}</span></label>
        <div class="slider-row">
          <input type="range" id="${idBase}" min="${def.min}" max="${def.max}" step="${def.sliderStep}" value="${value}">
          <input type="number" id="${idBase}-num" value="${value}" min="${def.min}" max="${def.max}" step="${def.numStep}">
        </div>
        <div class="param-desc">
          <p>${def.description}</p>
          <ul class="extremes">
            ${def.extremes.map(([v, m]) => `<li><b>${v}:</b> ${m}</li>`).join("")}
          </ul>
        </div>
      </div>`;
  }

  function renderParamCards(level) {
    const cfg = LEVEL_CONFIG[level];
    const setupKeys = cfg.paramKeys.filter((k) => PARAM_DEFS[k].group === "setup");
    const marketKeys = cfg.paramKeys.filter((k) => PARAM_DEFS[k].group === "market");
    const setupHtml = setupKeys.map((k) => paramCardHTML(level, k)).join("");
    const marketHtml = marketKeys.map((k) => paramCardHTML(level, k)).join("");
    document.getElementById(`l${level}-setup-params`).innerHTML = setupHtml;
    document.getElementById(`l${level}-market-params`).innerHTML = marketHtml;
    document.getElementById(`l${level}-reset`).textContent =
      level === 1 ? "⇄ Reset market params (Y=0)" : "⇄ Reset market params (Y=0, Z=0)";
  }

  // =====================================================================
  //  GENERATE STATS TABLES (decomposition + counts)
  // =====================================================================
  function renderStatsTables(level) {
    const decomp = DECOMP_COLUMNS[level];
    const counts = COUNT_COLUMNS[level];
    const head1 = decomp.map((c) => `<th>${c.label}</th>`).join("");
    const body1 = decomp.map((c) => `<td id="l${level}-${c.key}">–</td>`).join("");
    const head2 = counts
      .map(
        (c) =>
          `<th${c.help ? ` title="${c.help.replace(/"/g, "&quot;")}"` : ""}>${c.label}</th>`,
      )
      .join("");
    const body2 = counts.map((c) => `<td id="l${level}-cnt-${c.key}">–</td>`).join("");
    document.getElementById(`l${level}-decomp-table`).innerHTML = `
      <thead><tr>${head1}</tr></thead>
      <tbody><tr>${body1}</tr></tbody>`;
    document.getElementById(`l${level}-counts-table`).innerHTML = `
      <thead><tr>${head2}</tr></thead>
      <tbody><tr>${body2}</tr></tbody>`;
  }

  // =====================================================================
  //  HELPERS
  // =====================================================================
  function fmtEUR(v) {
    return Math.round(v).toLocaleString("en-US") + " €";
  }
  function fmtPct(v) {
    return (v * 100).toFixed(1) + "%";
  }
  function fmtInt(v) {
    return v.toLocaleString("en-US");
  }
  function fmtMWh(v) {
    return Math.round(v).toLocaleString("en-US") + " MWh";
  }

  function isoDate(d) {
    return d.toISOString().substring(0, 10);
  }
  function addDays(dateStr, n) {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return isoDate(d);
  }
  function clampDate(dateStr, lo, hi) {
    if (dateStr < lo) return lo;
    if (dateStr > hi) return hi;
    return dateStr;
  }
  function idxAtOrAfter(dateStr) {
    const t = new Date(dateStr + "T00:00:00Z").getTime();
    const startMs = new Date(D.start_iso).getTime();
    const targetOffset = (t - startMs) / (D.step_min * 60000);
    let lo = 0,
      hi = D.n - 1,
      ans = D.n;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (D.offsets[mid] >= targetOffset) {
        ans = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return ans;
  }
  function rangeToIdx(fromStr, toStr) {
    const start = idxAtOrAfter(fromStr);
    const next = new Date(toStr + "T00:00:00Z");
    next.setUTCDate(next.getUTCDate() + 1);
    const end = idxAtOrAfter(next.toISOString().substring(0, 10));
    return { start, end };
  }

  // =====================================================================
  //  CORE UPDATE — runs simulate, naïve, all charts and stats
  // =====================================================================
  function updateLevel(level) {
    const cfg = LEVEL_CONFIG[level];
    const p = state[level].params;

    // 1. Set engine window from simRange BEFORE winsorize/simulate.
    //    Percentile bounds come from the window slice, so order matters.
    const sim_range = state[level].simRange;
    const { start: winStart, end: winEnd } = rangeToIdx(sim_range.from, sim_range.to);
    Engine.setWindow(winStart, winEnd);
    Engine.maybeWinsorize(p.w_mfrr_lo, p.w_mfrr_hi, p.w_imb_lo, p.w_imb_hi);

    // 2. Always recompute naive at current θ_flat (and current window).
    const naive = Engine.simulateTotal(level, 0, 0, 0, p.theta_flat || 0);
    const sim = Engine.simulate(level, p);
    state[level].lastSim = sim;
    state[level].lastNaive = naive;

    const prefix = `l${level}`;

    // Top stats
    document.getElementById(`${prefix}-total`).textContent = fmtEUR(sim.totalRevenue);
    const diff = sim.totalRevenue - naive;
    const diffPct = naive !== 0 ? diff / Math.abs(naive) : 0;
    const vsEl = document.getElementById(`${prefix}-vs-naive`);
    vsEl.textContent = `${diff >= 0 ? "+" : ""}${fmtEUR(diff)} (${diff >= 0 ? "+" : ""}${(diffPct * 100).toFixed(2)}%)`;
    vsEl.className = "value " + (Math.abs(diff) < 1 ? "" : diff >= 0 ? "up" : "down");

    // Per-MWh of potential — over the window only
    const totalPotMWh = Engine.totalPotMWhInWindow();
    document.getElementById(`${prefix}-per-mwh`).textContent =
      totalPotMWh > 0 ? (sim.totalRevenue / totalPotMWh).toFixed(2) + " €/MWh" : "–";

    // Decomposition table
    for (const col of DECOMP_COLUMNS[level]) {
      const v = sim.breakdown[col.key];
      document.getElementById(`${prefix}-${col.key}`).textContent =
        col.type === "eur-cost" ? "−" + fmtEUR(v) : fmtEUR(v);
    }
    // Counts table
    for (const col of COUNT_COLUMNS[level]) {
      let v;
      if (col.key === "up") v = fmtInt(sim.counts.up);
      else if (col.key === "dn") v = fmtInt(sim.counts.dn);
      else if (col.key === "wasted") v = fmtInt(sim.counts.wasted);
      else if (col.key === "short") v = fmtInt(sim.counts.short);
      else if (col.key === "shortMWh") v = fmtMWh(sim.totalShortMWh);
      else if (col.key === "shortAvg")
        v =
          sim.counts.short > 0
            ? fmtEUR((sim.breakdown.imb + sim.breakdown.flat) / sim.counts.short)
            : "0 €";
      document.getElementById(`${prefix}-cnt-${col.key}`).textContent = v;
    }

    // Robustness — perISP is window-length, so concentrations are over window
    const conc1 = Engine.topConcentration(sim.perISP.revenue, 0.01);
    const conc5 = Engine.topConcentration(sim.perISP.revenue, 0.05);
    const conc10 = Engine.topConcentration(sim.perISP.revenue, 0.1);
    document.getElementById(`${prefix}-top1pct`).textContent =
      fmtPct(conc1.share) + " (" + conc1.topN + " ISPs)";
    document.getElementById(`${prefix}-top5pct`).textContent = fmtPct(conc5.share);
    document.getElementById(`${prefix}-top10pct`).textContent = fmtPct(conc10.share);

    // Time series — pick default range if not yet set, clamp to simRange
    let { from, to } = state[level].tsRange;
    if (!from || !to || from < sim_range.from || to > sim_range.to) {
      // Default to a single day at the midpoint of the simulation window
      const midIdx = Math.floor((winStart + Math.max(winStart, winEnd - 1)) / 2);
      const midDate = isoDate(Engine.tsAt(Math.max(0, Math.min(D.n - 1, midIdx))));
      from = clampDate(midDate, sim_range.from, sim_range.to);
      to = from;
      state[level].tsRange = { from, to };
      const fromEl = document.getElementById(`${prefix}-date-from`);
      const toEl = document.getElementById(`${prefix}-date-to`);
      if (fromEl) {
        fromEl.value = from;
        fromEl.min = sim_range.from;
        fromEl.max = sim_range.to;
      }
      if (toEl) {
        toEl.value = to;
        toEl.min = sim_range.from;
        toEl.max = sim_range.to;
      }
    } else {
      // Keep date input bounds in sync with current sim range
      const fromEl = document.getElementById(`${prefix}-date-from`);
      const toEl = document.getElementById(`${prefix}-date-to`);
      if (fromEl) {
        fromEl.min = sim_range.from;
        fromEl.max = sim_range.to;
      }
      if (toEl) {
        toEl.min = sim_range.from;
        toEl.max = sim_range.to;
      }
    }
    const chartIdx = rangeToIdx(from, to);
    Charts.drawTimeSeries(`${prefix}-ts-chart`, level, sim, p, chartIdx.start, chartIdx.end);

    // Monthly + histogram (over window)
    Charts.drawMonthly(`${prefix}-monthly-chart`, level, Engine.monthlyAggregation(level, p));
    Charts.drawHistogram(`${prefix}-hist-chart`, sim.perISP.revenue);
  }

  // =====================================================================
  //  EVENT WIRING — one function per kind of widget, called per param.
  // =====================================================================
  const updateTimers = {};
  function scheduleUpdate(level) {
    clearTimeout(updateTimers[level]);
    updateTimers[level] = setTimeout(() => updateLevel(level), 60);
  }

  function bindParamCards(level) {
    const cfg = LEVEL_CONFIG[level];
    for (const key of cfg.paramKeys) {
      const def = PARAM_DEFS[key];
      const idBase = `l${level}-${key}`;

      if (def.isDateRange) {
        const fromEl = document.getElementById(`${idBase}-from`);
        const toEl = document.getElementById(`${idBase}-to`);
        const resetEl = document.getElementById(`${idBase}-reset`);
        const onChange = () => {
          let f = clampDate(fromEl.value || dataMinDate, dataMinDate, dataMaxDate);
          let t = clampDate(toEl.value || dataMaxDate, dataMinDate, dataMaxDate);
          if (f > t) [f, t] = [t, f];
          fromEl.value = f;
          toEl.value = t;
          state[level].simRange = { from: f, to: t };
          // Sim range changed → invalidate the chart range so updateLevel
          // re-anchors it to the (possibly narrower) window.
          state[level].tsRange = { from: null, to: null };
          scheduleUpdate(level);
        };
        fromEl.addEventListener("change", onChange);
        toEl.addEventListener("change", onChange);
        resetEl.addEventListener("click", () => {
          fromEl.value = dataMinDate;
          toEl.value = dataMaxDate;
          onChange();
        });
        continue;
      }

      if (def.isWinsor) {
        const lo = document.getElementById(`${idBase}-lo`);
        const hi = document.getElementById(`${idBase}-hi`);
        if (lo.disabled) continue;
        const onChange = () => {
          state[level].params[`${key}_lo`] = clamp(parseFloat(lo.value) || 0, 0, 50);
          state[level].params[`${key}_hi`] = clamp(parseFloat(hi.value) || 100, 50, 100);
          lo.value = state[level].params[`${key}_lo`];
          hi.value = state[level].params[`${key}_hi`];
          scheduleUpdate(level);
        };
        lo.addEventListener("change", onChange);
        hi.addEventListener("change", onChange);
        continue;
      }

      // numeric (slider+number)
      const slider = document.getElementById(idBase);
      const num = document.getElementById(`${idBase}-num`);
      const onSet = (raw) => {
        let v = parseFloat(raw);
        if (isNaN(v)) return;
        v = clamp(v, def.min, def.max);
        slider.value = v;
        num.value = v;
        state[level].params[key] = v;
        scheduleUpdate(level);
      };
      slider.addEventListener("input", (e) => onSet(e.target.value));
      num.addEventListener("change", (e) => onSet(e.target.value));
    }
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function setSliderValue(level, key, value) {
    document.getElementById(`l${level}-${key}`).value = value;
    document.getElementById(`l${level}-${key}-num`).value = value;
    state[level].params[key] = value;
  }

  function bindReset(level) {
    document.getElementById(`l${level}-reset`).addEventListener("click", () => {
      const cfg = LEVEL_CONFIG[level];
      for (const key in cfg.naive) {
        if (key in state[level].params) setSliderValue(level, key, cfg.naive[key]);
      }
      updateLevel(level);
    });
  }

  function bindOptimise(level) {
    const btn = document.getElementById(`l${level}-optimise`);
    const progEl = document.getElementById(`l${level}-progress`);
    btn.addEventListener("click", () => {
      btn.disabled = true;
      const p = state[level].params;
      Engine.maybeWinsorize(p.w_mfrr_lo, p.w_mfrr_hi, p.w_imb_lo, p.w_imb_hi);
      const xs = [];
      for (let x = -100; x <= 300; x += 10) xs.push(x);
      const ys = [];
      for (let y = 0; y <= 1.0001; y += 0.05) ys.push(parseFloat(y.toFixed(2)));
      progEl.textContent = "computing…";
      if (level === 1) {
        setTimeout(() => {
          const t0 = performance.now();
          const result = Engine.sweepLevel1(xs, ys);
          const ms = Math.round(performance.now() - t0);
          progEl.textContent = `done in ${ms} ms — best at X=${result.best.X}, Y=${result.best.Y.toFixed(2)} → ${fmtEUR(result.best.revenue)}`;
          setSliderValue(1, "X", result.best.X);
          setSliderValue(1, "Y", result.best.Y);
          state[1].lastSweep = result;
          updateLevel(1);
          btn.disabled = false;
        }, 30);
      } else {
        const zs = [];
        for (let z = 0; z <= 1.0001; z += 0.1) zs.push(parseFloat(z.toFixed(1)));
        let xi = 0;
        const grid = [];
        let bestRev = -Infinity,
          bestX = 0,
          bestY = 0,
          bestZ = 0;
        const tStart = performance.now();
        function runRow() {
          if (xi >= xs.length) {
            const ms = Math.round(performance.now() - tStart);
            const result = {
              xs,
              ys,
              zs,
              grid,
              best: { X: bestX, Y: bestY, Z: bestZ, revenue: bestRev },
            };
            progEl.textContent = `done in ${ms} ms — best at X=${bestX}, Y=${bestY.toFixed(2)}, Z=${bestZ.toFixed(2)} → ${fmtEUR(bestRev)}`;
            setSliderValue(2, "X", bestX);
            setSliderValue(2, "Y", bestY);
            setSliderValue(2, "Z", bestZ);
            state[2].lastSweep = result;
            updateLevel(2);
            btn.disabled = false;
            return;
          }
          const xRow = [];
          for (let yi = 0; yi < ys.length; yi++) {
            const yRow = new Float64Array(zs.length);
            for (let zi = 0; zi < zs.length; zi++) {
              const r = Engine.simulateTotal(2, xs[xi], ys[yi], zs[zi], p.theta_flat);
              yRow[zi] = r;
              if (r > bestRev) {
                bestRev = r;
                bestX = xs[xi];
                bestY = ys[yi];
                bestZ = zs[zi];
              }
            }
            xRow.push(yRow);
          }
          grid.push(xRow);
          xi++;
          progEl.textContent = `computing… ${Math.round((xi / xs.length) * 100)}%`;
          setTimeout(runRow, 0);
        }
        runRow();
      }
    });
  }

  // =====================================================================
  //  DATE RANGE NAVIGATION
  // =====================================================================
  // The CHART date-range navigation is bounded by the simulation window
  // (so you can't view ISPs that aren't simulated). "all" preset means
  // the entire simulation window — not the entire dataset.
  function bindDateNav(level) {
    const prefix = `l${level}`;
    const fromEl = document.getElementById(`${prefix}-date-from`);
    const toEl = document.getElementById(`${prefix}-date-to`);
    function simBounds() {
      return state[level].simRange;
    }
    function applyRange(from, to) {
      const sb = simBounds();
      from = clampDate(from, sb.from, sb.to);
      to = clampDate(to, sb.from, sb.to);
      if (from > to) [from, to] = [to, from];
      fromEl.value = from;
      toEl.value = to;
      state[level].tsRange = { from, to };
      document
        .querySelectorAll(`.preset[data-level="${level}"]`)
        .forEach((b) => b.classList.remove("active"));
      updateLevel(level);
    }
    fromEl.addEventListener("change", () => applyRange(fromEl.value, toEl.value));
    toEl.addEventListener("change", () => applyRange(fromEl.value, toEl.value));
    document.getElementById(`${prefix}-prev-range`).addEventListener("click", () => {
      const { from, to } = state[level].tsRange;
      const span =
        (new Date(to + "T00:00:00Z") - new Date(from + "T00:00:00Z")) / 86400000 + 1;
      applyRange(addDays(from, -span), addDays(to, -span));
    });
    document.getElementById(`${prefix}-next-range`).addEventListener("click", () => {
      const { from, to } = state[level].tsRange;
      const span =
        (new Date(to + "T00:00:00Z") - new Date(from + "T00:00:00Z")) / 86400000 + 1;
      applyRange(addDays(from, span), addDays(to, span));
    });
    document.querySelectorAll(`.preset[data-level="${level}"]`).forEach((btn) => {
      btn.addEventListener("click", () => {
        const preset = btn.dataset.preset;
        const sb = simBounds();
        const anchor = state[level].tsRange.to || sb.to;
        let from, to;
        if (preset === "1d") {
          from = anchor;
          to = anchor;
        } else if (preset === "1w") {
          to = anchor;
          from = addDays(anchor, -6);
        } else if (preset === "1mo") {
          to = anchor;
          from = addDays(anchor, -29);
        } else if (preset === "3mo") {
          to = anchor;
          from = addDays(anchor, -89);
        } else if (preset === "all") {
          from = sb.from;
          to = sb.to;
        }
        applyRange(from, to);
        document
          .querySelectorAll(`.preset[data-level="${level}"]`)
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
      });
    });
  }

  // =====================================================================
  //  HEATMAP
  // =====================================================================
  function computeAndDrawHeatmap(level, pair) {
    const p = state[level].params;
    Engine.maybeWinsorize(p.w_mfrr_lo, p.w_mfrr_hi, p.w_imb_lo, p.w_imb_hi);
    const progEl = document.getElementById(`l${level}-heatmap-progress`);
    progEl.textContent = "computing…";
    const xs = [];
    for (let x = -100; x <= 300; x += 10) xs.push(x);
    const ys = [];
    for (let y = 0; y <= 1.0001; y += 0.05) ys.push(parseFloat(y.toFixed(2)));
    const zs = [];
    for (let z = 0; z <= 1.0001; z += 0.05) zs.push(parseFloat(z.toFixed(2)));
    setTimeout(() => {
      const t0 = performance.now();
      let grid, axisXs, axisYs, axisLabels, markX, markY;
      if (level === 1 || pair === "XY") {
        grid = [];
        for (let xi = 0; xi < xs.length; xi++) {
          const row = new Float64Array(ys.length);
          for (let yi = 0; yi < ys.length; yi++) {
            row[yi] = Engine.simulateTotal(level, xs[xi], ys[yi], p.Z || 0, p.theta_flat || 0);
          }
          grid.push(row);
        }
        axisXs = xs;
        axisYs = ys;
        axisLabels = { x: "X (DA threshold, EUR/MWh)", y: "Y (withhold fraction)" };
        markX = p.X;
        markY = p.Y;
      } else if (pair === "XZ") {
        grid = [];
        for (let xi = 0; xi < xs.length; xi++) {
          const row = new Float64Array(zs.length);
          for (let zi = 0; zi < zs.length; zi++) {
            row[zi] = Engine.simulateTotal(2, xs[xi], p.Y, zs[zi], p.theta_flat);
          }
          grid.push(row);
        }
        axisXs = xs;
        axisYs = zs;
        axisLabels = { x: "X (DA threshold, EUR/MWh)", y: "Z (ID trust)" };
        markX = p.X;
        markY = p.Z;
      } else {
        grid = [];
        for (let yi = 0; yi < ys.length; yi++) {
          const row = new Float64Array(zs.length);
          for (let zi = 0; zi < zs.length; zi++) {
            row[zi] = Engine.simulateTotal(2, p.X, ys[yi], zs[zi], p.theta_flat);
          }
          grid.push(row);
        }
        axisXs = ys;
        axisYs = zs;
        axisLabels = { x: "Y (withhold fraction)", y: "Z (ID trust)" };
        markX = p.Y;
        markY = p.Z;
      }
      const ms = Math.round(performance.now() - t0);
      progEl.textContent = `done in ${ms} ms`;
      Charts.drawHeatmap(`l${level}-heatmap`, grid, axisXs, axisYs, axisLabels, markX, markY,
        (xv, yv) => {
          if (level === 1) {
            setSliderValue(1, "X", xv);
            setSliderValue(1, "Y", yv);
          } else if (pair === "XY") {
            setSliderValue(2, "X", xv);
            setSliderValue(2, "Y", yv);
          } else if (pair === "XZ") {
            setSliderValue(2, "X", xv);
            setSliderValue(2, "Z", yv);
          } else {
            setSliderValue(2, "Y", xv);
            setSliderValue(2, "Z", yv);
          }
          updateLevel(level);
        });
    }, 30);
  }

  // =====================================================================
  //  TABS
  // =====================================================================
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const level = parseInt(btn.dataset.level);
      document.getElementById(`panel-${level}`).classList.add("active");
      setTimeout(() => updateLevel(level), 30);
    });
  });

  // =====================================================================
  //  INIT
  // =====================================================================
  for (const lvl of [1, 2]) {
    renderParamCards(lvl);
    renderStatsTables(lvl);
    bindParamCards(lvl);
    bindReset(lvl);
    bindOptimise(lvl);
    bindDateNav(lvl);
  }

  document
    .getElementById("l1-show-heatmap")
    .addEventListener("click", () => computeAndDrawHeatmap(1, "XY"));
  document
    .getElementById("l2-show-heatmap")
    .addEventListener("click", () =>
      computeAndDrawHeatmap(2, document.getElementById("l2-heatmap-pair").value),
    );

  updateLevel(1);
  setTimeout(() => updateLevel(2), 200);
})();
