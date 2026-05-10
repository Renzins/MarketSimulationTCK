// app.js — UI controller for the Backtester page (index.html).
//
// ARCHITECTURE
// ============
// This file is config-driven so Levels 1 and 2 share one rendering / binding
// path. The single source of truth is `LEVEL_CONFIG` (per-level metadata)
// plus `PARAM_DEFS` (per-parameter metadata: label, range, default,
// description, group=setup|market). Level panels are NOT duplicated in HTML —
// the HTML has placeholder divs (#l1-setup-params, #l1-market-params, etc.)
// that this file fills via `renderParamCards()`.
//
// FLOW
// ====
//   1. Engine.init(WIND_DATA)      — typed-array bootstrap of the dataset
//   2. renderParamCards(level)     — generates parameter HTML from PARAM_DEFS
//   3. renderStatsTables(level)    — generates the decomposition + counts tables
//   4. bindParamCards(level)       — wires each control to scheduleUpdate(level)
//   5. updateLevel(level)          — the hot path:
//                                       Engine.setWindow → Engine.maybeWinsorize
//                                       → Engine.simulate → render stats
//                                       → Charts.drawTimeSeries / Monthly / Histogram
//
// IMPORTANT INVARIANTS
// ====================
//   - Setup parameters (sim window, winsorization) are NEVER touched by the
//     Reset-to-naïve button. Only market params (X, Y, Z) are rolled back.
//   - Naïve baseline is recomputed at the *current* θ_flat on every update —
//     do NOT cache it across θ changes (that bug was fixed earlier).
//   - All HTML date inputs are <input type="text"> with DD/MM/YYYY parsing,
//     because <input type="date"> is browser-locale-driven and shows
//     MM/DD/YYYY on US-locale machines. Use parseEU / isoToEU helpers.
//   - The chart's tsRange is clamped to the simulation window — when sim
//     window changes, tsRange is invalidated and re-defaulted to a single day.
//
// TYPICAL FUTURE EDITS
// ====================
//   - New parameter? Add to PARAM_DEFS, add the key to the level's paramKeys
//     in LEVEL_CONFIG, and (if it's a setup param) decide whether the engine
//     needs to know about it.
//   - New stat row in the decomposition table? Add to DECOMP_COLUMNS or
//     COUNT_COLUMNS — the renderer picks them up automatically.

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
    w_afrr_pos: {
      group: "setup",
      label: "Winsorize aFRR upward (avg) price (percentiles)",
      unit: "%",
      isWinsor: true,
      defaultLo: 10,
      defaultHi: 90,
      description:
        "Caps the per-ISP averaged aFRR upward price (sum of AST_POS, NaN→0, ÷225) at the chosen percentiles. Only matters when s < 1 (any volume offered to aFRR).",
      extremes: [
        ["0 / 100", "no winsorization — extreme spike-ISPs retained"],
        ["25 / 75", "aggressive trimming — middle 50 % only"],
      ],
    },
    w_afrr_neg: {
      group: "setup",
      label: "Winsorize aFRR downward (avg) price (percentiles)",
      unit: "%",
      isWinsor: true,
      defaultLo: 10,
      defaultHi: 90,
      description:
        "Same idea on the aFRR downward (AST_NEG) average. Downward prices can be very negative — winsorization is especially relevant here.",
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
    s_up: {
      group: "market",
      label: "mFRR ↔ aFRR split — UPWARD (s_up)",
      unit: "0–1",
      min: 0,
      max: 1,
      sliderStep: 0.01,
      numStep: 0.05,
      decimals: 2,
      description:
        "Fraction of UPWARD offered MW routed to mFRR vs aFRR. Whole-MW market constraint preserved: Q_up_mfrr = round(s_up · Q_up_offer), Q_up_afrr = remainder. mFRR-up clears only on upside spikes (P_mfrr ≥ 1); aFRR-up earns whenever the per-ISP averaged AST_POS > 0.",
      extremes: [
        ["s_up = 1 (default)", "all upward volume to mFRR — matches the pre-feature behaviour"],
        ["s_up = 0", "all upward volume to aFRR — earns averaged AST_POS continuously"],
        ["0 < s_up < 1", "split: e.g. s_up = 0.7 → ~70 % mFRR-up, 30 % aFRR-up"],
      ],
    },
    s_dn: {
      group: "market",
      label: "mFRR ↔ aFRR split — DOWNWARD (s_dn)",
      unit: "0–1",
      min: 0,
      max: 1,
      sliderStep: 0.01,
      numStep: 0.05,
      decimals: 2,
      description:
        "Fraction of DOWNWARD offered MW (curtailment of DA position) routed to mFRR vs aFRR. Independent from s_up because the per-direction price dynamics differ: mFRR-dn fires only when P_mfrr ≤ −1 (system pays park to curtail); aFRR-dn earns whenever the averaged AST_NEG < 0.",
      extremes: [
        ["s_dn = 1 (default)", "all downward volume to mFRR"],
        ["s_dn = 0", "all downward volume to aFRR"],
        ["0 < s_dn < 1", "split: e.g. s_dn = 0.5 → 50/50 between markets"],
      ],
    },
  };

  // Per-level configuration. naive = parameters used as the baseline that
  // every "vs. naïve" line compares against (always sell everything to DA).
  // paramKeys are listed in display order. Setup keys are rendered in the
  // top section; market keys in the (optimised) bottom section.
  const LEVEL_CONFIG = {
    1: {
      paramKeys: [
        "sim_range",
        "w_mfrr",
        "w_imb",
        "w_afrr_pos",
        "w_afrr_neg",
        "X",
        "Y",
        "s_up",
        "s_dn",
      ],
      // naive = all withholding levers at their no-strategy values. The
      // splits stay at the user's current setting so the "vs naïve" diff
      // isolates the value of withholding (X/Y/Z), not market choice.
      naive: { X: 0, Y: 0, Z: 0 },
      defaults: {
        X: 30,
        Y: 1.0,
        s_up: 1.0,
        s_dn: 1.0,
        w_mfrr_lo: 10,
        w_mfrr_hi: 90,
        w_imb_lo: 10,
        w_imb_hi: 90,
        w_afrr_pos_lo: 10,
        w_afrr_pos_hi: 90,
        w_afrr_neg_lo: 10,
        w_afrr_neg_hi: 90,
      },
      imbalanceDisabled: true,
      hasImbalance: false,
    },
    2: {
      paramKeys: [
        "sim_range",
        "w_mfrr",
        "w_imb",
        "w_afrr_pos",
        "w_afrr_neg",
        "X",
        "Y",
        "Z",
        "theta_flat",
        "s_up",
        "s_dn",
      ],
      naive: { X: 0, Y: 0, Z: 0 },
      defaults: {
        X: 30,
        Y: 1.0,
        Z: 1.0,
        theta_flat: 30,
        s_up: 1.0,
        s_dn: 1.0,
        w_mfrr_lo: 10,
        w_mfrr_hi: 90,
        w_imb_lo: 10,
        w_imb_hi: 90,
        w_afrr_pos_lo: 10,
        w_afrr_pos_hi: 90,
        w_afrr_neg_lo: 10,
        w_afrr_neg_hi: 90,
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
      { key: "aFRR_up", label: "aFRR-up rev", type: "eur" },
      { key: "aFRR_dn", label: "aFRR-dn rev", type: "eur" },
    ],
    2: [
      { key: "DA", label: "DA revenue", type: "eur" },
      { key: "mFRR_up", label: "mFRR-up rev", type: "eur" },
      { key: "mFRR_dn", label: "mFRR-dn rev", type: "eur" },
      { key: "aFRR_up", label: "aFRR-up rev", type: "eur" },
      { key: "aFRR_dn", label: "aFRR-dn rev", type: "eur" },
      { key: "imb", label: "Imbalance cost", type: "eur-cost" },
      { key: "flat", label: "Flat penalty", type: "eur-cost" },
    ],
  };
  const COUNT_COLUMNS = {
    1: [
      { key: "up", label: "ISPs with mFRR-up", type: "int" },
      { key: "dn", label: "ISPs with mFRR-dn", type: "int" },
      { key: "upAfrr", label: "ISPs with aFRR-up", type: "int", help: "ISPs where avg_p_pos > 0 AND we routed volume to aFRR (s < 1) — wind park bid into upward and earned." },
      { key: "dnAfrr", label: "ISPs with aFRR-dn", type: "int", help: "ISPs where avg_p_neg < 0 AND we routed volume to aFRR — system paid the park to curtail." },
      { key: "wasted", label: "Withheld w/o activation", type: "int", help: "Below X, withheld but neither mFRR cleared nor aFRR was profitable — energy earns nothing." },
    ],
    2: [
      { key: "up", label: "ISPs with mFRR-up", type: "int" },
      { key: "dn", label: "ISPs with mFRR-dn", type: "int" },
      { key: "upAfrr", label: "ISPs with aFRR-up", type: "int", help: "ISPs where avg_p_pos > 0 AND we routed volume to aFRR (s < 1) — wind park bid into upward and earned." },
      { key: "dnAfrr", label: "ISPs with aFRR-dn", type: "int", help: "ISPs where avg_p_neg < 0 AND we routed volume to aFRR — system paid the park to curtail." },
      { key: "wasted", label: "Withheld w/o activation", type: "int", help: "Below X, withheld but neither market activated profitably — energy earns nothing." },
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
  // ISO (YYYY-MM-DD) is the internal canonical form; EU (DD/MM/YYYY) is what
  // the user types and sees.
  const fmtDateOnly = (d) => d.toISOString().substring(0, 10);
  const fmtDateEU = (d) => {
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = d.getUTCFullYear();
    return `${dd}/${mm}/${yyyy}`;
  };
  // Convert "DD/MM/YYYY" → "YYYY-MM-DD" or null if unparseable.
  function parseEU(str) {
    if (!str) return null;
    const m = str.trim().match(/^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{4})$/);
    if (!m) return null;
    const dd = m[1].padStart(2, "0");
    const mm = m[2].padStart(2, "0");
    return `${m[3]}-${mm}-${dd}`;
  }
  // Convert "YYYY-MM-DD" → "DD/MM/YYYY".
  function isoToEU(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  }
  document.getElementById("data-range").textContent =
    `${fmtDateEU(startTs)} → ${fmtDateEU(endTs)} (${D.n.toLocaleString()} ISPs)`;
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
          <label>${def.label}<span class="unit">DD/MM/YYYY</span></label>
          <div class="slider-row two">
            <input type="text" inputmode="numeric" placeholder="DD/MM/YYYY"
                   pattern="\\d{2}/\\d{2}/\\d{4}" maxlength="10"
                   id="${idBase}-from" value="${isoToEU(from)}">
            <span>→</span>
            <input type="text" inputmode="numeric" placeholder="DD/MM/YYYY"
                   pattern="\\d{2}/\\d{2}/\\d{4}" maxlength="10"
                   id="${idBase}-to" value="${isoToEU(to)}">
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
    // Two cap-preview spans show the live percentile-derived clip values
    // (e.g. "≤ −23 €/MWh" / "≥ 234 €/MWh"), updated by updateWinsorCaps()
    // after every Engine.maybeWinsorize call.
    if (def.isWinsor) {
      const disabled =
        key === "w_imb" && cfg.imbalanceDisabled ? "disabled" : "";
      const lo = cfg.defaults[`${key}_lo`];
      const hi = cfg.defaults[`${key}_hi`];
      return `
        <div class="control winsor">
          <label>${def.label}</label>
          <div class="slider-row two winsor-row">
            <span class="winsor-input">
              <input type="number" id="${idBase}-lo" value="${lo}" min="0" max="50" step="1" ${disabled}>
              <span class="winsor-cap" id="${idBase}-cap-lo">(…)</span>
            </span>
            <span>/</span>
            <span class="winsor-input">
              <input type="number" id="${idBase}-hi" value="${hi}" min="50" max="100" step="1" ${disabled}>
              <span class="winsor-cap" id="${idBase}-cap-hi">(…)</span>
            </span>
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

  // Format a winsor cap value (EUR/MWh) for the live preview span. Big
  // numbers get thousand separators, small ones get 1 dp.
  function fmtCap(v) {
    if (!isFinite(v)) return "—";
    const abs = Math.abs(v);
    if (abs >= 1000) return Math.round(v).toLocaleString("en-US");
    if (abs >= 100) return v.toFixed(0);
    return v.toFixed(1);
  }

  // Update the "(≤ X €/MWh)" / "(≥ Y €/MWh)" preview spans next to every
  // winsor input in the given level. Called after Engine.maybeWinsorize.
  // Map from PARAM_DEFS key → bounds object key on the maybeWinsorize result.
  function updateWinsorCaps(level, bounds) {
    const map = [
      ["w_mfrr", bounds && bounds.mfrrBounds],
      ["w_imb", bounds && bounds.imbBounds],
      ["w_afrr_pos", bounds && bounds.afrrPosBounds],
      ["w_afrr_neg", bounds && bounds.afrrNegBounds],
    ];
    for (const [key, b] of map) {
      const loEl = document.getElementById(`l${level}-${key}-cap-lo`);
      const hiEl = document.getElementById(`l${level}-${key}-cap-hi`);
      if (!loEl || !hiEl) continue;
      if (!b) {
        loEl.textContent = "(…)";
        hiEl.textContent = "(…)";
        continue;
      }
      loEl.textContent = `(≤ ${fmtCap(b.lo)} €/MWh)`;
      hiEl.textContent = `(≥ ${fmtCap(b.hi)} €/MWh)`;
    }
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
    const bounds = Engine.maybeWinsorize(
      p.w_mfrr_lo,
      p.w_mfrr_hi,
      p.w_imb_lo,
      p.w_imb_hi,
      p.w_afrr_pos_lo,
      p.w_afrr_pos_hi,
      p.w_afrr_neg_lo,
      p.w_afrr_neg_hi,
    );
    updateWinsorCaps(level, bounds);

    // 2. Always recompute naive at current θ_flat AND current splits.
    const naive = Engine.simulateTotal(
      level,
      0,
      0,
      0,
      p.theta_flat || 0,
      p.s_up == null ? 1 : p.s_up,
      p.s_dn == null ? 1 : p.s_dn,
    );
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
      else if (col.key === "upAfrr") v = fmtInt(sim.counts.upAfrr || 0);
      else if (col.key === "dnAfrr") v = fmtInt(sim.counts.dnAfrr || 0);
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
      if (fromEl) fromEl.value = isoToEU(from);
      if (toEl) toEl.value = isoToEU(to);
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
          // Parse DD/MM/YYYY; fall back to the dataset bounds on bad input
          let fIso = parseEU(fromEl.value) || dataMinDate;
          let tIso = parseEU(toEl.value) || dataMaxDate;
          fIso = clampDate(fIso, dataMinDate, dataMaxDate);
          tIso = clampDate(tIso, dataMinDate, dataMaxDate);
          if (fIso > tIso) [fIso, tIso] = [tIso, fIso];
          fromEl.value = isoToEU(fIso);
          toEl.value = isoToEU(tIso);
          state[level].simRange = { from: fIso, to: tIso };
          // Invalidate the chart range so updateLevel re-anchors to the new window
          state[level].tsRange = { from: null, to: null };
          scheduleUpdate(level);
        };
        fromEl.addEventListener("change", onChange);
        toEl.addEventListener("change", onChange);
        resetEl.addEventListener("click", () => {
          fromEl.value = isoToEU(dataMinDate);
          toEl.value = isoToEU(dataMaxDate);
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
      Engine.maybeWinsorize(
        p.w_mfrr_lo,
        p.w_mfrr_hi,
        p.w_imb_lo,
        p.w_imb_hi,
        p.w_afrr_pos_lo,
        p.w_afrr_pos_hi,
        p.w_afrr_neg_lo,
        p.w_afrr_neg_hi,
      );
      const xs = [];
      for (let x = -100; x <= 300; x += 10) xs.push(x);
      const ys = [];
      for (let y = 0; y <= 1.0001; y += 0.05) ys.push(parseFloat(y.toFixed(2)));
      // Per-direction split grids. The split parameters are 2-D in the
      // sweep (s_up × s_dn) so the optimiser can pick asymmetric ratios.
      // L1: 6 × 6 = 36 split combos (was 11). 41 × 21 × 36 ≈ 31 k → ~12 s.
      // L2: 4 × 4 = 16 split combos. 41 × 21 × 11 × 16 ≈ 152 k → ~60 s.
      const ssL1 = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
      const ssL2 = [0, 0.33, 0.67, 1.0];
      progEl.textContent = "computing…";
      if (level === 1) {
        setTimeout(() => {
          const t0 = performance.now();
          const result = Engine.sweepLevel1(xs, ys, ssL1, ssL1);
          const ms = Math.round(performance.now() - t0);
          progEl.textContent =
            `done in ${ms} ms — best at X=${result.best.X}, Y=${result.best.Y.toFixed(2)},` +
            ` s_up=${result.best.s_up.toFixed(2)}, s_dn=${result.best.s_dn.toFixed(2)}` +
            ` → ${fmtEUR(result.best.revenue)}`;
          setSliderValue(1, "X", result.best.X);
          setSliderValue(1, "Y", result.best.Y);
          setSliderValue(1, "s_up", result.best.s_up);
          setSliderValue(1, "s_dn", result.best.s_dn);
          state[1].lastSweep = result;
          updateLevel(1);
          btn.disabled = false;
        }, 30);
      } else {
        const zs = [];
        for (let z = 0; z <= 1.0001; z += 0.1) zs.push(parseFloat(z.toFixed(1)));
        let xi = 0;
        // 5-D sweep over (X, Y, Z, s_up, s_dn). Only the running best is
        // tracked — saving the full grid would cost > 50 MB at this
        // resolution. The heatmap is redrawn on demand from simulateTotal
        // and uses the CURRENT slider values for the un-pinned dimensions.
        let bestRev = -Infinity,
          bestX = 0,
          bestY = 0,
          bestZ = 0,
          bestSup = 1,
          bestSdn = 1;
        const tStart = performance.now();
        function runRow() {
          if (xi >= xs.length) {
            const ms = Math.round(performance.now() - tStart);
            const result = {
              best: {
                X: bestX,
                Y: bestY,
                Z: bestZ,
                s_up: bestSup,
                s_dn: bestSdn,
                revenue: bestRev,
              },
            };
            progEl.textContent =
              `done in ${ms} ms — best at X=${bestX}, Y=${bestY.toFixed(2)},` +
              ` Z=${bestZ.toFixed(2)}, s_up=${bestSup.toFixed(2)},` +
              ` s_dn=${bestSdn.toFixed(2)} → ${fmtEUR(bestRev)}`;
            setSliderValue(2, "X", bestX);
            setSliderValue(2, "Y", bestY);
            setSliderValue(2, "Z", bestZ);
            setSliderValue(2, "s_up", bestSup);
            setSliderValue(2, "s_dn", bestSdn);
            state[2].lastSweep = result;
            updateLevel(2);
            btn.disabled = false;
            return;
          }
          for (let yi = 0; yi < ys.length; yi++) {
            for (let zi = 0; zi < zs.length; zi++) {
              for (let ui = 0; ui < ssL2.length; ui++) {
                for (let di = 0; di < ssL2.length; di++) {
                  const r = Engine.simulateTotal(
                    2,
                    xs[xi],
                    ys[yi],
                    zs[zi],
                    p.theta_flat,
                    ssL2[ui],
                    ssL2[di],
                  );
                  if (r > bestRev) {
                    bestRev = r;
                    bestX = xs[xi];
                    bestY = ys[yi];
                    bestZ = zs[zi];
                    bestSup = ssL2[ui];
                    bestSdn = ssL2[di];
                  }
                }
              }
            }
          }
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
    // Range arguments are ISO YYYY-MM-DD; the inputs display DD/MM/YYYY.
    function applyRange(fromIso, toIso) {
      const sb = simBounds();
      fromIso = clampDate(fromIso, sb.from, sb.to);
      toIso = clampDate(toIso, sb.from, sb.to);
      if (fromIso > toIso) [fromIso, toIso] = [toIso, fromIso];
      fromEl.value = isoToEU(fromIso);
      toEl.value = isoToEU(toIso);
      state[level].tsRange = { from: fromIso, to: toIso };
      document
        .querySelectorAll(`.preset[data-level="${level}"]`)
        .forEach((b) => b.classList.remove("active"));
      updateLevel(level);
    }
    fromEl.addEventListener("change", () =>
      applyRange(parseEU(fromEl.value) || simBounds().from, parseEU(toEl.value) || simBounds().to),
    );
    toEl.addEventListener("change", () =>
      applyRange(parseEU(fromEl.value) || simBounds().from, parseEU(toEl.value) || simBounds().to),
    );
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
            row[yi] = Engine.simulateTotal(
              level,
              xs[xi],
              ys[yi],
              p.Z || 0,
              p.theta_flat || 0,
              p.s_up == null ? 1 : p.s_up,
              p.s_dn == null ? 1 : p.s_dn,
            );
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
            row[zi] = Engine.simulateTotal(
              2,
              xs[xi],
              p.Y,
              zs[zi],
              p.theta_flat,
              p.s_up == null ? 1 : p.s_up,
              p.s_dn == null ? 1 : p.s_dn,
            );
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
            row[zi] = Engine.simulateTotal(
              2,
              p.X,
              ys[yi],
              zs[zi],
              p.theta_flat,
              p.s_up == null ? 1 : p.s_up,
              p.s_dn == null ? 1 : p.s_dn,
            );
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
