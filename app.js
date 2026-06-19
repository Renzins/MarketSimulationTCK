// app.js — UI controller for the Backtester page (index.html).
//
// ARCHITECTURE (post-rework)
// ==========================
// Single unified panel — no Level 1 / 2 / 3 tabs. The engine always runs
// the full L3 codepath; the legacy "levels" are now expressible via:
//   · two source selectors in Setup (actualSource, idSource)
//   · four per-strategy enable checkboxes (DA withhold, split, ID trust,
//     intra-day oversell)
//
// Disabling a strategy greys its card and the engine treats its
// parameters as neutral (Y=0, s_up=s_dn=1, Z=0, X_cap=0 respectively).
// The optimiser only sweeps dimensions belonging to checked strategies.
//
// FLOW
// ====
//   1. Engine.init(WIND_DATA)      — typed-array bootstrap of the dataset
//   2. renderSetup()               — Setup card (sim window, winsor, θ,
//                                    source selectors)
//   3. renderStrategyCards()       — four strategy panels from PARAM_DEFS
//   4. renderStatsTables()         — decomposition + counts tables
//   5. bindAll()                   — wires every control to scheduleUpdate
//   6. update()                    — the hot path:
//                                      Engine.setWindow → maybeWinsorize
//                                      → simulate → render stats
//                                      → Charts.drawTimeSeries / Monthly / Histogram

