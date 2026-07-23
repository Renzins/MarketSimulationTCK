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
// MFRR ↔ AFRR SPLIT (per direction, s_up / s_dn ∈ [0, 1]; 1 = all mFRR;
//   the shipped strategy is the ADAPTIVE split — 8 params, see _splitBlocks —
//   whose per-ISP value feeds the same formulas; a static scalar s is the
//   step=0 special case)
//   Round-and-remainder per direction over the FREE (non-reserve) volume:
//     Q_up_mfrr = R_up_mfrr + round(s_up * up_free)   Q_up_afrr = R_up_afrr + remainder
//     Q_dn_mfrr = R_mfrr    + round(s_dn * da_nonres)  Q_dn_afrr = R_afrr    + remainder
//   The reserve-market awards (R_up_* / R_* — see the reserve blocks inside
//   simulate()) are a MANDATORY floor carrying their own ru_split / r_split;
//   only the free remainder follows s_up / s_dn. up_free = floor(F) − R_up −
//   da_sold + trustedExtra; da_nonres = da_sold − R_dn. With both reserves off
//   (R = 0) this is exactly round(s * total). With s_up = s_dn = 1 both aFRR
//   terms are 0.
//   aFRR prices come
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
//   setWindow(start, end)          — half-open ISP-index window
//   getWindow()                    — { start, end }
//   maybeWinsorize(mfrrLo, mfrrHi, imbLo, imbHi, posLo, posHi, negLo, negHi,
//                  resMLo, resMHi, resALo, resAHi)
//                                  — 12 args (4 main + reserve mFRR/aFRR pairs);
//                                    cache keyed on (window × percentiles);
//                                    ALWAYS returns current bounds (for live UI)
//   forceRewinsor()                — drop all winsor + derived caches (only
//                                    needed if raw arrays are mutated in place)
//   simulate(params)               — full per-ISP detail
//   simulateTotal(params)          — fast total-only (for sweeps / optimiser)
//   naiveRevenue(params)           — simulateTotal with EVERY strategy neutralised
//                                    (X=Y=Z=0, split forced all-mFRR, S3 + reserves off;
//                                    keeps current θ/sources/day filter)
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

    // ----- Reserve (capacity) market down-prices (optional file) -----
    // LV mFRR-down / aFRR-down HOURLY capacity prices (EUR/MW·h), broadcast
    // to every 15-min ISP of the hour. NaN where the market had no price
    // that ISP → the reserve strategy treats it as "no reserve available".
    // raw + winsorized buffers mirror p_mfrr/p_imb. Falls back to all-NaN
    // arrays if data-reserve.js is absent (reserve strategy then never fires).
    if (typeof RESERVE_DATA !== "undefined" && RESERVE_DATA && RESERVE_DATA.n === D.n) {
      D.reserve_mfrr_dn_raw = _toFloat32WithNaN(RESERVE_DATA.reserve_mfrr_dn);
      D.reserve_afrr_dn_raw = _toFloat32WithNaN(RESERVE_DATA.reserve_afrr_dn);
      // UP-capacity prices (optional — older data-reserve.js may lack them).
      D.reserve_mfrr_up_raw = RESERVE_DATA.reserve_mfrr_up
        ? _toFloat32WithNaN(RESERVE_DATA.reserve_mfrr_up)
        : new Float32Array(D.n).fill(NaN);
      D.reserve_afrr_up_raw = RESERVE_DATA.reserve_afrr_up
        ? _toFloat32WithNaN(RESERVE_DATA.reserve_afrr_up)
        : new Float32Array(D.n).fill(NaN);
      D.hasReserve = true;
    } else {
      D.reserve_mfrr_dn_raw = new Float32Array(D.n).fill(NaN);
      D.reserve_afrr_dn_raw = new Float32Array(D.n).fill(NaN);
      D.reserve_mfrr_up_raw = new Float32Array(D.n).fill(NaN);
      D.reserve_afrr_up_raw = new Float32Array(D.n).fill(NaN);
      D.hasReserve = false;
    }
    D.reserve_mfrr_dn = new Float32Array(D.n); // winsorized (filled by maybeWinsorize)
    D.reserve_afrr_dn = new Float32Array(D.n);
    D.reserve_mfrr_up = new Float32Array(D.n); // winsorized (shares dn percentiles)
    D.reserve_afrr_up = new Float32Array(D.n);

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
    cachedResMfrrKey = null;
    cachedResAfrrKey = null;
    cachedResMfrrBounds = { lo: 0, hi: 0 };
    cachedResAfrrBounds = { lo: 0, hi: 0 };
    _splitFxKey = null;
    _splitFx = null;
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

  // ---------- day-type filter (post-hoc accumulation gate) ---------------
  // The engine ALWAYS simulates every ISP in the window continuously, so the
  // S3 rolling-stats window [i−K−L, i−L) keeps spanning real calendar time
  // (a Monday trade still "sees" the preceding weekend's settled prices).
  // The day-type filter is applied ONLY when accumulating totals — a
  // non-matching ISP is dropped from the sums/counts but NEVER alters any
  // other ISP's P&L (each ISP's revenue is a pure function of i + the cached
  // rolling stats; there is no cross-ISP carry state in the loop). This is
  // what lets "workdays only" / "weekends+holidays" stay correct without
  // breaking intra-day oversell continuity. Reads D.dayTypeMask
  // (0 = workday, 1 = weekend, 2 = public holiday). "all" is a strict no-op.
  function _dayAccepts(filter, maskVal) {
    if (filter === "workday") return maskVal === 0;
    if (filter === "weekend-holiday") return maskVal !== 0;
    return true; // "all" / unknown → no filtering
  }

  function getData() {
    return D;
  }

  function setWindow(start, end) {
    // No cache invalidation here — winsor cache keys encode the window
    // (see maybeWinsorize), so a stale entry simply can't match.
    const s = Math.max(0, Math.min(D.n, start | 0));
    const e = Math.max(s, Math.min(D.n, end | 0));
    winStart = s;
    winEnd = e;
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
  // Reserve (capacity) down-price winsor cache.
  let cachedResMfrrKey = null;
  let cachedResAfrrKey = null;
  let cachedResMfrrBounds = { lo: 0, hi: 0 };
  let cachedResAfrrBounds = { lo: 0, hi: 0 };
  // Adaptive-split effective-price prefix sums, cached by winsor state
  // (the family keys encode window × percentiles, so this cache follows
  // window changes through the key strings alone).
  let _splitFxKey = null;
  let _splitFx = null;

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
    pResMLow = 5,
    pResMHigh = 95,
    pResALow = 5,
    pResAHigh = 95,
  ) {
    // Content-addressed keys: a winsorized array is a pure function of
    // (window × percentile knobs) — applyWinsor samples percentiles from
    // [winStart, winEnd) — so the key encodes both. Nothing ever invalidates
    // these caches; a changed window (or knob) simply produces a different
    // key. Caches derived from these keys (_splitEffPrefix) inherit
    // window-awareness through the key strings.
    const wKey = `${winStart}:${winEnd}`;
    const mfrrKey = `${wKey}|${pMfrrLow}-${pMfrrHigh}`;
    const imbKey = `${wKey}|${pImbLow}-${pImbHigh}`;
    const posKey = `${wKey}|${pPosLow}-${pPosHigh}`;
    const negKey = `${wKey}|${pNegLow}-${pNegHigh}`;
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
    // Reserve down-capacity prices (only meaningful when data-reserve.js
    // loaded; otherwise the raw arrays are all-NaN and applyWinsor no-ops).
    const resMKey = `${wKey}|${pResMLow}-${pResMHigh}`;
    const resAKey = `${wKey}|${pResALow}-${pResAHigh}`;
    if (resMKey !== cachedResMfrrKey) {
      cachedResMfrrBounds = applyWinsor(D.reserve_mfrr_dn_raw, D.reserve_mfrr_dn, pResMLow, pResMHigh);
      // UP mFRR-capacity shares the same percentile knob (its own distribution).
      applyWinsor(D.reserve_mfrr_up_raw, D.reserve_mfrr_up, pResMLow, pResMHigh);
      cachedResMfrrKey = resMKey;
    }
    if (resAKey !== cachedResAfrrKey) {
      cachedResAfrrBounds = applyWinsor(D.reserve_afrr_dn_raw, D.reserve_afrr_dn, pResALow, pResAHigh);
      applyWinsor(D.reserve_afrr_up_raw, D.reserve_afrr_up, pResALow, pResAHigh);
      cachedResAfrrKey = resAKey;
    }
    return {
      mfrrBounds: cachedMfrrBounds,
      imbBounds: cachedImbBounds,
      afrrPosBounds: cachedAfrrPosBounds,
      afrrNegBounds: cachedAfrrNegBounds,
      reserveMfrrBounds: cachedResMfrrBounds,
      reserveAfrrBounds: cachedResAfrrBounds,
    };
  }

  function forceRewinsor() {
    cachedMfrrKey = null;
    cachedImbKey = null;
    cachedAfrrPosKey = null;
    cachedAfrrNegKey = null;
    cachedResMfrrKey = null;
    cachedResAfrrKey = null;
    _splitFxKey = null;
    _splitFx = null;
  }

  // ---------- adaptive mFRR↔aFRR split ----------------------------------
  // Per-direction "follow the winner" split. The static split is the z=0
  // special case (split stays at its start). Decision metric = average
  // per-MW revenue RATE over the previous block:
  //   up:  mFRR = p_mfrr when it clears up (≥1) else 0 ;  aFRR = avg_p_pos
  //   dn:  mFRR = −p_mfrr when it clears dn (≤−1) else 0;  aFRR = −avg_p_neg
  // Prefix sums of those four rate series (over the WINSORIZED prices) are
  // cached by winsor state so the optimiser only pays O(blocks) per eval.
  function _splitEffPrefix() {
    const key = `${cachedMfrrKey}|${cachedAfrrPosKey}|${cachedAfrrNegKey}`;
    if (key === _splitFxKey && _splitFx) return _splitFx;
    const n = D.n;
    const pUM = new Float64Array(n + 1);
    const pUA = new Float64Array(n + 1);
    const pDM = new Float64Array(n + 1);
    const pDA = new Float64Array(n + 1);
    const pm = D.p_mfrr, ap = D.avg_p_pos, an = D.avg_p_neg;
    for (let i = 0; i < n; i++) {
      const m = pm[i], a = ap[i], b = an[i];
      pUM[i + 1] = pUM[i] + (m >= 1 ? m : 0);
      pDM[i + 1] = pDM[i] + (m <= -1 ? -m : 0);
      pUA[i + 1] = pUA[i] + (a > 0 ? a : 0);
      pDA[i + 1] = pDA[i] + (b < 0 ? -b : 0);
    }
    _splitFx = { pUM, pUA, pDM, pDA };
    _splitFxKey = key;
    return _splitFx;
  }

  // Piecewise-constant split sequence over [0, upto). The split is held for a
  // segment of `wait` ISPs (the rebalance CADENCE), then at each segment
  // boundary it steps toward whichever market had the higher average per-MW
  // rate over the trailing `win` ISPs (the LOOKBACK window) — causal, no
  // lookahead. `wait` and `win` are decoupled: wait=1 re-evaluates every ISP
  // off a sliding win-ISP window; wait=win reproduces the old non-overlapping
  // block behaviour exactly. Returns { blocks, w } where w is the SEGMENT
  // length (cadence) used to index blocks (SP.up[(i/w)|0]).
  function _splitBlocks(start, win, step, wait, fxM, fxA, upto) {
    const lb = win < 1 ? 1 : win | 0; // lookback length
    const wt = wait < 1 ? 1 : wait | 0; // cadence (segment length)
    const nB = Math.max(1, Math.floor((Math.max(1, upto) - 1) / wt) + 1);
    const blocks = new Float64Array(nB);
    let s = start < 0 ? 0 : start > 1 ? 1 : start;
    blocks[0] = s;
    for (let k = 1; k < nB; k++) {
      if (step > 0) {
        const boundary = k * wt; // ISP at the start of segment k
        const lo = boundary - lb < 0 ? 0 : boundary - lb; // trailing lookback start
        const hi = boundary < D.n ? boundary : D.n;
        const cnt = hi - lo;
        if (cnt > 0) {
          const am = (fxM[hi] - fxM[lo]) / cnt;
          const aa = (fxA[hi] - fxA[lo]) / cnt;
          if (am > aa) s += step;
          else if (aa > am) s -= step;
          if (s < 0) s = 0;
          else if (s > 1) s = 1;
        }
      }
      blocks[k] = s;
    }
    return { blocks, w: wt };
  }

  // Build the up/down block-split sequences for the current window (or two
  // constant-1 stubs when the split strategy is off).
  function _resolveSplit(p) {
    if (!p.splitAdaptive) {
      return { up: [1], upW: Math.max(1, winEnd || 1), dn: [1], dnW: Math.max(1, winEnd || 1) };
    }
    const fx = _splitEffPrefix();
    const u = _splitBlocks(p.s_up_start, p.s_up_win, p.s_up_step, p.s_up_wait, fx.pUM, fx.pUA, winEnd);
    const v = _splitBlocks(p.s_dn_start, p.s_dn_win, p.s_dn_step, p.s_dn_wait, fx.pDM, fx.pDA, winEnd);
    return { up: u.blocks, upW: u.w, dn: v.blocks, dnW: v.w };
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
    // Reserve defaults OFF (=== true) so callers that omit it — including
    // every existing test and the frozen-value baselines — are unaffected.
    const reserveOn = en.reserve === true;
    const reserveUpOn = en.reserveUp === true;
    const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
    const X = +params.X || 0;
    const Y_raw = +params.Y || 0;
    const Z_raw = +params.Z || 0;
    const theta_flat = +params.theta_flat || 0;
    // Adaptive split: start x (falls back to a scalar s_up/s_dn if supplied,
    // so legacy static calls still resolve to a constant split), rebalance
    // window y (ISPs), step z. step = 0 ⇒ split never moves ⇒ static = start.
    // When the split strategy is off, the split is a constant 1 (all mFRR).
    const sUpStart = params.s_up_start != null ? +params.s_up_start : (params.s_up != null ? +params.s_up : 1);
    const sDnStart = params.s_dn_start != null ? +params.s_dn_start : (params.s_dn != null ? +params.s_dn : 1);
    const clampStep = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
    return {
      X,
      Y: daWithhold ? Y_raw : 0,
      Z: idTrust ? Z_raw : 0,
      theta_flat,
      splitAdaptive: split,
      s_up_start: split ? clamp01(sUpStart) : 1,
      s_dn_start: split ? clamp01(sDnStart) : 1,
      s_up_win: Math.max(1, (params.s_up_win | 0) || 96),
      s_dn_win: Math.max(1, (params.s_dn_win | 0) || 96),
      // rebalance cadence (ISPs between recomputes); 1 = every ISP. Decoupled
      // from the lookback window above. wait = win reproduces the old behaviour.
      s_up_wait: Math.max(1, (params.s_up_wait | 0) || 1),
      s_dn_wait: Math.max(1, (params.s_dn_wait | 0) || 1),
      s_up_step: split ? clampStep(+params.s_up_step || 0) : 0,
      s_dn_step: split ? clampStep(+params.s_dn_step || 0) : 0,
      actualSource: params.actualSource || "real",
      idSource: params.idSource || "real",
      dayTypeFilter: params.dayTypeFilter || "all",
      reserveEnabled: reserveOn,
      r_coef: reserveOn ? clamp01(+params.r_coef || 0) : 0,
      r_split: reserveOn ? clamp01(params.r_split == null ? 1 : +params.r_split) : 1,
      r_min_price: +params.r_min_price || 0,
      reserveUpEnabled: reserveUpOn,
      ru_coef: reserveUpOn ? clamp01(+params.ru_coef || 0) : 0,
      ru_split: reserveUpOn ? clamp01(params.ru_split == null ? 1 : +params.ru_split) : 1,
      ru_min_price: +params.ru_min_price || 0,
      ru_min_mw: +params.ru_min_mw || 0,
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
    // aFRR OFFERED MW per direction (whole-MW). Stored explicitly so the chart
    // tooltip never has to reconstruct the split from Q_up/Q_dn — that
    // reconstruction double-applies the split when the same-direction mFRR leg
    // didn't clear (Q_up then already equals the aFRR portion alone), which
    // under-showed "offered". Dispatched stays Q_*_afrr_disp = offered × n_*_fav/225.
    const Q_up_afrr_off = new Float32Array(wLen);
    const Q_dn_afrr_off = new Float32Array(wLen);
    const Q_s3_intraday = new Float32Array(wLen);
    const Q_s3_curtail = new Float32Array(wLen);
    const Q_short = new Float32Array(wLen);
    const revenue = new Float32Array(wLen);
    const reserveRev = new Float32Array(wLen); // down-capacity income per ISP (EUR)
    const reserveUpRev = new Float32Array(wLen); // up-capacity income per ISP (EUR)
    const splitUpArr = new Float32Array(wLen); // adaptive s_up per ISP
    const splitDnArr = new Float32Array(wLen); // adaptive s_dn per ISP
    const SP = _resolveSplit(p);
    let sumDA = 0,
      sumUpMfrr = 0,
      sumDnMfrr = 0,
      sumUpAfrr = 0,
      sumDnAfrr = 0,
      sumImb = 0,
      sumFlat = 0,
      sumS3Intraday = 0,
      sumS3Curtail = 0,
      sumS3ExtraCost = 0,
      sumReserve = 0,
      sumReserveUp = 0;
    let nUp = 0,
      nDn = 0,
      nWasted = 0,
      nShort = 0,
      nUpAfrr = 0,
      nDnAfrr = 0,
      nS3Oversold = 0,
      nS3HedgeFired = 0,
      nReserve = 0,
      nReserveUp = 0;
    let totalShortMWh = 0;
    let nNegRevWarn = 0;

    // Day-type filter (post-hoc accumulation gate — see _dayAccepts). Per-ISP
    // arrays are filled for EVERY ISP so the time-series chart keeps a
    // continuous window; only the totals/counts below are gated by `accept`.
    const dtf = p.dayTypeFilter;
    const filtering = dtf !== "all";
    const mask = D.dayTypeMask;
    const dayType = new Uint8Array(wLen);
    const filteredRev = [];
    let matchedCount = 0;

    for (let i = winStart; i < winEnd; i++) {
      const k = i - winStart;
      const accept = !filtering || _dayAccepts(dtf, mask[i]);
      // Adaptive split for this ISP (constant 1 when the split strategy is off).
      const sUp = p.splitAdaptive ? SP.up[(i / SP.upW) | 0] : 1;
      const sDn = p.splitAdaptive ? SP.dn[(i / SP.dnW) | 0] : 1;
      const F = D.da_forecast[i];
      const ID = ID_src[i];
      const P_da = D.p_da[i];
      const P_mfrr = D.p_mfrr[i];
      const aboveX = P_da >= p.X;
      // ----- Reserve market (UP capacity) — carved out FIRST -----
      // Upward reserve is NOT free: each awarded MW is withheld from DA (it is
      // the headroom we'd ramp into if activated), so it shrinks the MW left for
      // DA + down capacity to F_avail = F − R_up. Gated by a forecast floor
      // (ru_min_mw) and the per-product reserve price. MANDATORY: the awarded MW
      // are offered as mFRR/aFRR-up regardless of wind, and when up-activated
      // they enter the position ⇒ imbalance risk if actual wind is short.
      let R_up_mfrr = 0,
        R_up_afrr = 0,
        reserve_up_rate = 0;
      if (p.reserveUpEnabled && F >= p.ru_min_mw) {
        const Ru_total = Math.floor(p.ru_coef * F + 1e-9);
        const Rum0 = Math.round(p.ru_split * Ru_total);
        const pru_m = D.reserve_mfrr_up[i];
        const pru_a = D.reserve_afrr_up[i];
        if (isFinite(pru_m) && pru_m >= p.ru_min_price) {
          R_up_mfrr = Rum0;
          reserve_up_rate += R_up_mfrr * pru_m;
        }
        if (isFinite(pru_a) && pru_a >= p.ru_min_price) {
          R_up_afrr = Ru_total - Rum0;
          reserve_up_rate += R_up_afrr * pru_a;
        }
      }
      const R_up = R_up_mfrr + R_up_afrr;
      const F_avail = F - R_up; // forecast left for DA + down capacity

      // ----- Reserve market (down capacity) — sized within F_avail -----
      // Awarded R MW down (whole-MW), split mFRR/aFRR; a product is kept only
      // if its winsorized capacity price is finite and ≥ min reserve price.
      // reserve_rate is EUR/h (price·MW); the trailing ×0.25 makes the 15-min
      // capacity payment. When reserve is off, R_*=0 and this is inert.
      let R_mfrr = 0,
        R_afrr = 0,
        reserve_rate = 0;
      if (p.reserveEnabled) {
        const R_total = Math.floor(p.r_coef * F_avail + 1e-9);
        const Rm0 = Math.round(p.r_split * R_total);
        const pr_m = D.reserve_mfrr_dn[i];
        const pr_a = D.reserve_afrr_dn[i];
        if (isFinite(pr_m) && pr_m >= p.r_min_price) {
          R_mfrr = Rm0;
          reserve_rate += R_mfrr * pr_m;
        }
        if (isFinite(pr_a) && pr_a >= p.r_min_price) {
          R_afrr = R_total - Rm0;
          reserve_rate += R_afrr * pr_a;
        }
      }
      const R_dn = R_mfrr + R_afrr;
      // DA position: down-reserve MW are MANDATORY DA sales (bypass withhold);
      // the withhold rule governs only the rest, all within F_avail.
      // F_int − R_up − da_sold = free withheld up-offer. With both reserves off
      // (R_up = R_dn = 0) this is identical to the pre-reserve math.
      const F_int = Math.floor(F + 1e-9);
      const da_sold_wh = Math.floor((aboveX ? F_avail : F_avail * (1 - p.Y)) + 1e-9);
      const da_sold = da_sold_wh > R_dn ? da_sold_wh : R_dn;
      const Q_w = F_int - R_up - da_sold;
      const trustedRevRaw = p.Z * (ID - F);
      if (trustedRevRaw < 0) nNegRevWarn++;
      const trustedExtra = trustedRevRaw > 0 ? Math.floor(trustedRevRaw + 1e-9) : 0;
      // mFRR ↔ aFRR split (per-direction, round-and-remainder). Reserve MW (up
      // and down) carry their own split as a mandatory floor; the free volume
      // uses the adaptive s_up / s_dn. Total up offer = R_up + free; total down
      // offer = R_dn + non-reserve == da_sold (unchanged from pre-reserve).
      const up_free = Q_w + trustedExtra;
      const da_nonreserve = da_sold - R_dn;
      const rest_up_mfrr = Math.round(sUp * up_free);
      const Q_up_mfrr = R_up_mfrr + rest_up_mfrr;
      const Q_up_afrr = R_up_afrr + (up_free - rest_up_mfrr);
      const rest_dn_mfrr = Math.round(sDn * da_nonreserve);
      const Q_dn_mfrr = R_mfrr + rest_dn_mfrr;
      const Q_dn_afrr = R_afrr + (da_nonreserve - rest_dn_mfrr);
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
          s3_curtail +
          reserve_rate +
          reserve_up_rate -
          imb -
          flat -
          s3_extra_cost) *
        0.25;
      // Per-ISP arrays are always written (full continuous window).
      Q_da_sold[k] = da_sold;
      reserveRev[k] = reserve_rate * 0.25;
      reserveUpRev[k] = reserve_up_rate * 0.25;
      Q_up[k] = up_mfrr + Q_up_afrr;
      Q_dn[k] = dn_mfrr + Q_dn_afrr;
      Q_up_afrr_off[k] = Q_up_afrr; // true aFRR-up MW offered (whole-MW)
      Q_dn_afrr_off[k] = Q_dn_afrr; // true aFRR-dn MW offered
      Q_s3_intraday[k] = s3_X;
      Q_s3_curtail[k] = s3_fires ? s3_X : 0;
      Q_short[k] = short;
      revenue[k] = rev;
      splitUpArr[k] = sUp;
      splitDnArr[k] = sDn;
      dayType[k] = mask[i];
      // Totals / counts only accumulate matching-day ISPs.
      if (!accept) continue;
      matchedCount++;
      filteredRev.push(rev);
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
      sumReserve += reserve_rate * 0.25;
      sumReserveUp += reserve_up_rate * 0.25;
      if (up_mfrr > 1e-6) nUp++;
      else if (dn_mfrr > 1e-6) nDn++;
      else if (Q_w > 1e-6 && !upAfrrActive && !dnAfrrActive) nWasted++;
      if (upAfrrActive) nUpAfrr++;
      if (dnAfrrActive) nDnAfrr++;
      if (R_dn > 0) nReserve++;
      if (R_up > 0) nReserveUp++;
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
      sumS3Curtail +
      sumReserve +
      sumReserveUp -
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
        Q_up_afrr_off,
        Q_dn_afrr_off,
        Q_s3_intraday,
        Q_s3_curtail,
        Q_short,
        revenue,
        reserveRev,
        reserveUpRev,
        s_up: splitUpArr,
        s_dn: splitDnArr,
        dayType,
      },
      // Revenues of matching-day ISPs only (== perISP.revenue when filter is
      // "all"). Histogram + robustness read this so they reflect the filter.
      filteredRevenue: Float64Array.from(filteredRev),
      matchedCount,
      totalRevenue: total,
      breakdown: {
        DA: sumDA,
        mFRR_up: sumUpMfrr,
        mFRR_dn: sumDnMfrr,
        aFRR_up: sumUpAfrr,
        aFRR_dn: sumDnAfrr,
        s3_intraday: sumS3Intraday,
        s3_curtail: sumS3Curtail,
        reserve: sumReserve,
        reserveUp: sumReserveUp,
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
        reserveISPs: nReserve,
        reserveUpISPs: nReserveUp,
      },
      totalShortMWh,
    };
  }

  // ---------- fast total-only simulation (for sweeps) --------------------
  // Same math as simulate() but returns only the scalar totalRevenue.
  // Inlined hot path; no per-ISP arrays allocated.
  // INVARIANT: every whole-MW floor must stay textually identical to
  // simulate() — Math.floor(x + 1e-9), never |0. Bare truncation drops the
  // epsilon guard, so fractional-coefficient products (0.58 × 50 =
  // 28.999999999999996) floor one MW lower here than in simulate(), and the
  // optimiser then ranks candidates on a different objective than the
  // headline the UI displays.
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
    const resM_arr = D.reserve_mfrr_dn;
    const resA_arr = D.reserve_afrr_dn;
    const resMU_arr = D.reserve_mfrr_up;
    const resAU_arr = D.reserve_afrr_up;
    const SP = _resolveSplit(p);
    // Day-type filter: skip non-matching ISPs (their P&L is independent of
    // every other ISP, so dropping them from the sum is exact). Rolling stats
    // are still full-data, so S3 continuity is preserved. See _dayAccepts.
    const dtf = p.dayTypeFilter;
    const filtering = dtf !== "all";
    const mask = D.dayTypeMask;
    let total = 0;
    for (let i = winStart; i < winEnd; i++) {
      if (filtering && !_dayAccepts(dtf, mask[i])) continue;
      const sUp = p.splitAdaptive ? SP.up[(i / SP.upW) | 0] : 1;
      const sDn = p.splitAdaptive ? SP.dn[(i / SP.dnW) | 0] : 1;
      const F = F_arr[i];
      const P_da = P_da_arr[i];
      const P_mfrr = P_mfrr_arr[i];
      const aboveX = P_da >= p.X;
      // Reserve UP capacity carved from forecast first (mirror simulate()).
      let R_up_mfrr = 0,
        R_up_afrr = 0,
        reserve_up_rate = 0;
      if (p.reserveUpEnabled && F >= p.ru_min_mw) {
        const Ru_total = Math.floor(p.ru_coef * F + 1e-9);
        const Rum0 = Math.round(p.ru_split * Ru_total);
        const pru_m = resMU_arr[i];
        const pru_a = resAU_arr[i];
        if (isFinite(pru_m) && pru_m >= p.ru_min_price) {
          R_up_mfrr = Rum0;
          reserve_up_rate += R_up_mfrr * pru_m;
        }
        if (isFinite(pru_a) && pru_a >= p.ru_min_price) {
          R_up_afrr = Ru_total - Rum0;
          reserve_up_rate += R_up_afrr * pru_a;
        }
      }
      const R_up = R_up_mfrr + R_up_afrr;
      const F_avail = F - R_up;
      // Reserve down capacity (mirror simulate(); inert when reserve off).
      let R_mfrr = 0,
        R_afrr = 0,
        reserve_rate = 0;
      if (p.reserveEnabled) {
        const R_total = Math.floor(p.r_coef * F_avail + 1e-9);
        const Rm0 = Math.round(p.r_split * R_total);
        const pr_m = resM_arr[i];
        const pr_a = resA_arr[i];
        if (isFinite(pr_m) && pr_m >= p.r_min_price) {
          R_mfrr = Rm0;
          reserve_rate += R_mfrr * pr_m;
        }
        if (isFinite(pr_a) && pr_a >= p.r_min_price) {
          R_afrr = R_total - Rm0;
          reserve_rate += R_afrr * pr_a;
        }
      }
      const R_dn = R_mfrr + R_afrr;
      const da_sold_wh = Math.floor((aboveX ? F_avail : F_avail * (1 - p.Y)) + 1e-9);
      const da_sold = da_sold_wh > R_dn ? da_sold_wh : R_dn;
      const Q_w = Math.floor(F + 1e-9) - R_up - da_sold;
      const trustedRevRaw = p.Z * (ID_src[i] - F);
      const trustedExtra = trustedRevRaw > 0 ? Math.floor(trustedRevRaw + 1e-9) : 0;
      const up_free = Q_w + trustedExtra;
      const da_nonreserve = da_sold - R_dn;
      const rest_up_mfrr = Math.round(sUp * up_free);
      const Q_up_mfrr = R_up_mfrr + rest_up_mfrr;
      const Q_up_afrr = R_up_afrr + (up_free - rest_up_mfrr);
      const rest_dn_mfrr = Math.round(sDn * da_nonreserve);
      const Q_dn_mfrr = R_mfrr + rest_dn_mfrr;
      const Q_dn_afrr = R_afrr + (da_nonreserve - rest_dn_mfrr);
      const isUp = P_mfrr >= 1;
      const isDn = P_mfrr <= -1;
      const up_mfrr = isUp ? Q_up_mfrr : 0;
      const dn_mfrr = isDn ? Q_dn_mfrr : 0;
      const avg_pos = aPos_arr[i];
      const avg_neg = aNeg_arr[i];
      const upAfrrActive = avg_pos > 0 && Q_up_afrr > 0;
      const dnAfrrActive = avg_neg < 0 && Q_dn_afrr > 0;
      let rev = da_sold * P_da + up_mfrr * P_mfrr - dn_mfrr * P_mfrr + reserve_rate + reserve_up_rate;
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
              const X_prop = Math.floor(X_raw + 1e-9);
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

  // Naïve baseline: the true do-nothing reference. Same sources / θ, but
  // every strategy neutralised so the headline "vs naïve" shows the lift from
  // ALL enabled strategies, each comparable against the same floor:
  //   · X = Y = Z = 0   → no DA-withhold, no ID-trust (sell everything to DA)
  //   · s3 / reserve off
  //   · split off       → all balancing volume to mFRR (the default market)
  // Disabling the split here is what lets turning the adaptive split ON read
  // as a gain — otherwise the baseline would run the same adaptive split and
  // absorb its down-side value. (At the default split — start 1 / step 0,
  // already all-mFRR — the baseline is unchanged, so this doesn't move the
  // default vs-naïve number.)
  function naiveRevenue(params) {
    const naiveP = {
      ...params,
      X: 0,
      Y: 0,
      Z: 0,
      enabled: { ...(params.enabled || {}), s3: false, reserve: false, reserveUp: false, split: false },
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
    const dtf = p.dayTypeFilter;
    const filtering = dtf !== "all";
    const mask = D.dayTypeMask;
    const SP = _resolveSplit(p);
    const buckets = new Map();
    for (let i = winStart; i < winEnd; i++) {
      if (filtering && !_dayAccepts(dtf, mask[i])) continue;
      const sUp = p.splitAdaptive ? SP.up[(i / SP.upW) | 0] : 1;
      const sDn = p.splitAdaptive ? SP.dn[(i / SP.dnW) | 0] : 1;
      const ts = new Date(start.getTime() + D.offsets[i] * D.step_min * 60000);
      const key = `${ts.getUTCFullYear()}-${String(ts.getUTCMonth() + 1).padStart(2, "0")}`;
      const F = D.da_forecast[i];
      const ID = ID_src[i];
      const P_da = D.p_da[i];
      const P_mfrr = D.p_mfrr[i];
      const aboveX = P_da >= p.X;
      // Reserve UP capacity carved from forecast first (mirror simulate()).
      let R_up_mfrr = 0,
        R_up_afrr = 0,
        reserve_up_rate = 0;
      if (p.reserveUpEnabled && F >= p.ru_min_mw) {
        const Ru_total = Math.floor(p.ru_coef * F + 1e-9);
        const Rum0 = Math.round(p.ru_split * Ru_total);
        const pru_m = D.reserve_mfrr_up[i];
        const pru_a = D.reserve_afrr_up[i];
        if (isFinite(pru_m) && pru_m >= p.ru_min_price) {
          R_up_mfrr = Rum0;
          reserve_up_rate += R_up_mfrr * pru_m;
        }
        if (isFinite(pru_a) && pru_a >= p.ru_min_price) {
          R_up_afrr = Ru_total - Rum0;
          reserve_up_rate += R_up_afrr * pru_a;
        }
      }
      const R_up = R_up_mfrr + R_up_afrr;
      const F_avail = F - R_up;
      // Reserve down capacity (mirror simulate(); inert when reserve off).
      let R_mfrr = 0,
        R_afrr = 0,
        reserve_rate = 0;
      if (p.reserveEnabled) {
        const R_total = Math.floor(p.r_coef * F_avail + 1e-9);
        const Rm0 = Math.round(p.r_split * R_total);
        const pr_m = D.reserve_mfrr_dn[i];
        const pr_a = D.reserve_afrr_dn[i];
        if (isFinite(pr_m) && pr_m >= p.r_min_price) {
          R_mfrr = Rm0;
          reserve_rate += R_mfrr * pr_m;
        }
        if (isFinite(pr_a) && pr_a >= p.r_min_price) {
          R_afrr = R_total - Rm0;
          reserve_rate += R_afrr * pr_a;
        }
      }
      const R_dn = R_mfrr + R_afrr;
      const F_int = Math.floor(F + 1e-9);
      const da_sold_wh = Math.floor((aboveX ? F_avail : F_avail * (1 - p.Y)) + 1e-9);
      const da_sold = da_sold_wh > R_dn ? da_sold_wh : R_dn;
      const Q_w = F_int - R_up - da_sold;
      const trustedRevRaw = p.Z * (ID - F);
      const trustedExtra = trustedRevRaw > 0 ? Math.floor(trustedRevRaw + 1e-9) : 0;
      const up_free = Q_w + trustedExtra;
      const da_nonreserve = da_sold - R_dn;
      const rest_up_mfrr = Math.round(sUp * up_free);
      const Q_up_mfrr = R_up_mfrr + rest_up_mfrr;
      const Q_up_afrr = R_up_afrr + (up_free - rest_up_mfrr);
      const rest_dn_mfrr = Math.round(sDn * da_nonreserve);
      const Q_dn_mfrr = R_mfrr + rest_dn_mfrr;
      const Q_dn_afrr = R_afrr + (da_nonreserve - rest_dn_mfrr);
      const Reserve_rev = reserve_rate * 0.25;
      const ReserveUp_rev = reserve_up_rate * 0.25;
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
          reserve: 0,
          reserveUp: 0,
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
      b.reserve += Reserve_rev;
      b.reserveUp += ReserveUp_rev;
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
        reserve: b.reserve,
        reserveUp: b.reserveUp,
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
          b.s3_curtail +
          b.reserve +
          b.reserveUp -
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
    const dtf = (params && params.dayTypeFilter) || "all";
    const filtering = dtf !== "all";
    const mask = D.dayTypeMask;
    let s = 0;
    for (let i = winStart; i < winEnd; i++) {
      if (filtering && !_dayAccepts(dtf, mask[i])) continue;
      s += arr[i] * 0.25;
    }
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
