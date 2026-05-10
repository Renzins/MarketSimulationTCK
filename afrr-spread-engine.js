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
//   setDayTypeFilter(filter)                   — "all" | "workday" | "weekend-holiday"
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
  let spread_w = null;       // winsorized — DIRECTION-SPECIFIC (charts 1-6)
  let spread_w_all = null;   // winsorized with direction='all' (charts 7-9, matched-by-DA)
  let cachedKey = null;      // for spread_w
  let cachedKeyAll = null;   // for spread_w_all
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
    spread_w = new Float32Array(P.n);     // direction-specific winsor
    spread_w_all = new Float32Array(P.n); // 'all'-direction winsor (matched-by-DA)
    cachedKey = null;
    cachedKeyAll = null;
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

  // ---------- day-type filter --------------------------------------------
  // Mirrors GraphsEngine / AfrrEngine. Reads Engine.getData().dayTypeMask.
  // Affects ISP-level edge derivation, pre-classification, and winsor
  // percentiles (so a "workday only" view's box bounds aren't dragged by
  // weekend / holiday outliers). Cache key invalidation is handled via the
  // _dayTypeFilter portion of each cache key — no manual invalidation here.
  let _dayTypeFilter = "all";
  function setDayTypeFilter(filter) {
    _dayTypeFilter = filter || "all";
  }
  function _acceptsDay(i) {
    if (_dayTypeFilter === "all") return true;
    const v = D.dayTypeMask[i];
    if (_dayTypeFilter === "workday") return v === 0;
    return v !== 0; // 'weekend-holiday'
  }

  // --------- winsorization ------------------------------------------------
  // Two buffers:
  //   spread_w     — winsorized per current direction (charts 1-6)
  //   spread_w_all — winsorized with direction='all' (matched-by-DA charts 7-9,
  //                  which are direction-agnostic by design; using 'all' bounds
  //                  keeps their values stable across direction toggles so the
  //                  graphs-app cache layer can safely skip recomputation).
  // Both use a 2-pass typed-array collection (count → allocate → fill) instead
  // of a plain `[].push()` loop; this is several×× faster for ~4 M entries.

  function _interp(sorted, idx) {
    const a = Math.floor(idx);
    const b = Math.ceil(idx);
    return a === b ? sorted[a] : sorted[a] + (sorted[b] - sorted[a]) * (idx - a);
  }

  function _winsorizeRange(kStart, kEnd, win, pLow, pHigh, dest) {
    // Pass 1: count entries inside window AND matching the day-type filter.
    let n = 0;
    for (let k = kStart; k < kEnd; k++) {
      const i = P.isp_idx[k];
      if (i >= win.start && i < win.end && _acceptsDay(i)) n++;
    }
    if (n === 0) {
      dest.set(P.spread_raw); // clip nothing
      return;
    }
    // Pass 2: fill typed buffer (same filter).
    const sorted = new Float32Array(n);
    let off = 0;
    for (let k = kStart; k < kEnd; k++) {
      const i = P.isp_idx[k];
      if (i >= win.start && i < win.end && _acceptsDay(i)) sorted[off++] = P.spread_raw[k];
    }
    sorted.sort();
    const lo = _interp(sorted, (pLow / 100) * (n - 1));
    const hi = _interp(sorted, (pHigh / 100) * (n - 1));
    for (let k = 0; k < P.n; k++) {
      const v = P.spread_raw[k];
      dest[k] = v < lo ? lo : v > hi ? hi : v;
    }
  }

  function maybeWinsorize(pLow, pHigh, direction = "all") {
    if (!P) return;
    const win = Engine.getWindow();
    const key = `${win.start}-${win.end}-${pLow}-${pHigh}-${direction}-${_dayTypeFilter}`;
    if (key === cachedKey) return;
    const [kStart, kEnd] = _dirRange(direction);
    _winsorizeRange(kStart, kEnd, win, pLow, pHigh, spread_w);
    cachedKey = key;
  }

  // Direction-independent winsor for matched-by-DA charts. Always uses 'all'.
  function maybeWinsorizeAll(pLow, pHigh) {
    if (!P) return;
    const win = Engine.getWindow();
    const key = `${win.start}-${win.end}-${pLow}-${pHigh}-${_dayTypeFilter}`;
    if (key === cachedKeyAll) return;
    _winsorizeRange(0, P.n, win, pLow, pHigh, spread_w_all);
    cachedKeyAll = key;
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
  // Accepts a Float32Array (sorted in place — caller must not reuse afterwards)
  // or any array-like (which is copied into a Float32Array first).
  function boxStats(values) {
    if (values.length === 0) {
      return {
        min: 0, q1: 0, median: 0, q3: 0, max: 0,
        mean: 0, std: 0, n: 0, outliers: [],
      };
    }
    const arr = values instanceof Float32Array ? values : Float32Array.from(values);
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

  // --------- FUSED 6-chart pass (graphs 1-6) ------------------------------
  // Produces all four 1-D regime/axis box-plot datasets AND both heatmap
  // datasets in a SINGLE pair of passes over the price array (one to count
  // entries per bucket, one to fill typed-array buckets), instead of the
  // previous six independent passes.
  //
  // Returns:
  //   {
  //     wind:    { surplus: <BoxBucketResult>, deficit: <BoxBucketResult> },
  //     solar:   { surplus: <BoxBucketResult>, deficit: <BoxBucketResult> },
  //     heatmap: { surplus: <HeatmapResult>,    deficit: <HeatmapResult>    },
  //   }
  // where shapes match what spreadByAxisRegime / spreadByWindSolarRegime used
  // to return individually, so the chart drawers don't need to change.
  function spreadByAxisAllRegimes(windBins, solarBins, direction = "all") {
    const win = Engine.getWindow();
    const imb = D.baltic_imb_vol;
    const wDA = D.baltic_wind_da;
    const sDA = D.baltic_solar_da;

    // --- Step 1: ISP-level edges, regime-restricted (cheap, 6 walks of 43k).
    // Day-type filter narrows the contributing ISPs so that bin boundaries
    // describe the workday (or weekend+holiday) distribution rather than
    // the full window's.
    const wSurpVals = [], wDefVals = [];
    const sSurpVals = [], sDefVals = [];
    for (let i = win.start; i < win.end; i++) {
      if (!_acceptsDay(i)) continue;
      const iv = imb[i];
      if (isNaN(iv)) continue;
      if (iv >= _balticSurplus) {
        wSurpVals.push(wDA[i]); sSurpVals.push(sDA[i]);
      } else if (iv <= _balticDeficit) {
        wDefVals.push(wDA[i]); sDefVals.push(sDA[i]);
      }
    }
    const eWindSurp = quantileEdges(wSurpVals, windBins, "MW");
    const eWindDef  = quantileEdges(wDefVals,  windBins, "MW");
    const eSolarSurp = quantileEdges(sSurpVals, solarBins, "MW");
    const eSolarDef  = quantileEdges(sDefVals,  solarBins, "MW");

    // --- Step 2: Pre-classify each ISP's regime and bin indices. Looking
    // these up via Uint8Arrays in the hot loop is ~10× faster than the
    // float-compare + binary search per entry.
    const N = imb.length;
    // ispRegime[i]: 0 = neither, 1 = surplus, 2 = deficit
    const ispRegime = new Uint8Array(N);
    // For surplus ISPs: wind/solar bin indices using surplus edges.
    // For deficit ISPs: wind/solar bin indices using deficit edges.
    const ispWBin = new Uint8Array(N);
    const ispSBin = new Uint8Array(N);
    for (let i = win.start; i < win.end; i++) {
      // ispRegime defaults to 0 ("neither") — leave it that way for ISPs
      // filtered out by day-type, so the price-entry passes below skip
      // them via the existing `r === 0` early-out.
      if (!_acceptsDay(i)) continue;
      const iv = imb[i];
      if (isNaN(iv)) continue;
      if (iv >= _balticSurplus) {
        ispRegime[i] = 1;
        ispWBin[i] = binIndex(wDA[i], eWindSurp.edges);
        ispSBin[i] = binIndex(sDA[i], eSolarSurp.edges);
      } else if (iv <= _balticDeficit) {
        ispRegime[i] = 2;
        ispWBin[i] = binIndex(wDA[i], eWindDef.edges);
        ispSBin[i] = binIndex(sDA[i], eSolarDef.edges);
      }
    }

    const [kStart, kEnd] = _dirRange(direction);

    // --- Step 3: Pass 1 — count entries per bucket.
    const cntWS = new Int32Array(windBins),  cntWD = new Int32Array(windBins);
    const cntSS = new Int32Array(solarBins), cntSD = new Int32Array(solarBins);
    const cntHS = new Int32Array(windBins * solarBins);
    const cntHD = new Int32Array(windBins * solarBins);
    for (let k = kStart; k < kEnd; k++) {
      const i = P.isp_idx[k];
      if (i < win.start || i >= win.end) continue;
      const r = ispRegime[i];
      if (r === 0) continue;
      const wB = ispWBin[i];
      const sB = ispSBin[i];
      if (r === 1) {
        cntWS[wB]++; cntSS[sB]++; cntHS[sB * windBins + wB]++;
      } else {
        cntWD[wB]++; cntSD[sB]++; cntHD[sB * windBins + wB]++;
      }
    }

    // --- Step 4: Allocate typed-array buckets sized to the counts.
    const alloc = (counts) => {
      const out = new Array(counts.length);
      for (let i = 0; i < counts.length; i++) out[i] = new Float32Array(counts[i]);
      return out;
    };
    const wsBuf = alloc(cntWS), wdBuf = alloc(cntWD);
    const ssBuf = alloc(cntSS), sdBuf = alloc(cntSD);
    const hsBuf = alloc(cntHS), hdBuf = alloc(cntHD);
    // Per-bucket write offsets.
    const offWS = new Int32Array(windBins),  offWD = new Int32Array(windBins);
    const offSS = new Int32Array(solarBins), offSD = new Int32Array(solarBins);
    const offHS = new Int32Array(windBins * solarBins);
    const offHD = new Int32Array(windBins * solarBins);

    // --- Step 5: Pass 2 — fill the buckets.
    for (let k = kStart; k < kEnd; k++) {
      const i = P.isp_idx[k];
      if (i < win.start || i >= win.end) continue;
      const r = ispRegime[i];
      if (r === 0) continue;
      const wB = ispWBin[i];
      const sB = ispSBin[i];
      const sw = spread_w[k];
      if (r === 1) {
        wsBuf[wB][offWS[wB]++] = sw;
        ssBuf[sB][offSS[sB]++] = sw;
        const hi = sB * windBins + wB;
        hsBuf[hi][offHS[hi]++] = sw;
      } else {
        wdBuf[wB][offWD[wB]++] = sw;
        sdBuf[sB][offSD[sB]++] = sw;
        const hi = sB * windBins + wB;
        hdBuf[hi][offHD[hi]++] = sw;
      }
    }

    // --- Step 6: Compute box stats per bucket (sort happens in place).
    const sumI32 = (arr) => {
      let s = 0;
      for (let i = 0; i < arr.length; i++) s += arr[i];
      return s;
    };
    const reshapeHm = (bufs) => {
      const cells = new Array(solarBins);
      for (let s = 0; s < solarBins; s++) {
        cells[s] = new Array(windBins);
        for (let w = 0; w < windBins; w++) {
          cells[s][w] = boxStats(bufs[s * windBins + w]);
        }
      }
      return cells;
    };

    return {
      wind: {
        surplus: { labels: eWindSurp.labels, edges: eWindSurp.edges,
                   boxes: wsBuf.map(boxStats), totalN: sumI32(cntWS) },
        deficit: { labels: eWindDef.labels,  edges: eWindDef.edges,
                   boxes: wdBuf.map(boxStats), totalN: sumI32(cntWD) },
      },
      solar: {
        surplus: { labels: eSolarSurp.labels, edges: eSolarSurp.edges,
                   boxes: ssBuf.map(boxStats), totalN: sumI32(cntSS) },
        deficit: { labels: eSolarDef.labels,  edges: eSolarDef.edges,
                   boxes: sdBuf.map(boxStats), totalN: sumI32(cntSD) },
      },
      heatmap: {
        surplus: { wind: eWindSurp, solar: eSolarSurp, cells: reshapeHm(hsBuf) },
        deficit: { wind: eWindDef,  solar: eSolarDef,  cells: reshapeHm(hdBuf) },
      },
    };
  }

  // --------- 1-D bucketed box stats (graphs 1-4) --------------------------
  // axis: 'wind' | 'solar'; regime: 'surplus' | 'deficit'
  // direction: 'all' | 'pos' | 'neg'
  // Each price entry's bin is determined by its ISP's wind/solar value.
  // (Kept for back-compat / direct callers; the active app path now uses
  //  spreadByAxisAllRegimes which fuses all 6 charts into one pair of passes.)
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
      if (!_acceptsDay(i)) continue;
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
      if (!_acceptsDay(i)) continue;
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
      if (!_acceptsDay(i)) continue;
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
      if (!_acceptsDay(i)) continue;
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
  // Uses spread_w_all (direction-independent winsor) so results are stable
  // across direction toggles — letting the caller cache them.
  function absSpreadMatchedByDA(daBins, levels, levelFn, levelUnit = "MW") {
    const win = Engine.getWindow();
    const N = D.baltic_imb_vol.length;
    // Edges — only ISPs matching the day-type filter contribute. Allocate
    // to the max possible length and trim with subarray() before passing
    // into quantileEdges (it accepts any iterable / typed-array).
    const maxLen = win.end - win.start;
    const daIspVals = new Float32Array(maxLen);
    const levelIspVals = new Float32Array(maxLen);
    // ispAccept[i] = 1 if this ISP passes the day-type filter; the
    // price-entry passes below use this flag to drop entries belonging to
    // filtered-out ISPs (instead of polluting the (0,0) cell with their
    // default-zero bin indices).
    const ispAccept = new Uint8Array(N);
    let ispCount = 0;
    for (let i = win.start; i < win.end; i++) {
      if (!_acceptsDay(i)) continue;
      ispAccept[i] = 1;
      daIspVals[ispCount] = D.p_da[i];
      levelIspVals[ispCount] = levelFn(i);
      ispCount++;
    }
    const daSlice = ispCount === maxLen ? daIspVals : daIspVals.subarray(0, ispCount);
    const lvlSlice = ispCount === maxLen ? levelIspVals : levelIspVals.subarray(0, ispCount);
    const DA = quantileEdges(daSlice, daBins, "€");
    const L = quantileEdges(lvlSlice, levels, levelUnit);

    // Pre-compute (DA bin, level bin) per ACCEPTED ISP. Filtered-out ISPs
    // keep dBin=lBin=0 (the array default) but ispAccept=0 prevents their
    // price entries from feeding cell (0,0).
    const dBin = new Uint8Array(N);
    const lBin = new Uint8Array(N);
    for (let i = win.start; i < win.end; i++) {
      if (!ispAccept[i]) continue;
      dBin[i] = binIndex(D.p_da[i], DA.edges);
      lBin[i] = binIndex(levelFn(i), L.edges);
    }

    // Pass 1: count entries per (DA, level) cell.
    const cnt = new Int32Array(daBins * levels);
    for (let k = 0; k < P.n; k++) {
      const i = P.isp_idx[k];
      if (i < win.start || i >= win.end) continue;
      if (!ispAccept[i]) continue;
      cnt[dBin[i] * levels + lBin[i]]++;
    }

    // Allocate typed-array buckets sized to the counts.
    const buf = new Array(daBins * levels);
    for (let idx = 0; idx < buf.length; idx++) buf[idx] = new Float32Array(cnt[idx]);
    const off = new Int32Array(daBins * levels);

    // Pass 2: fill with absolute spread (using direction-independent winsor).
    const src = spread_w_all;
    for (let k = 0; k < P.n; k++) {
      const i = P.isp_idx[k];
      if (i < win.start || i >= win.end) continue;
      if (!ispAccept[i]) continue;
      const idx = dBin[i] * levels + lBin[i];
      buf[idx][off[idx]++] = Math.abs(src[k]);
    }

    const panels = new Array(daBins);
    for (let b = 0; b < daBins; b++) {
      const boxes = new Array(levels);
      for (let l = 0; l < levels; l++) boxes[l] = boxStats(buf[b * levels + l]);
      panels[b] = { daLabel: DA.labels[b], boxes };
    }
    return {
      daLabels: DA.labels,
      daEdges: DA.edges,
      levelLabels: L.labels,
      levelEdges: L.edges,
      panels,
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
    setDayTypeFilter,
    maybeWinsorize,
    maybeWinsorizeAll,
    spreadByAxisRegime,        // legacy single-chart API (unused by app, kept for tests)
    spreadByWindSolarRegime,   // legacy single-chart API
    spreadByAxisAllRegimes,    // FUSED — produces the 6 regime/axis charts in 2 passes
    absSpreadMatchedByDA,
    absSpreadByWindMatchedByDABand,
    absSpreadBySolarMatchedByDABand,
    absSpreadByRenewablesMatchedByDABand,
  };
})();

if (typeof module !== "undefined") module.exports = AfrrSpreadEngine;