(() => {
  // =====================================================================
  //  CONFIG: parameter metadata
  // =====================================================================

  // group: 'setup' = experiment env (NOT optimised);
  //        'da-withhold' / 'split' / 'id-trust' / 's3' = strategy levers.
  // The strategy group is also the data-strategy attribute on the card
  // and the suffix on the enable checkbox id (#enable-{group}).
  const PARAM_DEFS = {
    sim_range: {
      group: "setup",
      isDateRange: true,
      label: "Simulation date range",
      description:
        "Restricts the simulation to ISPs in this window. All revenue, imbalance, robustness and sweep calculations use only the selected period; winsorization percentiles are also computed within it.",
      extremes: [
        ["Full dataset", "all 14 months — most statistically powerful"],
        ["Sub-period", "stress-test: does the strategy still win when the window excludes a known easy month?"],
      ],
    },
    dayType: {
      group: "setup",
      isDayType: true,
      label: "Day type filter",
      description:
        "Restricts every result — totals, decomposition, monthly bars, robustness and the optimiser — to ISPs of the chosen day type. The simulation still runs over the FULL continuous window first, so intra-day oversell's rolling stats keep seeing the hidden days (a Monday trade still uses the preceding weekend's settled prices); the filter is applied only when summing the results, so continuity is never broken. Public holidays are detected for Latvia / Estonia / Lithuania via the date-holidays plugin (a date counts as a holiday if any of the three observes it).",
    },
    actualSource: {
      group: "setup",
      isSourceSelect: true,
      label: "Actual power source",
      description:
        "What the engine treats as the realised generation Q_pot when computing shortfall (Q_position − Q_pot). With \"DA forecast\" the simulation is fully self-consistent (no surprises ⇒ no shortfall ⇒ no imbalance cost) — this is the legacy Level 1 setup. With \"Real actual power\" the SCADA-derived wind_park_possible series drives shortfall — the legacy Level 2/3 setup. \"Intra-day forecast\" is an experimental in-between.",
      options: [
        { value: "da", label: "DA forecast" },
        { value: "id", label: "Intra-day forecast" },
        { value: "real", label: "Real actual power" },
      ],
      default: "real",
    },
    idSource: {
      group: "setup",
      isSourceSelect: true,
      label: "Intra-day forecast source",
      description:
        "What the engine feeds into the Z·(ID − F) revision. With \"DA forecast\" the revision is identically zero (ID − F = 0) — equivalent to switching off the ID-trust strategy. With \"Real intra-day forecast\" the SciPHER intra-day P50 drives the revision.",
      options: [
        { value: "da", label: "DA forecast" },
        { value: "real", label: "Real intra-day forecast" },
      ],
      default: "real",
    },
    w_mfrr: {
      group: "setup",
      label: "Winsorize mFRR price (percentiles)",
      unit: "%",
      isWinsor: true,
      defaultLo: 5,
      defaultHi: 95,
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
      defaultLo: 5,
      defaultHi: 95,
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
      defaultLo: 5,
      defaultHi: 95,
      description:
        "Caps the per-ISP averaged aFRR upward price (sum of AST_POS, NaN→0, ÷225) at the chosen percentiles. Only matters when s_up < 1 (any upward volume routed to aFRR).",
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
      defaultLo: 5,
      defaultHi: 95,
      description:
        "Same idea on the aFRR downward (AST_NEG) average. Downward prices can be very negative — winsorization is especially relevant here.",
      extremes: [
        ["0 / 100", "no winsorization"],
        ["25 / 75", "aggressive trimming"],
      ],
    },
    theta_flat: {
      group: "setup",
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
    X: {
      group: "da-withhold",
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
        ["X = −100", "never withhold — always sell every MW to DA (= naïve)"],
        ["X = 300", "always withhold — practically never use DA"],
      ],
    },
    Y: {
      group: "da-withhold",
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
        ["Y = 0", "sell everything to DA even when price is low"],
        ["Y = 1", "withhold the entire forecast below X and offer it all to mFRR-up"],
      ],
    },
    Z: {
      group: "id-trust",
      label: "ID trust coefficient Z",
      unit: "0–1",
      min: 0,
      max: 1,
      sliderStep: 0.01,
      numStep: 0.05,
      decimals: 2,
      description:
        "How much we trust the intraday forecast revision (ID − DA). The trusted positive revision is offered as additional mFRR-up volume in every ISP, regardless of X. Negative revisions are not acted on (no buy-back modelled).",
      extremes: [
        ["Z = 0", "ignore the intraday forecast — only DA drives the decision"],
        ["Z = 1", "fully trust ID — offer the entire ID−DA revision as extra mFRR-up"],
      ],
    },
    s_up: {
      group: "split",
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
        ["s_up = 1", "all upward volume to mFRR"],
        ["s_up = 0", "all upward volume to aFRR"],
        ["0 < s_up < 1", "split: e.g. s_up = 0.7 → ~70 % mFRR-up, 30 % aFRR-up"],
      ],
    },
    s_dn: {
      group: "split",
      label: "mFRR ↔ aFRR split — DOWNWARD (s_dn)",
      unit: "0–1",
      min: 0,
      max: 1,
      sliderStep: 0.01,
      numStep: 0.05,
      decimals: 2,
      description:
        "Fraction of DOWNWARD offered MW (curtailment of DA position) routed to mFRR vs aFRR. Independent from s_up because the per-direction price dynamics differ: mFRR-dn fires only when P_mfrr ≤ −1; aFRR-dn earns whenever the averaged AST_NEG < 0.",
      extremes: [
        ["s_dn = 1", "all downward volume to mFRR"],
        ["s_dn = 0", "all downward volume to aFRR"],
      ],
    },
    // -------- S3 (speculative intraday oversell) ---------------------
    s3_K: {
      group: "s3",
      label: "Lookback window K",
      unit: "ISPs",
      min: 2,
      max: 48,
      sliderStep: 1,
      numStep: 1,
      decimals: 0,
      description:
        "How many recent settled mFRR clearing prices we average to estimate the next ISP's mFRR price. Small K (2–4) reacts fast but noisy; large K (12–24) stable but slow to detect regime changes.",
      extremes: [
        ["K = 2", "very reactive — picks up rapid regime changes but mean is noisy"],
        ["K = 4 (default)", "covers the last hour (4 × 15 min)"],
        ["K = 48", "very stable; 12 hours of history"],
      ],
    },
    s3_lag: {
      group: "s3",
      label: "Publication lag L",
      unit: "ISPs",
      min: 0,
      max: 24,
      sliderStep: 1,
      numStep: 1,
      decimals: 0,
      description:
        "Number of most-recent ISPs whose settlement we cannot yet observe at the time the intra-day bid is placed. The rolling stats use samples in [target − K − L, target − L). At 08:55 a trader bidding for the 09:30 ISP has visibility only through ~08:30 ⇒ L = 4. Not swept by the optimiser; set manually based on real publication latency.",
      extremes: [
        ["L = 0", "no lag (unrealistic)"],
        ["L = 4 (default)", "≈ 1 h gap between latest visible settlement and target ISP"],
        ["L = 24", "6 h delay; rolling stats become quite stale"],
      ],
    },
    s3_da_skip: {
      group: "s3",
      label: "Skip if DA sold ≥",
      unit: "MW",
      min: 0,
      max: 59,
      sliderStep: 1,
      numStep: 1,
      decimals: 0,
      description:
        "S3 is skipped on ISPs where da_sold (after withholding + floor) is at or above this MW threshold. Prevents oversell-on-top-of-near-max-DA situations where the park has little physical headroom. Park capacity is 58.8 MW. Setting this to 0 disables S3 entirely; setting it to 59 effectively turns the gate off. Not optimised.",
      extremes: [
        ["skip = 0", "S3 fully gated off"],
        ["skip = 50 (default)", "S3 only runs when DA position leaves ≥ 9 MW headroom"],
        ["skip = 59", "gate effectively off"],
      ],
    },
    s3_S_min: {
      group: "s3",
      label: "Minimum spread S_min",
      unit: "EUR/MWh",
      min: 0,
      max: 200,
      sliderStep: 1,
      numStep: 1,
      decimals: 0,
      description:
        "Trigger gate: only trade when (VWAP1H − rolling-mean mFRR) ≥ S_min. Below this, the expected profit per MW is too small to overcome friction and noise.",
      extremes: [
        ["S_min = 10", "loose — most ISPs trigger; lots of low-margin trades"],
        ["S_min = 25 (default)", "balanced filter"],
        ["S_min = 200", "very tight — only trade on extreme spreads"],
      ],
    },
    s3_sigma_max: {
      group: "s3",
      label: "Max volatility σ_max",
      unit: "EUR/MWh",
      min: 0,
      max: 1000,
      sliderStep: 5,
      numStep: 5,
      decimals: 0,
      description:
        "Stand-aside gate: skip the trade if rolling std of recent mFRR prices exceeds σ_max. Captures the intuition that the rolling mean is meaningless when prices have been chaotic.",
      extremes: [
        ["σ_max = 20", "very strict — only trade during very stable regimes"],
        ["σ_max = 75 (default)", "moderate filter"],
        ["σ_max = 1000", "effectively disabled"],
      ],
    },
    s3_X_cap: {
      group: "s3",
      label: "Volume cap X_cap",
      unit: "MW",
      min: 0,
      max: 58,
      sliderStep: 1,
      numStep: 1,
      decimals: 0,
      description:
        "Hard upper limit on the extra MW oversold in a single ISP. Strong signal → up to X_cap; weak signal → proportionally less (whole-MW floored). Setting X_cap = 0 disables the strategy entirely (equivalent to unchecking the card). NOT optimised — the backtest has no price-impact term, so a sweep would always pick the grid maximum.",
      extremes: [
        ["X_cap = 0", "S3 disabled"],
        ["X_cap = 5 (default)", "modest position, safe in shallow markets"],
        ["X_cap = 30+", "aggressive — significant price-impact risk in Baltic"],
      ],
    },
    s3_M: {
      group: "s3",
      label: "Hedge bid margin M",
      unit: "EUR/MWh",
      min: -50,
      max: 100,
      sliderStep: 1,
      numStep: 1,
      decimals: 0,
      description:
        "Sets the hedge mFRR-dn bid_price = VWAP1H + M. This is a stop-loss mFRR-dn offer the wind park wouldn't normally place — pitched above the typical clearing — so when it clears it costs us, but it bounds the loss on the oversold MW vs imbalance settlement. Clears whenever p_mfrr ≤ bid_price.",
      extremes: [
        ["M = −50", "tight stop — only accept curtailment when paid ≥ 50 below VWAP1H"],
        ["M = 0", "bid right at VWAP1H — fires when curtailment is breakeven or better"],
        ["M = 5 (default)", "small cushion above VWAP1H"],
        ["M = 100", "very loose stop — fires almost always"],
      ],
    },
  };

  // Defaults — match the previous "Level 3 default" behaviour exactly.
  const DEFAULTS = {
    actualSource: "real",
    idSource: "real",
    enabled: { daWithhold: true, split: true, idTrust: true, s3: true },
    params: {
      X: 30,
      Y: 1.0,
      Z: 1.0,
      theta_flat: 30,
      s_up: 1.0,
      s_dn: 1.0,
      w_mfrr_lo: 5,
      w_mfrr_hi: 95,
      w_imb_lo: 5,
      w_imb_hi: 95,
      w_afrr_pos_lo: 5,
      w_afrr_pos_hi: 95,
      w_afrr_neg_lo: 5,
      w_afrr_neg_hi: 95,
      s3_K: 4,
      s3_lag: 4,
      s3_da_skip: 50,
      s3_S_min: 25,
      s3_sigma_max: 75,
      s3_X_cap: 5,
      s3_M: 5,
    },
  };

  // Display order of strategy cards (must match index.html data-strategy
  // attribute on each .controls-card). Setup is rendered above.
  const STRATEGY_GROUPS = ["da-withhold", "split", "id-trust", "s3"];

  // Setup keys in display order. The two source selectors go first so
  // they're the most prominent decision.
  const SETUP_KEYS = [
    "actualSource",
    "idSource",
    "sim_range",
    "dayType",
    "w_mfrr",
    "w_imb",
    "w_afrr_pos",
    "w_afrr_neg",
    "theta_flat",
  ];

  // Decomposition + counts tables — always show all rows since the
  // engine always computes every leg.
  const DECOMP_COLUMNS = [
    { key: "DA", label: "DA revenue", type: "eur" },
    { key: "mFRR_up", label: "mFRR-up rev", type: "eur" },
    { key: "mFRR_dn", label: "mFRR-dn rev", type: "eur" },
    { key: "aFRR_up", label: "aFRR-up rev", type: "eur" },
    { key: "aFRR_dn", label: "aFRR-dn rev", type: "eur" },
    { key: "s3_intraday", label: "S3 ID sale rev", type: "eur" },
    { key: "s3_curtail", label: "S3 curtail rev", type: "eur" },
    { key: "imb", label: "Imbalance cost", type: "eur-cost" },
    { key: "flat", label: "Flat penalty", type: "eur-cost" },
    { key: "s3_extra_cost", label: "S3 extra imb cost", type: "eur-cost" },
  ];
  const COUNT_COLUMNS = [
    { key: "up", label: "ISPs with mFRR-up", type: "int" },
    { key: "dn", label: "ISPs with mFRR-dn", type: "int" },
    { key: "upAfrr", label: "ISPs with aFRR-up", type: "int", help: "ISPs where avg_p_pos > 0 AND we routed volume to aFRR (s_up < 1) — wind park bid into upward and earned." },
    { key: "dnAfrr", label: "ISPs with aFRR-dn", type: "int", help: "ISPs where avg_p_neg < 0 AND we routed volume to aFRR — system paid the park to curtail." },
    { key: "wasted", label: "Withheld w/o activation", type: "int", help: "Below X, withheld but neither market activated profitably — energy earns nothing." },
    { key: "short", label: "ISPs with shortfall", type: "int" },
    { key: "shortMWh", label: "Total shortfall (MWh)", type: "mwh" },
    { key: "shortAvg", label: "Avg cost / short ISP", type: "eur" },
    { key: "s3Oversold", label: "ISPs with S3 oversell", type: "int", help: "ISPs where the S3 strategy passed all gates and the wind park oversold on intraday." },
    { key: "s3HedgeFired", label: "S3 hedge fired", type: "int", help: "Of the S3-oversell ISPs, how many had p_mfrr ≤ VWAP1H + M so the hedge mFRR-dn bid cleared." },
  ];

  // =====================================================================
  //  BOOTSTRAP
  // =====================================================================
  const D = Engine.init(WIND_DATA);
  console.log(`Loaded ${D.n} ISPs`);
  Engine.maybeWinsorize(5, 95, 5, 95);

  const startTs = Engine.tsAt(0);
  const endTs = Engine.tsAt(D.n - 1);
  const fmtDateOnly = (d) => d.toISOString().substring(0, 10);
  const fmtDateEU = (d) => {
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = d.getUTCFullYear();
    return `${dd}/${mm}/${yyyy}`;
  };
  function parseEU(str) {
    if (!str) return null;
    const m = str.trim().match(/^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{4})$/);
    if (!m) return null;
    const dd = m[1].padStart(2, "0");
    const mm = m[2].padStart(2, "0");
    return `${m[3]}-${mm}-${dd}`;
  }
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
  //  STATE
  // =====================================================================
  const state = {
    actualSource: DEFAULTS.actualSource,
    idSource: DEFAULTS.idSource,
    enabled: { ...DEFAULTS.enabled },
    params: { ...DEFAULTS.params },
    simRange: { from: dataMinDate, to: dataMaxDate },
    // Day-type filter — like simRange, it scopes the experiment and is NOT
    // touched by "Reset to defaults". "all" | "weekend-holiday" | "workday".
    dayType: "all",
    tsRange: { from: null, to: null },
    lastSim: null,
    lastNaive: null,
    lastSweep: null,
    // Optimised-runs log (#4) — one entry per completed Optimise. In-memory.
    optimRuns: [],
  };

  // Build the params object the engine expects: numeric params + sources
  // + enabled flags. simSourceParams() is read by every engine call.
  function simSourceParams(extras) {
    return {
      ...state.params,
      ...(extras || {}),
      actualSource: state.actualSource,
      idSource: state.idSource,
      dayTypeFilter: state.dayType,
      enabled: { ...state.enabled },
    };
  }

  // =====================================================================
  //  RENDER PARAM CARDS
  // =====================================================================
  function paramCardHTML(key) {
    const def = PARAM_DEFS[key];
    const idBase = key;

    // ---- date-range card ----
    if (def.isDateRange) {
      const from = state.simRange.from;
      const to = state.simRange.to;
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

    // ---- day-type toggle (all / weekends+holidays / workdays) ----
    if (def.isDayType) {
      const cur = state.dayType;
      const btn = (val, lbl) =>
        `<button type="button" class="btn small preset${cur === val ? " active" : ""}" data-day-type="${val}">${lbl}</button>`;
      return `
        <div class="control">
          <label>${def.label}</label>
          <div class="day-type-toggle bt-day-type-toggle">
            ${btn("all", "All days")}
            ${btn("weekend-holiday", "Weekends + holidays")}
            ${btn("workday", "Workdays only")}
          </div>
          <div class="param-desc">
            <p>${def.description}</p>
          </div>
        </div>`;
    }

    // ---- source selector (radio pills) ----
    if (def.isSourceSelect) {
      const current = state[key];
      const opts = def.options
        .map(
          (o) => `
        <label class="source-option">
          <input type="radio" name="${idBase}" value="${o.value}" ${o.value === current ? "checked" : ""}>
          <span>${o.label}</span>
        </label>`,
        )
        .join("");
      return `
        <div class="control source-selector">
          <label>${def.label}</label>
          <div class="source-options" id="${idBase}-options">${opts}</div>
          <div class="param-desc">
            <p>${def.description}</p>
          </div>
        </div>`;
    }

    // ---- winsor card ----
    if (def.isWinsor) {
      const lo = state.params[`${key}_lo`];
      const hi = state.params[`${key}_hi`];
      return `
        <div class="control winsor">
          <label>${def.label}</label>
          <div class="slider-row two winsor-row">
            <span class="winsor-input">
              <input type="number" id="${idBase}-lo" value="${lo}" min="0" max="50" step="1">
              <span class="winsor-cap" id="${idBase}-cap-lo">(…)</span>
            </span>
            <span>/</span>
            <span class="winsor-input">
              <input type="number" id="${idBase}-hi" value="${hi}" min="50" max="100" step="1">
              <span class="winsor-cap" id="${idBase}-cap-hi">(…)</span>
            </span>
          </div>
          <div class="param-desc">
            <p>${def.description}</p>
            <ul class="extremes">
              ${def.extremes.map(([v, m]) => `<li><b>${v}:</b> ${m}</li>`).join("")}
            </ul>
          </div>
        </div>`;
    }

    // ---- numeric (slider+number) card ----
    const value = state.params[key];
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

  function renderSetup() {
    document.getElementById("setup-params").innerHTML = SETUP_KEYS
      .map((k) => paramCardHTML(k))
      .join("");
  }

  function renderStrategyCards() {
    for (const grp of STRATEGY_GROUPS) {
      const container = document.getElementById(`${grp}-params`);
      if (!container) continue;
      const keys = Object.keys(PARAM_DEFS).filter((k) => PARAM_DEFS[k].group === grp);
      container.innerHTML = keys.map((k) => paramCardHTML(k)).join("");
    }
  }

  // =====================================================================
  //  STATS TABLES
  // =====================================================================
  function renderStatsTables() {
    const head1 = DECOMP_COLUMNS.map((c) => `<th>${c.label}</th>`).join("");
    const body1 = DECOMP_COLUMNS.map((c) => `<td id="${c.key}">–</td>`).join("");
    const head2 = COUNT_COLUMNS
      .map((c) => `<th${c.help ? ` title="${c.help.replace(/"/g, "&quot;")}"` : ""}>${c.label}</th>`)
      .join("");
    const body2 = COUNT_COLUMNS.map((c) => `<td id="cnt-${c.key}">–</td>`).join("");
    document.getElementById("decomp-table").innerHTML = `
      <thead><tr>${head1}</tr></thead>
      <tbody><tr>${body1}</tr></tbody>`;
    document.getElementById("counts-table").innerHTML = `
      <thead><tr>${head2}</tr></thead>
      <tbody><tr>${body2}</tr></tbody>`;
  }

  // =====================================================================
  //  FORMATTERS
  // =====================================================================
  const fmtEUR = (v) => Math.round(v).toLocaleString("en-US") + " €";
  const fmtPct = (v) => (v * 100).toFixed(1) + "%";
  const fmtInt = (v) => v.toLocaleString("en-US");
  const fmtMWh = (v) => Math.round(v).toLocaleString("en-US") + " MWh";

  function fmtCap(v) {
    if (!isFinite(v)) return "—";
    const abs = Math.abs(v);
    if (abs >= 1000) return Math.round(v).toLocaleString("en-US");
    if (abs >= 100) return v.toFixed(0);
    return v.toFixed(1);
  }

  function updateWinsorCaps(bounds) {
    const map = [
      ["w_mfrr", bounds && bounds.mfrrBounds],
      ["w_imb", bounds && bounds.imbBounds],
      ["w_afrr_pos", bounds && bounds.afrrPosBounds],
      ["w_afrr_neg", bounds && bounds.afrrNegBounds],
    ];
    for (const [key, b] of map) {
      const loEl = document.getElementById(`${key}-cap-lo`);
      const hiEl = document.getElementById(`${key}-cap-hi`);
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
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // =====================================================================
  //  CORE UPDATE
  // =====================================================================
  // charts.js still takes a "level" arg for what to render in tooltip /
  // bars. With the unified engine: level=3 when S3 is enabled (S3 bars
  // shown), else level=2 (always show Q_pot / imbalance breakdown — even
  // when the actualSource selection makes them structurally zero).
  function effectiveLevel() {
    return state.enabled.s3 ? 3 : 2;
  }

  function update() {
    // 1. Window + winsor
    const sim_range = state.simRange;
    const { start: winStart, end: winEnd } = rangeToIdx(sim_range.from, sim_range.to);
    Engine.setWindow(winStart, winEnd);
    const p = state.params;
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
    updateWinsorCaps(bounds);

    // 2. Simulate + naïve baseline
    const callParams = simSourceParams();
    const sim = Engine.simulate(callParams);
    const naive = Engine.naiveRevenue(callParams);
    state.lastSim = sim;
    state.lastNaive = naive;

    // 3. Top stats
    document.getElementById("total").textContent = fmtEUR(sim.totalRevenue);
    const diff = sim.totalRevenue - naive;
    const diffPct = naive !== 0 ? diff / Math.abs(naive) : 0;
    const vsEl = document.getElementById("vs-naive");
    vsEl.textContent = `${diff >= 0 ? "+" : ""}${fmtEUR(diff)} (${diff >= 0 ? "+" : ""}${(diffPct * 100).toFixed(2)}%)`;
    vsEl.className = "value " + (Math.abs(diff) < 1 ? "" : diff >= 0 ? "up" : "down");

    const totalPotMWh = Engine.totalPotMWhInWindow(callParams);
    document.getElementById("per-mwh").textContent =
      totalPotMWh > 0 ? (sim.totalRevenue / totalPotMWh).toFixed(2) + " €/MWh" : "–";

    // 4. Decomposition / counts
    for (const col of DECOMP_COLUMNS) {
      const v = sim.breakdown[col.key];
      document.getElementById(col.key).textContent =
        col.type === "eur-cost" ? "−" + fmtEUR(v) : fmtEUR(v);
    }
    const setCnt = (key, value) => {
      const el = document.getElementById(`cnt-${key}`);
      if (el) el.textContent = value;
    };
    setCnt("up", fmtInt(sim.counts.up));
    setCnt("dn", fmtInt(sim.counts.dn));
    setCnt("upAfrr", fmtInt(sim.counts.upAfrr || 0));
    setCnt("dnAfrr", fmtInt(sim.counts.dnAfrr || 0));
    setCnt("wasted", fmtInt(sim.counts.wasted));
    setCnt("short", fmtInt(sim.counts.short));
    setCnt("shortMWh", fmtMWh(sim.totalShortMWh));
    setCnt(
      "shortAvg",
      sim.counts.short > 0
        ? fmtEUR((sim.breakdown.imb + sim.breakdown.flat) / sim.counts.short)
        : "0 €",
    );
    setCnt("s3Oversold", fmtInt(sim.counts.s3Oversold || 0));
    setCnt("s3HedgeFired", fmtInt(sim.counts.s3HedgeFired || 0));

    // 5. Robustness — use filteredRevenue so concentration reflects only the
    // days the headline total is computed over (== perISP.revenue when the
    // filter is "all").
    const robustRev = sim.filteredRevenue || sim.perISP.revenue;
    const conc1 = Engine.topConcentration(robustRev, 0.01);
    const conc5 = Engine.topConcentration(robustRev, 0.05);
    const conc10 = Engine.topConcentration(robustRev, 0.1);
    document.getElementById("top1pct").textContent =
      fmtPct(conc1.share) + " (" + conc1.topN + " ISPs)";
    document.getElementById("top5pct").textContent = fmtPct(conc5.share);
    document.getElementById("top10pct").textContent = fmtPct(conc10.share);

    // 6. Time-series chart range (re-anchor when sim window changes)
    let { from, to } = state.tsRange;
    if (!from || !to || from < sim_range.from || to > sim_range.to) {
      const midIdx = Math.floor((winStart + Math.max(winStart, winEnd - 1)) / 2);
      const midDate = isoDate(Engine.tsAt(Math.max(0, Math.min(D.n - 1, midIdx))));
      from = clampDate(midDate, sim_range.from, sim_range.to);
      to = from;
      state.tsRange = { from, to };
      const fromEl = document.getElementById("date-from");
      const toEl = document.getElementById("date-to");
      if (fromEl) fromEl.value = isoToEU(from);
      if (toEl) toEl.value = isoToEU(to);
    }
    const chartIdx = rangeToIdx(from, to);
    const lvl = effectiveLevel();
    Charts.drawTimeSeries("ts-chart", lvl, sim, callParams, chartIdx.start, chartIdx.end);
    Charts.drawMonthly("monthly-chart", lvl, Engine.monthlyAggregation(callParams));
    Charts.drawHistogram("hist-chart", sim.filteredRevenue || sim.perISP.revenue);
  }

  let updateTimer = null;
  function scheduleUpdate() {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(update, 60);
  }

  // =====================================================================
  //  STRATEGY ENABLE TOGGLES
  // =====================================================================
  // Map data-strategy attribute → state.enabled key.
  const STRATEGY_TO_ENABLE_KEY = {
    "da-withhold": "daWithhold",
    split: "split",
    "id-trust": "idTrust",
    s3: "s3",
  };

  function applyEnableUI() {
    for (const grp of STRATEGY_GROUPS) {
      const card = document.querySelector(`.controls-card[data-strategy="${grp}"]`);
      const cb = document.getElementById(`enable-${grp}`);
      const key = STRATEGY_TO_ENABLE_KEY[grp];
      const on = state.enabled[key];
      if (cb) cb.checked = on;
      if (card) card.classList.toggle("disabled", !on);
    }
  }

  function bindEnableToggles() {
    for (const grp of STRATEGY_GROUPS) {
      const cb = document.getElementById(`enable-${grp}`);
      const key = STRATEGY_TO_ENABLE_KEY[grp];
      if (!cb) continue;
      cb.addEventListener("change", () => {
        state.enabled[key] = cb.checked;
        applyEnableUI();
        scheduleUpdate();
      });
    }
  }

  // =====================================================================
  //  SETUP + PARAM BINDING
  // =====================================================================
  function bindAll() {
    // Setup keys
    for (const key of SETUP_KEYS) {
      const def = PARAM_DEFS[key];
      const idBase = key;

      if (def.isDateRange) {
        const fromEl = document.getElementById(`${idBase}-from`);
        const toEl = document.getElementById(`${idBase}-to`);
        const resetEl = document.getElementById(`${idBase}-reset`);
        const onChange = () => {
          let fIso = parseEU(fromEl.value) || dataMinDate;
          let tIso = parseEU(toEl.value) || dataMaxDate;
          fIso = clampDate(fIso, dataMinDate, dataMaxDate);
          tIso = clampDate(tIso, dataMinDate, dataMaxDate);
          if (fIso > tIso) [fIso, tIso] = [tIso, fIso];
          fromEl.value = isoToEU(fIso);
          toEl.value = isoToEU(tIso);
          state.simRange = { from: fIso, to: tIso };
          state.tsRange = { from: null, to: null };
          scheduleUpdate();
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

      if (def.isDayType) {
        document
          .querySelectorAll(".bt-day-type-toggle .preset[data-day-type]")
          .forEach((b) => {
            b.addEventListener("click", () => {
              const nt = b.dataset.dayType;
              if (state.dayType === nt) return;
              state.dayType = nt;
              document
                .querySelectorAll(".bt-day-type-toggle .preset[data-day-type]")
                .forEach((x) => x.classList.remove("active"));
              b.classList.add("active");
              scheduleUpdate();
            });
          });
        continue;
      }

      if (def.isSourceSelect) {
        const radios = document.querySelectorAll(`input[type="radio"][name="${idBase}"]`);
        radios.forEach((r) => {
          r.addEventListener("change", () => {
            if (!r.checked) return;
            state[idBase] = r.value;
            scheduleUpdate();
          });
        });
        continue;
      }

      if (def.isWinsor) {
        const lo = document.getElementById(`${idBase}-lo`);
        const hi = document.getElementById(`${idBase}-hi`);
        const onChange = () => {
          const loV = clamp(parseFloat(lo.value) || 0, 0, 50);
          const hiV = clamp(parseFloat(hi.value) || 100, 50, 100);
          state.params[`${idBase}_lo`] = loV;
          state.params[`${idBase}_hi`] = hiV;
          lo.value = loV;
          hi.value = hiV;
          scheduleUpdate();
        };
        lo.addEventListener("change", onChange);
        hi.addEventListener("change", onChange);
        continue;
      }

      // numeric (theta_flat)
      const slider = document.getElementById(idBase);
      const num = document.getElementById(`${idBase}-num`);
      const onSet = (raw) => {
        let v = parseFloat(raw);
        if (isNaN(v)) return;
        v = clamp(v, def.min, def.max);
        slider.value = v;
        num.value = v;
        state.params[idBase] = v;
        scheduleUpdate();
      };
      slider.addEventListener("input", (e) => onSet(e.target.value));
      num.addEventListener("change", (e) => onSet(e.target.value));
    }

    // Strategy params
    for (const grp of STRATEGY_GROUPS) {
      const keys = Object.keys(PARAM_DEFS).filter((k) => PARAM_DEFS[k].group === grp);
      for (const key of keys) {
        const def = PARAM_DEFS[key];
        const idBase = key;
        const slider = document.getElementById(idBase);
        const num = document.getElementById(`${idBase}-num`);
        if (!slider || !num) continue;
        const onSet = (raw) => {
          let v = parseFloat(raw);
          if (isNaN(v)) return;
          v = clamp(v, def.min, def.max);
          slider.value = v;
          num.value = v;
          state.params[idBase] = v;
          scheduleUpdate();
        };
        slider.addEventListener("input", (e) => onSet(e.target.value));
        num.addEventListener("change", (e) => onSet(e.target.value));
      }
    }
  }

  function setSliderValue(key, value) {
    const slider = document.getElementById(key);
    const num = document.getElementById(`${key}-num`);
    if (slider) slider.value = value;
    if (num) num.value = value;
    state.params[key] = value;
  }

  function setSourceSelector(key, value) {
    state[key] = value;
    document
      .querySelectorAll(`input[type="radio"][name="${key}"]`)
      .forEach((r) => {
        r.checked = r.value === value;
      });
  }

  // Full reset — sources, enables and every parameter back to defaults.
  function resetToDefaults() {
    state.actualSource = DEFAULTS.actualSource;
    state.idSource = DEFAULTS.idSource;
    state.enabled = { ...DEFAULTS.enabled };
    state.params = { ...DEFAULTS.params };
    setSourceSelector("actualSource", DEFAULTS.actualSource);
    setSourceSelector("idSource", DEFAULTS.idSource);
    for (const key of Object.keys(DEFAULTS.params)) {
      // winsor pairs are stored as _lo / _hi suffixes; their inputs are
      // {key}-lo / {key}-hi directly without a base slider.
      const slider = document.getElementById(key);
      const num = document.getElementById(`${key}-num`);
      if (slider && num) {
        slider.value = DEFAULTS.params[key];
        num.value = DEFAULTS.params[key];
      }
    }
    // Winsor pair inputs
    for (const k of ["w_mfrr", "w_imb", "w_afrr_pos", "w_afrr_neg"]) {
      const lo = document.getElementById(`${k}-lo`);
      const hi = document.getElementById(`${k}-hi`);
      if (lo) lo.value = DEFAULTS.params[`${k}_lo`];
      if (hi) hi.value = DEFAULTS.params[`${k}_hi`];
    }
    applyEnableUI();
    update();
  }

  document.getElementById("reset").addEventListener("click", resetToDefaults);

  // =====================================================================
  //  OPTIMISER — random search + multi-start coord-descent refine.
  //  Sweeps only over dimensions belonging to ENABLED strategies. Disabled
  //  strategies stay at their current state.params values; the engine's
  //  enabled flag forces them to a neutral effective value regardless.
  // =====================================================================
  const RANDOM_N = 4000;
  const REFINE_STARTS = 5;
  const RAND_PROGRESS = 0.35;

  const _yieldChannel =
    typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
  let _yieldResolve = null;
  if (_yieldChannel) {
    _yieldChannel.port1.onmessage = () => {
      const r = _yieldResolve;
      _yieldResolve = null;
      if (r) r();
    };
  }
  function yieldToBrowser() {
    if (_yieldChannel) {
      return new Promise((r) => {
        _yieldResolve = r;
        _yieldChannel.port2.postMessage(null);
      });
    }
    return new Promise((r) => setTimeout(r, 0));
  }

  function mulberry32(seed) {
    let s = seed | 0;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Which dimensions are sweepable, given which strategies are enabled.
  // Each entry: { key, sample(rng), refineValues } — sample produces a
  // single random value, refineValues is the coord-descent grid.
  function rangeArr(lo, hi, step) {
    const out = [];
    for (let v = lo; v <= hi + step * 1e-6; v += step) {
      out.push(Math.round((v / step) * 1) * step);
    }
    return out;
  }
  function range01(step) {
    const out = [];
    for (let v = 0; v <= 1 + 1e-9; v += step) out.push(parseFloat(v.toFixed(4)));
    return out;
  }

  function buildOptimDims() {
    const dims = [];
    if (state.enabled.daWithhold) {
      dims.push({
        key: "X",
        sample: (rng) => -100 + Math.floor(rng() * 401),
        refineValues: rangeArr(-100, 300, 5),
      });
      dims.push({
        key: "Y",
        sample: (rng) => Math.round(rng() * 100) / 100,
        refineValues: range01(0.02),
      });
    }
    if (state.enabled.split) {
      dims.push({
        key: "s_up",
        sample: (rng) => Math.round(rng() * 100) / 100,
        refineValues: range01(0.02),
      });
      dims.push({
        key: "s_dn",
        sample: (rng) => Math.round(rng() * 100) / 100,
        refineValues: range01(0.02),
      });
    }
    if (state.enabled.idTrust) {
      dims.push({
        key: "Z",
        sample: (rng) => Math.round(rng() * 100) / 100,
        refineValues: range01(0.02),
      });
    }
    if (state.enabled.s3) {
      dims.push({
        key: "s3_K",
        sample: (rng) => 2 + Math.floor(rng() * 47),
        refineValues: rangeArr(2, 48, 1),
      });
      dims.push({
        key: "s3_S_min",
        sample: (rng) => Math.floor(rng() * 201),
        refineValues: rangeArr(0, 200, 5),
      });
      dims.push({
        key: "s3_sigma_max",
        sample: (rng) => Math.floor(rng() * 201) * 5,
        refineValues: rangeArr(0, 1000, 25),
      });
      dims.push({
        key: "s3_M",
        sample: (rng) => -50 + Math.floor(rng() * 151),
        refineValues: rangeArr(-50, 100, 5),
      });
    }
    return dims;
  }

  function randomSampleByDims(dims, rng) {
    const sample = {};
    for (const d of dims) sample[d.key] = d.sample(rng);
    return sample;
  }

  function evaluateSample(sample) {
    return Engine.simulateTotal(simSourceParams(sample));
  }

  async function coordRefine(startSample, dims, maxPasses = 3) {
    let cur = { ...startSample };
    let curRev = evaluateSample(cur);
    let lastYield = performance.now();
    for (let pass = 0; pass < maxPasses; pass++) {
      let improved = false;
      for (const dim of dims) {
        let bestVal = cur[dim.key];
        let bestR = curRev;
        for (const v of dim.refineValues) {
          if (v === cur[dim.key]) continue;
          const probe = { ...cur, [dim.key]: v };
          const r = evaluateSample(probe);
          if (r > bestR) {
            bestR = r;
            bestVal = v;
          }
          if (performance.now() - lastYield > 200) {
            await yieldToBrowser();
            lastYield = performance.now();
          }
        }
        if (bestVal !== cur[dim.key]) {
          cur[dim.key] = bestVal;
          curRev = bestR;
          improved = true;
        }
      }
      if (!improved) break;
    }
    return { sample: cur, revenue: curRev };
  }

  function renderProgressBar(progEl, fraction, label) {
    if (!progEl.querySelector(".progress-bar")) {
      progEl.innerHTML =
        '<div class="progress-bar">' +
        '<div class="progress-bar-fill"></div>' +
        '<div class="progress-bar-text"></div>' +
        "</div>";
    }
    const fill = progEl.querySelector(".progress-bar-fill");
    const text = progEl.querySelector(".progress-bar-text");
    const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    fill.style.width = `${pct}%`;
    text.textContent = label;
  }

  function applyOptimisedSample(sample) {
    for (const key of Object.keys(sample)) {
      setSliderValue(key, sample[key]);
    }
  }

  async function optimise() {
    const optimiseBtn = document.getElementById("optimise");
    const resetBtn = document.getElementById("reset");
    const progEl = document.getElementById("progress");
    const dims = buildOptimDims();
    if (dims.length === 0) {
      renderProgressBar(progEl, 1, "nothing to optimise (no strategies enabled)");
      return;
    }
    optimiseBtn.disabled = true;
    resetBtn.disabled = true;

    const p = state.params;
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

    const N = RANDOM_N;
    const K = REFINE_STARTS;
    const YIELD_INTERVAL_MS = 200;
    const t0 = performance.now();
    const rng = mulberry32(0xc0ffee);

    renderProgressBar(progEl, 0, "optimising 0%");
    await yieldToBrowser();

    const topK = [];
    let lastYield = performance.now();
    for (let i = 0; i < N; i++) {
      const s = randomSampleByDims(dims, rng);
      const r = evaluateSample(s);
      if (topK.length < K) {
        topK.push({ sample: s, revenue: r });
        topK.sort((a, b) => b.revenue - a.revenue);
      } else if (r > topK[K - 1].revenue) {
        topK[K - 1] = { sample: s, revenue: r };
        topK.sort((a, b) => b.revenue - a.revenue);
      }
      if (performance.now() - lastYield > YIELD_INTERVAL_MS) {
        const f = ((i + 1) / N) * RAND_PROGRESS;
        renderProgressBar(progEl, f, `optimising ${Math.round(f * 100)}%`);
        await yieldToBrowser();
        lastYield = performance.now();
      }
    }

    renderProgressBar(progEl, RAND_PROGRESS, `refining 1/${K}…`);
    await yieldToBrowser();
    let best = null;
    for (let k = 0; k < topK.length; k++) {
      const refined = await coordRefine(topK[k].sample, dims);
      if (!best || refined.revenue > best.revenue) best = refined;
      const f = RAND_PROGRESS + ((k + 1) / K) * (1 - RAND_PROGRESS);
      const label = k + 1 < topK.length ? `refining ${k + 2}/${K}…` : "finalising…";
      renderProgressBar(progEl, f, label);
      await yieldToBrowser();
    }
    const ms = Math.round(performance.now() - t0);

    applyOptimisedSample(best.sample);
    state.lastSweep = { best: { ...best.sample, revenue: best.revenue } };
    update();
    recordOptimRun(best, ms);
    renderProgressBar(
      progEl,
      1,
      `done in ${(ms / 1000).toFixed(1)}s — ${fmtEUR(best.revenue)}`,
    );
    optimiseBtn.disabled = false;
    resetBtn.disabled = false;
  }

  // =====================================================================
  //  OPTIMISED RUNS LOG (#4)
  //  Each completed Optimise appends a row capturing the setup, which
  //  strategies were enabled, and the optimal parameters found — so runs
  //  (e.g. summer vs winter, workdays vs weekends) line up for comparison.
  //  In-memory only; cleared on reload or via the Clear button.
  // =====================================================================
  const DAYTYPE_LABEL = {
    all: "All",
    "weekend-holiday": "Wknd+Hol",
    workday: "Workday",
  };

  function nowClock() {
    const d = new Date();
    const p2 = (x) => String(x).padStart(2, "0");
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  }

  function recordOptimRun(best, ms) {
    const p = state.params;
    state.optimRuns.push({
      n: state.optimRuns.length + 1,
      when: nowClock(),
      ms,
      from: state.simRange.from,
      to: state.simRange.to,
      dayType: state.dayType,
      actualSource: state.actualSource,
      idSource: state.idSource,
      enabled: { ...state.enabled },
      theta: p.theta_flat,
      winsor: {
        mfrr: [p.w_mfrr_lo, p.w_mfrr_hi],
        imb: [p.w_imb_lo, p.w_imb_hi],
        afrrPos: [p.w_afrr_pos_lo, p.w_afrr_pos_hi],
        afrrNeg: [p.w_afrr_neg_lo, p.w_afrr_neg_hi],
      },
      // Effective values after the optimise. Swept dims hold the optimum;
      // the fixed S3 knobs (cap/lag/skip) hold whatever the user set.
      params: {
        X: p.X,
        Y: p.Y,
        s_up: p.s_up,
        s_dn: p.s_dn,
        Z: p.Z,
        s3_K: p.s3_K,
        s3_S_min: p.s3_S_min,
        s3_sigma_max: p.s3_sigma_max,
        s3_M: p.s3_M,
        s3_X_cap: p.s3_X_cap,
        s3_lag: p.s3_lag,
        s3_da_skip: p.s3_da_skip,
      },
      revenue: best.revenue,
      naive: state.lastNaive,
    });
    saveOptimRuns();
    renderOptimRuns();
  }

  const OPTIM_HEADER = [
    "#", "Time", "Range", "Days", "Strategies",
    "X", "Y", "s_up", "s_dn", "Z",
    "S3 K", "S3 S_min", "S3 σ_max", "S3 M", "S3 cap/lag/skip",
    "θ", "Sources", "Winsor m/i/+/−", "Revenue", "Δ vs naïve",
  ];

  // Per-tab persistence (sessionStorage): survives navigating to Graphs /
  // Forecast and back, clears on tab close. Bump the version suffix if the
  // run-row shape changes so a stale cache can't render wrong.
  const OPTIM_RUNS_KEY = "tck.optimRuns.v1";
  function saveOptimRuns() {
    try {
      sessionStorage.setItem(OPTIM_RUNS_KEY, JSON.stringify(state.optimRuns));
    } catch (_) {
      /* storage disabled or full — non-critical */
    }
  }
  function loadOptimRuns() {
    let raw;
    try {
      raw = sessionStorage.getItem(OPTIM_RUNS_KEY);
    } catch (_) {
      return;
    }
    if (!raw) return;
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) state.optimRuns = arr;
    } catch (_) {
      /* corrupt cache — ignore */
    }
  }

  function renderOptimRuns() {
    const table = document.getElementById("optim-runs-table");
    if (!table) return;
    const runs = state.optimRuns;
    if (!runs.length) {
      table.innerHTML =
        '<tbody><tr><td class="optim-empty">No runs yet — click ⚡ Optimise to capture the setup and optimal parameters here.</td></tr></tbody>';
      return;
    }
    const num = (v, d = 0) => (v == null || isNaN(v) ? "—" : (+v).toFixed(d));
    const dash = '<span class="optim-off">—</span>';
    const win = (pair) => `${pair[0]}–${pair[1]}`;
    const chip = (on, lbl) =>
      `<span class="optim-chip ${on ? "on" : "off"}">${lbl}</span>`;
    const rows = runs
      .map((r) => {
        const en = r.enabled;
        const p = r.params;
        const strategies =
          chip(en.daWithhold, "DA") + chip(en.split, "SP") +
          chip(en.idTrust, "ID") + chip(en.s3, "S3");
        const diff = r.revenue - (r.naive || 0);
        const diffPct = r.naive ? (diff / Math.abs(r.naive)) * 100 : 0;
        const cells = [
          r.n,
          r.when,
          `${isoToEU(r.from)}<br>${isoToEU(r.to)}`,
          DAYTYPE_LABEL[r.dayType] || r.dayType,
          strategies,
          en.daWithhold ? num(p.X) : dash,
          en.daWithhold ? num(p.Y, 2) : dash,
          en.split ? num(p.s_up, 2) : dash,
          en.split ? num(p.s_dn, 2) : dash,
          en.idTrust ? num(p.Z, 2) : dash,
          en.s3 ? num(p.s3_K) : dash,
          en.s3 ? num(p.s3_S_min) : dash,
          en.s3 ? num(p.s3_sigma_max) : dash,
          en.s3 ? num(p.s3_M) : dash,
          en.s3 ? `${num(p.s3_X_cap)}/${num(p.s3_lag)}/${num(p.s3_da_skip)}` : dash,
          num(r.theta),
          `${r.actualSource}/${r.idSource}`,
          `${win(r.winsor.mfrr)} · ${win(r.winsor.imb)} · ${win(r.winsor.afrrPos)} · ${win(r.winsor.afrrNeg)}`,
          `<b>${fmtEUR(r.revenue)}</b>`,
          `<span class="${diff >= 0 ? "optim-up" : "optim-down"}">${diff >= 0 ? "+" : ""}${fmtEUR(diff)}<br>(${diff >= 0 ? "+" : ""}${diffPct.toFixed(1)}%)</span>`,
        ];
        return `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
      })
      .reverse(); // newest first
    table.innerHTML =
      `<thead><tr>${OPTIM_HEADER.map((h) => `<th>${h}</th>`).join("")}</tr></thead>` +
      `<tbody>${rows.join("")}</tbody>`;
  }

  document.getElementById("optimise").addEventListener("click", () => {
    optimise().catch((err) => {
      console.error("optimise failed", err);
      document.getElementById("optimise").disabled = false;
      document.getElementById("reset").disabled = false;
    });
  });

  // Debug hook — silent optimise w/ a chosen seed for variance analysis.
  window.__optimiseSilent = async function (seed) {
    const dims = buildOptimDims();
    const p = state.params;
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
    const N = RANDOM_N;
    const K = REFINE_STARTS;
    const rng = mulberry32(seed | 0);
    const t0 = performance.now();
    const topK = [];
    let lastYield = t0;
    for (let i = 0; i < N; i++) {
      const s = randomSampleByDims(dims, rng);
      const r = evaluateSample(s);
      if (topK.length < K) {
        topK.push({ sample: s, revenue: r });
        topK.sort((a, b) => b.revenue - a.revenue);
      } else if (r > topK[K - 1].revenue) {
        topK[K - 1] = { sample: s, revenue: r };
        topK.sort((a, b) => b.revenue - a.revenue);
      }
      if (performance.now() - lastYield > 200) {
        await yieldToBrowser();
        lastYield = performance.now();
      }
    }
    let best = null;
    for (let k = 0; k < topK.length; k++) {
      const refined = await coordRefine(topK[k].sample, dims);
      if (!best || refined.revenue > best.revenue) best = refined;
    }
    return {
      revenue: best.revenue,
      sample: best.sample,
      ms: Math.round(performance.now() - t0),
    };
  };

  // =====================================================================
  //  DATE-RANGE NAVIGATION (time-series chart)
  // =====================================================================
  function bindDateNav() {
    const fromEl = document.getElementById("date-from");
    const toEl = document.getElementById("date-to");
    function simBounds() {
      return state.simRange;
    }
    function applyRange(fromIso, toIso) {
      const sb = simBounds();
      fromIso = clampDate(fromIso, sb.from, sb.to);
      toIso = clampDate(toIso, sb.from, sb.to);
      if (fromIso > toIso) [fromIso, toIso] = [toIso, fromIso];
      fromEl.value = isoToEU(fromIso);
      toEl.value = isoToEU(toIso);
      state.tsRange = { from: fromIso, to: toIso };
      document.querySelectorAll(".preset").forEach((b) => b.classList.remove("active"));
      update();
    }
    fromEl.addEventListener("change", () =>
      applyRange(parseEU(fromEl.value) || simBounds().from, parseEU(toEl.value) || simBounds().to),
    );
    toEl.addEventListener("change", () =>
      applyRange(parseEU(fromEl.value) || simBounds().from, parseEU(toEl.value) || simBounds().to),
    );
    document.getElementById("prev-range").addEventListener("click", () => {
      const { from, to } = state.tsRange;
      const span =
        (new Date(to + "T00:00:00Z") - new Date(from + "T00:00:00Z")) / 86400000 + 1;
      applyRange(addDays(from, -span), addDays(to, -span));
    });
    document.getElementById("next-range").addEventListener("click", () => {
      const { from, to } = state.tsRange;
      const span =
        (new Date(to + "T00:00:00Z") - new Date(from + "T00:00:00Z")) / 86400000 + 1;
      applyRange(addDays(from, span), addDays(to, span));
    });
    document.querySelectorAll(".preset").forEach((btn) => {
      btn.addEventListener("click", () => {
        const preset = btn.dataset.preset;
        const sb = simBounds();
        const anchor = state.tsRange.to || sb.to;
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
        document.querySelectorAll(".preset").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
      });
    });
  }

  // =====================================================================
  //  RESIZE OBSERVER — keep charts in sync with container size changes
  // =====================================================================
  if (typeof ResizeObserver !== "undefined") {
    const chartResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const div = entry.target;
        if (div._fullLayout) {
          requestAnimationFrame(() => {
            if (div.isConnected && div._fullLayout) Plotly.Plots.resize(div);
          });
        }
      }
    });
    document.querySelectorAll(".chart").forEach((div) => {
      chartResizeObserver.observe(div);
    });
  }

  // =====================================================================
  //  INIT
  // =====================================================================
  renderSetup();
  renderStrategyCards();
  renderStatsTables();
  bindAll();
  bindEnableToggles();
  bindDateNav();
  applyEnableUI();

  const clearOptimBtn = document.getElementById("clear-optim-runs");
  if (clearOptimBtn) {
    clearOptimBtn.addEventListener("click", () => {
      state.optimRuns = [];
      saveOptimRuns();
      renderOptimRuns();
    });
  }
  loadOptimRuns();
  renderOptimRuns();

  update();
})();
