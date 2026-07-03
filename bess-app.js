// bess-app.js — UI controller for the BESS backtester page (bess.html).
//
// Mirrors the wind-park app.js structure (config-driven param cards, hot-path
// update(), seeded random + multi-start optimiser, per-tab optimised-runs log)
// but drives the stateful BessEngine instead of the wind-park Engine. engine.js
// is loaded only for its shared utilities (Engine.init / setWindow /
// maybeWinsorize / getData / tsAt); BessEngine does the SoC simulation.

(() => {
  // =====================================================================
  //  PARAM METADATA
  // =====================================================================
  const PARAM_DEFS = {
    sim_range: {
      group: "setup",
      isDateRange: true,
      label: "Simulation date range",
      description:
        "Restricts the simulation to ISPs in this window. SoC starts at the Initial SoC on the first ISP of the window and evolves continuously from there; winsorisation percentiles are computed within the window.",
      extremes: [
        ["Full dataset", "all 14 months"],
        ["Sub-period", "stress-test a season or a single month"],
      ],
    },
    dayType: {
      group: "setup",
      isDayType: true,
      label: "Day type filter",
      description:
        "Restricts totals / decomposition / robustness to ISPs of the chosen day type. SoC still evolves over the FULL continuous window (a weekend charge still affects Monday); only the sums are gated — so total(all) == workday + weekend/holiday exactly. Public holidays: LV / EE / LT via date-holidays.",
    },
    cap_mwh: {
      group: "setup", label: "Battery capacity", unit: "MWh", min: 1, max: 500, sliderStep: 1, numStep: 1, decimals: 0,
      description: "Usable energy store. State of charge is bounded to [0, capacity].",
      extremes: [["40 (default)", "2-hour battery at 20 MW"], ["large", "more energy to arbitrage / more cycles per day"]],
    },
    power_mw: {
      group: "setup", label: "Max power", unit: "MW", min: 1, max: 200, sliderStep: 1, numStep: 1, decimals: 0,
      description: "Inverter limit. Grid-side throughput per ISP is capped at power × 0.25 h.",
      extremes: [["20 (default)", "C/2 — full charge/discharge in 2 h"], ["high", "faster cycling, more balancing capacity"]],
    },
    eff_pct: {
      group: "setup", label: "Round-trip efficiency", unit: "%", min: 50, max: 100, sliderStep: 1, numStep: 1, decimals: 0,
      description: "Energy kept charge→discharge. Applied as √η on each leg (grid-side). Folded into the cost basis, so Min delta gates true round-trip profit.",
      extremes: [["90 (default)", "typical grid Li-ion"], ["100", "ideal, lossless"]],
    },
    init_soc_pct: {
      group: "setup", label: "Initial SoC", unit: "%", min: 0, max: 100, sliderStep: 1, numStep: 1, decimals: 0,
      description: "State of charge at the first ISP of the window. The initial energy is treated as zero-cost (negligible over a 14-month run).",
      extremes: [["50 (default)", "half full"], ["0 / 100", "empty / full start"]],
    },
    dwell_isps: {
      group: "setup", label: "Min time between direction change", unit: "ISPs (×15 min)", min: 0, max: 96, sliderStep: 1, numStep: 1, decimals: 0,
      description: "A cooldown/rest: after the last charge or discharge, the battery must idle at least this many ISPs before it may switch to the OPPOSITE direction (continuing the same direction is unconstrained). Measured from the end of a block, so it forces a genuine break between a discharge phase and the next charge phase. Day-ahead-committed sells/buys override it.",
      extremes: [["4 (default)", "1 hour"], ["0", "flip freely"], ["96", "at most one flip per day"]],
    },
    upper_red_pct: {
      group: "setup", label: "Upper red zone", unit: "%", min: 50, max: 100, sliderStep: 1, numStep: 1, decimals: 0,
      description: "Above this SoC the battery stops placing new CHARGE bids. The headroom above it is a buffer kept free for committed charge activations.",
      extremes: [["80 (default)", "keep 20% headroom"], ["100", "charge to the brim"]],
    },
    lower_red_pct: {
      group: "setup", label: "Lower red zone", unit: "%", min: 0, max: 50, sliderStep: 1, numStep: 1, decimals: 0,
      description: "Below this SoC the battery stops placing new discretionary DISCHARGE bids. The energy below it is a buffer kept for committed discharge activations (and DA commitments, which may use it and risk imbalance).",
      extremes: [["20 (default)", "keep 20% reserve"], ["0", "discharge to empty"]],
    },
    min_delta: {
      group: "setup", label: "Min delta", unit: "EUR/MWh", min: 0, max: 500, sliderStep: 5, numStep: 5, decimals: 0,
      description: "Minimum round-trip margin per delivered MWh. A discretionary discharge fires only when its price ≥ (cost basis ÷ efficiency) + Min delta. Guards against churning the battery for thin spreads.",
      extremes: [["100 (default)", "demand a 100 €/MWh round-trip margin"], ["0", "discharge on any non-loss"]],
    },
    w_mfrr: {
      group: "setup", label: "Winsorize mFRR price (percentiles)", unit: "%", isWinsor: true, defaultLo: 5, defaultHi: 95,
      description: "Caps extreme mFRR clearing prices within the window (the data has ±10 000 €/MWh outliers).",
      extremes: [["0 / 100", "raw outliers retained"], ["25 / 75", "aggressive trimming"]],
    },
    w_imb: {
      group: "setup", label: "Winsorize imbalance price (percentiles)", unit: "%", isWinsor: true, defaultLo: 5, defaultHi: 95,
      description: "Caps the Latvian imbalance price (settlement for unmet DA) within the window.",
      extremes: [["0 / 100", "no winsorization"], ["25 / 75", "aggressive trimming"]],
    },
    w_afrr_pos: {
      group: "setup", label: "Winsorize aFRR upward (avg) price", unit: "%", isWinsor: true, defaultLo: 5, defaultHi: 95,
      description: "Caps the per-ISP averaged aFRR upward price (discharge income).",
      extremes: [["0 / 100", "spike-ISPs retained"], ["25 / 75", "middle 50% only"]],
    },
    w_afrr_neg: {
      group: "setup", label: "Winsorize aFRR downward (avg) price", unit: "%", isWinsor: true, defaultLo: 5, defaultHi: 95,
      description: "Caps the aFRR downward average (charge cashflow — can be deeply negative, i.e. paid to absorb).",
      extremes: [["0 / 100", "no winsorization"], ["25 / 75", "aggressive trimming"]],
    },
    theta_flat: {
      group: "setup", label: "Flat penalty θ", unit: "EUR/MWh shortfall", min: 0, max: 100, sliderStep: 1, numStep: 1, decimals: 0,
      description: "Extra €/MWh charge on every UNMET day-ahead MWh, on top of the imbalance price. Captures BSP penalties / risk aversion. (Balancing activations are never left unmet, so this only ever touches DA shortfalls.)",
      extremes: [["30 (default)", "moderate"], ["0", "imbalance price only"]],
    },
    // -------- adaptive split --------
    s_up_start: { group: "split", label: "UP split — start x₁", unit: "0–1", min: 0, max: 1, sliderStep: 0.01, numStep: 0.05, decimals: 2,
      description: "Starting fraction of UPWARD (discharge) balancing MW routed to mFRR (rest to aFRR). Adapts every y₁ ISPs toward the better-paying market.",
      extremes: [["1", "start all discharge to mFRR"], ["0", "start all to aFRR"]] },
    s_up_win: { group: "split", label: "UP lookback window y₁", unit: "ISPs", min: 4, max: 672, sliderStep: 4, numStep: 4, decimals: 0,
      description: "How far back the upward split looks when comparing markets (trailing y₁-ISP average). Lookback only — cadence is 'wait' below. 96 = one day.",
      extremes: [["4", "1 h of history"], ["96", "one day"], ["672", "one week"]] },
    s_up_wait: { group: "split", label: "UP rebalance wait w₁", unit: "ISPs", min: 1, max: 672, sliderStep: 1, numStep: 1, decimals: 0,
      description: "How often the upward split is recomputed (cadence). 1 = every ISP off the trailing y₁-window. Decoupled from lookback; w₁ = y₁ reproduces the old block behaviour.",
      extremes: [["1", "every ISP (default)"], ["96", "once a day"], ["= y₁", "old behaviour"]] },
    s_up_step: { group: "split", label: "UP step z₁", unit: "0–0.5", min: 0, max: 0.5, sliderStep: 0.01, numStep: 0.02, decimals: 2,
      description: "Shift toward the winning market per rebalance. 0 = static at x₁.",
      extremes: [["0", "static"], ["0.1", "10% per rebalance"]] },
    s_dn_start: { group: "split", label: "DOWN split — start x₂", unit: "0–1", min: 0, max: 1, sliderStep: 0.01, numStep: 0.05, decimals: 2,
      description: "Starting fraction of DOWNWARD (charge) balancing MW routed to mFRR-dn (rest to aFRR-dn). Independent of up.",
      extremes: [["1", "start all charge to mFRR-dn"], ["0", "start all to aFRR-dn"]] },
    s_dn_win: { group: "split", label: "DOWN lookback window y₂", unit: "ISPs", min: 4, max: 672, sliderStep: 4, numStep: 4, decimals: 0,
      description: "How far back the downward split looks (trailing y₂-ISP average). Lookback only; cadence is 'wait' below. 96 = one day.",
      extremes: [["4", "1 h of history"], ["96", "one day"], ["672", "one week"]] },
    s_dn_wait: { group: "split", label: "DOWN rebalance wait w₂", unit: "ISPs", min: 1, max: 672, sliderStep: 1, numStep: 1, decimals: 0,
      description: "How often the downward split is recomputed (cadence). 1 = every ISP. Decoupled from lookback; w₂ = y₂ reproduces the old block behaviour.",
      extremes: [["1", "every ISP (default)"], ["96", "once a day"], ["= y₂", "old behaviour"]] },
    s_dn_step: { group: "split", label: "DOWN step z₂", unit: "0–0.5", min: 0, max: 0.5, sliderStep: 0.01, numStep: 0.02, decimals: 2,
      description: "Shift toward the winning market per rebalance. 0 = static at x₂.",
      extremes: [["0", "static"], ["0.1", "10% per rebalance"]] },
    // -------- sell on day-ahead --------
    da_min_price: { group: "da-discharge", label: "Min DA sell price", unit: "EUR/MWh", min: -50, max: 300, sliderStep: 1, numStep: 1, decimals: 0,
      description: "Floor price for day-ahead discharge offers. An offer is placed at a forecast peak and clears only when the actual DA price ≥ this floor.",
      extremes: [["100 (default)", "only sell DA at ≥ 100"], ["0", "sell at any non-negative price"]] },
    da_n_periods: { group: "da-discharge", label: "Discharge periods / day", unit: "ISPs", min: 0, max: 48, sliderStep: 1, numStep: 1, decimals: 0,
      description: "How many of each day's forecast-peak 15-min periods to target for discharge. Fewer = concentrate on the very top; more = spread across a wider peak.",
      extremes: [["8 (default)", "8 × 15 min = the day's top 2 hours"], ["16", "spread over 4 hours at lower MW"]] },
    da_mw: { group: "da-discharge", label: "MW per period", unit: "MW", min: 0, max: 100, sliderStep: 1, numStep: 1, decimals: 0,
      description: "MW offered to DA in each targeted period (capped by max power, whole-MW). 8×20 MW concentrates; 16×10 MW spreads the same energy wider. Used for both the sell-at-peaks and buy-low-at-troughs legs.",
      extremes: [["20 (default)", "full power per period"], ["10", "half power, wider spread"]] },
    da_charge_price: { group: "da-discharge", label: "Max DA buy-low price", unit: "EUR/MWh", min: -100, max: 100, sliderStep: 1, numStep: 1, decimals: 0,
      description: "Day-ahead BUY leg (committed a day before, like the sell leg): the battery pre-buys energy at each day's forecast price troughs to have stock for the next peaks, but only when both the forecast and the actual price are at or below this ceiling.",
      extremes: [["0 (default)", "only pre-buy on DA when the price is ≤ 0 (negative/free)"], ["30", "pre-buy at genuinely cheap troughs"], ["−100", "never pre-buy on DA"]] },
    // -------- dynamic charging (real-time only) --------
    max_charge_price: { group: "charging", label: "Max charge price", unit: "EUR/MWh", min: -100, max: 150, sliderStep: 1, numStep: 1, decimals: 0,
      description: "The BID PRICE of every real-time charge order (mFRR-dn / aFRR-dn / intraday): a balancing bid clears only when the realised price is at or below it; the intraday order fills at the pre-gate quote when that quote is at/below it. Routing uses KNOWN info only — the adaptive DOWN split, with a share re-routed when its side was unusable in the last settled ISP, and intraday taking the headroom only when settled balancing was dead entirely. Day-ahead buy-low is the separate committed leg above.",
      extremes: [["20 (default)", "charge when cheap or paid"], ["0", "only charge when paid (price ≤ 0)"], ["100", "buy real-time aggressively"]] },
    // -------- dynamic discharge (reactive ask re-pricing) --------
    dd_lookback: { group: "dynamic-discharge", label: "Run-up lookback", unit: "ISPs", min: 1, max: 48, sliderStep: 1, numStep: 1, decimals: 0,
      description: "The run-up is measured on SETTLED prices only: the last settled mFRR price (ISP i−3 — the newest final price at both market gates) vs the price this many ISPs before it. Short lookbacks react to sharp steps; long ones also trigger on slow drifts.",
      extremes: [["1 (default)", "react to a step over the previous settled ISP"], ["4", "an hour-long drift also triggers"]] },
    dd_threshold: { group: "dynamic-discharge", label: "Run-up threshold", unit: "EUR/MWh", min: 0, max: 200, sliderStep: 1, numStep: 1, decimals: 0,
      description: "Re-price only when the observed (settled) rise is at least this much. Below it the offer rests at its normal ask (break-even + min delta).",
      extremes: [["20 (default)", "moderate step"], ["0", "re-price on any rise"]] },
    dd_markup: { group: "dynamic-discharge", label: "Reactive ask mark-up", unit: "EUR/MWh", min: 0, max: 300, sliderStep: 5, numStep: 5, decimals: 0,
      description: "How far ABOVE the last settled mFRR price the whole offer is re-priced when the run-up trigger fires. Full volume stays offered — it clears only if the realised price reaches the raised ask, and rests unfilled if the spike stalls. 0 disables re-pricing (pure price-taker).",
      extremes: [["75 (default)", "sell only into a genuine continuation"], ["0", "never re-price (price-taker)"], ["300", "only extreme continuations clear"]] },
    // -------- opportunistic --------
    opp_threshold: { group: "opportunistic", label: "Spike threshold over intraday", unit: "EUR/MWh", min: 0, max: 500, sliderStep: 5, numStep: 5, decimals: 0,
      description: "Trigger AND ask of the divert bet, on known prices only: when the last SETTLED mFRR price is at least this far above the live intraday quote, the DA-sold volume is bought back on intraday (committed cost) and re-offered to mFRR at ask = quote + threshold. If the spike persists the offer clears (gain ≈ mFRR − intraday); if it fizzles the offer rests, the energy stays stored and the ISP nets (DA − intraday) — a real loss when the buy-back was dearer. 'Divert misses' counts those.",
      extremes: [["100 (default)", "bet only on strong settled spikes"], ["50", "more bets, more misses"], ["400", "practically never divert"]] },
  };

  const DEFAULTS = {
    enabled: { split: true, daDischarge: true, charging: true, dynamicDischarge: true, opportunistic: true },
    params: {
      cap_mwh: 40, power_mw: 20, eff_pct: 90, init_soc_pct: 50, dwell_isps: 4,
      upper_red_pct: 80, lower_red_pct: 20, min_delta: 100, theta_flat: 30,
      w_mfrr_lo: 5, w_mfrr_hi: 95, w_imb_lo: 5, w_imb_hi: 95,
      w_afrr_pos_lo: 5, w_afrr_pos_hi: 95, w_afrr_neg_lo: 5, w_afrr_neg_hi: 95,
      s_up_start: 1, s_up_win: 96, s_up_wait: 1, s_up_step: 0, s_dn_start: 1, s_dn_win: 96, s_dn_wait: 1, s_dn_step: 0,
      da_min_price: 100, da_charge_price: 0, da_n_periods: 8, da_mw: 20, max_charge_price: 20,
      dd_lookback: 1, dd_threshold: 20, dd_markup: 75, opp_threshold: 100,
    },
  };

  const STRATEGY_GROUPS = ["split", "da-discharge", "charging", "dynamic-discharge", "opportunistic"];
  const STRATEGY_TO_ENABLE_KEY = {
    split: "split", "da-discharge": "daDischarge", charging: "charging",
    "dynamic-discharge": "dynamicDischarge", opportunistic: "opportunistic",
  };
  const SETUP_KEYS = [
    "cap_mwh", "power_mw", "eff_pct", "init_soc_pct", "dwell_isps",
    "upper_red_pct", "lower_red_pct", "min_delta",
    "sim_range", "dayType", "w_mfrr", "w_imb", "w_afrr_pos", "w_afrr_neg", "theta_flat",
  ];

  const DECOMP_COLUMNS = [
    { key: "DA", label: "DA sell rev", type: "eur" },
    { key: "mFRR_up", label: "mFRR-up rev", type: "eur" },
    { key: "aFRR_up", label: "aFRR-up rev", type: "eur" },
    { key: "mFRR_dn", label: "mFRR-dn charge", type: "eur" },
    { key: "aFRR_dn", label: "aFRR-dn charge", type: "eur" },
    { key: "charge", label: "Intraday/DA charge", type: "eur" },
    { key: "intraday", label: "Opportunistic close", type: "eur" },
    { key: "imb", label: "Imbalance cost", type: "eur-cost" },
    { key: "flat", label: "Flat penalty", type: "eur-cost" },
  ];
  const COUNT_COLUMNS = [
    { key: "discharge", label: "Discharge ISPs" },
    { key: "charge", label: "Charge ISPs" },
    { key: "idle", label: "Idle ISPs" },
    { key: "daCleared", label: "DA-sold ISPs" },
    { key: "upMfrr", label: "mFRR-up ISPs" },
    { key: "upAfrr", label: "aFRR-up ISPs" },
    { key: "dnMfrr", label: "mFRR-dn ISPs" },
    { key: "dnAfrr", label: "aFRR-dn ISPs" },
    { key: "repriced", label: "Repriced bids" },
    { key: "repClear", label: "Repriced & cleared" },
    { key: "divMiss", label: "Divert misses" },
    { key: "short", label: "DA-short ISPs" },
  ];

  // =====================================================================
  //  BOOTSTRAP
  // =====================================================================
  Engine.init(WIND_DATA);
  Engine.maybeWinsorize(5, 95, 5, 95, 5, 95, 5, 95);
  const D = BessEngine.init();
  console.log(`BESS: loaded ${D.n} ISPs`);

  const startTs = Engine.tsAt(0);
  const endTs = Engine.tsAt(D.n - 1);
  const fmtDateOnly = (d) => d.toISOString().substring(0, 10);
  const fmtDateEU = (d) =>
    `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
  function parseEU(str) {
    if (!str) return null;
    const m = str.trim().match(/^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{4})$/);
    if (!m) return null;
    return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  const isoToEU = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
  document.getElementById("data-range").textContent =
    `${fmtDateEU(startTs)} → ${fmtDateEU(endTs)} (${D.n.toLocaleString()} ISPs)`;
  const dataMinDate = fmtDateOnly(startTs);
  const dataMaxDate = fmtDateOnly(endTs);

  const state = {
    enabled: { ...DEFAULTS.enabled },
    params: { ...DEFAULTS.params },
    simRange: { from: dataMinDate, to: dataMaxDate },
    dayType: "all",
    tsRange: { from: null, to: null },
    lastSim: null,
    lastSens: null,
    optimRuns: [],
  };

  function simParams(extras) {
    return { ...state.params, ...(extras || {}), dayTypeFilter: state.dayType, enabled: { ...state.enabled } };
  }

  // =====================================================================
  //  RENDER PARAM CARDS  (reuses the wind-park card shapes minus source-select)
  // =====================================================================
  function paramCardHTML(key) {
    const def = PARAM_DEFS[key];
    const idBase = key;
    if (def.isDateRange) {
      return `
        <div class="control sim-range">
          <label>${def.label}<span class="unit">DD/MM/YYYY</span></label>
          <div class="slider-row two">
            <input type="text" inputmode="numeric" placeholder="DD/MM/YYYY" pattern="\\d{2}/\\d{2}/\\d{4}" maxlength="10" id="${idBase}-from" value="${isoToEU(state.simRange.from)}">
            <span>→</span>
            <input type="text" inputmode="numeric" placeholder="DD/MM/YYYY" pattern="\\d{2}/\\d{2}/\\d{4}" maxlength="10" id="${idBase}-to" value="${isoToEU(state.simRange.to)}">
            <button type="button" class="btn small" id="${idBase}-reset" title="Reset to full dataset">↻</button>
          </div>
          <div class="param-desc"><p>${def.description}</p>
            <ul class="extremes">${def.extremes.map(([v, m]) => `<li><b>${v}:</b> ${m}</li>`).join("")}</ul></div>
        </div>`;
    }
    if (def.isDayType) {
      const cur = state.dayType;
      const btn = (val, lbl) => `<button type="button" class="btn small preset${cur === val ? " active" : ""}" data-day-type="${val}">${lbl}</button>`;
      return `
        <div class="control">
          <label>${def.label}</label>
          <div class="day-type-toggle bt-day-type-toggle">${btn("all", "All days")}${btn("weekend-holiday", "Weekends + holidays")}${btn("workday", "Workdays only")}</div>
          <div class="param-desc"><p>${def.description}</p></div>
        </div>`;
    }
    if (def.isWinsor) {
      const lo = state.params[`${key}_lo`], hi = state.params[`${key}_hi`];
      return `
        <div class="control winsor">
          <label>${def.label}</label>
          <div class="slider-row two winsor-row">
            <span class="winsor-input"><input type="number" id="${idBase}-lo" value="${lo}" min="0" max="50" step="1"><span class="winsor-cap" id="${idBase}-cap-lo">(…)</span></span>
            <span>/</span>
            <span class="winsor-input"><input type="number" id="${idBase}-hi" value="${hi}" min="50" max="100" step="1"><span class="winsor-cap" id="${idBase}-cap-hi">(…)</span></span>
          </div>
          <div class="param-desc"><p>${def.description}</p>
            <ul class="extremes">${def.extremes.map(([v, m]) => `<li><b>${v}:</b> ${m}</li>`).join("")}</ul></div>
        </div>`;
    }
    const value = state.params[key];
    return `
      <div class="control">
        <label for="${idBase}">${def.label}<span class="unit">${def.unit}</span></label>
        <div class="slider-row">
          <input type="range" id="${idBase}" min="${def.min}" max="${def.max}" step="${def.sliderStep}" value="${value}">
          <input type="number" id="${idBase}-num" value="${value}" min="${def.min}" max="${def.max}" step="${def.numStep}">
        </div>
        <div class="param-desc"><p>${def.description}</p>
          <ul class="extremes">${def.extremes.map(([v, m]) => `<li><b>${v}:</b> ${m}</li>`).join("")}</ul></div>
      </div>`;
  }

  function renderSetup() {
    document.getElementById("setup-params").innerHTML = SETUP_KEYS.map(paramCardHTML).join("");
  }
  function renderStrategyCards() {
    for (const grp of STRATEGY_GROUPS) {
      const container = document.getElementById(`${grp}-params`);
      if (!container) continue;
      container.innerHTML = Object.keys(PARAM_DEFS).filter((k) => PARAM_DEFS[k].group === grp).map(paramCardHTML).join("");
    }
  }
  function renderStatsTables() {
    document.getElementById("decomp-table").innerHTML =
      `<thead><tr>${DECOMP_COLUMNS.map((c) => `<th>${c.label}</th>`).join("")}</tr></thead>` +
      `<tbody><tr>${DECOMP_COLUMNS.map((c) => `<td id="${c.key}">–</td>`).join("")}</tr></tbody>`;
    document.getElementById("counts-table").innerHTML =
      `<thead><tr>${COUNT_COLUMNS.map((c) => `<th>${c.label}</th>`).join("")}</tr></thead>` +
      `<tbody><tr>${COUNT_COLUMNS.map((c) => `<td id="cnt-${c.key}">–</td>`).join("")}</tr></tbody>`;
  }

  // =====================================================================
  //  FORMATTERS
  // =====================================================================
  const fmtEUR = (v) => Math.round(v).toLocaleString("en-US") + " €";
  const fmtPct = (v) => (v * 100).toFixed(1) + "%";
  const fmtInt = (v) => v.toLocaleString("en-US");
  function fmtCap(v) {
    if (!isFinite(v)) return "—";
    const a = Math.abs(v);
    return a >= 1000 ? Math.round(v).toLocaleString("en-US") : a >= 100 ? v.toFixed(0) : v.toFixed(1);
  }
  function updateWinsorCaps(b) {
    const map = [["w_mfrr", b && b.mfrrBounds], ["w_imb", b && b.imbBounds], ["w_afrr_pos", b && b.afrrPosBounds], ["w_afrr_neg", b && b.afrrNegBounds]];
    for (const [key, bb] of map) {
      const lo = document.getElementById(`${key}-cap-lo`), hi = document.getElementById(`${key}-cap-hi`);
      if (!lo || !hi) continue;
      lo.textContent = bb ? `(≤ ${fmtCap(bb.lo)} €/MWh)` : "(…)";
      hi.textContent = bb ? `(≥ ${fmtCap(bb.hi)} €/MWh)` : "(…)";
    }
  }
  const isoDate = (d) => d.toISOString().substring(0, 10);
  function addDays(s, n) { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return isoDate(d); }
  function clampDate(s, lo, hi) { return s < lo ? lo : s > hi ? hi : s; }
  function idxAtOrAfter(dateStr) {
    const t = new Date(dateStr + "T00:00:00Z").getTime();
    const startMs = new Date(D.start_iso).getTime();
    const targetOffset = (t - startMs) / (D.step_min * 60000);
    let lo = 0, hi = D.n - 1, ans = D.n;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (D.offsets[mid] >= targetOffset) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
    return ans;
  }
  function rangeToIdx(fromStr, toStr) {
    const start = idxAtOrAfter(fromStr);
    const next = new Date(toStr + "T00:00:00Z"); next.setUTCDate(next.getUTCDate() + 1);
    return { start, end: idxAtOrAfter(next.toISOString().substring(0, 10)) };
  }
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // =====================================================================
  //  CORE UPDATE
  // =====================================================================
  function update() {
    const sim_range = state.simRange;
    const { start: winStart, end: winEnd } = rangeToIdx(sim_range.from, sim_range.to);
    Engine.setWindow(winStart, winEnd);
    const p = state.params;
    const bounds = Engine.maybeWinsorize(
      p.w_mfrr_lo, p.w_mfrr_hi, p.w_imb_lo, p.w_imb_hi,
      p.w_afrr_pos_lo, p.w_afrr_pos_hi, p.w_afrr_neg_lo, p.w_afrr_neg_hi,
    );
    BessEngine.invalidateCaches();
    updateWinsorCaps(bounds);

    const callParams = simParams();
    const sim = BessEngine.simulate(callParams);
    state.lastSim = sim;

    // headline
    document.getElementById("total").textContent = fmtEUR(sim.totalRevenue);
    const perMWh = sim.stats.mwhDischarged > 0 ? sim.totalRevenue / sim.stats.mwhDischarged : 0;
    document.getElementById("per-mwh").textContent = sim.stats.mwhDischarged > 0 ? perMWh.toFixed(2) + " €/MWh" : "–";
    document.getElementById("cycles").textContent = sim.stats.cycles.toFixed(1);

    // decomposition + counts
    for (const col of DECOMP_COLUMNS) {
      const v = sim.breakdown[col.key];
      document.getElementById(col.key).textContent = col.type === "eur-cost" ? "−" + fmtEUR(v) : fmtEUR(v);
    }
    for (const col of COUNT_COLUMNS) {
      const el = document.getElementById(`cnt-${col.key}`);
      if (el) el.textContent = fmtInt(sim.counts[col.key] || 0);
    }

    // ops + soc-stats tables
    const st = sim.stats, c = sim.counts;
    const h = (isps) => (isps * 0.25).toFixed(2) + " h";
    document.getElementById("ops-table").innerHTML =
      `<tbody>
        <tr><th>Avg discharge block</th><td>${h(st.avgDisRun)}</td><th>Avg charge block</th><td>${h(st.avgChgRun)}</td></tr>
        <tr><th>Avg idle gap</th><td>${h(st.avgIdleGap)}</td><th>Full cycles</th><td>${st.cycles.toFixed(1)}</td></tr>
        <tr><th>MWh discharged</th><td>${Math.round(st.mwhDischarged).toLocaleString()}</td><th>MWh charged</th><td>${Math.round(st.mwhCharged).toLocaleString()}</td></tr>
      </tbody>`;
    const okBad = c.unfulfilled > 0 ? "down" : "up";
    // Red-zone time: ISPs whose end-of-ISP SoC is pinned at/inside a zone
    // (within one whole-MW step of the boundary, or beyond it). Dynamic wrt
    // the configured red-zone percentages, NOT a static 0%/100% check.
    const zoneIsps = Math.max(1, c.discharge + c.charge + c.idle);
    const zoneCell = (n) => `${fmtInt(n)} (${((n / zoneIsps) * 100).toFixed(1)}%)`;
    const zoneTitle = "ISPs whose end-of-ISP SoC is pinned at or inside the zone — within one whole-MW step of the boundary, or beyond it (committed DA legs may dig inside).";
    document.getElementById("soc-stats-table").innerHTML =
      `<tbody>
        <tr><th title="${zoneTitle}">In lower red zone (≤${p.lower_red_pct}%)</th><td>${zoneCell(c.lowRed)}</td>
            <th title="${zoneTitle}">In upper red zone (≥${p.upper_red_pct}%)</th><td>${zoneCell(c.upRed)}</td></tr>
        <tr><th>DA-short ISPs (→ imbalance)</th><td>${fmtInt(c.short)}</td><th>DA shortfall</th><td>${Math.round(st.shortMWh).toLocaleString()} MWh</td></tr>
        <tr><th>Balancing UNFULFILLED</th><td class="value ${okBad}">${fmtInt(c.unfulfilled)} ${c.unfulfilled > 0 ? "⚠" : "✓"}</td><th></th><td></td></tr>
      </tbody>`;

    // robustness
    const robustRev = sim.filteredRevenue;
    document.getElementById("top1pct").textContent =
      fmtPct(BessEngine.topConcentration(robustRev, 0.01).share) + " (" + BessEngine.topConcentration(robustRev, 0.01).topN + " ISPs)";
    document.getElementById("top5pct").textContent = fmtPct(BessEngine.topConcentration(robustRev, 0.05).share);
    document.getElementById("top10pct").textContent = fmtPct(BessEngine.topConcentration(robustRev, 0.1).share);

    // time-series window (re-anchor when sim window changes)
    let { from, to } = state.tsRange;
    if (!from || !to || from < sim_range.from || to > sim_range.to) {
      const midIdx = Math.floor((winStart + Math.max(winStart, winEnd - 1)) / 2);
      const midDate = isoDate(Engine.tsAt(Math.max(0, Math.min(D.n - 1, midIdx))));
      from = clampDate(midDate, sim_range.from, sim_range.to);
      to = from;
      state.tsRange = { from, to };
    }
    syncTsInputs();
    const chartIdx = rangeToIdx(state.tsRange.from, state.tsRange.to);
    BessCharts.drawDaForecast("da-chart", sim, callParams, chartIdx.start, chartIdx.end);
    BessCharts.drawTimeSeries("ts-chart", sim, callParams, chartIdx.start, chartIdx.end);
    BessCharts.drawBids("bids-chart", sim, chartIdx.start, chartIdx.end);
    BessCharts.drawOps("ops-chart", sim);
    BessCharts.drawSocStats("soc-stats-chart", sim, callParams);
    BessCharts.drawMonthly("monthly-chart", BessEngine.monthlyAggregation(callParams));
    BessCharts.drawHistogram("hist-chart", sim.filteredRevenue);
  }

  let updateTimer = null;
  function scheduleUpdate() { clearTimeout(updateTimer); updateTimer = setTimeout(update, 60); }

  // =====================================================================
  //  ENABLE TOGGLES + BINDING
  // =====================================================================
  function applyEnableUI() {
    for (const grp of STRATEGY_GROUPS) {
      const card = document.querySelector(`.controls-card[data-strategy="${grp}"]`);
      const cb = document.getElementById(`enable-${grp}`);
      const on = state.enabled[STRATEGY_TO_ENABLE_KEY[grp]];
      if (cb) cb.checked = on;
      if (card) card.classList.toggle("disabled", !on);
    }
  }
  function bindEnableToggles() {
    for (const grp of STRATEGY_GROUPS) {
      const cb = document.getElementById(`enable-${grp}`);
      if (!cb) continue;
      cb.addEventListener("change", () => {
        state.enabled[STRATEGY_TO_ENABLE_KEY[grp]] = cb.checked;
        applyEnableUI();
        scheduleUpdate();
      });
    }
  }

  function bindNumeric(idBase, def) {
    const slider = document.getElementById(idBase), num = document.getElementById(`${idBase}-num`);
    if (!slider || !num) return;
    const onSet = (raw) => {
      let v = parseFloat(raw);
      if (isNaN(v)) return;
      v = clamp(v, def.min, def.max);
      slider.value = v; num.value = v; state.params[idBase] = v;
      scheduleUpdate();
    };
    slider.addEventListener("input", (e) => onSet(e.target.value));
    num.addEventListener("change", (e) => onSet(e.target.value));
  }

  function bindAll() {
    for (const key of SETUP_KEYS) {
      const def = PARAM_DEFS[key], idBase = key;
      if (def.isDateRange) {
        const fromEl = document.getElementById(`${idBase}-from`), toEl = document.getElementById(`${idBase}-to`), resetEl = document.getElementById(`${idBase}-reset`);
        const onChange = () => {
          let f = parseEU(fromEl.value) || dataMinDate, t = parseEU(toEl.value) || dataMaxDate;
          f = clampDate(f, dataMinDate, dataMaxDate); t = clampDate(t, dataMinDate, dataMaxDate);
          if (f > t) [f, t] = [t, f];
          fromEl.value = isoToEU(f); toEl.value = isoToEU(t);
          state.simRange = { from: f, to: t }; state.tsRange = { from: null, to: null };
          scheduleUpdate();
        };
        fromEl.addEventListener("change", onChange);
        toEl.addEventListener("change", onChange);
        resetEl.addEventListener("click", () => { fromEl.value = isoToEU(dataMinDate); toEl.value = isoToEU(dataMaxDate); onChange(); });
        continue;
      }
      if (def.isDayType) {
        document.querySelectorAll(".bt-day-type-toggle .preset[data-day-type]").forEach((b) => {
          b.addEventListener("click", () => {
            if (state.dayType === b.dataset.dayType) return;
            state.dayType = b.dataset.dayType;
            document.querySelectorAll(".bt-day-type-toggle .preset[data-day-type]").forEach((x) => x.classList.remove("active"));
            b.classList.add("active");
            scheduleUpdate();
          });
        });
        continue;
      }
      if (def.isWinsor) {
        const lo = document.getElementById(`${idBase}-lo`), hi = document.getElementById(`${idBase}-hi`);
        const onChange = () => {
          const loV = clamp(parseFloat(lo.value) || 0, 0, 50), hiV = clamp(parseFloat(hi.value) || 100, 50, 100);
          state.params[`${idBase}_lo`] = loV; state.params[`${idBase}_hi`] = hiV; lo.value = loV; hi.value = hiV;
          scheduleUpdate();
        };
        lo.addEventListener("change", onChange);
        hi.addEventListener("change", onChange);
        continue;
      }
      bindNumeric(idBase, def);
    }
    for (const grp of STRATEGY_GROUPS) {
      Object.keys(PARAM_DEFS).filter((k) => PARAM_DEFS[k].group === grp).forEach((k) => bindNumeric(k, PARAM_DEFS[k]));
    }
  }

  function setSliderValue(key, value) {
    const slider = document.getElementById(key), num = document.getElementById(`${key}-num`);
    if (slider) slider.value = value;
    if (num) num.value = value;
    state.params[key] = value;
  }

  function resetToDefaults() {
    state.enabled = { ...DEFAULTS.enabled };
    state.params = { ...DEFAULTS.params };
    for (const key of Object.keys(DEFAULTS.params)) {
      const slider = document.getElementById(key), num = document.getElementById(`${key}-num`);
      if (slider && num) { slider.value = DEFAULTS.params[key]; num.value = DEFAULTS.params[key]; }
    }
    for (const k of ["w_mfrr", "w_imb", "w_afrr_pos", "w_afrr_neg"]) {
      const lo = document.getElementById(`${k}-lo`), hi = document.getElementById(`${k}-hi`);
      if (lo) lo.value = DEFAULTS.params[`${k}_lo`];
      if (hi) hi.value = DEFAULTS.params[`${k}_hi`];
    }
    applyEnableUI();
    update();
  }
  document.getElementById("reset").addEventListener("click", resetToDefaults);

  // =====================================================================
  //  OPTIMISER — seeded random search + multi-start coord-descent refine
  // =====================================================================
  const RANDOM_N = 3000;
  const REFINE_STARTS = 5;
  const RAND_PROGRESS = 0.35; // progress fraction consumed by the random phase
  const REFINE_END = 0.8; // refine ends here; sensitivity analysis takes the rest
  const SENS_TOL = 0.01; // "as good as the optimum" band = within 1% of it
  const _yieldChannel = typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
  let _yieldResolve = null;
  if (_yieldChannel) _yieldChannel.port1.onmessage = () => { const r = _yieldResolve; _yieldResolve = null; if (r) r(); };
  function yieldToBrowser() {
    if (_yieldChannel) return new Promise((r) => { _yieldResolve = r; _yieldChannel.port2.postMessage(null); });
    return new Promise((r) => setTimeout(r, 0));
  }
  function mulberry32(seed) {
    let s = seed | 0;
    return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function rangeArr(lo, hi, step) { const out = []; for (let v = lo; v <= hi + step * 1e-6; v += step) out.push(Math.round((v / step) * 1) * step); return out; }
  function range01(step) { const out = []; for (let v = 0; v <= 1 + 1e-9; v += step) out.push(parseFloat(v.toFixed(4))); return out; }

  function buildOptimDims() {
    const dims = [];
    const winRefine = [4, 8, 12, 24, 48, 96, 168, 288, 480, 672];
    const winSample = (rng) => 4 + 4 * Math.floor(rng() * 168);
    const waitRefine = [1, 2, 4, 8, 12, 24, 48, 96, 168, 288, 480, 672];
    const waitSample = (rng) => 1 + Math.floor(rng() * 672);
    const r100 = (rng) => Math.round(rng() * 100) / 100;
    if (state.enabled.split) {
      dims.push({ key: "s_up_start", sample: r100, refineValues: range01(0.02) });
      dims.push({ key: "s_up_win", sample: winSample, refineValues: winRefine });
      dims.push({ key: "s_up_wait", sample: waitSample, refineValues: waitRefine });
      dims.push({ key: "s_up_step", sample: (rng) => Math.round(rng() * 50) / 100, refineValues: rangeArr(0, 0.5, 0.02) });
      dims.push({ key: "s_dn_start", sample: r100, refineValues: range01(0.02) });
      dims.push({ key: "s_dn_win", sample: winSample, refineValues: winRefine });
      dims.push({ key: "s_dn_wait", sample: waitSample, refineValues: waitRefine });
      dims.push({ key: "s_dn_step", sample: (rng) => Math.round(rng() * 50) / 100, refineValues: rangeArr(0, 0.5, 0.02) });
    }
    if (state.enabled.daDischarge) {
      dims.push({ key: "da_min_price", sample: (rng) => -50 + Math.floor(rng() * 351), refineValues: rangeArr(-50, 300, 5) });
      dims.push({ key: "da_charge_price", sample: (rng) => -100 + 5 * Math.floor(rng() * 41), refineValues: rangeArr(-100, 100, 5) });
      dims.push({ key: "da_n_periods", sample: (rng) => Math.floor(rng() * 49), refineValues: rangeArr(0, 48, 2) });
      dims.push({ key: "da_mw", sample: (rng) => Math.floor(rng() * (state.params.power_mw + 1)), refineValues: rangeArr(0, state.params.power_mw, 2) });
    }
    if (state.enabled.charging) {
      dims.push({ key: "max_charge_price", sample: (rng) => -100 + Math.floor(rng() * 251), refineValues: rangeArr(-100, 150, 5) });
    }
    if (state.enabled.dynamicDischarge) {
      dims.push({ key: "dd_lookback", sample: (rng) => 1 + Math.floor(rng() * 48), refineValues: rangeArr(1, 48, 2) });
      dims.push({ key: "dd_threshold", sample: (rng) => Math.floor(rng() * 201), refineValues: rangeArr(0, 200, 5) });
      dims.push({ key: "dd_markup", sample: (rng) => 5 * Math.floor(rng() * 61), refineValues: rangeArr(0, 300, 10) });
    }
    if (state.enabled.opportunistic) {
      dims.push({ key: "opp_threshold", sample: (rng) => Math.floor(rng() * 101) * 5, refineValues: rangeArr(0, 500, 10) });
    }
    return dims;
  }
  const evaluateSample = (sample) => BessEngine.simulateTotal(simParams(sample));
  function randomSampleByDims(dims, rng) { const s = {}; for (const d of dims) s[d.key] = d.sample(rng); return s; }

  async function coordRefine(startSample, dims, maxPasses = 3) {
    let cur = { ...startSample }, curRev = evaluateSample(cur), lastYield = performance.now();
    for (let pass = 0; pass < maxPasses; pass++) {
      let improved = false;
      for (const dim of dims) {
        let bestVal = cur[dim.key], bestR = curRev;
        for (const v of dim.refineValues) {
          if (v === cur[dim.key]) continue;
          const r = evaluateSample({ ...cur, [dim.key]: v });
          if (r > bestR) { bestR = r; bestVal = v; }
          if (performance.now() - lastYield > 200) { await yieldToBrowser(); lastYield = performance.now(); }
        }
        if (bestVal !== cur[dim.key]) { cur[dim.key] = bestVal; curRev = bestR; improved = true; }
      }
      if (!improved) break;
    }
    return { sample: cur, revenue: curRev };
  }
  function renderProgressBar(progEl, fraction, label) {
    if (!progEl.querySelector(".progress-bar")) progEl.innerHTML = '<div class="progress-bar"><div class="progress-bar-fill"></div><div class="progress-bar-text"></div></div>';
    const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    progEl.querySelector(".progress-bar-fill").style.width = `${pct}%`;
    progEl.querySelector(".progress-bar-text").textContent = label;
  }
  function applyOptimisedSample(sample) { for (const key of Object.keys(sample)) setSliderValue(key, sample[key]); }

  async function optimise() {
    const optimiseBtn = document.getElementById("optimise"), resetBtn = document.getElementById("reset"), progEl = document.getElementById("progress");
    const dims = buildOptimDims();
    if (!dims.length) { renderProgressBar(progEl, 1, "nothing to optimise (no strategies enabled)"); return; }
    optimiseBtn.disabled = true; resetBtn.disabled = true;
    const p = state.params;
    Engine.setWindow(...Object.values(rangeToIdx(state.simRange.from, state.simRange.to)));
    Engine.maybeWinsorize(p.w_mfrr_lo, p.w_mfrr_hi, p.w_imb_lo, p.w_imb_hi, p.w_afrr_pos_lo, p.w_afrr_pos_hi, p.w_afrr_neg_lo, p.w_afrr_neg_hi);
    BessEngine.invalidateCaches();
    const N = RANDOM_N, K = REFINE_STARTS, t0 = performance.now(), rng = mulberry32(0xc0ffee);
    renderProgressBar(progEl, 0, "optimising 0%");
    await yieldToBrowser();
    const topK = [];
    const pop = []; // full random population — reused by the sensitivity analysis
    let lastYield = performance.now();
    for (let i = 0; i < N; i++) {
      const s = randomSampleByDims(dims, rng), r = evaluateSample(s);
      pop.push({ sample: s, revenue: r });
      if (topK.length < K) { topK.push({ sample: s, revenue: r }); topK.sort((a, b) => b.revenue - a.revenue); }
      else if (r > topK[K - 1].revenue) { topK[K - 1] = { sample: s, revenue: r }; topK.sort((a, b) => b.revenue - a.revenue); }
      if (performance.now() - lastYield > 200) { const f = ((i + 1) / N) * RAND_PROGRESS; renderProgressBar(progEl, f, `optimising ${Math.round(f * 100)}%`); await yieldToBrowser(); lastYield = performance.now(); }
    }
    renderProgressBar(progEl, RAND_PROGRESS, `refining 1/${K}…`);
    await yieldToBrowser();
    let best = null;
    for (let k = 0; k < topK.length; k++) {
      const refined = await coordRefine(topK[k].sample, dims);
      if (!best || refined.revenue > best.revenue) best = refined;
      const f = RAND_PROGRESS + ((k + 1) / K) * (REFINE_END - RAND_PROGRESS);
      renderProgressBar(progEl, f, k + 1 < topK.length ? `refining ${k + 2}/${K}…` : "analysing sensitivity…");
      await yieldToBrowser();
    }
    const sens = await analyseSensitivity(best, dims, pop, progEl);
    state.lastSens = sens;
    const ms = Math.round(performance.now() - t0);
    applyOptimisedSample(best.sample);
    update();
    recordOptimRun(best, ms, sens);
    renderSensitivity(sens);
    renderProgressBar(progEl, 1, `done in ${(ms / 1000).toFixed(1)}s — ${fmtEUR(best.revenue)}`);
    optimiseBtn.disabled = false; resetBtn.disabled = false;
  }

  // =====================================================================
  //  SENSITIVITY ANALYSIS — what actually drives the found optimum.
  //  One-at-a-time sweeps around the optimum (local weight / tolerance
  //  band / shape / edge saturation), global stats over the random
  //  population (Spearman rho, top-decile clustering), pairwise
  //  interaction scores, and a 2-D sweep of the strongest pair.
  //  All math lives in optim-sens.js (OptimSens — shared with the wind-park
  //  page, mirrored in tests_bess.py).
  // =====================================================================
  function _heatGrid(refineValues, vStar, maxN = 9) {
    const vals = [...new Set([...refineValues, vStar])].sort((x, y) => x - y);
    if (vals.length <= maxN) return vals;
    const step = (vals.length - 1) / (maxN - 1);
    const out = [];
    for (let i = 0; i < maxN; i++) out.push(vals[Math.round(i * step)]);
    if (!out.includes(vStar)) out.push(vStar);
    return [...new Set(out)].sort((x, y) => x - y);
  }

  async function analyseSensitivity(best, dims, pop, progEl) {
    const denom = Math.max(1, Math.abs(best.revenue));
    const perParam = {}, curves = {};
    const totalEvals = Math.max(1, dims.reduce((s, d) => s + d.refineValues.length, 0));
    let done = 0, lastYield = performance.now();
    for (const dim of dims) {
      const vStar = best.sample[dim.key];
      const values = [...new Set([...dim.refineValues, vStar])].sort((a, b) => a - b);
      const curve = [];
      for (const v of values) {
        const r = v === vStar ? best.revenue : evaluateSample({ ...best.sample, [dim.key]: v });
        curve.push({ v, r });
        done++;
        if (performance.now() - lastYield > 200) {
          renderProgressBar(progEl, REFINE_END + 0.17 * (done / totalEvals), "analysing sensitivity…");
          await yieldToBrowser();
          lastYield = performance.now();
        }
      }
      perParam[dim.key] = Object.assign(
        { vStar },
        OptimSens.weightAndBand(curve, vStar, best.revenue, SENS_TOL),
        OptimSens.globalStats(pop, dim.key),
      );
      curves[dim.key] = curve;
    }
    const keys = dims.map((d) => d.key);
    const pairs = keys.length >= 2 ? OptimSens.interactionScores(pop, keys, best.revenue).slice(0, 5) : [];
    let heat = null;
    if (pairs.length) {
      const { a, b } = pairs[0];
      const ga = _heatGrid(dims.find((d) => d.key === a).refineValues, best.sample[a]);
      const gb = _heatGrid(dims.find((d) => d.key === b).refineValues, best.sample[b]);
      const z = [];
      for (const va of ga) {
        const row = [];
        for (const vb of gb) {
          const r = va === best.sample[a] && vb === best.sample[b]
            ? best.revenue
            : evaluateSample({ ...best.sample, [a]: va, [b]: vb });
          row.push(((r - best.revenue) / denom) * 100); // Δ% vs the optimum
          if (performance.now() - lastYield > 200) {
            renderProgressBar(progEl, 0.98, "mapping interaction…");
            await yieldToBrowser();
            lastYield = performance.now();
          }
        }
        z.push(row);
      }
      heat = { a, b, va: ga, vb: gb, z, aStar: best.sample[a], bStar: best.sample[b] };
    }
    return { revenue: best.revenue, perParam, curves, pairs, heat };
  }

  const SHAPE_LABEL = { flat: "— flat", up: "↑ higher is better", down: "↓ lower is better", peaked: "▲ interior peak" };
  function renderSensitivity(sens) {
    const table = document.getElementById("sens-table");
    if (!table) return;
    if (!sens) {
      table.innerHTML = '<tbody><tr><td class="optim-empty">No analysis yet — click ⚡ Optimise. The report is per session (not persisted).</td></tr></tbody>';
      const list = document.getElementById("sens-pairs-list");
      if (list) list.textContent = "";
      return;
    }
    const keys = Object.keys(sens.perParam).sort((a, b) => sens.perParam[b].weight - sens.perParam[a].weight);
    const num = (v, d = 0) => (v == null || isNaN(v) ? "—" : (+v).toFixed(d));
    const rows = keys.map((k) => {
      const s = sens.perParam[k];
      const dec = /_(start|step)$/.test(k) ? 2 : 0;
      return `<tr>
        <td>${k}${s.edge ? ' <span title="optimum sits on the sweep boundary — saturated lever">⚠</span>' : ""}</td>
        <td><b>${num(s.vStar, dec)}</b></td>
        <td>${(s.weight * 100).toFixed(1)}%${s.sharp ? ' <span title="one grid step next to the optimum already loses >5%">✶</span>' : ""}</td>
        <td>${num(s.band[0], dec)} … ${num(s.band[1], dec)}</td>
        <td>${SHAPE_LABEL[s.shape] || s.shape}</td>
        <td>${s.rho >= 0 ? "+" : ""}${s.rho.toFixed(2)}</td>
        <td>${num(s.topBand[0], dec)} … ${num(s.topBand[1], dec)}</td>
      </tr>`;
    }).join("");
    table.innerHTML =
      `<thead><tr><th>Parameter</th><th>Optimum</th><th>Weight (max loss)</th><th>1%-band</th><th>Shape (local)</th><th>Global ρ</th><th>Top-10% cluster</th></tr></thead>` +
      `<tbody>${rows}</tbody>`;
    const list = document.getElementById("sens-pairs-list");
    if (list) {
      list.innerHTML = sens.pairs.length
        ? "Ranking: " + sens.pairs.map((p, i) => `${i + 1}. ${p.a} × ${p.b} (${(p.score * 100).toFixed(1)}%)`).join(" · ")
        : "fewer than two optimised parameters — no pairs to rank.";
    }
    OptimSens.drawWeights("sens-weights", sens.perParam);
    OptimSens.drawCurves("sens-curves", sens.curves, sens.perParam, sens.revenue);
    OptimSens.drawHeatmap("sens-heatmap", sens.heat);
  }

  // =====================================================================
  //  OPTIMISED RUNS LOG (per-tab sessionStorage)
  // =====================================================================
  const DAYTYPE_LABEL = { all: "All", "weekend-holiday": "Wknd+Hol", workday: "Workday" };
  const OPTIM_RUNS_KEY = "tck.bessOptimRuns.v3"; // v3: dd_hold → dd_markup (reactive ask)
  function nowClock() { const d = new Date(); const p2 = (x) => String(x).padStart(2, "0"); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; }

  function recordOptimRun(best, ms, sens) {
    const p = state.params;
    // compact per-run sensitivity summary (full curves stay in-memory only)
    let sensTop = null;
    if (sens) {
      sensTop = Object.keys(sens.perParam)
        .sort((a, b) => sens.perParam[b].weight - sens.perParam[a].weight)
        .slice(0, 3)
        .map((k) => ({ k, w: sens.perParam[k].weight, edge: sens.perParam[k].edge }));
    }
    state.optimRuns.push({
      n: state.optimRuns.length + 1, when: nowClock(), ms,
      from: state.simRange.from, to: state.simRange.to, dayType: state.dayType,
      enabled: { ...state.enabled },
      params: { ...p },
      revenue: best.revenue,
      perMWh: state.lastSim && state.lastSim.stats.mwhDischarged > 0 ? best.revenue / state.lastSim.stats.mwhDischarged : 0,
      cycles: state.lastSim ? state.lastSim.stats.cycles : 0,
      sensTop,
    });
    saveOptimRuns(); renderOptimRuns();
  }
  function saveOptimRuns() { try { sessionStorage.setItem(OPTIM_RUNS_KEY, JSON.stringify(state.optimRuns)); } catch (_) {} }
  function loadOptimRuns() {
    let raw; try { raw = sessionStorage.getItem(OPTIM_RUNS_KEY); } catch (_) { return; }
    if (!raw) return;
    try { const arr = JSON.parse(raw); if (Array.isArray(arr)) state.optimRuns = arr; } catch (_) {}
  }
  const OPTIM_HEADER = ["#", "Time", "Range", "Days", "Strategies", "Split↑ x/y/w/z", "Split↓ x/y/w/z", "DA sell/buy/n/MW", "Max chg €", "DynDis lb/thr/mkup", "Opp €", "Top drivers (weight)", "Revenue", "€/MWh", "Cycles"];
  function renderOptimRuns() {
    const table = document.getElementById("optim-runs-table");
    if (!table) return;
    const runs = state.optimRuns;
    if (!runs.length) { table.innerHTML = '<tbody><tr><td class="optim-empty">No runs yet — click ⚡ Optimise to capture the setup and optimal parameters here.</td></tr></tbody>'; return; }
    const num = (v, d = 0) => (v == null || isNaN(v) ? "—" : (+v).toFixed(d));
    const dash = '<span class="optim-off">—</span>';
    const chip = (on, lbl) => `<span class="optim-chip ${on ? "on" : "off"}">${lbl}</span>`;
    const rows = runs.map((r) => {
      const en = r.enabled, p = r.params;
      const strategies = chip(en.split, "SP") + chip(en.daDischarge, "DA") + chip(en.charging, "CH") + chip(en.dynamicDischarge, "DD") + chip(en.opportunistic, "OP");
      const cells = [
        r.n, r.when, `${isoToEU(r.from)}<br>${isoToEU(r.to)}`, DAYTYPE_LABEL[r.dayType] || r.dayType, strategies,
        en.split ? `${num(p.s_up_start, 2)}/${num(p.s_up_win)}/${num(p.s_up_wait)}/${num(p.s_up_step, 2)}` : dash,
        en.split ? `${num(p.s_dn_start, 2)}/${num(p.s_dn_win)}/${num(p.s_dn_wait)}/${num(p.s_dn_step, 2)}` : dash,
        en.daDischarge ? `${num(p.da_min_price)}/${num(p.da_charge_price)}/${num(p.da_n_periods)}/${num(p.da_mw)}` : dash,
        en.charging ? num(p.max_charge_price) : dash,
        en.dynamicDischarge ? `${num(p.dd_lookback)}/${num(p.dd_threshold)}/${num(p.dd_markup)}` : dash,
        en.opportunistic ? num(p.opp_threshold) : dash,
        r.sensTop && r.sensTop.length
          ? r.sensTop.map((t) => `${t.edge ? "⚠" : ""}${t.k} ${(t.w * 100).toFixed(0)}%`).join("<br>")
          : dash,
        `<b>${fmtEUR(r.revenue)}</b>`, num(r.perMWh, 1), num(r.cycles, 1),
      ];
      return `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
    }).reverse();
    table.innerHTML = `<thead><tr>${OPTIM_HEADER.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody>`;
  }
  document.getElementById("optimise").addEventListener("click", () => {
    optimise().catch((err) => { console.error("optimise failed", err); document.getElementById("optimise").disabled = false; document.getElementById("reset").disabled = false; });
  });

  // =====================================================================
  //  TIME-SERIES WINDOW NAV (shared by the DA chart, SoC chart and bids chart)
  // =====================================================================
  function syncTsInputs() {
    const { from, to } = state.tsRange;
    for (const id of ["date-from", "da-date-from"]) { const el = document.getElementById(id); if (el) el.value = isoToEU(from); }
    for (const id of ["date-to", "da-date-to"]) { const el = document.getElementById(id); if (el) el.value = isoToEU(to); }
  }
  function bindDateNav() {
    const simBounds = () => state.simRange;
    function applyRange(f, t) {
      const sb = simBounds();
      f = clampDate(f, sb.from, sb.to); t = clampDate(t, sb.from, sb.to);
      if (f > t) [f, t] = [t, f];
      state.tsRange = { from: f, to: t };
      document.querySelectorAll(".preset").forEach((b) => b.classList.remove("active"));
      update();
    }
    const ids = [["date-from", "date-to"], ["da-date-from", "da-date-to"]];
    for (const [fId, tId] of ids) {
      const fromEl = document.getElementById(fId), toEl = document.getElementById(tId);
      if (!fromEl || !toEl) continue;
      const handler = () => applyRange(parseEU(fromEl.value) || simBounds().from, parseEU(toEl.value) || simBounds().to);
      fromEl.addEventListener("change", handler);
      toEl.addEventListener("change", handler);
    }
    document.getElementById("prev-range").addEventListener("click", () => {
      const { from, to } = state.tsRange;
      const span = (new Date(to + "T00:00:00Z") - new Date(from + "T00:00:00Z")) / 86400000 + 1;
      applyRange(addDays(from, -span), addDays(to, -span));
    });
    document.getElementById("next-range").addEventListener("click", () => {
      const { from, to } = state.tsRange;
      const span = (new Date(to + "T00:00:00Z") - new Date(from + "T00:00:00Z")) / 86400000 + 1;
      applyRange(addDays(from, span), addDays(to, span));
    });
    document.querySelectorAll(".preset").forEach((btn) => {
      btn.addEventListener("click", () => {
        const preset = btn.dataset.preset, sb = simBounds(), anchor = state.tsRange.to || sb.to;
        let from, to;
        if (preset === "1d") { from = anchor; to = anchor; }
        else if (preset === "1w") { to = anchor; from = addDays(anchor, -6); }
        else if (preset === "1mo") { to = anchor; from = addDays(anchor, -29); }
        else if (preset === "3mo") { to = anchor; from = addDays(anchor, -89); }
        else { from = sb.from; to = sb.to; }
        applyRange(from, to);
        document.querySelectorAll(".preset").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
      });
    });
  }

  // resize observer keeps charts crisp on container resize
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) { const div = entry.target; if (div._fullLayout) requestAnimationFrame(() => { if (div.isConnected && div._fullLayout) Plotly.Plots.resize(div); }); }
    });
    document.querySelectorAll(".chart").forEach((div) => ro.observe(div));
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
  const clearBtn = document.getElementById("clear-optim-runs");
  if (clearBtn) clearBtn.addEventListener("click", () => { state.optimRuns = []; saveOptimRuns(); renderOptimRuns(); });
  loadOptimRuns();
  renderOptimRuns();
  renderSensitivity(null); // empty state until the first ⚡ Optimise
  update();
})();
