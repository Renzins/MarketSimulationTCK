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
      defaultLo: 5,
      defaultHi: 95,
      description:
        "Same idea on the aFRR downward (AST_NEG) average. Downward prices can be very negative — winsorization is especially relevant here.",
      extremes: [
        ["0 / 100", "no winsorization"],
        ["25 / 75", "aggressive trimming"],
      ],
    },
    X: {
      group: "market",
      section: "da-withhold",
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
      section: "da-withhold",
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
      section: "id-trust",
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
      // Lives in Setup, not Market: it's NOT swept by the optimiser and
      // NOT touched by "Reset to naïve" (cfg.naive only rolls back X/Y/Z).
      // It bounds the analysis (cost model) rather than being a lever
      // the optimiser searches over.
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
    s_up: {
      group: "market",
      section: "split",
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
      section: "split",
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
    // -------- S3 (speculative intraday oversell) params, L3 only --------
    // Set X_cap = 0 to disable S3 entirely while keeping the other settings.
    s3_K: {
      group: "oversell",
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
      group: "oversell",
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
        ["L = 0", "no lag — trader magically sees prices up to the target ISP (unrealistic)"],
        ["L = 4 (default)", "≈ 1 h gap between latest visible settlement and target ISP"],
        ["L = 24", "6 h delay; rolling stats become quite stale"],
      ],
    },
    s3_da_skip: {
      group: "oversell",
      label: "Skip if DA sold ≥",
      unit: "MW",
      min: 0,
      max: 59,
      sliderStep: 1,
      numStep: 1,
      decimals: 0,
      description:
        "S3 is skipped on ISPs where da_sold (after withholding + floor) is at or above this MW threshold. Prevents oversell-on-top-of-near-max-DA situations where the park has little physical headroom to honour an extra X_cap MW. Park capacity is 58.8 MW. Setting this to 0 disables S3 entirely; setting it to 59 effectively turns the gate off. Not optimised — set manually based on physical / risk considerations.",
      extremes: [
        ["skip = 0", "S3 fully disabled (gate always trips)"],
        ["skip = 50 (default)", "S3 only runs when DA position leaves ≥ 9 MW headroom"],
        ["skip = 59", "gate effectively off — S3 runs at any DA level"],
      ],
    },
    s3_S_min: {
      group: "oversell",
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
      group: "oversell",
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
        ["σ_max = 1000", "effectively disabled — trade through any volatility"],
      ],
    },
    s3_X_cap: {
      group: "oversell",
      label: "Volume cap X_cap",
      unit: "MW",
      min: 0,
      max: 58,
      sliderStep: 1,
      numStep: 1,
      decimals: 0,
      description:
        "Hard upper limit on the extra MW oversold in a single ISP. Strong signal → up to X_cap; weak signal → proportionally less (whole-MW floored). Setting X_cap = 0 disables the strategy entirely. Park capacity is 58.8 MW. NOT optimised — the backtest has no price-impact term, so a sweep would always pick the grid maximum; the user must set this manually based on real intra-day liquidity. Default 5 MW.",
      extremes: [
        ["X_cap = 0", "S3 disabled — L3 reverts to L2 behaviour"],
        ["X_cap = 5 (default)", "modest position, safe in shallow markets"],
        ["X_cap = 30+", "aggressive — significant price-impact risk in Baltic"],
      ],
    },
    s3_M: {
      group: "oversell",
      label: "Hedge bid margin M",
      unit: "EUR/MWh",
      min: -50,
      max: 100,
      sliderStep: 1,
      numStep: 1,
      decimals: 0,
      description:
        "Sets the hedge mFRR-dn bid_price = VWAP1H + M. This is a stop-loss mFRR-dn offer the wind park wouldn't normally place — pitched above the typical clearing — so when it clears it costs us, but it bounds the loss on the oversold MW vs imbalance settlement. Clears whenever p_mfrr ≤ bid_price. p_mfrr < 0 → grid pays us (windfall); 0 < p_mfrr ≤ bid_price → we pay up to bid_price per MWh. Higher M → looser stop, clears almost always but accepts higher curtailment costs; lower (or negative) M → tighter stop, clears only when curtailment is cheap/free or we get paid.",
      extremes: [
        ["M = −50", "tight stop — only accept curtailment when paid ≥ 50 below VWAP1H"],
        ["M = 0", "bid right at VWAP1H — fires when curtailment is breakeven or better"],
        ["M = 5 (default)", "small cushion above VWAP1H"],
        ["M = 100", "very loose stop — fires almost always; max acceptable cost VWAP1H+100"],
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
        w_mfrr_lo: 5,
        w_mfrr_hi: 95,
        w_imb_lo: 5,
        w_imb_hi: 95,
        w_afrr_pos_lo: 5,
        w_afrr_pos_hi: 95,
        w_afrr_neg_lo: 5,
        w_afrr_neg_hi: 95,
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
        w_mfrr_lo: 5,
        w_mfrr_hi: 95,
        w_imb_lo: 5,
        w_imb_hi: 95,
        w_afrr_pos_lo: 5,
        w_afrr_pos_hi: 95,
        w_afrr_neg_lo: 5,
        w_afrr_neg_hi: 95,
      },
      imbalanceDisabled: false,
      hasImbalance: true,
    },
    // Level 3 = L2 + S3 (speculative intraday oversell). The S3 strategy
    // lives in a third param group ("oversell"). Set s3_X_cap = 0 to
    // disable S3 entirely (L3 then equals L2 mathematically).
    3: {
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
        "s3_K",
        "s3_lag",
        "s3_da_skip",
        "s3_S_min",
        "s3_sigma_max",
        "s3_X_cap",
        "s3_M",
      ],
      naive: { X: 0, Y: 0, Z: 0 },
      defaults: {
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
      imbalanceDisabled: false,
      hasImbalance: true,
    },
  };

  // Market-parameter sub-sections. Each strategy gets its own visually
  // separated .param-group, ordered per level. Setup is rendered ONCE
  // above the tabs (shared across levels); oversell is L3-only and lives
  // in its own group, separate from these.
  const SECTION_LABELS = {
    "da-withhold": "DA withhold on low prices",
    split: "mFRR ↔ aFRR universal offer split",
    "id-trust": "ID trust coefficient",
  };
  const SECTION_DESCRIPTIONS = {
    "da-withhold":
      "When DA clears at or below price threshold X, hold back fraction Y of the forecast from DA and offer it to balancing instead. Above X, sell the full forecast to DA as usual.",
    split:
      "Per-direction routing of balancing volume between mFRR and aFRR. Independent ratios for upward (s_up) and downward (s_dn) because the two markets price each direction differently.",
    "id-trust":
      "How much of the intraday forecast revision (ID − DA) to act on as additional mFRR-up volume. Negative revisions are not acted on (no buy-back modelled).",
  };
  // Display order of the per-strategy sub-sections per level.
  const SECTION_ORDER = {
    1: ["da-withhold", "split"],
    2: ["da-withhold", "split", "id-trust"],
    3: ["da-withhold", "split", "id-trust"],
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
    // L3 = L2 + S3 (intraday oversell + hedge mFRR-dn bid). The s3_extra_cost
    // bundles the extra imbalance + flat penalty incurred specifically by
    // the S3-induced shortfall (when the hedge bid doesn't clear).
    3: [
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
    // L3 — same as L2 plus two S3-specific counts.
    3: [
      { key: "up", label: "ISPs with mFRR-up", type: "int" },
      { key: "dn", label: "ISPs with mFRR-dn", type: "int" },
      { key: "upAfrr", label: "ISPs with aFRR-up", type: "int", help: "ISPs where avg_p_pos > 0 AND we routed volume to aFRR (s < 1) — wind park bid into upward and earned." },
      { key: "dnAfrr", label: "ISPs with aFRR-dn", type: "int", help: "ISPs where avg_p_neg < 0 AND we routed volume to aFRR — system paid the park to curtail." },
      { key: "wasted", label: "Withheld w/o activation", type: "int", help: "Below X, withheld but neither market activated profitably — energy earns nothing." },
      { key: "short", label: "ISPs with shortfall", type: "int" },
      { key: "shortMWh", label: "Total shortfall (MWh)", type: "mwh" },
      { key: "shortAvg", label: "Avg cost / short ISP", type: "eur" },
      { key: "s3Oversold", label: "ISPs with S3 oversell", type: "int", help: "ISPs where the S3 strategy passed all three gates (spread, sigma, ≥1 MW) and the wind park oversold on intraday." },
      { key: "s3HedgeFired", label: "S3 hedge fired", type: "int", help: "Of the S3-oversell ISPs, how many had p_mfrr ≤ VWAP1H + M so the hedge mFRR-dn bid cleared and the wind park was curtailed." },
    ],
  };

  // =====================================================================
  //  BOOTSTRAP
  // =====================================================================
  const D = Engine.init(WIND_DATA);
  console.log(`Loaded ${D.n} ISPs`);
  Engine.maybeWinsorize(5, 95, 5, 95);

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
  // activeLevel tracks which panel is currently visible. The shared setup
  // controls call scheduleUpdate(activeLevel) on change — other levels'
  // state stays in sync (they pick up changes when next activated).
  let activeLevel = 1;

  const state = {};
  for (const lvl of [1, 2, 3]) {
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
  // L1's defaults omit theta_flat (L1 has no imbalance). Now that the
  // shared setup writes theta_flat to all three levels, seed L1's params
  // with the same default so the in-sync invariant holds from the start.
  // L1's engine path ignores theta_flat (no flat penalty without imbalance).
  if (state[1].params.theta_flat == null) {
    state[1].params.theta_flat = LEVEL_CONFIG[2].defaults.theta_flat;
  }

  // =====================================================================
  //  GENERATE PARAMETER CARDS
  //  Each level fills its own #l{N}-params container from PARAM_DEFS.
  // =====================================================================
  // Render one parameter card.
  //   idPrefix: ID prefix for the inputs ("setup" for shared setup, "l1"/"l2"/"l3" for per-level).
  //   sourceLevel: which level's defaults / simRange to seed from. For shared setup,
  //                we pass 2 because L2's defaults include every setup key (incl. theta_flat
  //                which L1 doesn't have).
  //   isShared: when true (shared-setup render), the imbalanceDisabled flag on L1 is ignored —
  //             the shared w_imb input is always active because it applies to L2/L3 too.
  function paramCardHTML(idPrefix, sourceLevel, key, isShared = false) {
    const def = PARAM_DEFS[key];
    const cfg = LEVEL_CONFIG[sourceLevel];
    const idBase = `${idPrefix}-${key}`;

    // ---- date-range card ----
    if (def.isDateRange) {
      const from = state[sourceLevel].simRange.from;
      const to = state[sourceLevel].simRange.to;
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
      // Shared setup never disables — the input applies to L2/L3 even if L1
      // ignores it. The legacy per-level disabled-on-L1 path is kept for
      // safety but isn't reachable after the shared-setup refactor.
      const disabled =
        !isShared && key === "w_imb" && cfg.imbalanceDisabled ? "disabled" : "";
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
            <p>${def.description}</p>
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

  // Render the shared Setup section ONCE (above the tabs). Pulls the setup
  // keys from any level that has them all — we use L2 because its paramKeys
  // include theta_flat (L1 omits it). The shared setup writes to all three
  // state[].params objects on change, keeping them in sync.
  function renderSharedSetup() {
    const setupKeys = LEVEL_CONFIG[2].paramKeys.filter(
      (k) => PARAM_DEFS[k].group === "setup",
    );
    document.getElementById("setup-params").innerHTML = setupKeys
      .map((k) => paramCardHTML("setup", 2, k, true))
      .join("");
  }

  // Render per-level market + oversell controls. Setup is no longer rendered
  // per level — it lives once in the shared setup box. Market params are
  // split across sub-sections (one .controls-grid per sub-section), keyed by
  // PARAM_DEFS[key].section and ordered via SECTION_ORDER[level].
  function renderParamCards(level) {
    const cfg = LEVEL_CONFIG[level];
    const marketKeys = cfg.paramKeys.filter((k) => PARAM_DEFS[k].group === "market");
    const oversellKeys = cfg.paramKeys.filter(
      (k) => PARAM_DEFS[k].group === "oversell",
    );
    // Each market sub-section has its own container: #l{level}-{section}-params.
    for (const section of SECTION_ORDER[level]) {
      const container = document.getElementById(`l${level}-${section}-params`);
      if (!container) continue;
      const keys = marketKeys.filter((k) => PARAM_DEFS[k].section === section);
      container.innerHTML = keys.map((k) => paramCardHTML(`l${level}`, level, k)).join("");
    }
    // Oversell section is L3-only; the container element may not exist on
    // L1 / L2 (only L3's HTML scaffolding renders it).
    const overEl = document.getElementById(`l${level}-oversell-params`);
    if (overEl) {
      overEl.innerHTML = oversellKeys
        .map((k) => paramCardHTML(`l${level}`, level, k))
        .join("");
    }
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
  // winsor input. Called after Engine.maybeWinsorize. Caps live in the
  // shared setup (one set of inputs for all three levels), so the IDs use
  // the "setup-" prefix and are level-independent.
  function updateWinsorCaps(bounds) {
    const map = [
      ["w_mfrr", bounds && bounds.mfrrBounds],
      ["w_imb", bounds && bounds.imbBounds],
      ["w_afrr_pos", bounds && bounds.afrrPosBounds],
      ["w_afrr_neg", bounds && bounds.afrrNegBounds],
    ];
    for (const [key, b] of map) {
      const loEl = document.getElementById(`setup-${key}-cap-lo`);
      const hiEl = document.getElementById(`setup-${key}-cap-hi`);
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
    updateWinsorCaps(bounds);

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
      else if (col.key === "s3Oversold") v = fmtInt(sim.counts.s3Oversold || 0);
      else if (col.key === "s3HedgeFired")
        v = fmtInt(sim.counts.s3HedgeFired || 0);
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

  // Bind the shared Setup controls. Each change writes to ALL THREE level
  // state objects (so they stay in sync) and re-runs the currently active
  // level. The other levels pick up the new state next time the user
  // switches to them.
  function bindSharedSetup() {
    const setupKeys = LEVEL_CONFIG[2].paramKeys.filter(
      (k) => PARAM_DEFS[k].group === "setup",
    );
    for (const key of setupKeys) {
      const def = PARAM_DEFS[key];
      const idBase = `setup-${key}`;

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
          for (const lvl of [1, 2, 3]) {
            state[lvl].simRange = { from: fIso, to: tIso };
            // Invalidate chart range so updateLevel re-anchors to the new window.
            state[lvl].tsRange = { from: null, to: null };
          }
          scheduleUpdate(activeLevel);
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
        const onChange = () => {
          const loV = clamp(parseFloat(lo.value) || 0, 0, 50);
          const hiV = clamp(parseFloat(hi.value) || 100, 50, 100);
          for (const lvl of [1, 2, 3]) {
            state[lvl].params[`${key}_lo`] = loV;
            state[lvl].params[`${key}_hi`] = hiV;
          }
          lo.value = loV;
          hi.value = hiV;
          scheduleUpdate(activeLevel);
        };
        lo.addEventListener("change", onChange);
        hi.addEventListener("change", onChange);
        continue;
      }

      // numeric (slider+number) — e.g. theta_flat
      const slider = document.getElementById(idBase);
      const num = document.getElementById(`${idBase}-num`);
      const onSet = (raw) => {
        let v = parseFloat(raw);
        if (isNaN(v)) return;
        v = clamp(v, def.min, def.max);
        slider.value = v;
        num.value = v;
        for (const lvl of [1, 2, 3]) {
          state[lvl].params[key] = v;
        }
        scheduleUpdate(activeLevel);
      };
      slider.addEventListener("input", (e) => onSet(e.target.value));
      num.addEventListener("change", (e) => onSet(e.target.value));
    }
  }

  // Bind per-level market + oversell controls. Setup keys are skipped — they
  // live in the shared setup section and are wired by bindSharedSetup.
  function bindParamCards(level) {
    const cfg = LEVEL_CONFIG[level];
    for (const key of cfg.paramKeys) {
      const def = PARAM_DEFS[key];
      if (def.group === "setup") continue;
      const idBase = `l${level}-${key}`;

      // numeric (slider+number) — all market and oversell params are numeric.
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

  // =====================================================================
  //  OPTIMISER — random search + MULTI-START coord-descent refine.
  //  Single algorithm for all three levels. Seeded RNG (Mulberry32) so
  //  clicking Optimise twice produces identical results.
  //
  //  Pipeline:
  //    1. Random search: N uniform samples over the optimised parameter
  //       space. Track the top-K samples by revenue (a small sorted array).
  //    2. Multi-start refine: run coord-descent from EACH of the top-K
  //       samples. Return the best of the refined samples.
  //
  //  Why multi-start? A variance test (3 seeds × 3 levels) showed near-zero
  //  revenue spread (< 0.07 % on L1/L2, 0 % on L3) with single-start. The
  //  landscape on the current dataset has one dominant basin and refine
  //  converges reliably. Multi-start is **belt-and-suspenders against
  //  future data changes** introducing additional basins: if a second
  //  basin appears with a competitive local optimum, top-K will include
  //  samples from both, refining catches both, and we return the better
  //  one. Cost is cheap relative to the random search itself.
  //
  //  Per-level config (measured per-sim cost: L1 0.65 ms, L2 1.26 ms,
  //  L3 2.10 ms — L3 is dearer because S3's rolling stats run per-ISP):
  //
  //  | Level | N    | K | Random | Refine (K×~) | Wall  |
  //  |-------|------|---|--------|--------------|-------|
  //  | L1    | 2000 | 3 | 1.3 s  | 3 × 0.4 s    | 2.5 s |
  //  | L2    | 4000 | 3 | 5 s    | 3 × 0.7 s    | 7 s   |
  //  | L3    | 4000 | 5 | 8.4 s  | 5 × 3 s      | 23 s  |
  //
  //  The math P(random sample ∈ top X %) = 1 − (1 − X/100)^N is
  //  dim-independent: N = 2000 random samples on a 4-D space already gives
  //  ≥ 99 % confidence of hitting the top 0.25 %; refine then polishes
  //  whatever the random search found.
  //
  //  X_cap, s3_lag and s3_da_skip are held at user values:
  //   - X_cap: model has no price-impact term; any sweep picks the grid
  //     boundary. User must set this manually based on real liquidity.
  //   - lag, da_skip: physical / risk constraints, not strategy levers.
  // =====================================================================
  const RANDOM_N = { 1: 2000, 2: 4000, 3: 4000 };
  const REFINE_STARTS = { 1: 3, 2: 3, 3: 5 };
  // Fraction of the progress bar reserved for the random search phase.
  // The remainder is split evenly across the K refine starts. Calibrated
  // per level so the bar advances at roughly even wall-time speed (on L3
  // the refines take longer than the random phase, so random gets less of
  // the bar).
  const RAND_PROGRESS = { 1: 0.5, 2: 0.7, 3: 0.35 };

  // Cooperative yield primitive. setTimeout(0) gets clamped to 4 ms after
  // nesting (HTML spec) AND is heavily throttled in some headless / hidden
  // browser contexts (we've measured > 300 ms / yield in the preview's
  // server). MessageChannel bypasses both, posting onto the macrotask
  // queue with minimal overhead. We share one channel across the whole
  // optimiser run; the single in-flight resolver is safe because we only
  // ever have one pending yield at a time (the optimiser is sequential).
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

  // Tiny seeded PRNG (Mulberry32). Same seed across runs ⇒ reproducible
  // optimise output.
  function mulberry32(seed) {
    let s = seed | 0;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Uniform sample of the optimised params for `level`. Values are
  // pre-snapped to each slider's step so setSliderValue won't introduce
  // a state/DOM mismatch on apply.
  function randomSample(level, rng) {
    const sample = {
      X: -100 + Math.floor(rng() * 401),
      Y: Math.round(rng() * 100) / 100,
      s_up: Math.round(rng() * 100) / 100,
      s_dn: Math.round(rng() * 100) / 100,
      Z: level >= 2 ? Math.round(rng() * 100) / 100 : 0,
    };
    if (level === 3) {
      sample.s3_K = 2 + Math.floor(rng() * 47);
      sample.s3_S_min = Math.floor(rng() * 201);
      sample.s3_sigma_max = Math.floor(rng() * 201) * 5;
      sample.s3_M = -50 + Math.floor(rng() * 151);
    }
    return sample;
  }

  // Wrap simulateTotal: lift the sample's optimised dims + the user's
  // held-fixed dims (theta_flat, X_cap, lag, da_skip) into engine args.
  function evaluateSample(level, sample, userParams) {
    const s3 =
      level === 3
        ? {
            K: sample.s3_K,
            S_min: sample.s3_S_min,
            sigma_max: sample.s3_sigma_max,
            X_cap: userParams.s3_X_cap,
            M: sample.s3_M,
            lag: userParams.s3_lag,
            da_skip: userParams.s3_da_skip,
          }
        : null;
    return Engine.simulateTotal(
      level,
      sample.X,
      sample.Y,
      sample.Z,
      userParams.theta_flat || 0,
      sample.s_up,
      sample.s_dn,
      s3,
    );
  }

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

  // Per-axis refine grids — moderate step over full range. Coordinate
  // descent sweeps each axis once per pass; if a pass found no improvement
  // we stop early. maxPasses=3 caps the cost.
  function refineDims(level) {
    const dims = [
      { key: "X", values: rangeArr(-100, 300, 5) },
      { key: "Y", values: range01(0.02) },
      { key: "s_up", values: range01(0.02) },
      { key: "s_dn", values: range01(0.02) },
    ];
    if (level >= 2) dims.push({ key: "Z", values: range01(0.02) });
    if (level === 3) {
      dims.push({ key: "s3_K", values: rangeArr(2, 48, 1) });
      dims.push({ key: "s3_S_min", values: rangeArr(0, 200, 5) });
      dims.push({ key: "s3_sigma_max", values: rangeArr(0, 1000, 25) });
      dims.push({ key: "s3_M", values: rangeArr(-50, 100, 5) });
    }
    return dims;
  }

  // Coordinate-descent refine starting from `startSample`. Sweeps each
  // axis over its refine grid holding others at current best, updates the
  // best, repeats until a full pass found no improvement or maxPasses is
  // hit. async + internal yields keep the UI responsive — on L3 a single
  // refine run costs ~3 s, and we run K of them, so without yields the
  // browser would freeze for 15 s.
  async function coordRefine(level, startSample, userParams, maxPasses = 3) {
    let cur = { ...startSample };
    let curRev = evaluateSample(level, cur, userParams);
    const dims = refineDims(level);
    let lastYield = performance.now();
    for (let pass = 0; pass < maxPasses; pass++) {
      let improved = false;
      for (const dim of dims) {
        let bestVal = cur[dim.key];
        let bestR = curRev;
        for (const v of dim.values) {
          if (v === cur[dim.key]) continue;
          const probe = { ...cur, [dim.key]: v };
          const r = evaluateSample(level, probe, userParams);
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

  // Render the progress bar inside the level's #l{level}-progress div.
  // On first call we inject the bar HTML; subsequent calls just update
  // width + text. The bar persists at 100 % with the result text after
  // optimise completes.
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

  // Apply optimised sample to sliders. Always writes X/Y/s_up/s_dn, plus
  // Z (L2/L3) and S3 dims (L3). X_cap, lag, DA-skip are intentionally not
  // touched — they're held-fixed inputs, not optimisation targets.
  function applyOptimisedSample(level, sample) {
    setSliderValue(level, "X", sample.X);
    setSliderValue(level, "Y", sample.Y);
    setSliderValue(level, "s_up", sample.s_up);
    setSliderValue(level, "s_dn", sample.s_dn);
    if (level >= 2) setSliderValue(level, "Z", sample.Z);
    if (level === 3) {
      setSliderValue(level, "s3_K", sample.s3_K);
      setSliderValue(level, "s3_S_min", sample.s3_S_min);
      setSliderValue(level, "s3_sigma_max", sample.s3_sigma_max);
      setSliderValue(level, "s3_M", sample.s3_M);
    }
  }

  // Main optimiser entry point. Runs random search then coord-descent
  // refine, with a progress bar that fills as the sweep advances.
  async function optimiseLevel(level) {
    const optimiseBtn = document.getElementById(`l${level}-optimise`);
    const resetBtn = document.getElementById(`l${level}-reset`);
    const progEl = document.getElementById(`l${level}-progress`);
    optimiseBtn.disabled = true;
    resetBtn.disabled = true;

    const p = state[level].params;
    // maybeWinsorize re-runs only if percentiles changed since the last
    // call; cheap when nothing's moved. updateLevel calls it too, but the
    // optimiser bypasses updateLevel for its inner loop so we re-prime
    // the winsorised arrays here.
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

    const N = RANDOM_N[level];
    const K = REFINE_STARTS[level];
    const RAND_FRACTION = RAND_PROGRESS[level];
    // Time-budget chunking: yield ~5 times / second so the bar paints
    // smoothly without spending the run inside throttled timer callbacks.
    const YIELD_INTERVAL_MS = 200;
    const t0 = performance.now();
    const rng = mulberry32(0xc0ffee);

    renderProgressBar(progEl, 0, "optimising 0%");
    await yieldToBrowser();

    // Random search: maintain a sorted top-K array (descending by revenue).
    // K is small (3–5), insertion sort is trivially fast. We avoid a heap
    // because the marginal complexity wins nothing at this scale.
    const topK = [];
    let lastYield = performance.now();
    for (let i = 0; i < N; i++) {
      const s = randomSample(level, rng);
      const r = evaluateSample(level, s, p);
      if (topK.length < K) {
        topK.push({ sample: s, revenue: r });
        topK.sort((a, b) => b.revenue - a.revenue);
      } else if (r > topK[K - 1].revenue) {
        topK[K - 1] = { sample: s, revenue: r };
        topK.sort((a, b) => b.revenue - a.revenue);
      }
      if (performance.now() - lastYield > YIELD_INTERVAL_MS) {
        const f = ((i + 1) / N) * RAND_FRACTION;
        renderProgressBar(progEl, f, `optimising ${Math.round(f * 100)}%`);
        await yieldToBrowser();
        lastYield = performance.now();
      }
    }

    // Multi-start refine: run coord-descent from each of the top-K
    // samples, keep the best refined result. The progress bar advances
    // one step per refine completed (1/K, 2/K, …).
    renderProgressBar(progEl, RAND_FRACTION, `refining 1/${K}…`);
    await yieldToBrowser();
    let best = null;
    for (let k = 0; k < topK.length; k++) {
      const refined = await coordRefine(level, topK[k].sample, p);
      if (!best || refined.revenue > best.revenue) best = refined;
      const f = RAND_FRACTION + ((k + 1) / K) * (1 - RAND_FRACTION);
      const label =
        k + 1 < topK.length
          ? `refining ${k + 2}/${K}…`
          : "finalising…";
      renderProgressBar(progEl, f, label);
      await yieldToBrowser();
    }
    const ms = Math.round(performance.now() - t0);

    applyOptimisedSample(level, best.sample);
    state[level].lastSweep = {
      best: { ...best.sample, revenue: best.revenue },
    };
    updateLevel(level);

    renderProgressBar(
      progEl,
      1,
      `done in ${(ms / 1000).toFixed(1)}s — ${fmtEUR(best.revenue)}`,
    );
    optimiseBtn.disabled = false;
    resetBtn.disabled = false;
  }

  function bindOptimise(level) {
    const btn = document.getElementById(`l${level}-optimise`);
    btn.addEventListener("click", () => {
      optimiseLevel(level).catch((err) => {
        console.error("optimise failed", err);
        btn.disabled = false;
        document.getElementById(`l${level}-reset`).disabled = false;
      });
    });
  }

  // Debug hook: run the optimiser with a chosen seed WITHOUT touching the
  // UI (no progress bar, no slider updates, no updateLevel). Mirrors the
  // multi-start logic in optimiseLevel exactly — used for variance
  // analysis across different seeds. Returns {revenue, sample, ms}.
  window.__optimiseSilent = async function (level, seed) {
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
    const N = RANDOM_N[level];
    const K = REFINE_STARTS[level];
    const rng = mulberry32(seed | 0);
    const t0 = performance.now();
    const topK = [];
    let lastYield = t0;
    for (let i = 0; i < N; i++) {
      const s = randomSample(level, rng);
      const r = evaluateSample(level, s, p);
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
      const refined = await coordRefine(level, topK[k].sample, p);
      if (!best || refined.revenue > best.revenue) best = refined;
    }
    return {
      revenue: best.revenue,
      sample: best.sample,
      ms: Math.round(performance.now() - t0),
    };
  };

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
  //  TABS
  // =====================================================================
  // Resize fix: Level 2 charts are pre-rendered ~200 ms after page load
  // (see updateLevel(2) call at the bottom) into a panel that's still
  // display:none — Plotly canvases get drawn at 0×0 and `responsive:true`
  // only fires on window resize, so users had to zoom in/out for the
  // chart to fill its space. Forcing Plotly.Plots.resize on every chart
  // in the newly-active panel re-measures against the now-visible
  // container. Idempotent and safe on un-rendered charts (guarded via
  // `_fullLayout`). Same pattern as graphs-app.js's aFRR-bar fix.
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const level = parseInt(btn.dataset.level);
      activeLevel = level;
      const panel = document.getElementById(`panel-${level}`);
      panel.classList.add("active");
      // rAF: wait for the browser's layout pass on the now-visible panel so
      // Plotly measures the final container size, not the display:none one.
      requestAnimationFrame(() => {
        panel.querySelectorAll(".chart").forEach((div) => {
          if (div._fullLayout) Plotly.Plots.resize(div);
        });
      });
      setTimeout(() => updateLevel(level), 30);
    });
  });

  // Global ResizeObserver — keeps every chart in sync with its container
  // across any size change (initial reveal, window resize, font load).
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
  // Shared setup renders + binds ONCE, before any level-specific work — so
  // updateLevel() can read shared inputs and updateWinsorCaps() can write
  // to shared IDs without a "container not found" race.
  renderSharedSetup();
  bindSharedSetup();
  for (const lvl of [1, 2, 3]) {
    renderParamCards(lvl);
    renderStatsTables(lvl);
    bindParamCards(lvl);
    bindReset(lvl);
    bindOptimise(lvl);
    bindDateNav(lvl);
  }

  updateLevel(1);
  setTimeout(() => updateLevel(2), 200);
  setTimeout(() => updateLevel(3), 400);
})();
