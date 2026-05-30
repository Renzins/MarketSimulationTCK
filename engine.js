// engine.js — pure simulation logic for the Vanessa wind-park Backtester.
//
// No DOM access. Reads from a pre-loaded WIND_DATA global plus a params
// object. Returns per-ISP arrays, totals and decompositions.
//
// UNIFIED ENGINE (post-rework)
// ============================
// There is no longer a Level 1 / Level 2 / Level 3 distinction inside the
// engine. A single simulate() always runs the full L3-style codepath
// (DA + mFRR + aFRR + imbalance/flat + S3 speculation). The legacy "levels"
// are now expressible via two source selectors in params:
//
//   actualSource:  'da' | 'id' | 'real'   — what feeds Q_pot
//   idSource:      'da' | 'real'          — what feeds the ID input to
//                                            the Z·(ID − F) revision
//
// And per-strategy enable flags in params.enabled:
//   daWithhold:  false → Y is forced to 0 (always sell full forecast to DA)
//   split:       false → s_up = s_dn = 1 (all volume to mFRR, never aFRR)
//   idTrust:     false → Z is forced to 0 (no ID revision)
//   s3:          false → s3_X_cap is forced to 0 (S3 leg disabled)
//
// Equivalences:
//   Legacy L1 ≡ actualSource='da', idSource='da', enabled.s3=false
//   Legacy L2 ≡ actualSource='real', idSource='real', enabled.s3=false
//   Legacy L3 ≡ actualSource='real', idSource='real', all enabled
//
// When (actualSource='da', idSource='da'), trustedRev = Z·(F−F) = 0 and
// Q_position ≤ floor(F) ≤ F = Q_pot, so short = 0 and imb/flat costs are
// structurally 0 — matching the legacy L1 result without an L1 flag.
//
// SIGN CONVENTIONS (verified by tests.py + the spec's two worked examples)
//   DA revenue:    Q_da_sold * P_da                           [≥ 0]
//   mFRR-up rev:   Q_up_mfrr * P_mfrr                         [+ when P_mfrr > 0]
//   mFRR-dn rev:   -Q_dn_mfrr * P_mfrr                        [+ when P_mfrr < 0]
//   aFRR-up rev:   Q_up_afrr * avg_p_pos                      [averaged 4-s POS price]
//   aFRR-dn rev:   -Q_dn_afrr * avg_p_neg                     [sign mirrors mFRR-dn]
//   Imbalance:    -Q_short * P_imb                            [cost when short]
//   Flat penalty: -Q_short * theta_flat
//   per-ISP rev = (DA + up + dn - imb - flat) * 0.25          [MW * h]
//
// MFRR ↔ AFRR SPLIT (two parameters: s_up, s_dn ∈ [0, 1]; 1 = all mFRR)
//   Round-and-remainder per direction:
//     Q_up_mfrr = round(s_up * Q_up_offer)      Q_up_afrr = Q_up_offer - Q_up_mfrr
//     Q_dn_mfrr = round(s_dn * Q_dn_offer)      Q_dn_afrr = Q_dn_offer - Q_dn_mfrr
//   With s_up = s_dn = 1 (default) both aFRR terms are 0. aFRR prices come
//   from data-afrr-15min.js: avg_p_pos[i] / avg_p_neg[i] are the
//   time-weighted means of AST_POS / AST_NEG over each ISP's 4-s slots,
//   with the FAVOURABLE-ONLY filter at preprocess time (see init() / the
//   preprocess-afrr-15min.py docstring).
//
// PHYSICAL CONSTRAINTS (audit-applied, do NOT regress)
//   * Whole-MW market quantities. Balancing market accepts integer MW only,
//     so Q_da_sold, Q_w, trusted_rev and Q_dn_offer are floored. The
//     s-split also produces integer Q_*_mfrr / Q_*_afrr (round + remainder).
//   * mFRR-dn capped at the DA position. A wind park can drop from
//     Q_da_sold to 0 but cannot go below 0. Therefore Q_dn_offer = Q_da_sold
//     (NOT Q_w), independent of Y. When Q_da_sold = 0 there is no mFRR-dn
//     revenue.
//   * Q_position = Q_da_sold + Q_up_active - Q_dn_active. mFRR-up and
//     mFRR-dn cannot both fire in the same ISP (P_mfrr is single-signed).
//     aFRR contributions are scaled by activity fraction (n_*_fav/225)
//     since aFRR is partial-dispatch.
//
// SIMULATION WINDOW
//   The engine carries a half-open ISP-index window [winStart, winEnd) set
//   by setWindow(start, end). All summation, sweeping,
//   winsorization-percentile computation and monthly aggregation respect
//   it. Per-ISP arrays returned by simulate() are sized to the window —
//   index k of perISP corresponds to global ISP (windowStart + k).
//
// NaN HANDLING
//   D.p_imb (Latvia imbalance price) is NaN for ~6.8% of rows where the
//   upstream source ran out (mostly April 2026). simulate() and
//   simulateTotal() detect NaN p_imb and treat its imbalance + flat
//   penalty as 0 for that ISP, so April rows still contribute DA + mFRR
//   revenue to the totals. Tests verify this.
//
// EXPORTS
//   init(rawData)                  — bootstrap typed-array views, reset window
//   getData()                      — internal D (typed arrays + meta + dayTypeMask + aFRR)
//   setWindow(start, end)          — half-open ISP-index window (invalidates winsor cache)
//   getWindow()                    — { start, end }
//   maybeWinsorize(mfrrLo, mfrrHi, imbLo, imbHi, posLo, posHi, negLo, negHi)
//                                  — keyed-cache; ALWAYS returns current bounds (for live UI)
//   forceRewinsor()                — invalidate cache (rare)
//   simulate(params)               — full per-ISP detail
//   simulateTotal(params)          — fast total-only (for sweeps / optimiser)
//   naiveRevenue(params)           — simulateTotal at X=0, Y=0, Z=0 with current splits + sources
//   topConcentration(perISP, frac) — top-N% revenue share (robustness)
//   monthlyAggregation(params)     — month-bucketed decomposition (incl. aFRR + S3)
//   totalPotMWhInWindow(params)    — sum of Q_pot in current window (Q_pot depends on actualSource)
//   tsAt(i)                        — Date object for global ISP index i

