// afrr-spread-engine.js — pure data layer for the aFRR PRICE / SPREAD charts.
//
// Distinct from afrr-engine.js (which only deals with activation COUNTS) —
// this module operates on the per-4-second spread file (data-afrr-prices.js,
// ~86 MB, lazy-loaded). The mFRR-spread chart drawers (drawSpreadByBucket /
// drawWindSolarHeatmap / drawAbsSpreadMatchedPanels in graphs-charts.js) are
// reused as-is — this module just produces the same `result` shape they
// already accept.
//
// SPREAD CONVENTION (merged across both aFRR directions by default)
//   spread = AST_POS - P_DA   (when AST_POS non-null, "upward" price)
//          OR
//   spread = AST_NEG - P_DA   (when AST_NEG non-null, "downward" price)
// A 4-second slot with both prices active produces two entries (one each
// for POS and NEG). The price file lays them out as POS entries first,
// then NEG entries, with the boundary stored in P.n_pos_entries.
//
// DIRECTION FILTER
//   Every signed-spread function accepts an optional `direction` argument:
//     'all' — every entry (default; merged distribution)
//     'pos' — only POS entries (AST_POS, "upward")
//     'neg' — only NEG entries (AST_NEG, "downward")
//   Implemented as iteration bounds [kStart, kEnd) over the price arrays,
//   so it adds no per-entry overhead. Winsorization is computed *per
//   direction* (so toggling direction recomputes the bounds), giving a
//   tight box-plot Y range for each view.
//
//   The matched-by-DA |spread| charts (graphs 7-9) are intentionally NOT
//   direction-aware — they look at absolute spread, where direction is
//   already abstracted away.
//
// REGIME CLASSIFICATION
//   This section uses Baltic-level imbalance only (per the user's instruction
//   for these graphs). The threshold pair is reused from afrr-engine.js's
//   Baltic thresholds so changes in the Setup card propagate consistently.
//
// EXPORTS
//   isLoaded()                                 — true if AFRR_PRICES global exists
//   init()                                     — wrap the global into typed arrays
//   maybeWinsorize(pLo, pHi)                   — winsorize spreads within window
//   spreadByAxisRegime(axis, regime, n)        — 1-D bucketed box stats (mirrors GraphsEngine)
//   spreadByWindSolarRegime(regime, w, s)      — 2-D heatmap stats
//   absSpreadMatchedByDA(daBins, levels, fn)   — 5-panel grouped boxes (any level fn)
//   absSpreadByWindMatchedByDABand(da, n)      — wrapper: level = baltic_wind_da
//   absSpreadBySolarMatchedByDABand(da, n)     — wrapper: level = baltic_solar_da
//   absSpreadByRenewablesMatchedByDABand(da,n) — wrapper: level = wind+solar
//
// All functions respect Engine.getWindow() so the date range from the
// Setup card filters the price data the same way it filters the count data.

