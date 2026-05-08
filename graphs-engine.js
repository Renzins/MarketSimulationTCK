// graphs-engine.js — pure data layer for the Graphs page.
//
// Reads from the same WIND_DATA / Engine bootstrap as the Backtester (so the
// simulation window state is shared) but produces statistics for box plots
// and heatmaps instead of P&L.
//
// COLUMN CONVENTIONS
//   spread[i]   = p_mfrr[i] − p_da[i]                        (winsorized: spread_w)
//   regime[i]   = "surplus" if baltic_imb_vol[i] ≥ +surplus_threshold (default +30)
//                 "deficit" if baltic_imb_vol[i] ≤ −deficit_threshold (default −30)
//                 (everything between thresholds is the dead band, excluded)
//   wind[i]     = baltic_wind_da[i]   (sum of LV+EE+LT day-ahead wind, MW)
//   solar[i]    = baltic_solar_da[i]  (sum of LV+EE+LT day-ahead solar, MW)
//
// All percentile / quantile work uses the simulation window currently set by
// Engine.setWindow() — same window state the Backtester uses.
//
// EXPORTS
//   init()                                  — wrap baltic columns into Float32Arrays
//   maybeWinsorizeSpread(pLo, pHi)          — recompute spread_w within current window
//   setRegimeThresholds(deficit, surplus)   — module-level pair read by regimeIndices()
//   regimeIndices(regime)                   — global ISP indices in the regime
//   quantileEdges(values, n, unit)          — compute n+1 quantile edges + labels
//   boxStats(values)                        — {min, q1, median, q3, max, mean, std, n, outliers}
//   spreadByAxisRegime(axis, regime, n)     — 1-D bucketed box stats
//   spreadByWindSolarRegime(regime, w, s)   — 2-D bucketed box stats (heatmap cells)
//   absSpreadByWindMatchedByDABand(da, n)   — 5-panel grouped boxes (wind levels)
//   absSpreadBySolarMatchedByDABand(da, n)  — same with solar
//   absSpreadByRenewablesMatchedByDABand    — same with wind+solar
//
// IMPORTANT INVARIANTS
//   - boxStats() outliers use the standard 1.5·IQR fence rule.
//   - quantileEdges produces equal-count bins (each bin has ~N/k ISPs).
//   - regimeIndices SKIPS rows where baltic_imb_vol is NaN (defensive — the
//     dataset doesn't currently have any NaN baltic values, but keep this).