const Engine = (() => {
  // ---------- typed-array view of the JSON data --------------------------
  let D = null;
  let winStart = 0;
  let winEnd = 0;

  // null in JSON arrays denotes missing data → convert to NaN in the Float32Array
  // so engine code can detect it via isNaN().
  function _toFloat32WithNaN(arr) {
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      out[i] = arr[i] === null ? NaN : arr[i];
    }
    return out;
  }

  function init(rawData) {
    D = {
      n: rawData.n,
      start_iso: rawData.start_iso,
      step_min: rawData.step_min,
      offsets: new Int32Array(rawData.offsets),
      da_forecast: new Float32Array(rawData.da_forecast),
      id_forecast: new Float32Array(rawData.id_forecast),
      p_da: new Float32Array(rawData.p_da),
      p_mfrr_raw: _toFloat32WithNaN(rawData.p_mfrr),
      q_pot: new Float32Array(rawData.q_pot),
      // p_imb may contain null (April lacks the imbalance-price source).
      // Engine treats NaN p_imb as zero imbalance cost.
      p_imb_raw: _toFloat32WithNaN(rawData.p_imb),
      // vwap_1h is the LV intraday 1h-VWAP. NaN where missing — S3
      // (speculative oversell) skips those ISPs.
      vwap_1h: Array.isArray(rawData.vwap_1h)
        ? _toFloat32WithNaN(rawData.vwap_1h)
        : new Float32Array(rawData.n).fill(NaN),
    };
    // Working buffers for winsorized prices (filled by maybeWinsorize)
    D.p_mfrr = new Float32Array(D.n);
    D.p_imb = new Float32Array(D.n);

    // ----- aFRR per-ISP feeds -----
    // avg_p_pos / avg_p_neg are the time-weighted averaged AST_POS /
    // AST_NEG over each 15-min ISP, with the FAVOURABLE-ONLY filter
    // applied at preprocess time: AST_POS values ≤ 0 and AST_NEG values
    // ≥ 0 are dropped (replaced with 0) before the sum. This represents
    // a wind park that only bids profitable directions — see
    // preprocess-afrr-15min.py for the rationale. After the filter,
    // avg_p_pos ≥ 0 and avg_p_neg ≤ 0 by construction.
    //
    // n_pos_fav / n_neg_fav are the matching FAVOURABLE-ONLY 4-s counts
    // (slots where AST_POS > 0 / AST_NEG < 0). They scale the position
    // contribution: Q_*_afrr × n_*_fav / 225.
    if (typeof AFRR_15MIN !== "undefined" && AFRR_15MIN && AFRR_15MIN.n === D.n) {
      D.avg_p_pos_raw = new Float32Array(AFRR_15MIN.avg_p_pos);
      D.avg_p_neg_raw = new Float32Array(AFRR_15MIN.avg_p_neg);
    } else {
      D.avg_p_pos_raw = new Float32Array(D.n);
      D.avg_p_neg_raw = new Float32Array(D.n);
    }
    D.avg_p_pos = new Float32Array(D.n); // winsorized
    D.avg_p_neg = new Float32Array(D.n); // winsorized

    let havePosFav = false, haveNegFav = false;
    if (typeof AFRR_15MIN !== "undefined" && AFRR_15MIN && AFRR_15MIN.n === D.n) {
      if (Array.isArray(AFRR_15MIN.n_pos_fav)) {
        D.afrr_n_pos_fav = new Int16Array(AFRR_15MIN.n_pos_fav);
        havePosFav = true;
      }
      if (Array.isArray(AFRR_15MIN.n_neg_fav)) {
        D.afrr_n_neg_fav = new Int16Array(AFRR_15MIN.n_neg_fav);
        haveNegFav = true;
      }
    }
    if (typeof AFRR_DATA !== "undefined" && AFRR_DATA && AFRR_DATA.n === D.n) {
      D.afrr_n_pos = new Int16Array(AFRR_DATA.n_pos);
      D.afrr_n_neg = new Int16Array(AFRR_DATA.n_neg);
      D.afrr_n_total = new Int16Array(AFRR_DATA.n_total);
    } else {
      D.afrr_n_pos = new Int16Array(D.n);
      D.afrr_n_neg = new Int16Array(D.n);
      D.afrr_n_total = new Int16Array(D.n);
    }
    if (!havePosFav) D.afrr_n_pos_fav = D.afrr_n_pos;
    if (!haveNegFav) D.afrr_n_neg_fav = D.afrr_n_neg;

    D.dayTypeMask = _computeDayTypeMask(rawData);
    winStart = 0;
    winEnd = D.n;
    cachedMfrrKey = null;
    cachedImbKey = null;
    cachedAfrrPosKey = null;
    cachedAfrrNegKey = null;
    cachedMfrrBounds = { lo: 0, hi: 0 };
    cachedImbBounds = { lo: 0, hi: 0 };
    cachedAfrrPosBounds = { lo: 0, hi: 0 };
    cachedAfrrNegBounds = { lo: 0, hi: 0 };
    _s3RollingCache.clear();
    return D;
  }

  // ---------- day-type mask (workday / weekend / public holiday) ---------
  // Mask values: 0 = workday, 1 = weekend, 2 = holiday. See README for the
  // full rationale (Latvia/Estonia/Lithuania holidays via date-holidays).
  function _computeDayTypeMask(rawData) {
    const n = rawData.n;
    const startMs = new Date(rawData.start_iso).getTime();
    const stepMs = rawData.step_min * 60000;
    const offsets = rawData.offsets;
    const mask = new Uint8Array(n);
    const holidaySet = _balticHolidaySet(startMs, offsets, n, stepMs);
    for (let i = 0; i < n; i++) {
      const ts = new Date(startMs + offsets[i] * stepMs);
      const dow = ts.getUTCDay();
      if (dow === 0 || dow === 6) {
        mask[i] = 1;
      } else {
        const ds = ts.toISOString().substring(0, 10);
        mask[i] = holidaySet.has(ds) ? 2 : 0;
      }
    }
    return mask;
  }

  function _balticHolidaySet(startMs, offsets, n, stepMs) {
    const set = new Set();
    // The UMD bundle of date-holidays v3+ exposes the constructor as either
    // window.Holidays (older) OR window.Holidays.default (ES-module wrap).
    const Ctor =
      typeof Holidays === "function"
        ? Holidays
        : typeof Holidays === "object" && Holidays && typeof Holidays.default === "function"
          ? Holidays.default
          : null;
    if (!Ctor) {
      if (typeof console !== "undefined") {
        console.info(
          "date-holidays plugin not loaded — day-type filter will treat" +
            " every Mon–Fri as a workday (no public-holiday detection).",
        );
      }
      return set;
    }
    try {
      const firstYear = new Date(startMs + offsets[0] * stepMs).getUTCFullYear();
      const lastYear = new Date(startMs + offsets[n - 1] * stepMs).getUTCFullYear();
      for (const cc of ["LV", "EE", "LT"]) {
        const hd = new Ctor(cc);
        for (let y = firstYear; y <= lastYear; y++) {
          const list = hd.getHolidays(y) || [];
          for (const h of list) {
            if (h.type !== "public") continue;
            if (typeof h.date === "string" && h.date.length >= 10) {
              set.add(h.date.substring(0, 10));
            }
          }
        }
      }
    } catch (e) {
      if (typeof console !== "undefined") {
        console.warn("date-holidays threw — falling back to weekend-only:", e);
      }
    }
    return set;
  }

  function getData() {
    return D;
  }

  function setWindow(start, end) {
    const s = Math.max(0, Math.min(D.n, start | 0));
    const e = Math.max(s, Math.min(D.n, end | 0));
    if (s !== winStart || e !== winEnd) {
      winStart = s;
      winEnd = e;
      cachedMfrrKey = null;
      cachedImbKey = null;
      cachedAfrrPosKey = null;
      cachedAfrrNegKey = null;
    }
    return { start: winStart, end: winEnd };
  }

  function getWindow() {
    return { start: winStart, end: winEnd };
  }

  // ---------- winsorization with caching ---------------------------------
  let cachedMfrrKey = null;
  let cachedImbKey = null;
  let cachedAfrrPosKey = null;
  let cachedAfrrNegKey = null;
  let cachedMfrrBounds = { lo: 0, hi: 0 };
  let cachedImbBounds = { lo: 0, hi: 0 };
  let cachedAfrrPosBounds = { lo: 0, hi: 0 };
  let cachedAfrrNegBounds = { lo: 0, hi: 0 };

  // ---------- S3 rolling stats cache, keyed on (K, L) --------------------
  // Computed from raw p_mfrr across the FULL dataset. Independent of
  // winStart/winEnd, so cached forever. Mirrors a real trader: rolling
  // window is [i − K − L, i − L) — the K samples ending L ISPs before the
  // target ISP (publication latency).
  const _s3RollingCache = new Map();
  function _getS3Rolling(K, L) {
    if (!D || K < 1) return null;
    const Ki = K | 0;
    const Lraw = L | 0;
    const Li = Lraw < 0 ? 0 : Lraw;
    const key = `${Ki}_${Li}`;
    const hit = _s3RollingCache.get(key);
    if (hit) return hit;
    const n = D.n;
    const mean = new Float32Array(n);
    const std = new Float32Array(n);
    const src = D.p_mfrr_raw;
    const need = Ki + Li;
    for (let i = 0; i < n; i++) {
      if (i < need) {
        mean[i] = NaN;
        std[i] = NaN;
        continue;
      }
      const winLo = i - Ki - Li;
      const winHi = i - Li;
      let sum = 0;
      let cnt = 0;
      for (let j = winLo; j < winHi; j++) {
        const v = src[j];
        if (!isNaN(v)) {
          sum += v;
          cnt++;
        }
      }
      if (cnt < 2) {
        mean[i] = NaN;
        std[i] = NaN;
        continue;
      }
      const m = sum / cnt;
      let sq = 0;
      for (let j = winLo; j < winHi; j++) {
        const v = src[j];
        if (!isNaN(v)) sq += (v - m) * (v - m);
      }
      mean[i] = m;
      std[i] = Math.sqrt(sq / (cnt - 1));
    }
    const entry = { mean, std };
    _s3RollingCache.set(key, entry);
    return entry;
  }

  function percentileValue(sorted, p) {
    const N = sorted.length;
    if (N === 0) return 0;
    const idx = (p / 100) * (N - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  function applyWinsor(src, dst, pLow, pHigh) {
    const wLen = winEnd - winStart;
    if (wLen <= 0) {
      for (let i = 0; i < src.length; i++) dst[i] = src[i];
      return { lo: 0, hi: 0 };
    }
    const buf = [];
    for (let i = winStart; i < winEnd; i++) {
      const v = src[i];
      if (!isNaN(v)) buf.push(v);
    }
    if (buf.length === 0) {
      for (let i = 0; i < src.length; i++) dst[i] = src[i];
      return { lo: 0, hi: 0 };
    }
    const sample = Float32Array.from(buf);
    sample.sort();
    const lo = percentileValue(sample, pLow);
    const hi = percentileValue(sample, pHigh);
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (isNaN(v)) {
        dst[i] = NaN;
      } else {
        dst[i] = v < lo ? lo : v > hi ? hi : v;
      }
    }
    return { lo, hi };
  }

  function maybeWinsorize(
    pMfrrLow,
    pMfrrHigh,
    pImbLow,
    pImbHigh,
    pPosLow = 10,
    pPosHigh = 90,
    pNegLow = 10,
    pNegHigh = 90,
  ) {
    const mfrrKey = `${pMfrrLow}-${pMfrrHigh}`;
    const imbKey = `${pImbLow}-${pImbHigh}`;
    const posKey = `${pPosLow}-${pPosHigh}`;
    const negKey = `${pNegLow}-${pNegHigh}`;
    if (mfrrKey !== cachedMfrrKey) {
      cachedMfrrBounds = applyWinsor(D.p_mfrr_raw, D.p_mfrr, pMfrrLow, pMfrrHigh);
      cachedMfrrKey = mfrrKey;
    }
    if (imbKey !== cachedImbKey) {
      cachedImbBounds = applyWinsor(D.p_imb_raw, D.p_imb, pImbLow, pImbHigh);
      cachedImbKey = imbKey;
    }
    if (posKey !== cachedAfrrPosKey) {
      cachedAfrrPosBounds = applyWinsor(D.avg_p_pos_raw, D.avg_p_pos, pPosLow, pPosHigh);
      cachedAfrrPosKey = posKey;
    }
    if (negKey !== cachedAfrrNegKey) {
      cachedAfrrNegBounds = applyWinsor(D.avg_p_neg_raw, D.avg_p_neg, pNegLow, pNegHigh);
      cachedAfrrNegKey = negKey;
    }
    return {
      mfrrBounds: cachedMfrrBounds,
      imbBounds: cachedImbBounds,
      afrrPosBounds: cachedAfrrPosBounds,
      afrrNegBounds: cachedAfrrNegBounds,
    };
  }

  function forceRewinsor() {
    cachedMfrrKey = null;
    cachedImbKey = null;
    cachedAfrrPosKey = null;
    cachedAfrrNegKey = null;
  }

  // ---------- helpers: resolve sources + enable flags --------------------
  // Source resolvers honour the user's selectors. Pure index → value.
  function _qPotArray(actualSource) {
    if (actualSource === "da") return D.da_forecast;
    if (actualSource === "id") return D.id_forecast;
    return D.q_pot;
  }
  function _idArray(idSource) {
    return idSource === "da" ? D.da_forecast : D.id_forecast;
  }
  // Effective scalar params given the user's enable flags. Disabling a
  // strategy collapses its params to a neutral value (same shape the
  // optimiser already understands).
  function _resolveParams(params) {
    const en = params.enabled || {};
    const daWithhold = en.daWithhold !== false;
    const split = en.split !== false;
    const idTrust = en.idTrust !== false;
    const s3On = en.s3 !== false;
    const X = +params.X || 0;
    const Y_raw = +params.Y || 0;
    const Z_raw = +params.Z || 0;
    const theta_flat = +params.theta_flat || 0;
    const sUpRaw = params.s_up == null ? 1 : +params.s_up;
    const sDnRaw = params.s_dn == null ? 1 : +params.s_dn;
    return {
      X,
      Y: daWithhold ? Y_raw : 0,
      Z: idTrust ? Z_raw : 0,
      theta_flat,
      s_up: split ? (sUpRaw < 0 ? 0 : sUpRaw > 1 ? 1 : sUpRaw) : 1,
      s_dn: split ? (sDnRaw < 0 ? 0 : sDnRaw > 1 ? 1 : sDnRaw) : 1,
      actualSource: params.actualSource || "real",
      idSource: params.idSource || "real",
      s3Enabled: s3On,
      s3_K: (params.s3_K | 0) || 0,
      s3_X_cap: s3On ? (params.s3_X_cap | 0) || 0 : 0,
      s3_S_min: +params.s3_S_min || 0,
      s3_sigma_max: +params.s3_sigma_max || 0,
      s3_M: +params.s3_M || 0,
      s3_lag: params.s3_lag == null ? 4 : (params.s3_lag | 0),
      s3_da_skip: params.s3_da_skip == null ? 50 : (params.s3_da_skip | 0),
    };
  }

  // ---------- detailed simulation (returns per-ISP arrays) ---------------
  // params shape:
  //   { X, Y, Z, theta_flat, s_up, s_dn,
  //     actualSource: 'da'|'id'|'real',
  //     idSource: 'da'|'real',
  //     enabled: { daWithhold, split, idTrust, s3 },
  //     s3_K, s3_lag, s3_da_skip, s3_S_min, s3_sigma_max, s3_X_cap, s3_M }
  //
  // Per-ISP arrays are sized to the simulation window length. Index k of
  // perISP corresponds to global ISP (windowStart + k).
  function simulate(params) {
    const p = _resolveParams(params);
    const s3Active = p.s3Enabled && p.s3_X_cap >= 1 && p.s3_K >= 1;
    const s3Roll = s3Active ? _getS3Rolling(p.s3_K, p.s3_lag) : null;
    const Q_pot_src = _qPotArray(p.actualSource);
    const ID_src = _idArray(p.idSource);

    const wLen = Math.max(0, winEnd - winStart);
    const Q_da_sold = new Float32Array(wLen);
    const Q_up = new Float32Array(wLen);
    const Q_dn = new Float32Array(wLen);
    const Q_up_afrr_disp = new Float32Array(wLen);
    const Q_dn_afrr_disp = new Float32Array(wLen);
    const Q_s3_intraday = new Float32Array(wLen);
    const Q_s3_curtail = new Float32Array(wLen);
    const Q_short = new Float32Array(wLen);
    const revenue = new Float32Array(wLen);
    let sumDA = 0,
      sumUpMfrr = 0,
      sumDnMfrr = 0,
      sumUpAfrr = 0,
      sumDnAfrr = 0,
      sumImb = 0,
      sumFlat = 0,
      sumS3Intraday = 0,
      sumS3Curtail = 0,
      sumS3ExtraCost = 0;
    let nUp = 0,
      nDn = 0,
      nWasted = 0,
      nShort = 0,
      nUpAfrr = 0,
      nDnAfrr = 0,
      nS3Oversold = 0,
      nS3HedgeFired = 0;
    let totalShortMWh = 0;
    let nNegRevWarn = 0;

    for (let i = winStart; i < winEnd; i++) {
      const k = i - winStart;
      const F = D.da_forecast[i];
      const ID = ID_src[i];
      const P_da = D.p_da[i];
      const P_mfrr = D.p_mfrr[i];
      const aboveX = P_da >= p.X;
      const da_sold_raw = aboveX ? F : F * (1 - p.Y);
      const da_sold = Math.floor(da_sold_raw + 1e-9);
      const Q_w_raw = aboveX ? 0 : F - da_sold;
      const Q_w = Math.floor(Q_w_raw + 1e-9);
      const trustedRevRaw = p.Z * (ID - F);
      if (trustedRevRaw < 0) nNegRevWarn++;
      const trustedExtra = trustedRevRaw > 0 ? Math.floor(trustedRevRaw + 1e-9) : 0;
      const Q_up_offer = Q_w + trustedExtra;
      const Q_dn_offer = da_sold;
      // mFRR ↔ aFRR split (per-direction, round-and-remainder).
      const Q_up_mfrr = Math.round(p.s_up * Q_up_offer);
      const Q_up_afrr = Q_up_offer - Q_up_mfrr;
      const Q_dn_mfrr = Math.round(p.s_dn * Q_dn_offer);
      const Q_dn_afrr = Q_dn_offer - Q_dn_mfrr;
      const isUp = P_mfrr >= 1;
      const isDn = P_mfrr <= -1;
      const up_mfrr = isUp ? Q_up_mfrr : 0;
      const dn_mfrr = isDn ? Q_dn_mfrr : 0;
      // aFRR profitability gate (per direction, per ISP).
      const avg_pos = D.avg_p_pos[i];
      const avg_neg = D.avg_p_neg[i];
      const upAfrrActive = avg_pos > 0 && Q_up_afrr > 0;
      const dnAfrrActive = avg_neg < 0 && Q_dn_afrr > 0;
      const up_afrr_rev_rate = upAfrrActive ? Q_up_afrr * avg_pos : 0;
      const dn_afrr_rev_rate = dnAfrrActive ? -Q_dn_afrr * avg_neg : 0;
      const DA_rev = da_sold * P_da;
      const Up_rev_mfrr = up_mfrr * P_mfrr;
      const Dn_rev_mfrr = -dn_mfrr * P_mfrr;
      // Position: mFRR full Q when activated (binary); aFRR scaled by
      // favourable-slot fraction n_*_fav/225.
      const aFracPos = D.afrr_n_pos_fav[i] / 225;
      const aFracNeg = D.afrr_n_neg_fav[i] / 225;
      const up_afrr_disp = upAfrrActive ? Q_up_afrr * aFracPos : 0;
      const dn_afrr_disp = dnAfrrActive ? Q_dn_afrr * aFracNeg : 0;
      Q_up_afrr_disp[k] = up_afrr_disp;
      Q_dn_afrr_disp[k] = dn_afrr_disp;
      const Q_pos_l2 = da_sold + up_mfrr + up_afrr_disp - dn_mfrr - dn_afrr_disp;

      // ----- S3 (speculative intraday oversell) -----
      let s3_X = 0;
      let s3_fires = false;
      let s3_intraday = 0;
      let s3_curtail = 0;
      if (s3Active && da_sold < p.s3_da_skip) {
        const P_ID_est = D.vwap_1h[i];
        if (!isNaN(P_ID_est)) {
          const P_mfrr_est = s3Roll.mean[i];
          const P_mfrr_sigma = s3Roll.std[i];
          if (!isNaN(P_mfrr_est) && !isNaN(P_mfrr_sigma)) {
            const spread = P_ID_est - P_mfrr_est;
            if (spread >= p.s3_S_min && P_mfrr_sigma <= p.s3_sigma_max) {
              const sig = (spread - p.s3_S_min) / p.s3_S_min;
              const X_raw = p.s3_X_cap * (sig < 1 ? sig : 1);
              const X_prop = Math.floor(X_raw + 1e-9);
              if (X_prop >= 1) {
                const bid_price = P_ID_est + p.s3_M;
                s3_fires = P_mfrr <= bid_price;
                s3_X = X_prop;
                s3_intraday = X_prop * P_ID_est;
                if (s3_fires) s3_curtail = X_prop * (-P_mfrr);
              }
            }
          }
        }
      }
      const s3_delta_pos = s3_fires ? 0 : s3_X;
      const Q_pos = Q_pos_l2 + s3_delta_pos;
      const Q_pot = Q_pot_src[i];
      const short_l2 = Q_pos_l2 > Q_pot ? Q_pos_l2 - Q_pot : 0;
      const short = Q_pos > Q_pot ? Q_pos - Q_pot : 0;

      // NaN p_imb (April rows): skip imbalance + flat costs entirely.
      const P_imb_raw = D.p_imb[i];
      const P_imb_valid = !isNaN(P_imb_raw);
      const imb = P_imb_valid ? short_l2 * P_imb_raw : 0;
      const flat = P_imb_valid ? short_l2 * p.theta_flat : 0;
      const s3_extra_short = short - short_l2;
      const s3_extra_cost = P_imb_valid
        ? s3_extra_short * (P_imb_raw + p.theta_flat)
        : 0;
      const rev =
        (DA_rev +
          Up_rev_mfrr +
          Dn_rev_mfrr +
          up_afrr_rev_rate +
          dn_afrr_rev_rate +
          s3_intraday +
          s3_curtail -
          imb -
          flat -
          s3_extra_cost) *
        0.25;
      Q_da_sold[k] = da_sold;
      Q_up[k] = up_mfrr + Q_up_afrr;
      Q_dn[k] = dn_mfrr + Q_dn_afrr;
      Q_s3_intraday[k] = s3_X;
      Q_s3_curtail[k] = s3_fires ? s3_X : 0;
      Q_short[k] = short;
      revenue[k] = rev;
      sumDA += DA_rev * 0.25;
      sumUpMfrr += Up_rev_mfrr * 0.25;
      sumDnMfrr += Dn_rev_mfrr * 0.25;
      sumUpAfrr += up_afrr_rev_rate * 0.25;
      sumDnAfrr += dn_afrr_rev_rate * 0.25;
      sumImb += imb * 0.25;
      sumFlat += flat * 0.25;
      sumS3Intraday += s3_intraday * 0.25;
      sumS3Curtail += s3_curtail * 0.25;
      sumS3ExtraCost += s3_extra_cost * 0.25;
      if (up_mfrr > 1e-6) nUp++;
      else if (dn_mfrr > 1e-6) nDn++;
      else if (Q_w > 1e-6 && !upAfrrActive && !dnAfrrActive) nWasted++;
      if (upAfrrActive) nUpAfrr++;
      if (dnAfrrActive) nDnAfrr++;
      if (s3_X > 0) {
        nS3Oversold++;
        if (s3_fires) nS3HedgeFired++;
      }
      if (short > 1e-6) {
        nShort++;
        totalShortMWh += short * 0.25;
      }
    }
    const total =
      sumDA +
      sumUpMfrr +
      sumDnMfrr +
      sumUpAfrr +
      sumDnAfrr +
      sumS3Intraday +
      sumS3Curtail -
      sumImb -
      sumFlat -
      sumS3ExtraCost;
    return {
      windowStart: winStart,
      windowEnd: winEnd,
      perISP: {
        Q_da_sold,
        Q_up,
        Q_dn,
        Q_up_afrr_disp,
        Q_dn_afrr_disp,
        Q_s3_intraday,
        Q_s3_curtail,
        Q_short,
        revenue,
      },
      totalRevenue: total,
      breakdown: {
        DA: sumDA,
        mFRR_up: sumUpMfrr,
        mFRR_dn: sumDnMfrr,
        aFRR_up: sumUpAfrr,
        aFRR_dn: sumDnAfrr,
        s3_intraday: sumS3Intraday,
        s3_curtail: sumS3Curtail,
        imb: sumImb,
        flat: sumFlat,
        s3_extra_cost: sumS3ExtraCost,
      },
      counts: {
        up: nUp,
        dn: nDn,
        upAfrr: nUpAfrr,
        dnAfrr: nDnAfrr,
        wasted: nWasted,
        short: nShort,
        negRev: nNegRevWarn,
        s3Oversold: nS3Oversold,
        s3HedgeFired: nS3HedgeFired,
      },
      totalShortMWh,
    };
  }

  // ---------- fast total-only simulation (for sweeps) --------------------
  // Same math as simulate() but returns only the scalar totalRevenue.
  // Inlined hot path; no per-ISP arrays allocated.
  function simulateTotal(params) {
    const p = _resolveParams(params);
    const s3Active = p.s3Enabled && p.s3_X_cap >= 1 && p.s3_K >= 1;
    const s3Roll = s3Active ? _getS3Rolling(p.s3_K, p.s3_lag) : null;
    const s3MeanArr = s3Roll ? s3Roll.mean : null;
    const s3StdArr = s3Roll ? s3Roll.std : null;
    const Q_pot_src = _qPotArray(p.actualSource);
    const ID_src = _idArray(p.idSource);
    const vwap_arr = D.vwap_1h;
    const F_arr = D.da_forecast;
    const P_da_arr = D.p_da;
    const P_mfrr_arr = D.p_mfrr;
    const P_imb_arr = D.p_imb;
    const aPos_arr = D.avg_p_pos;
    const aNeg_arr = D.avg_p_neg;
    const nPos_arr = D.afrr_n_pos_fav;
    const nNeg_arr = D.afrr_n_neg_fav;
    let total = 0;
    for (let i = winStart; i < winEnd; i++) {
      const F = F_arr[i];
      const P_da = P_da_arr[i];
      const P_mfrr = P_mfrr_arr[i];
      const aboveX = P_da >= p.X;
      const da_sold = (aboveX ? F : F * (1 - p.Y)) | 0;
      const Q_w = aboveX ? 0 : ((F - da_sold) | 0);
      const trustedRevRaw = p.Z * (ID_src[i] - F);
      const trustedExtra = trustedRevRaw > 0 ? (trustedRevRaw | 0) : 0;
      const Q_up_offer = Q_w + trustedExtra;
      const Q_dn_offer = da_sold;
      const Q_up_mfrr = Math.round(p.s_up * Q_up_offer);
      const Q_up_afrr = Q_up_offer - Q_up_mfrr;
      const Q_dn_mfrr = Math.round(p.s_dn * Q_dn_offer);
      const Q_dn_afrr = Q_dn_offer - Q_dn_mfrr;
      const isUp = P_mfrr >= 1;
      const isDn = P_mfrr <= -1;
      const up_mfrr = isUp ? Q_up_mfrr : 0;
      const dn_mfrr = isDn ? Q_dn_mfrr : 0;
      const avg_pos = aPos_arr[i];
      const avg_neg = aNeg_arr[i];
      const upAfrrActive = avg_pos > 0 && Q_up_afrr > 0;
      const dnAfrrActive = avg_neg < 0 && Q_dn_afrr > 0;
      let rev = da_sold * P_da + up_mfrr * P_mfrr - dn_mfrr * P_mfrr;
      if (upAfrrActive) rev += Q_up_afrr * avg_pos;
      if (dnAfrrActive) rev -= Q_dn_afrr * avg_neg;
      const up_afrr_disp = upAfrrActive ? Q_up_afrr * (nPos_arr[i] / 225) : 0;
      const dn_afrr_disp = dnAfrrActive ? Q_dn_afrr * (nNeg_arr[i] / 225) : 0;
      let Q_pos = da_sold + up_mfrr + up_afrr_disp - dn_mfrr - dn_afrr_disp;
      if (s3Active && da_sold < p.s3_da_skip) {
        const P_ID_est = vwap_arr[i];
        if (!isNaN(P_ID_est)) {
          const P_mfrr_est = s3MeanArr[i];
          const P_mfrr_sigma = s3StdArr[i];
          if (!isNaN(P_mfrr_est) && !isNaN(P_mfrr_sigma)) {
            const spread = P_ID_est - P_mfrr_est;
            if (spread >= p.s3_S_min && P_mfrr_sigma <= p.s3_sigma_max) {
              const sig = (spread - p.s3_S_min) / p.s3_S_min;
              const X_raw = p.s3_X_cap * (sig < 1 ? sig : 1);
              const X_prop = (X_raw + 1e-9) | 0;
              if (X_prop >= 1) {
                const bid_price = P_ID_est + p.s3_M;
                rev += X_prop * P_ID_est;
                if (P_mfrr <= bid_price) {
                  rev += X_prop * (-P_mfrr);
                } else {
                  Q_pos += X_prop;
                }
              }
            }
          }
        }
      }
      const Q_pot = Q_pot_src[i];
      const short = Q_pos > Q_pot ? Q_pos - Q_pot : 0;
      const pimb = P_imb_arr[i];
      if (!isNaN(pimb)) rev -= short * (pimb + p.theta_flat);
      total += rev;
    }
    return total * 0.25;
  }

  // Naïve baseline: same sources / θ / splits the user picked, but
  // X = Y = Z = 0 (always sell everything to DA, no withhold, no ID trust)
  // and S3 disabled. Re-uses the user's enables so a strategy switched off
  // stays off in the baseline too.
  function naiveRevenue(params) {
    const naiveP = {
      ...params,
      X: 0,
      Y: 0,
      Z: 0,
      enabled: { ...(params.enabled || {}), s3: false },
    };
    return simulateTotal(naiveP);
  }

  // ---------- robustness: top-N revenue concentration --------------------
  function topConcentration(perISPRev, fraction) {
    const sorted = new Float64Array(perISPRev);
    sorted.sort();
    let total = 0;
    for (let i = 0; i < perISPRev.length; i++) total += perISPRev[i];
    const topN = Math.max(1, Math.floor(perISPRev.length * fraction));
    let topSum = 0;
    for (let i = sorted.length - 1; i >= sorted.length - topN; i--) topSum += sorted[i];
    return { topN, topSum, totalSum: total, share: total !== 0 ? topSum / total : 0 };
  }

  // ---------- monthly aggregation (window-only) --------------------------
  // Mirrors simulate()'s revenue formula exactly so the monthly bars sum
  // back to the headline totalRevenue.
  function monthlyAggregation(params) {
    const p = _resolveParams(params);
    const s3Active = p.s3Enabled && p.s3_X_cap >= 1 && p.s3_K >= 1;
    const s3Roll = s3Active ? _getS3Rolling(p.s3_K, p.s3_lag) : null;
    const Q_pot_src = _qPotArray(p.actualSource);
    const ID_src = _idArray(p.idSource);
    const start = new Date(D.start_iso);
    const buckets = new Map();
    for (let i = winStart; i < winEnd; i++) {
      const ts = new Date(start.getTime() + D.offsets[i] * D.step_min * 60000);
      const key = `${ts.getUTCFullYear()}-${String(ts.getUTCMonth() + 1).padStart(2, "0")}`;
      const F = D.da_forecast[i];
      const ID = ID_src[i];
      const P_da = D.p_da[i];
      const P_mfrr = D.p_mfrr[i];
      const aboveX = P_da >= p.X;
      const da_sold = Math.floor((aboveX ? F : F * (1 - p.Y)) + 1e-9);
      const Q_w = Math.floor((aboveX ? 0 : F - da_sold) + 1e-9);
      const trustedRevRaw = p.Z * (ID - F);
      const trustedExtra = trustedRevRaw > 0 ? Math.floor(trustedRevRaw + 1e-9) : 0;
      const up_offer = Q_w + trustedExtra;
      const dn_offer = da_sold;
      const Q_up_mfrr = Math.round(p.s_up * up_offer);
      const Q_up_afrr = up_offer - Q_up_mfrr;
      const Q_dn_mfrr = Math.round(p.s_dn * dn_offer);
      const Q_dn_afrr = dn_offer - Q_dn_mfrr;
      const isUp = P_mfrr >= 1;
      const isDn = P_mfrr <= -1;
      const up_mfrr_q = isUp ? Q_up_mfrr : 0;
      const dn_mfrr_q = isDn ? Q_dn_mfrr : 0;
      const avg_pos = D.avg_p_pos[i];
      const avg_neg = D.avg_p_neg[i];
      const upAfrrActive = avg_pos > 0 && Q_up_afrr > 0;
      const dnAfrrActive = avg_neg < 0 && Q_dn_afrr > 0;
      const DA_rev = da_sold * P_da * 0.25;
      const UpMfrr_rev = up_mfrr_q * P_mfrr * 0.25;
      const DnMfrr_rev = -dn_mfrr_q * P_mfrr * 0.25;
      const UpAfrr_rev = upAfrrActive ? Q_up_afrr * avg_pos * 0.25 : 0;
      const DnAfrr_rev = dnAfrrActive ? -Q_dn_afrr * avg_neg * 0.25 : 0;
      const up_afrr_disp = upAfrrActive ? Q_up_afrr * (D.afrr_n_pos_fav[i] / 225) : 0;
      const dn_afrr_disp = dnAfrrActive ? Q_dn_afrr * (D.afrr_n_neg_fav[i] / 225) : 0;
      const Q_pos_l2 = da_sold + up_mfrr_q + up_afrr_disp - dn_mfrr_q - dn_afrr_disp;
      let S3Intraday_rev = 0,
        S3Curtail_rev = 0,
        S3ExtraCost = 0;
      let s3_X = 0;
      let s3_fires = false;
      if (s3Active && da_sold < p.s3_da_skip) {
        const P_ID_est = D.vwap_1h[i];
        if (!isNaN(P_ID_est)) {
          const P_mfrr_est = s3Roll.mean[i];
          const P_mfrr_sigma = s3Roll.std[i];
          if (!isNaN(P_mfrr_est) && !isNaN(P_mfrr_sigma)) {
            const spread = P_ID_est - P_mfrr_est;
            if (spread >= p.s3_S_min && P_mfrr_sigma <= p.s3_sigma_max) {
              const sig = (spread - p.s3_S_min) / p.s3_S_min;
              const X_prop = Math.floor(p.s3_X_cap * (sig < 1 ? sig : 1) + 1e-9);
              if (X_prop >= 1) {
                const bid_price = P_ID_est + p.s3_M;
                s3_fires = P_mfrr <= bid_price;
                s3_X = X_prop;
                S3Intraday_rev = X_prop * P_ID_est * 0.25;
                if (s3_fires) S3Curtail_rev = X_prop * (-P_mfrr) * 0.25;
              }
            }
          }
        }
      }
      const Q_pos = Q_pos_l2 + (s3_fires ? 0 : s3_X);
      const Q_pot = Q_pot_src[i];
      const short_l2 = Q_pos_l2 > Q_pot ? Q_pos_l2 - Q_pot : 0;
      const short = Q_pos > Q_pot ? Q_pos - Q_pot : 0;
      let imb = 0,
        flat = 0;
      const pimb = D.p_imb[i];
      if (!isNaN(pimb)) {
        imb = short_l2 * pimb * 0.25;
        flat = short_l2 * p.theta_flat * 0.25;
        S3ExtraCost = (short - short_l2) * (pimb + p.theta_flat) * 0.25;
      }
      const b =
        buckets.get(key) ||
        {
          DA: 0,
          up_mfrr: 0,
          dn_mfrr: 0,
          up_afrr: 0,
          dn_afrr: 0,
          s3_intraday: 0,
          s3_curtail: 0,
          s3_extra_cost: 0,
          imb: 0,
          flat: 0,
        };
      b.DA += DA_rev;
      b.up_mfrr += UpMfrr_rev;
      b.dn_mfrr += DnMfrr_rev;
      b.up_afrr += UpAfrr_rev;
      b.dn_afrr += DnAfrr_rev;
      b.s3_intraday += S3Intraday_rev;
      b.s3_curtail += S3Curtail_rev;
      b.s3_extra_cost += S3ExtraCost;
      b.imb += imb;
      b.flat += flat;
      buckets.set(key, b);
    }
    const out = [];
    const keys = [...buckets.keys()].sort();
    for (const k of keys) {
      const b = buckets.get(k);
      out.push({
        month: k,
        DA: b.DA,
        up: b.up_mfrr + b.up_afrr,
        dn: b.dn_mfrr + b.dn_afrr,
        up_mfrr: b.up_mfrr,
        dn_mfrr: b.dn_mfrr,
        up_afrr: b.up_afrr,
        dn_afrr: b.dn_afrr,
        s3_intraday: b.s3_intraday,
        s3_curtail: b.s3_curtail,
        s3_extra_cost: b.s3_extra_cost,
        imb: b.imb,
        flat: b.flat,
        total:
          b.DA +
          b.up_mfrr +
          b.dn_mfrr +
          b.up_afrr +
          b.dn_afrr +
          b.s3_intraday +
          b.s3_curtail -
          b.imb -
          b.flat -
          b.s3_extra_cost,
      });
    }
    return out;
  }

  // Sum of MWh of Q_pot in the current window. Q_pot depends on the
  // actualSource selector so the "revenue per MWh of potential" tile is
  // self-consistent with whatever drives shortfall.
  function totalPotMWhInWindow(params) {
    const actualSource = params && params.actualSource ? params.actualSource : "real";
    const arr = _qPotArray(actualSource);
    let s = 0;
    for (let i = winStart; i < winEnd; i++) s += arr[i] * 0.25;
    return s;
  }

  // ---------- timestamp helper -------------------------------------------
  function tsAt(i) {
    const start = new Date(D.start_iso).getTime();
    return new Date(start + D.offsets[i] * D.step_min * 60000);
  }

  return {
    init,
    getData,
    setWindow,
    getWindow,
    maybeWinsorize,
    forceRewinsor,
    simulate,
    simulateTotal,
    naiveRevenue,
    topConcentration,
    monthlyAggregation,
    totalPotMWhInWindow,
    tsAt,
  };
})();

if (typeof module !== "undefined") module.exports = Engine;