const AfrrSpreadEngine = (() => {
  let D = null; // main Engine.getData() reference
  let P = null; // typed-array view of AFRR_PRICES
  let spread_w = null; // winsorized spread copy
  let cachedKey = null;
  // Quartile-bin labels are derived from the same wind / solar buckets the
  // mFRR section uses (per ISP), but each spread inherits its bin from its
  // ISP's wind/solar value at preprocess time — no per-slot wind/solar info
  // is needed in the price file.

  function isLoaded() {
    return typeof AFRR_PRICES !== "undefined" && AFRR_PRICES !== null;
  }

  function init() {
    if (!isLoaded()) return false;
    D = Engine.getData();
    if (!D.lv_imb_vol && WIND_DATA.lv_imb_vol) {
      D.lv_imb_vol = new Float32Array(WIND_DATA.lv_imb_vol);
    }
    if (!D.baltic_wind_da) {
      D.baltic_wind_da = new Float32Array(WIND_DATA.baltic_wind_da);
      D.baltic_solar_da = new Float32Array(WIND_DATA.baltic_solar_da);
      D.baltic_imb_vol = new Float32Array(WIND_DATA.baltic_imb_vol);
    }
    P = {
      n: AFRR_PRICES.n_entries,
      // POS entries occupy [0, n_pos_entries); NEG entries occupy
      // [n_pos_entries, n). Older preprocessor files may not have this key,
      // in which case all entries are treated as the merged "all" view.
      n_pos_entries: AFRR_PRICES.n_pos_entries ?? AFRR_PRICES.n_entries,
      isp_idx: new Int32Array(AFRR_PRICES.isp_idx),
      // spreads were stored as integer ×10 fixed-point — restore to float
      _spread_x10: new Int32Array(AFRR_PRICES.spread_x10),
    };
    P.spread_raw = new Float32Array(P.n);
    for (let k = 0; k < P.n; k++) P.spread_raw[k] = P._spread_x10[k] / 10;
    spread_w = new Float32Array(P.n); // winsorised buffer
    cachedKey = null;
    return true;
  }

  // Return [kStart, kEnd) for the price-array iteration given a direction.
  function _dirRange(direction) {
    if (direction === "pos") return [0, P.n_pos_entries];
    if (direction === "neg") return [P.n_pos_entries, P.n];
    return [0, P.n];
  }

  // --------- regime thresholds (read-only mirror — set on AfrrEngine) -----
  // These are read fresh from AfrrEngine each call so the user can change
  // them via the Setup card without having to call a setter here.
  let _balticDeficit = -30;
  let _balticSurplus = +30;
  function setBalticThresholds(d, s) {
    _balticDeficit = d;
    _balticSurplus = s;
    cachedKey = null; // because regimes change which entries enter winsor
  }

  // --------- winsorization ------------------------------------------------
  // We winsorize per-direction so that each view (All / POS / NEG) has its
  // own tight Y range. Cache key includes direction.
  function maybeWinsorize(pLow, pHigh, direction = "all") {
    if (!P) return;
    const win = Engine.getWindow();
    const key = `${win.start}-${win.end}-${pLow}-${pHigh}-${direction}`;
    if (key === cachedKey) return;
    const [kStart, kEnd] = _dirRange(direction);
    // Collect spreads that belong to ISPs in the window AND match the direction
    const buf = [];
    for (let k = kStart; k < kEnd; k++) {
      const i = P.isp_idx[k];
      if (i >= win.start && i < win.end) buf.push(P.spread_raw[k]);
    }
    if (buf.length === 0) {
      // Fall back: clip nothing
      for (let k = 0; k < P.n; k++) spread_w[k] = P.spread_raw[k];
      cachedKey = key;
      return;
    }
    const sorted = Float32Array.from(buf);
    sorted.sort();
    const interp = (idx) => {
      const a = Math.floor(idx);
      const b = Math.ceil(idx);
      return a === b
        ? sorted[a]
        : sorted[a] + (sorted[b] - sorted[a]) * (idx - a);
    };
    const lo = interp((pLow / 100) * (sorted.length - 1));
    const hi = interp((pHigh / 100) * (sorted.length - 1));
    // Apply to all entries (we only iterate the relevant range later, but
    // keeping the full array clipped means if direction is toggled we still
    // have valid winsorized values everywhere — they'll get refreshed on
    // the next maybeWinsorize call anyway).
    for (let k = 0; k < P.n; k++) {
      const v = P.spread_raw[k];
      spread_w[k] = v < lo ? lo : v > hi ? hi : v;
    }
    cachedKey = key;
  }

  // --------- core: collect spreads matching a regime + filter -------------
  // For each price entry k, look up its ISP's baltic_imb_vol; include if it
  // matches the requested regime. Returns an array of spread values.
  function _spreadsInRegime(regime) {
    const win = Engine.getWindow();
    const out = [];
    if (!P) return out;
    const imb = D.baltic_imb_vol;
    for (let k = 0; k < P.n; k++) {
      const i = P.isp_idx[k];
      if (i < win.start || i >= win.end) continue;
      const iv = imb[i];
      if (isNaN(iv)) continue;
      const s = spread_w[k];
      if (regime === "surplus" && iv >= _balticSurplus) out.push(s);
      else if (regime === "deficit" && iv <= _balticDeficit) out.push(s);
    }
    return out;
  }

  // --------- box-plot stats (re-implementation matching graphs-engine.js) -
  function boxStats(values) {
    if (values.length === 0) {
      return {
        min: 0, q1: 0, median: 0, q3: 0, max: 0,
        mean: 0, std: 0, n: 0, outliers: [],
      };
    }
    const arr = Float32Array.from(values);
    arr.sort();
    const n = arr.length;
    const quant = (p) => {
      const idx = (p / 100) * (n - 1);
      const a = Math.floor(idx);
      const b = Math.ceil(idx);
      return a === b ? arr[a] : arr[a] + (arr[b] - arr[a]) * (idx - a);
    };
    const q1 = quant(25);
    const median = quant(50);
    const q3 = quant(75);
    const iqr = q3 - q1;
    const lowFence = q1 - 1.5 * iqr;
    const highFence = q3 + 1.5 * iqr;
    let whiskerLow = q1, whiskerHigh = q3;
    const outliers = [];
    for (let i = 0; i < n; i++) {
      const v = arr[i];
      if (v < lowFence || v > highFence) outliers.push(v);
      else {
        if (v < whiskerLow) whiskerLow = v;
        if (v > whiskerHigh) whiskerHigh = v;
      }
    }
    let sum = 0;
    for (let i = 0; i < n; i++) sum += arr[i];
    const mean = sum / n;
    let varSum = 0;
    for (let i = 0; i < n; i++) {
      const d = arr[i] - mean;
      varSum += d * d;
    }
    const std = n > 1 ? Math.sqrt(varSum / (n - 1)) : 0;
    return { min: whiskerLow, q1, median, q3, max: whiskerHigh, mean, std, n, outliers };
  }

  // --------- quantile edges, mirrored from graphs-engine.js ---------------
  function quantileEdges(values, nBins, unit = "MW") {
    if (nBins < 2) nBins = 2;
    if (values.length === 0) {
      return {
        edges: new Array(nBins + 1).fill(0),
        labels: new Array(nBins).fill("(no data)"),
      };
    }
    const sorted = Float32Array.from(values);
    sorted.sort();
    const edges = new Array(nBins + 1);
    edges[0] = sorted[0];
    edges[nBins] = sorted[sorted.length - 1];
    for (let k = 1; k < nBins; k++) {
      const idx = (k / nBins) * (sorted.length - 1);
      const a = Math.floor(idx);
      const b = Math.ceil(idx);
      edges[k] = a === b ? sorted[a] : sorted[a] + (sorted[b] - sorted[a]) * (idx - a);
    }
    const fmt = (v) => {
      if (Math.abs(v) < 100) return v.toFixed(1);
      return Math.round(v).toLocaleString("en-US");
    };
    const labels = new Array(nBins);
    for (let k = 0; k < nBins; k++) {
      if (k === 0) labels[k] = `≤${fmt(edges[1])} ${unit}`;
      else if (k === nBins - 1) labels[k] = `>${fmt(edges[nBins - 1])} ${unit}`;
      else labels[k] = `${fmt(edges[k])}–${fmt(edges[k + 1])} ${unit}`;
    }
    return { edges, labels };
  }
  function binIndex(v, edges) {
    const N = edges.length - 1;
    for (let k = 0; k < N - 1; k++) {
      if (v <= edges[k + 1]) return k;
    }
    return N - 1;
  }

  // --------- 1-D bucketed box stats (graphs 1-4) --------------------------
  // axis: 'wind' | 'solar'; regime: 'surplus' | 'deficit'
  // direction: 'all' | 'pos' | 'neg'
  // Each price entry's bin is determined by its ISP's wind/solar value.
  function spreadByAxisRegime(axis, regime, nBins, direction = "all") {
    const win = Engine.getWindow();
    const valArr = axis === "wind" ? D.baltic_wind_da : D.baltic_solar_da;
    const imb = D.baltic_imb_vol;
    // Step 1 — find quantile edges from the ISP-level distribution restricted
    // to the regime (so bin sizes are regime-specific, matching the mFRR
    // section's behaviour). Direction filtering doesn't affect ISP-level
    // edges — they describe the wind/solar distribution of qualifying ISPs.
    const ispVals = [];
    for (let i = win.start; i < win.end; i++) {
      const iv = imb[i];
      if (isNaN(iv)) continue;
      if (regime === "surplus" && iv < _balticSurplus) continue;
      if (regime === "deficit" && iv > _balticDeficit) continue;
      ispVals.push(valArr[i]);
    }
    const { edges, labels } = quantileEdges(ispVals, nBins, "MW");

    // Step 2 — drop each price entry (within direction-filtered range) into
    // its ISP's bucket.
    const [kStart, kEnd] = _dirRange(direction);
    const buckets = Array.from({ length: nBins }, () => []);
    let totalN = 0;
    for (let k = kStart; k < kEnd; k++) {
      const i = P.isp_idx[k];
      if (i < win.start || i >= win.end) continue;
      const iv = imb[i];
      if (isNaN(iv)) continue;
      if (regime === "surplus" && iv < _balticSurplus) continue;
      if (regime === "deficit" && iv > _balticDeficit) continue;
      const b = binIndex(valArr[i], edges);
      buckets[b].push(spread_w[k]);
      totalN++;
    }
    return { labels, edges, boxes: buckets.map(boxStats), totalN };
  }

  // --------- 2-D heatmap stats (graphs 5-6) -------------------------------
  // direction: 'all' | 'pos' | 'neg'
  function spreadByWindSolarRegime(regime, windBins, solarBins, direction = "all") {
    const win = Engine.getWindow();
    const imb = D.baltic_imb_vol;
    // Edges from the regime-restricted ISP-level distribution
    const wIspVals = [];
    const sIspVals = [];
    for (let i = win.start; i < win.end; i++) {
      const iv = imb[i];
      if (isNaN(iv)) continue;
      if (regime === "surplus" && iv < _balticSurplus) continue;
      if (regime === "deficit" && iv > _balticDeficit) continue;
      wIspVals.push(D.baltic_wind_da[i]);
      sIspVals.push(D.baltic_solar_da[i]);
    }
    const W = quantileEdges(wIspVals, windBins, "MW");
    const S = quantileEdges(sIspVals, solarBins, "MW");
    const cells = Array.from({ length: solarBins }, () =>
      Array.from({ length: windBins }, () => []),
    );
    const [kStart, kEnd] = _dirRange(direction);
    for (let k = kStart; k < kEnd; k++) {
      const i = P.isp_idx[k];
      if (i < win.start || i >= win.end) continue;
      const iv = imb[i];
      if (isNaN(iv)) continue;
      if (regime === "surplus" && iv < _balticSurplus) continue;
      if (regime === "deficit" && iv > _balticDeficit) continue;
      const wB = binIndex(D.baltic_wind_da[i], W.edges);
      const sB = binIndex(D.baltic_solar_da[i], S.edges);
      cells[sB][wB].push(spread_w[k]);
    }
    return { wind: W, solar: S, cells: cells.map((row) => row.map(boxStats)) };
  }

  // --------- |spread| matched by DA price band (graph 7-9) ----------------
  // levelFn(i) returns the level value (wind / solar / wind+solar) for ISP i.
  function absSpreadMatchedByDA(daBins, levels, levelFn, levelUnit = "MW") {
    const win = Engine.getWindow();
    // Edges
    const daIspVals = [];
    const levelIspVals = [];
    for (let i = win.start; i < win.end; i++) {
      // No regime filter — this view is across the whole window
      daIspVals.push(D.p_da[i]);
      levelIspVals.push(levelFn(i));
    }
    const DA = quantileEdges(daIspVals, daBins, "€");
    const L = quantileEdges(levelIspVals, levels, levelUnit);
    const panels = Array.from({ length: daBins }, (_, b) => ({
      daLabel: DA.labels[b],
      boxesByLevel: Array.from({ length: levels }, () => []),
    }));
    for (let k = 0; k < P.n; k++) {
      const i = P.isp_idx[k];
      if (i < win.start || i >= win.end) continue;
      const dB = binIndex(D.p_da[i], DA.edges);
      const lB = binIndex(levelFn(i), L.edges);
      panels[dB].boxesByLevel[lB].push(Math.abs(spread_w[k]));
    }
    return {
      daLabels: DA.labels,
      daEdges: DA.edges,
      levelLabels: L.labels,
      levelEdges: L.edges,
      panels: panels.map((p) => ({
        daLabel: p.daLabel,
        boxes: p.boxesByLevel.map(boxStats),
      })),
    };
  }
  function absSpreadByWindMatchedByDABand(daBins, levels) {
    return absSpreadMatchedByDA(daBins, levels, (i) => D.baltic_wind_da[i], "MW");
  }
  function absSpreadBySolarMatchedByDABand(daBins, levels) {
    return absSpreadMatchedByDA(daBins, levels, (i) => D.baltic_solar_da[i], "MW");
  }
  function absSpreadByRenewablesMatchedByDABand(daBins, levels) {
    return absSpreadMatchedByDA(
      daBins,
      levels,
      (i) => D.baltic_wind_da[i] + D.baltic_solar_da[i],
      "MW",
    );
  }

  return {
    isLoaded,
    init,
    setBalticThresholds,
    maybeWinsorize,
    spreadByAxisRegime,
    spreadByWindSolarRegime,
    absSpreadMatchedByDA,
    absSpreadByWindMatchedByDABand,
    absSpreadBySolarMatchedByDABand,
    absSpreadByRenewablesMatchedByDABand,
  };
})();

if (typeof module !== "undefined") module.exports = AfrrSpreadEngine;