const GraphsEngine = (() => {
  // ---------- raw + winsorized arrays ------------------------------------
  let D = null;
  let spread = null; // raw spread
  let spread_w = null; // winsorized spread
  let cachedKey = null;

  function init() {
    D = Engine.getData();
    if (!D.baltic_wind_da) {
      // Lazily wrap into Float32Arrays (data.js stores plain arrays)
      D.baltic_wind_da = new Float32Array(WIND_DATA.baltic_wind_da);
      D.baltic_solar_da = new Float32Array(WIND_DATA.baltic_solar_da);
      D.baltic_imb_vol = new Float32Array(WIND_DATA.baltic_imb_vol);
      // LV-only imbalance volume (used by the aFRR section's LV-vs-Baltic
      // regime comparison). Older data.js may not have this key.
      if (WIND_DATA.lv_imb_vol) {
        D.lv_imb_vol = new Float32Array(WIND_DATA.lv_imb_vol);
      }
    }
    spread = new Float32Array(D.n);
    spread_w = new Float32Array(D.n);
    for (let i = 0; i < D.n; i++) {
      // Use raw mFRR price (so winsorization in the Graphs page is
      // independent of the Backtester's). mFRR_raw may contain NaN — keep.
      const m = D.p_mfrr_raw[i];
      const da = D.p_da[i];
      spread[i] = isNaN(m) ? NaN : m - da;
    }
    cachedKey = null;
  }

  // Compute the same winsor as Engine but on `spread`. Window is taken from
  // the shared Engine state.
  function maybeWinsorizeSpread(pLow, pHigh) {
    const win = Engine.getWindow();
    const key = `${win.start}-${win.end}-${pLow}-${pHigh}`;
    if (key === cachedKey) return;
    const buf = [];
    for (let i = win.start; i < win.end; i++) {
      const v = spread[i];
      if (!isNaN(v)) buf.push(v);
    }
    if (buf.length === 0) {
      for (let i = 0; i < D.n; i++) spread_w[i] = spread[i];
      cachedKey = key;
      return;
    }
    const sorted = Float32Array.from(buf);
    sorted.sort();
    const idxLo = (pLow / 100) * (sorted.length - 1);
    const idxHi = (pHigh / 100) * (sorted.length - 1);
    const interp = (idx) => {
      const a = Math.floor(idx);
      const b = Math.ceil(idx);
      if (a === b) return sorted[a];
      return sorted[a] + (sorted[b] - sorted[a]) * (idx - a);
    };
    const lo = interp(idxLo);
    const hi = interp(idxHi);
    for (let i = 0; i < D.n; i++) {
      const v = spread[i];
      if (isNaN(v)) {
        spread_w[i] = NaN;
      } else {
        spread_w[i] = v < lo ? lo : v > hi ? hi : v;
      }
    }
    cachedKey = key;
  }

  // ---------- regime mask -------------------------------------------------
  // Surplus = baltic_imb_vol >= surplusThr (default +30 MW)
  // Deficit = baltic_imb_vol <= deficitThr (default -30 MW)
  // Anything in (deficitThr, surplusThr) is the neutral / dead band and is
  // excluded from both surplus and deficit graphs.
  let _deficitThr = -30;
  let _surplusThr = 30;
  function setRegimeThresholds(deficitThr, surplusThr) {
    _deficitThr = deficitThr;
    _surplusThr = surplusThr;
  }
  function regimeIndices(regime) {
    const win = Engine.getWindow();
    const out = [];
    for (let i = win.start; i < win.end; i++) {
      const iv = D.baltic_imb_vol[i];
      if (isNaN(iv)) continue;
      if (regime === "surplus" && iv >= _surplusThr) out.push(i);
      else if (regime === "deficit" && iv <= _deficitThr) out.push(i);
      else if (regime === "all") out.push(i);
    }
    return out;
  }

  // ---------- quantile binning -------------------------------------------
  // Given an array of values and a bin count, returns:
  //   { edges: [b0, b1, ..., bN], labels: ["≤b1", "b1–b2", ..., ">bN-1"] }
  // Edges are quantile boundaries computed from the values.
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

  // Bin a value into one of N bins given N+1 edges. Returns 0..N-1.
  // Lower edge inclusive, upper edge inclusive on the last bin.
  function binIndex(v, edges) {
    const N = edges.length - 1;
    for (let k = 0; k < N - 1; k++) {
      if (v <= edges[k + 1]) return k;
    }
    return N - 1;
  }

  // ---------- box-plot statistics for an array of values ---------------
  // Returns { min, q1, median, q3, max, mean, std, n, outliers }.
  // Outliers = values outside [q1-1.5*IQR, q3+1.5*IQR]. min/max are the
  // whisker limits (closest non-outlier values to q1/q3).
  function boxStats(values) {
    if (values.length === 0) {
      return { min: 0, q1: 0, median: 0, q3: 0, max: 0, mean: 0, std: 0, n: 0, outliers: [] };
    }
    const arr = Float32Array.from(values);
    arr.sort();
    const n = arr.length;
    const quant = (p) => {
      const idx = (p / 100) * (n - 1);
      const a = Math.floor(idx);
      const b = Math.ceil(idx);
      if (a === b) return arr[a];
      return arr[a] + (arr[b] - arr[a]) * (idx - a);
    };
    const q1 = quant(25);
    const median = quant(50);
    const q3 = quant(75);
    const iqr = q3 - q1;
    const lowFence = q1 - 1.5 * iqr;
    const highFence = q3 + 1.5 * iqr;
    let whiskerLow = q1;
    let whiskerHigh = q3;
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

  // ---------- spread by 1-D buckets (graphs 1-4) ------------------------
  // axis: 'wind' or 'solar'
  // regime: 'surplus' | 'deficit'
  // nBins: number of buckets
  // Returns { labels, edges, boxes: [boxStats], totalN }
  function spreadByAxisRegime(axis, regime, nBins) {
    const idxs = regimeIndices(regime);
    const valArr = axis === "wind" ? D.baltic_wind_da : D.baltic_solar_da;
    const vals = new Array(idxs.length);
    for (let k = 0; k < idxs.length; k++) vals[k] = valArr[idxs[k]];
    const { edges, labels } = quantileEdges(vals, nBins, "MW");
    const buckets = Array.from({ length: nBins }, () => []);
    for (let k = 0; k < idxs.length; k++) {
      const i = idxs[k];
      const s = spread_w[i];
      if (isNaN(s)) continue;
      const b = binIndex(valArr[i], edges);
      buckets[b].push(s);
    }
    const boxes = buckets.map(boxStats);
    return { labels, edges, boxes, totalN: idxs.length };
  }

  // ---------- spread by 2-D bucket grid (graphs 5-6) -------------------
  // Returns { wind: {edges,labels}, solar: {edges,labels},
  //          cells: [[stats]] of shape [solar][wind] }
  function spreadByWindSolarRegime(regime, windBins, solarBins) {
    const idxs = regimeIndices(regime);
    const wVals = idxs.map((i) => D.baltic_wind_da[i]);
    const sVals = idxs.map((i) => D.baltic_solar_da[i]);
    const W = quantileEdges(wVals, windBins, "MW");
    const S = quantileEdges(sVals, solarBins, "MW");
    const buckets = Array.from({ length: solarBins }, () =>
      Array.from({ length: windBins }, () => []),
    );
    for (let k = 0; k < idxs.length; k++) {
      const i = idxs[k];
      const sp = spread_w[i];
      if (isNaN(sp)) continue;
      const wB = binIndex(D.baltic_wind_da[i], W.edges);
      const sB = binIndex(D.baltic_solar_da[i], S.edges);
      buckets[sB][wB].push(sp);
    }
    const cells = buckets.map((row) => row.map(boxStats));
    return { wind: W, solar: S, cells };
  }

  // ---------- |spread| matched by DA price band, by an arbitrary level ----
  // - DA bands derived from quantiles of p_da WITHIN the current window.
  // - "Levels" are quantile-binned values of `levelFn(i)` (wind, solar, or
  //   wind+solar). The binning is GLOBAL — independent of DA band — so
  //   panel-internal counts can be uneven (matches the PDF behaviour).
  // Returns { daLabels, daEdges, levelLabels, levelEdges,
  //          panels: [ { daLabel, boxes: [boxStats x levels] } ] }
  function absSpreadMatchedByDA(daBins, levels, levelFn, levelUnit = "MW") {
    const win = Engine.getWindow();
    const allIdx = [];
    for (let i = win.start; i < win.end; i++) {
      if (!isNaN(spread_w[i])) allIdx.push(i);
    }
    if (allIdx.length === 0) {
      return {
        daLabels: [],
        daEdges: [],
        levelLabels: [],
        levelEdges: [],
        panels: [],
      };
    }
    const daVals = allIdx.map((i) => D.p_da[i]);
    const levelVals = allIdx.map((i) => levelFn(i));
    const DA = quantileEdges(daVals, daBins, "€");
    const L = quantileEdges(levelVals, levels, levelUnit);
    const panels = Array.from({ length: daBins }, (_, b) => ({
      daLabel: DA.labels[b],
      boxesByLevel: Array.from({ length: levels }, () => []),
    }));
    for (let k = 0; k < allIdx.length; k++) {
      const i = allIdx[k];
      const dB = binIndex(D.p_da[i], DA.edges);
      const lB = binIndex(levelFn(i), L.edges);
      panels[dB].boxesByLevel[lB].push(Math.abs(spread_w[i]));
    }
    const out = panels.map((p) => ({
      daLabel: p.daLabel,
      boxes: p.boxesByLevel.map(boxStats),
    }));
    return {
      daLabels: DA.labels,
      daEdges: DA.edges,
      levelLabels: L.labels,
      levelEdges: L.edges,
      panels: out,
    };
  }

  // Convenience wrappers — wind / solar / renewables (wind + solar)
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
    init,
    maybeWinsorizeSpread,
    setRegimeThresholds,
    regimeIndices,
    quantileEdges,
    boxStats,
    spreadByAxisRegime,
    spreadByWindSolarRegime,
    absSpreadMatchedByDA,
    absSpreadByWindMatchedByDABand,
    absSpreadBySolarMatchedByDABand,
    absSpreadByRenewablesMatchedByDABand,
  };
})();

if (typeof module !== "undefined") module.exports = GraphsEngine;
