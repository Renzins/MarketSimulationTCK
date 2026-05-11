// engine.js — pure simulation logic for the Vanessa wind-park Backtester.
//
// No DOM access. Reads from a pre-loaded WIND_DATA global plus parameter
// objects. Returns per-ISP arrays, totals and decompositions.
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
//   The mFRR-vs-aFRR economics differ between directions (mFRR-up clears
//   only on upside spikes, aFRR-up earns continuously on positive avg;
//   the downward direction has its own separate price dynamics), so the
//   strategy parameter is per-direction:
//     Q_up_mfrr = round(s_up * Q_up_offer)      Q_up_afrr = Q_up_offer - Q_up_mfrr
//     Q_dn_mfrr = round(s_dn * Q_dn_offer)      Q_dn_afrr = Q_dn_offer - Q_dn_mfrr
//   With s_up = s_dn = 1 (default) both aFRR terms are 0 and the engine
//   reduces to its pre-feature behaviour (frozen regression values still
//   hold). aFRR prices come from data-afrr-15min.js: avg_p_pos[i] /
//   avg_p_neg[i] are the time-weighted means of AST_POS / AST_NEG over
//   each ISP's 4-s slots, with NaN treated as 0 (sum / 225). See
//   preprocess-afrr-15min.py for the derivation.
//
// PHYSICAL CONSTRAINTS (audit-applied, do NOT regress)
//   * Whole-MW market quantities. Balancing market accepts integer MW only,
//     so Q_da_sold, Q_w, trusted_rev and Q_dn_offer are floored. Fractional
//     MW between floor(F) and the actual forecast are simply not traded.
//     The s-split also produces integer Q_*_mfrr / Q_*_afrr (round + remainder).
//   * mFRR-dn capped at the DA position. A wind park can drop from Q_da_sold
//     to 0 but cannot go below 0. Therefore Q_dn_offer = Q_da_sold (NOT Q_w),
//     independent of Y. When Q_da_sold = 0 there is no mFRR-dn revenue.
//   * Q_position = Q_da_sold + Q_up_active - Q_dn_active. mFRR-up and
//     mFRR-dn cannot both fire in the same ISP (P_mfrr is single-signed).
//     aFRR contributions are scaled by activity fraction (n_pos/225 for
//     upward, n_neg/225 for downward) since aFRR is partial-dispatch.
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
//   revenue to the L2 totals. Tests verify this.
//
// EXPORTS
//   init(rawData)                  — bootstrap typed-array views, reset window
//   getData()                      — internal D (typed arrays + meta + dayTypeMask + aFRR)
//   setWindow(start, end)          — half-open ISP-index window (invalidates winsor cache)
//   getWindow()                    — { start, end }
//   maybeWinsorize(mfrrLo, mfrrHi, imbLo, imbHi, posLo, posHi, negLo, negHi)
//                                  — keyed-cache; ALWAYS returns current bounds (for live UI)
//   forceRewinsor()                — invalidate cache (rare)
//   simulate(level, params)        — full per-ISP detail (params.s_up / params.s_dn)
//   simulateTotal(level, X,Y,Z,θ,s_up,s_dn)
//                                  — fast total-only (sweeps)
//   naiveRevenue(level, θ, s_up, s_dn)
//                                  — simulateTotal at X=0,Y=0,Z=0 with current splits
//   sweepLevel1(xs, ys, ss_up, ss_dn) — 4-D grid for the L1 optimiser
//   sweepLevel2(xs, ys, zs, ss_up, ss_dn, θ)
//                                  — 5-D grid for the L2 optimiser
//   topConcentration(perISP, frac) — top-N% revenue share (robustness)
//   monthlyAggregation(level, p)   — month-bucketed decomposition (incl. aFRR)
//   totalPotMWhInWindow()          — sum of q_pot in current window
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
      // Engine treats NaN p_imb as zero imbalance cost in L2.
      p_imb_raw: _toFloat32WithNaN(rawData.p_imb),
      // vwap_1h is the LV intraday 1h-VWAP. NaN where missing — L3's S3
      // (speculative oversell) strategy skips those ISPs.
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
    // (slots where AST_POS > 0 / AST_NEG < 0). They scale the L2
    // position contribution: Q_*_afrr × n_*_fav / 225. Distinct from
    // data-afrr.js's n_pos / n_neg, which count ALL non-NaN slots
    // regardless of sign.
    //
    // If a refreshed data-afrr-15min.js doesn't have the new
    // *_fav arrays (older preprocess version), we fall back to
    // AFRR_DATA's n_pos / n_neg — slightly inaccurate for the mixed-
    // sign ISPs the new filter targets, but the engine still runs.
    if (typeof AFRR_15MIN !== "undefined" && AFRR_15MIN && AFRR_15MIN.n === D.n) {
      D.avg_p_pos_raw = new Float32Array(AFRR_15MIN.avg_p_pos);
      D.avg_p_neg_raw = new Float32Array(AFRR_15MIN.avg_p_neg);
    } else {
      D.avg_p_pos_raw = new Float32Array(D.n);
      D.avg_p_neg_raw = new Float32Array(D.n);
    }
    D.avg_p_pos = new Float32Array(D.n); // winsorized
    D.avg_p_neg = new Float32Array(D.n); // winsorized

    // Favourable counts (preferred) with fallback to legacy n_pos / n_neg.
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

    // Day-type classification per ISP — used by the Graphs page's day-type
    // filter (workdays / weekends+holidays / all). Computed once here from
    // timestamps + the date-holidays plugin (if present); 1 ms work, no
    // dependence on user-set filter state.
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
  // Mask values:
  //   0 = workday (Mon–Fri AND not a public holiday in LV/EE/LT)
  //   1 = weekend (Saturday or Sunday — UTC day-of-week)
  //   2 = holiday (Mon–Fri but a public holiday in any of LV / EE / LT)
  //
  // We classify by UTC calendar date — the dataset's offsets[] are in UTC
  // throughout, and date-holidays returns a YYYY-MM-DD prefix in the
  // country's local time. Local-vs-UTC boundary error is at most ~3 hours
  // per holiday (LV/EE/LT are UTC+2 / +3); below the 15-min ISP sensitivity
  // for nearly all aggregate analyses. If exact local-time classification
  // becomes required, this is the function to upgrade.
  //
  // If the date-holidays plugin is missing (e.g. on the Backtester page,
  // which doesn't load it), the holiday set stays empty and the mask
  // degrades to weekend-only — every Mon–Fri counts as a workday. The
  // graphs page's day-type filter still works in that mode; "weekends +
  // holidays" simply matches Sat/Sun.
  function _computeDayTypeMask(rawData) {
    const n = rawData.n;
    const startMs = new Date(rawData.start_iso).getTime();
    const stepMs = rawData.step_min * 60000;
    const offsets = rawData.offsets;
    const mask = new Uint8Array(n);
    const holidaySet = _balticHolidaySet(startMs, offsets, n, stepMs);
    for (let i = 0; i < n; i++) {
      const ts = new Date(startMs + offsets[i] * stepMs);
      const dow = ts.getUTCDay(); // 0 = Sun, 6 = Sat
      if (dow === 0 || dow === 6) {
        mask[i] = 1; // weekend
      } else {
        const ds = ts.toISOString().substring(0, 10);
        mask[i] = holidaySet.has(ds) ? 2 : 0;
      }
    }
    return mask;
  }

  // Build the union of public-holiday calendar dates (YYYY-MM-DD strings)
  // across LV / EE / LT for every year in the dataset, using the
  // date-holidays plugin loaded as a global.
  function _balticHolidaySet(startMs, offsets, n, stepMs) {
    const set = new Set();
    // The UMD bundle of date-holidays v3+ exposes the constructor as either
    // window.Holidays directly (older style) OR window.Holidays.default
    // (ES-module-flavoured style — what v3.28's umd.min.js does). Probe both.
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
      const lastYear = new Date(
        startMs + offsets[n - 1] * stepMs,
      ).getUTCFullYear();
      for (const cc of ["LV", "EE", "LT"]) {
        const hd = new Ctor(cc);
        for (let y = firstYear; y <= lastYear; y++) {
          const list = hd.getHolidays(y) || [];
          for (const h of list) {
            // Public bank-holiday calendar only — not 'observance' or 'school'.
            if (h.type !== "public") continue;
            // h.date is "YYYY-MM-DD HH:MM:SS" in the country's local TZ.
            // Substring(0, 10) gives the local calendar date, which we use
            // directly as the UTC-keyed bucket (see fn-level comment).
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

  // Set the simulation window. Re-clamps to dataset bounds. Invalidates the
  // winsorization cache because percentiles are derived from the window slice.
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
  // Cached bounds are kept across calls so the UI can show the current cap
  // values (live preview) without forcing a recompute on every render.
  let cachedMfrrKey = null;
  let cachedImbKey = null;
  let cachedAfrrPosKey = null;
  let cachedAfrrNegKey = null;
  let cachedMfrrBounds = { lo: 0, hi: 0 };
  let cachedImbBounds = { lo: 0, hi: 0 };
  let cachedAfrrPosBounds = { lo: 0, hi: 0 };
  let cachedAfrrNegBounds = { lo: 0, hi: 0 };

  // ---------- S3 (Level-3 speculative intraday oversell) rolling stats ----
  // Computed from raw p_imb across the FULL dataset (not the sim window) —
  // the rolling window looks back K ISPs from each H, which can cross the
  // window boundary. Independent of winStart/winEnd, so cached forever.
  // Keyed by K. NaN-aware: a window with <2 valid (non-NaN) values yields
  // NaN mean/std at that ISP (the S3 evaluator treats that as "skip ISP").
  // Sample std (ddof=1) per Q6.
  const _s3RollingCache = new Map();
  function _getS3Rolling(K) {
    if (!D || K < 1) return null;
    const key = K | 0;
    const hit = _s3RollingCache.get(key);
    if (hit) return hit;
    const n = D.n;
    const mean = new Float32Array(n);
    const std = new Float32Array(n);
    const src = D.p_imb_raw;
    for (let i = 0; i < n; i++) {
      if (i < key) {
        mean[i] = NaN;
        std[i] = NaN;
        continue;
      }
      let sum = 0;
      let cnt = 0;
      for (let j = i - key; j < i; j++) {
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
      for (let j = i - key; j < i; j++) {
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

  // Compute the percentile bounds over the [winStart, winEnd) slice and
  // clamp every value in `src` to those bounds, writing into `dst`. NaN
  // values are excluded from percentile computation and copied through to
  // dst as NaN (so the Backtester's L2 can detect missing imbalance prices).
  function applyWinsor(src, dst, pLow, pHigh) {
    const wLen = winEnd - winStart;
    if (wLen <= 0) {
      for (let i = 0; i < src.length; i++) dst[i] = src[i];
      return { lo: 0, hi: 0 };
    }
    // Collect non-NaN window values for percentile estimation
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

  // maybeWinsorize ALWAYS returns the current cached bounds (mfrr, imb,
  // afrrPos, afrrNeg) so the UI can read them for live cap previews
  // without forcing a recompute. New args (afrr*) default to 10/90 to keep
  // the Graphs page's existing 4-arg call valid.
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

  // ---------- detailed simulation (returns per-ISP arrays) ---------------
  // level: 1 or 2. params: { X, Y, Z?, theta_flat? }
  // Per-ISP arrays are sized to the simulation window length. The result
  // also carries windowStart / windowEnd so callers can map perISP[k]
  // back to a global ISP index via (windowStart + k).
  function simulate(level, params) {
    const { X, Y, Z = 0, theta_flat = 0 } = params;
    // s_up controls the mFRR/aFRR split for UPWARD volume offered; s_dn
    // for DOWNWARD volume. They're independent because the per-direction
    // economics differ (mFRR-up clears on upside spikes; mFRR-dn on the
    // negative side; aFRR earnings come from the AVERAGED 4-s prices).
    // Default both to 1 so any callers that didn't pass them still get
    // the all-mFRR behaviour and the frozen regression values hold.
    const s_up = params.s_up == null ? 1 : params.s_up;
    const s_dn = params.s_dn == null ? 1 : params.s_dn;
    const sUpC = s_up < 0 ? 0 : s_up > 1 ? 1 : s_up;
    const sDnC = s_dn < 0 ? 0 : s_dn > 1 ? 1 : s_dn;
    // ----- S3 (speculative intraday oversell) params -----
    // Only active when level === 3 AND X_cap ≥ 1 AND K ≥ 1. Setting X_cap=0
    // disables S3 entirely (UI convention; saves a toggle). L1/L2 always
    // skip S3 because isL3 is false.
    const isL3 = level === 3;
    const s3K = (params.s3_K | 0) || 0;
    const s3X_cap = (params.s3_X_cap | 0) || 0;
    const s3Enabled = isL3 && s3X_cap >= 1 && s3K >= 1;
    const s3S_min = +params.s3_S_min || 0;
    const s3Sigma_max = +params.s3_sigma_max || 0;
    const s3M = +params.s3_M || 0;
    const s3Roll = s3Enabled ? _getS3Rolling(s3K) : null;

    const wLen = Math.max(0, winEnd - winStart);
    const Q_da_sold = new Float32Array(wLen);
    const Q_up = new Float32Array(wLen); // total upward volume offered (mFRR + aFRR)
    const Q_dn = new Float32Array(wLen);
    // aFRR DISPATCHED MW (time-averaged over ISP) — the volume the system
    // actually used, after the profitability gate AND the n_pos/n_neg
    // activation fraction. These feed the time-series chart bars; they're
    // < Q_*_afrr offered when the gate fails or the activation rate < 1.
    const Q_up_afrr_disp = new Float32Array(wLen);
    const Q_dn_afrr_disp = new Float32Array(wLen);
    // S3 per-ISP volumes (positive ints in MW). Q_s3_intraday is the oversold
    // amount; Q_s3_curtail is the same amount when the defensive bid fires
    // (else 0). Charts show these as hatched green/red bars.
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
      nS3DefensiveFired = 0;
    let totalShortMWh = 0;
    let nNegRevWarn = 0;
    // L2 math also applies to L3 (which adds "speculation" on top).
    const isL2 = level >= 2;
    for (let i = winStart; i < winEnd; i++) {
      const k = i - winStart;
      const F = D.da_forecast[i];
      const ID = D.id_forecast[i];
      const P_da = D.p_da[i];
      const P_mfrr = D.p_mfrr[i];
      const aboveX = P_da >= X;
      const da_sold_raw = aboveX ? F : F * (1 - Y);
      const da_sold = Math.floor(da_sold_raw + 1e-9);
      const Q_w_raw = aboveX ? 0 : F - da_sold;
      const Q_w = Math.floor(Q_w_raw + 1e-9);
      const trustedRevRaw = isL2 ? Z * (ID - F) : 0;
      if (isL2 && trustedRevRaw < 0) nNegRevWarn++;
      const trustedExtra = trustedRevRaw > 0 ? Math.floor(trustedRevRaw + 1e-9) : 0;
      const Q_up_offer = Q_w + trustedExtra;
      const Q_dn_offer = da_sold;
      // ----- mFRR ↔ aFRR split (per-direction) -----
      // Round-and-remainder per direction: Q_up_mfrr + Q_up_afrr = Q_up_offer
      // exactly (no MW lost), same for downward. s_up = s_dn = 1 → all mFRR.
      const Q_up_mfrr = Math.round(sUpC * Q_up_offer);
      const Q_up_afrr = Q_up_offer - Q_up_mfrr;
      const Q_dn_mfrr = Math.round(sDnC * Q_dn_offer);
      const Q_dn_afrr = Q_dn_offer - Q_dn_mfrr;
      const isUp = P_mfrr >= 1;
      const isDn = P_mfrr <= -1;
      const up_mfrr = isUp ? Q_up_mfrr : 0;
      const dn_mfrr = isDn ? Q_dn_mfrr : 0;
      // ----- aFRR profitability gate (per direction, per ISP) -----
      // A wind park bidding sensibly will only OFFER aFRR-up where
      // avg_p_pos > 0 (positive earnings per MWh), and aFRR-dn where
      // avg_p_neg < 0 (system pays the park to curtail → −Q × negative =
      // positive earnings). When the gate fails, the offered volume earns
      // 0 AND contributes 0 to the L2 position — the park simply didn't
      // bid that direction this ISP. This is the ISP-level analogue of
      // the existing |P_mfrr| ≥ 1 mFRR gate.
      const avg_pos = D.avg_p_pos[i];
      const avg_neg = D.avg_p_neg[i];
      const upAfrrActive = avg_pos > 0 && Q_up_afrr > 0;
      const dnAfrrActive = avg_neg < 0 && Q_dn_afrr > 0;
      const up_afrr_rev_rate = upAfrrActive ? Q_up_afrr * avg_pos : 0;
      const dn_afrr_rev_rate = dnAfrrActive ? -Q_dn_afrr * avg_neg : 0;
      const DA_rev = da_sold * P_da;
      const Up_rev_mfrr = up_mfrr * P_mfrr;
      const Dn_rev_mfrr = -dn_mfrr * P_mfrr;
      // ----- position accounting -----
      // mFRR contributes its full Q when activated (binary across the ISP);
      // aFRR contributes a time-fraction n_*_fav[i]/225 — the FAVOURABLE
      // 4-s slot count (slots where the wind park would have bid). This
      // matches the favourable-only revenue averaging in preprocess-
      // afrr-15min.py: dispatched MW = MW × (favourable slots / 225).
      // The profitability gate ALSO governs position; if avg_p_pos ≤ 0
      // (no favourable slots existed) we weren't dispatched at all.
      const aFracPos = D.afrr_n_pos_fav[i] / 225;
      const aFracNeg = D.afrr_n_neg_fav[i] / 225;
      const up_afrr_disp = upAfrrActive ? Q_up_afrr * aFracPos : 0;
      const dn_afrr_disp = dnAfrrActive ? Q_dn_afrr * aFracNeg : 0;
      Q_up_afrr_disp[k] = up_afrr_disp;
      Q_dn_afrr_disp[k] = dn_afrr_disp;
      const Q_pos_l2 = da_sold + up_mfrr + up_afrr_disp - dn_mfrr - dn_afrr_disp;

      // ----- S3 (Level-3 speculative intraday oversell) ---------------
      // Evaluate the strategy's 3 gates (spread, sigma, ≥1 MW after floor).
      // If all pass, add X_prop MW to position (intraday oversell) and submit
      // a defensive mFRR-dn bid at vwap+M. Defensive fires iff p_mfrr ≤ -bid.
      // When defensive fires, the curtailment offsets the oversell exactly
      // (s3_delta_pos = 0). When it doesn't, position increases by X_prop
      // and the extra shortfall is settled at p_imb (+ theta_flat).
      // Uses WINSORIZED p_mfrr (D.p_mfrr) so the user's winsor settings
      // affect S3 the same way they affect existing mFRR revenue.
      let s3_X = 0;
      let s3_fires = false;
      let s3_intraday = 0;
      let s3_curtail = 0;
      if (s3Enabled) {
        const P_ID_est = D.vwap_1h[i];
        if (!isNaN(P_ID_est)) {
          const P_imb_est = s3Roll.mean[i];
          const P_imb_sigma = s3Roll.std[i];
          if (!isNaN(P_imb_est) && !isNaN(P_imb_sigma)) {
            const spread = P_ID_est - P_imb_est;
            if (spread >= s3S_min && P_imb_sigma <= s3Sigma_max) {
              const sig = (spread - s3S_min) / s3S_min;
              const X_raw = s3X_cap * (sig < 1 ? sig : 1);
              const X_prop = Math.floor(X_raw + 1e-9);
              if (X_prop >= 1) {
                const bid_price = P_ID_est + s3M;
                // Defensive bid is a "stop-loss" mFRR-dn order:
                // wind farm accepts being curtailed at any marginal price
                // ≤ bid_price. Negative P_mfrr → grid pays the wind farm
                // (windfall); positive P_mfrr ≤ bid_price → wind farm
                // pays the grid, but cost is capped at bid_price · X.
                // This caps the worst-case loss vs imbalance settlement.
                s3_fires = P_mfrr <= bid_price;
                s3_X = X_prop;
                s3_intraday = X_prop * P_ID_est;
                // Curtailment "revenue" is signed: −P_mfrr can be positive
                // (we're paid) OR negative (we paid). Accumulated as-is in
                // sumS3Curtail.
                if (s3_fires) s3_curtail = X_prop * (-P_mfrr);
              }
            }
          }
        }
      }
      const s3_delta_pos = s3_fires ? 0 : s3_X;
      const Q_pos = Q_pos_l2 + s3_delta_pos;
      const Q_pot = isL2 ? D.q_pot[i] : F;
      const short_l2 = Q_pos_l2 > Q_pot ? Q_pos_l2 - Q_pot : 0;
      const short = Q_pos > Q_pot ? Q_pos - Q_pot : 0;

      // ----- NaN p_imb handling -----
      // The Latvia imbalance-price source ran out at end-of-March 2026, so
      // ~6.8% of rows (mostly April) have NaN p_imb. We keep those rows in
      // the simulation (they still earn DA + mFRR + aFRR revenue) but zero
      // their imbalance & flat-penalty contributions — effectively assuming
      // "perfect imbalance" for those ISPs. This MILDLY undercounts L2 cost
      // if you point the sim window at April only.
      const P_imb_raw = isL2 ? D.p_imb[i] : 0;
      const P_imb_valid = isL2 ? !isNaN(P_imb_raw) : true;
      // L2 portion of imb/flat (existing behaviour). For L3 with S3, the
      // S3-induced extra shortfall settles at the same p_imb+theta but is
      // attributed to S3 so the decomposition makes sense.
      const imb = isL2 && P_imb_valid ? short_l2 * P_imb_raw : 0;
      const flat = isL2 && P_imb_valid ? short_l2 * theta_flat : 0;
      const s3_extra_short = short - short_l2; // ≥ 0
      const s3_extra_cost =
        isL2 && P_imb_valid ? s3_extra_short * (P_imb_raw + theta_flat) : 0;
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
      // Counts: mFRR up vs dn are mutually exclusive per ISP (P_mfrr is
      // single-signed) — kept as before. aFRR up / dn are independent and
      // can BOTH fire in the same ISP (e.g. mFRR-dn + aFRR-up at the same
      // time when prices allow it).
      if (up_mfrr > 1e-6) nUp++;
      else if (dn_mfrr > 1e-6) nDn++;
      else if (Q_w > 1e-6 && !upAfrrActive && !dnAfrrActive) nWasted++;
      if (upAfrrActive) nUpAfrr++;
      if (dnAfrrActive) nDnAfrr++;
      if (s3_X > 0) {
        nS3Oversold++;
        if (s3_fires) nS3DefensiveFired++;
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
        s3DefensiveFired: nS3DefensiveFired,
      },
      totalShortMWh,
    };
  }

  // ---------- fast total-only simulation (for sweeps) --------------------
  // s_up / s_dn default to 1 so legacy 5-arg callers keep their
  // pre-feature behaviour exactly (frozen regression values intact).
  // s3: null (disabled) or { K, S_min, sigma_max, X_cap, M } — when set
  // AND level === 3, adds the speculative intraday-oversell contribution.
  function simulateTotal(level, X, Y, Z, theta_flat, s_up = 1, s_dn = 1, s3 = null) {
    const isL2 = level >= 2;
    const isL3 = level === 3;
    const sUpC = s_up < 0 ? 0 : s_up > 1 ? 1 : s_up;
    const sDnC = s_dn < 0 ? 0 : s_dn > 1 ? 1 : s_dn;
    const s3Enabled = isL3 && s3 && (s3.X_cap | 0) >= 1;
    const s3K = s3Enabled ? (s3.K | 0) || 4 : 0;
    const s3S_min = s3Enabled ? +s3.S_min : 0;
    const s3Sigma_max = s3Enabled ? +s3.sigma_max : 0;
    const s3X_cap = s3Enabled ? (s3.X_cap | 0) : 0;
    const s3M = s3Enabled ? +s3.M : 0;
    const s3Roll = s3Enabled ? _getS3Rolling(s3K) : null;
    const s3MeanArr = s3Roll ? s3Roll.mean : null;
    const s3StdArr = s3Roll ? s3Roll.std : null;
    const vwap_arr = D.vwap_1h;
    const F_arr = D.da_forecast;
    const ID_arr = D.id_forecast;
    const P_da_arr = D.p_da;
    const P_mfrr_arr = D.p_mfrr;
    const Q_pot_arr = D.q_pot;
    const P_imb_arr = D.p_imb;
    const aPos_arr = D.avg_p_pos;
    const aNeg_arr = D.avg_p_neg;
    // Favourable-only counts: see init() docstring + preprocess script.
    const nPos_arr = D.afrr_n_pos_fav;
    const nNeg_arr = D.afrr_n_neg_fav;
    let total = 0;
    for (let i = winStart; i < winEnd; i++) {
      const F = F_arr[i];
      const P_da = P_da_arr[i];
      const P_mfrr = P_mfrr_arr[i];
      const aboveX = P_da >= X;
      const da_sold = (aboveX ? F : F * (1 - Y)) | 0; // floor via |0
      const Q_w = aboveX ? 0 : ((F - da_sold) | 0);
      const trustedRevRaw = isL2 ? Z * (ID_arr[i] - F) : 0;
      const trustedExtra = trustedRevRaw > 0 ? (trustedRevRaw | 0) : 0;
      const Q_up_offer = Q_w + trustedExtra;
      const Q_dn_offer = da_sold;
      // Round-and-remainder per-direction split (see simulate()).
      const Q_up_mfrr = Math.round(sUpC * Q_up_offer);
      const Q_up_afrr = Q_up_offer - Q_up_mfrr;
      const Q_dn_mfrr = Math.round(sDnC * Q_dn_offer);
      const Q_dn_afrr = Q_dn_offer - Q_dn_mfrr;
      const isUp = P_mfrr >= 1;
      const isDn = P_mfrr <= -1;
      const up_mfrr = isUp ? Q_up_mfrr : 0;
      const dn_mfrr = isDn ? Q_dn_mfrr : 0;
      // aFRR profitability gate — see simulate() for the rationale.
      const avg_pos = aPos_arr[i];
      const avg_neg = aNeg_arr[i];
      const upAfrrActive = avg_pos > 0 && Q_up_afrr > 0;
      const dnAfrrActive = avg_neg < 0 && Q_dn_afrr > 0;
      let rev = da_sold * P_da + up_mfrr * P_mfrr - dn_mfrr * P_mfrr;
      if (upAfrrActive) rev += Q_up_afrr * avg_pos;
      if (dnAfrrActive) rev -= Q_dn_afrr * avg_neg;
      if (isL2) {
        const up_afrr_disp = upAfrrActive ? Q_up_afrr * (nPos_arr[i] / 225) : 0;
        const dn_afrr_disp = dnAfrrActive ? Q_dn_afrr * (nNeg_arr[i] / 225) : 0;
        let Q_pos =
          da_sold + up_mfrr + up_afrr_disp - dn_mfrr - dn_afrr_disp;
        // ----- S3 (Level-3 speculative intraday oversell) -----
        // Same logic as simulate(); inlined for hot-path performance.
        if (s3Enabled) {
          const P_ID_est = vwap_arr[i];
          if (!isNaN(P_ID_est)) {
            const P_imb_est = s3MeanArr[i];
            const P_imb_sigma = s3StdArr[i];
            if (!isNaN(P_imb_est) && !isNaN(P_imb_sigma)) {
              const spread = P_ID_est - P_imb_est;
              if (spread >= s3S_min && P_imb_sigma <= s3Sigma_max) {
                const sig = (spread - s3S_min) / s3S_min;
                const X_raw = s3X_cap * (sig < 1 ? sig : 1);
                const X_prop = (X_raw + 1e-9) | 0; // floor
                if (X_prop >= 1) {
                  const bid_price = P_ID_est + s3M;
                  rev += X_prop * P_ID_est;
                  // Defensive bid is a stop-loss for mFRR-dn: clears
                  // whenever the marginal price isn't above our ceiling.
                  // Curtailment revenue −P_mfrr can be positive (paid)
                  // or negative (we paid up to bid_price per MWh).
                  if (P_mfrr <= bid_price) {
                    rev += X_prop * (-P_mfrr);
                    // defensive fires offsets the oversell — no position increase
                  } else {
                    Q_pos += X_prop; // shortfall increases by X_prop
                  }
                }
              }
            }
          }
        }
        const Q_pot = Q_pot_arr[i];
        const short = Q_pos > Q_pot ? Q_pos - Q_pot : 0;
        // NaN p_imb (April rows): skip imbalance + flat costs entirely.
        // Mirrors simulate(); see the long comment on NaN handling there.
        const pimb = P_imb_arr[i];
        if (!isNaN(pimb)) rev -= short * (pimb + theta_flat);
      }
      total += rev;
    }
    return total * 0.25;
  }

  function naiveRevenue(level, theta_flat = 0, s_up = 1, s_dn = 1) {
    return simulateTotal(level, 0, 0, 0, theta_flat, s_up, s_dn);
  }

  // ---------- parameter sweeps -------------------------------------------
  // sweepLevel1 / sweepLevel2 sweep over the per-direction splits ss_up
  // and ss_dn (was a single `ss`). Independent grids let the optimiser
  // pick a different mFRR/aFRR ratio for upward vs downward — useful
  // because the per-direction price economics aren't symmetric. Old
  // callers passing undefined / [] get a degenerate {1} grid (all mFRR).
  function sweepLevel1(xs, ys, ss_up, ss_dn) {
    const upList = ss_up && ss_up.length ? ss_up : [1];
    const dnList = ss_dn && ss_dn.length ? ss_dn : [1];
    let bestRev = -Infinity,
      bestX = 0,
      bestY = 0,
      bestSup = 1,
      bestSdn = 1;
    for (let xi = 0; xi < xs.length; xi++) {
      for (let yi = 0; yi < ys.length; yi++) {
        for (let ui = 0; ui < upList.length; ui++) {
          for (let di = 0; di < dnList.length; di++) {
            const r = simulateTotal(
              1,
              xs[xi],
              ys[yi],
              0,
              0,
              upList[ui],
              dnList[di],
            );
            if (r > bestRev) {
              bestRev = r;
              bestX = xs[xi];
              bestY = ys[yi];
              bestSup = upList[ui];
              bestSdn = dnList[di];
            }
          }
        }
      }
    }
    return {
      best: {
        X: bestX,
        Y: bestY,
        s_up: bestSup,
        s_dn: bestSdn,
        revenue: bestRev,
      },
    };
  }

  function sweepLevel2(xs, ys, zs, ss_up, ss_dn, theta_flat, progressCb) {
    const upList = ss_up && ss_up.length ? ss_up : [1];
    const dnList = ss_dn && ss_dn.length ? ss_dn : [1];
    let bestRev = -Infinity,
      bestX = 0,
      bestY = 0,
      bestZ = 0,
      bestSup = 1,
      bestSdn = 1;
    const total =
      xs.length * ys.length * zs.length * upList.length * dnList.length;
    let done = 0;
    for (let xi = 0; xi < xs.length; xi++) {
      for (let yi = 0; yi < ys.length; yi++) {
        for (let zi = 0; zi < zs.length; zi++) {
          for (let ui = 0; ui < upList.length; ui++) {
            for (let di = 0; di < dnList.length; di++) {
              const r = simulateTotal(
                2,
                xs[xi],
                ys[yi],
                zs[zi],
                theta_flat,
                upList[ui],
                dnList[di],
              );
              if (r > bestRev) {
                bestRev = r;
                bestX = xs[xi];
                bestY = ys[yi];
                bestZ = zs[zi];
                bestSup = upList[ui];
                bestSdn = dnList[di];
              }
              done++;
            }
          }
        }
      }
      if (progressCb) progressCb(done / total);
    }
    return {
      best: {
        X: bestX,
        Y: bestY,
        Z: bestZ,
        s_up: bestSup,
        s_dn: bestSdn,
        revenue: bestRev,
      },
    };
  }

  // ---------- L3 oversell sweep ------------------------------------------
  // Separate optimiser for the S3 strategy params (K, S_min, sigma_max,
  // X_cap, M). Holds the market params (X, Y, Z, s_up, s_dn, theta_flat)
  // fixed at the values passed in — by design (per Q7), so the user can
  // independently tune market vs speculation. 5-D grid; coarse defaults
  // for speed (the caller can pass denser grids if needed).
  function sweepLevel3Oversell(
    Ks,
    S_mins,
    sigma_maxs,
    X_caps,
    Ms,
    fixedMarket,
    progressCb,
  ) {
    const X = fixedMarket.X;
    const Y = fixedMarket.Y;
    const Z = fixedMarket.Z;
    const theta = fixedMarket.theta_flat;
    const sUp = fixedMarket.s_up == null ? 1 : fixedMarket.s_up;
    const sDn = fixedMarket.s_dn == null ? 1 : fixedMarket.s_dn;
    let bestRev = -Infinity,
      bestK = Ks[0],
      bestSmin = S_mins[0],
      bestSigma = sigma_maxs[0],
      bestXcap = X_caps[0],
      bestM = Ms[0];
    const total =
      Ks.length * S_mins.length * sigma_maxs.length * X_caps.length * Ms.length;
    let done = 0;
    for (let ki = 0; ki < Ks.length; ki++) {
      for (let si = 0; si < S_mins.length; si++) {
        for (let gi = 0; gi < sigma_maxs.length; gi++) {
          for (let xi = 0; xi < X_caps.length; xi++) {
            for (let mi = 0; mi < Ms.length; mi++) {
              const r = simulateTotal(3, X, Y, Z, theta, sUp, sDn, {
                K: Ks[ki],
                S_min: S_mins[si],
                sigma_max: sigma_maxs[gi],
                X_cap: X_caps[xi],
                M: Ms[mi],
              });
              if (r > bestRev) {
                bestRev = r;
                bestK = Ks[ki];
                bestSmin = S_mins[si];
                bestSigma = sigma_maxs[gi];
                bestXcap = X_caps[xi];
                bestM = Ms[mi];
              }
              done++;
            }
          }
        }
      }
      if (progressCb) progressCb(done / total);
    }
    return {
      best: {
        K: bestK,
        S_min: bestSmin,
        sigma_max: bestSigma,
        X_cap: bestXcap,
        M: bestM,
        revenue: bestRev,
      },
    };
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
  // back to the headline totalRevenue. Includes aFRR contributions when
  // s < 1.
  function monthlyAggregation(level, params) {
    const start = new Date(D.start_iso);
    const buckets = new Map();
    const isL2 = level >= 2;
    const isL3 = level === 3;
    const Y = params.Y;
    const X = params.X;
    const Z = params.Z || 0;
    const theta = params.theta_flat || 0;
    const s_up = params.s_up == null ? 1 : params.s_up;
    const s_dn = params.s_dn == null ? 1 : params.s_dn;
    const sUpC = s_up < 0 ? 0 : s_up > 1 ? 1 : s_up;
    const sDnC = s_dn < 0 ? 0 : s_dn > 1 ? 1 : s_dn;
    // S3 params (active when level === 3 AND X_cap ≥ 1 AND K ≥ 1).
    const s3K = (params.s3_K | 0) || 0;
    const s3X_cap = (params.s3_X_cap | 0) || 0;
    const s3Enabled = isL3 && s3X_cap >= 1 && s3K >= 1;
    const s3S_min = +params.s3_S_min || 0;
    const s3Sigma_max = +params.s3_sigma_max || 0;
    const s3M = +params.s3_M || 0;
    const s3Roll = s3Enabled ? _getS3Rolling(s3K) : null;
    for (let i = winStart; i < winEnd; i++) {
      const ts = new Date(start.getTime() + D.offsets[i] * D.step_min * 60000);
      const key = `${ts.getUTCFullYear()}-${String(ts.getUTCMonth() + 1).padStart(2, "0")}`;
      const F = D.da_forecast[i];
      const ID = D.id_forecast[i];
      const P_da = D.p_da[i];
      const P_mfrr = D.p_mfrr[i];
      const aboveX = P_da >= X;
      const da_sold = Math.floor((aboveX ? F : F * (1 - Y)) + 1e-9);
      const Q_w = Math.floor((aboveX ? 0 : F - da_sold) + 1e-9);
      const trustedRevRaw = isL2 ? Z * (ID - F) : 0;
      const trustedExtra = trustedRevRaw > 0 ? Math.floor(trustedRevRaw + 1e-9) : 0;
      const up_offer = Q_w + trustedExtra;
      const dn_offer = da_sold;
      const Q_up_mfrr = Math.round(sUpC * up_offer);
      const Q_up_afrr = up_offer - Q_up_mfrr;
      const Q_dn_mfrr = Math.round(sDnC * dn_offer);
      const Q_dn_afrr = dn_offer - Q_dn_mfrr;
      const isUp = P_mfrr >= 1;
      const isDn = P_mfrr <= -1;
      const up_mfrr_q = isUp ? Q_up_mfrr : 0;
      const dn_mfrr_q = isDn ? Q_dn_mfrr : 0;
      // aFRR profitability gate (see simulate() for the rationale).
      const avg_pos = D.avg_p_pos[i];
      const avg_neg = D.avg_p_neg[i];
      const upAfrrActive = avg_pos > 0 && Q_up_afrr > 0;
      const dnAfrrActive = avg_neg < 0 && Q_dn_afrr > 0;
      const DA_rev = da_sold * P_da * 0.25;
      const UpMfrr_rev = up_mfrr_q * P_mfrr * 0.25;
      const DnMfrr_rev = -dn_mfrr_q * P_mfrr * 0.25;
      const UpAfrr_rev = upAfrrActive ? Q_up_afrr * avg_pos * 0.25 : 0;
      const DnAfrr_rev = dnAfrrActive ? -Q_dn_afrr * avg_neg * 0.25 : 0;
      let imb = 0,
        flat = 0;
      let S3Intraday_rev = 0,
        S3Curtail_rev = 0,
        S3ExtraCost = 0;
      if (isL2) {
        // Favourable-only counts (see init()) — matches simulate().
        const up_afrr_disp = upAfrrActive ? Q_up_afrr * (D.afrr_n_pos_fav[i] / 225) : 0;
        const dn_afrr_disp = dnAfrrActive ? Q_dn_afrr * (D.afrr_n_neg_fav[i] / 225) : 0;
        const Q_pos_l2 = da_sold + up_mfrr_q + up_afrr_disp - dn_mfrr_q - dn_afrr_disp;

        // S3 contribution per ISP — mirrors simulate() logic.
        let s3_X = 0;
        let s3_fires = false;
        if (s3Enabled) {
          const P_ID_est = D.vwap_1h[i];
          if (!isNaN(P_ID_est)) {
            const P_imb_est = s3Roll.mean[i];
            const P_imb_sigma = s3Roll.std[i];
            if (!isNaN(P_imb_est) && !isNaN(P_imb_sigma)) {
              const spread = P_ID_est - P_imb_est;
              if (spread >= s3S_min && P_imb_sigma <= s3Sigma_max) {
                const sig = (spread - s3S_min) / s3S_min;
                const X_prop = Math.floor(s3X_cap * (sig < 1 ? sig : 1) + 1e-9);
                if (X_prop >= 1) {
                  const bid_price = P_ID_est + s3M;
                  // Stop-loss activation: P_mfrr ≤ bid_price (see simulate()).
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
        const Q_pot = D.q_pot[i];
        const short_l2 = Q_pos_l2 > Q_pot ? Q_pos_l2 - Q_pot : 0;
        const short = Q_pos > Q_pot ? Q_pos - Q_pot : 0;
        // Guard against NaN p_imb (April rows): treat as 0 cost rather than
        // letting NaN poison the entire month's bucket.
        const pimb = D.p_imb[i];
        if (!isNaN(pimb)) {
          imb = short_l2 * pimb * 0.25;
          flat = short_l2 * theta * 0.25;
          S3ExtraCost = (short - short_l2) * (pimb + theta) * 0.25;
        }
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
      // Back-compat: keep `up` / `dn` as the SUM of mFRR + aFRR for the
      // existing stacked-bar chart (charts.js drawMonthly stacks DA / up /
      // dn / imb / flat). Callers that need the split read the new keys.
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

  // Sum of MWh of potential generation in the current window.
  function totalPotMWhInWindow() {
    let s = 0;
    for (let i = winStart; i < winEnd; i++) s += D.q_pot[i] * 0.25;
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
    sweepLevel1,
    sweepLevel2,
    sweepLevel3Oversell,
    topConcentration,
    monthlyAggregation,
    totalPotMWhInWindow,
    tsAt,
  };
})();

if (typeof module !== "undefined") module.exports = Engine;
