// engine.js — pure simulation logic for the Vanessa wind-park Backtester.
//
// No DOM access. Reads from a pre-loaded WIND_DATA global plus parameter
// objects. Returns per-ISP arrays, totals and decompositions.
//
// SIGN CONVENTIONS (verified by tests.py + the spec's two worked examples)
//   DA revenue:    Q_da_sold * P_da                           [≥ 0]
//   mFRR-up rev:   Q_up * P_mfrr                              [+ when P_mfrr > 0]
//   mFRR-dn rev:   -Q_dn * P_mfrr                             [+ when P_mfrr < 0]
//   Imbalance:    -Q_short * P_imb                            [cost when short]
//   Flat penalty: -Q_short * theta_flat
//   per-ISP rev = (DA + up + dn - imb - flat) * 0.25          [MW * h]
//
// PHYSICAL CONSTRAINTS (audit-applied, do NOT regress)
//   * Whole-MW market quantities. Balancing market accepts integer MW only,
//     so Q_da_sold, Q_w, trusted_rev and Q_dn_offer are floored. Fractional
//     MW between floor(F) and the actual forecast are simply not traded.
//   * mFRR-dn capped at the DA position. A wind park can drop from Q_da_sold
//     to 0 but cannot go below 0. Therefore Q_dn_offer = Q_da_sold (NOT Q_w),
//     independent of Y. When Q_da_sold = 0 there is no mFRR-dn revenue.
//   * Q_position = Q_da_sold + Q_up - Q_dn. mFRR-up and mFRR-dn cannot both
//     fire in the same ISP (P_mfrr is single-signed; tests verify).
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
//   getData()                      — internal D (typed arrays + meta)
//   setWindow(start, end)          — half-open ISP-index window (invalidates winsor cache)
//   getWindow()                    — { start, end }
//   maybeWinsorize(mfrrLo, mfrrHi, imbLo, imbHi) — keyed-cache; recomputes only on change
//   forceRewinsor()                — invalidate cache (rare)
//   simulate(level, params)        — full per-ISP detail
//   simulateTotal(level, X,Y,Z,θ)  — fast total-only (sweeps)
//   naiveRevenue(level, θ)         — simulateTotal at X=0,Y=0,Z=0
//   sweepLevel1(xs, ys)            — 2-D grid for the L1 heatmap
//   sweepLevel2(xs, ys, zs, θ)     — 3-D grid for the L2 heatmap
//   topConcentration(perISP, frac) — top-N% revenue share (robustness)
//   monthlyAggregation(level, p)   — month-bucketed decomposition
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
    };
    // Working buffers for winsorized prices (filled by maybeWinsorize)
    D.p_mfrr = new Float32Array(D.n);
    D.p_imb = new Float32Array(D.n);
    winStart = 0;
    winEnd = D.n;
    cachedMfrrKey = null;
    cachedImbKey = null;
    return D;
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
    }
    return { start: winStart, end: winEnd };
  }

  function getWindow() {
    return { start: winStart, end: winEnd };
  }

  // ---------- winsorization with caching ---------------------------------
  let cachedMfrrKey = null;
  let cachedImbKey = null;

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

  function maybeWinsorize(pMfrrLow, pMfrrHigh, pImbLow, pImbHigh) {
    const mfrrKey = `${pMfrrLow}-${pMfrrHigh}`;
    const imbKey = `${pImbLow}-${pImbHigh}`;
    let mfrrBounds = null;
    let imbBounds = null;
    if (mfrrKey !== cachedMfrrKey) {
      mfrrBounds = applyWinsor(D.p_mfrr_raw, D.p_mfrr, pMfrrLow, pMfrrHigh);
      cachedMfrrKey = mfrrKey;
    }
    if (imbKey !== cachedImbKey) {
      imbBounds = applyWinsor(D.p_imb_raw, D.p_imb, pImbLow, pImbHigh);
      cachedImbKey = imbKey;
    }
    return { mfrrBounds, imbBounds };
  }

  function forceRewinsor() {
    cachedMfrrKey = null;
    cachedImbKey = null;
  }

  // ---------- detailed simulation (returns per-ISP arrays) ---------------
  // level: 1 or 2. params: { X, Y, Z?, theta_flat? }
  // Per-ISP arrays are sized to the simulation window length. The result
  // also carries windowStart / windowEnd so callers can map perISP[k]
  // back to a global ISP index via (windowStart + k).
  function simulate(level, params) {
    const { X, Y, Z = 0, theta_flat = 0 } = params;
    const wLen = Math.max(0, winEnd - winStart);
    const Q_da_sold = new Float32Array(wLen);
    const Q_up = new Float32Array(wLen);
    const Q_dn = new Float32Array(wLen);
    const Q_short = new Float32Array(wLen);
    const revenue = new Float32Array(wLen);
    let sumDA = 0,
      sumUp = 0,
      sumDn = 0,
      sumImb = 0,
      sumFlat = 0;
    let nUp = 0,
      nDn = 0,
      nWasted = 0,
      nShort = 0;
    let totalShortMWh = 0;
    let nNegRevWarn = 0;
    const isL2 = level === 2;
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
      const isUp = P_mfrr >= 1;
      const isDn = P_mfrr <= -1;
      const up = isUp ? Q_up_offer : 0;
      const dn = isDn ? Q_dn_offer : 0;
      const DA_rev = da_sold * P_da;
      const Up_rev = up * P_mfrr;
      const Dn_rev = -dn * P_mfrr;
      const Q_pos = da_sold + up - dn;
      const Q_pot = isL2 ? D.q_pot[i] : F;
      const short = Q_pos > Q_pot ? Q_pos - Q_pot : 0;
      // ----- NaN p_imb handling -----
      // The Latvia imbalance-price source ran out at end-of-March 2026, so
      // ~6.8% of rows (mostly April) have NaN p_imb. We keep those rows in
      // the simulation (they still earn DA + mFRR revenue) but zero their
      // imbalance & flat-penalty contributions — effectively assuming
      // "perfect imbalance" for those ISPs. This MILDLY undercounts L2 cost
      // if you point the sim window at April only; mention this in any
      // narrative about April-specific results. When a refreshed CSV
      // includes April imbalance prices, no engine change is needed —
      // p_imb just stops being NaN and the cost flows through.
      const P_imb_raw = isL2 ? D.p_imb[i] : 0;
      const P_imb_valid = isL2 ? !isNaN(P_imb_raw) : true;
      const imb = isL2 && P_imb_valid ? short * P_imb_raw : 0;
      const flat = isL2 && P_imb_valid ? short * theta_flat : 0;
      const rev = (DA_rev + Up_rev + Dn_rev - imb - flat) * 0.25;
      Q_da_sold[k] = da_sold;
      Q_up[k] = up;
      Q_dn[k] = dn;
      Q_short[k] = short;
      revenue[k] = rev;
      sumDA += DA_rev * 0.25;
      sumUp += Up_rev * 0.25;
      sumDn += Dn_rev * 0.25;
      sumImb += imb * 0.25;
      sumFlat += flat * 0.25;
      if (up > 1e-6) nUp++;
      else if (dn > 1e-6) nDn++;
      else if (Q_w > 1e-6) nWasted++;
      if (short > 1e-6) {
        nShort++;
        totalShortMWh += short * 0.25;
      }
    }
    const total = sumDA + sumUp + sumDn - sumImb - sumFlat;
    return {
      windowStart: winStart,
      windowEnd: winEnd,
      perISP: { Q_da_sold, Q_up, Q_dn, Q_short, revenue },
      totalRevenue: total,
      breakdown: {
        DA: sumDA,
        mFRR_up: sumUp,
        mFRR_dn: sumDn,
        imb: sumImb,
        flat: sumFlat,
      },
      counts: { up: nUp, dn: nDn, wasted: nWasted, short: nShort, negRev: nNegRevWarn },
      totalShortMWh,
    };
  }

  // ---------- fast total-only simulation (for sweeps) --------------------
  function simulateTotal(level, X, Y, Z, theta_flat) {
    const isL2 = level === 2;
    const F_arr = D.da_forecast;
    const ID_arr = D.id_forecast;
    const P_da_arr = D.p_da;
    const P_mfrr_arr = D.p_mfrr;
    const Q_pot_arr = D.q_pot;
    const P_imb_arr = D.p_imb;
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
      const isUp = P_mfrr >= 1;
      const isDn = P_mfrr <= -1;
      const up = isUp ? Q_up_offer : 0;
      const dn = isDn ? Q_dn_offer : 0;
      let rev = da_sold * P_da + up * P_mfrr - dn * P_mfrr;
      if (isL2) {
        const Q_pos = da_sold + up - dn;
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

  function naiveRevenue(level, theta_flat = 0) {
    return simulateTotal(level, 0, 0, 0, theta_flat);
  }

  // ---------- parameter sweeps -------------------------------------------
  function sweepLevel1(xs, ys) {
    const grid = [];
    let bestRev = -Infinity,
      bestX = 0,
      bestY = 0;
    for (let xi = 0; xi < xs.length; xi++) {
      const row = new Float64Array(ys.length);
      for (let yi = 0; yi < ys.length; yi++) {
        const r = simulateTotal(1, xs[xi], ys[yi], 0, 0);
        row[yi] = r;
        if (r > bestRev) {
          bestRev = r;
          bestX = xs[xi];
          bestY = ys[yi];
        }
      }
      grid.push(row);
    }
    return { xs, ys, grid, best: { X: bestX, Y: bestY, revenue: bestRev } };
  }

  function sweepLevel2(xs, ys, zs, theta_flat, progressCb) {
    const grid = [];
    let bestRev = -Infinity,
      bestX = 0,
      bestY = 0,
      bestZ = 0;
    const total = xs.length * ys.length * zs.length;
    let done = 0;
    for (let xi = 0; xi < xs.length; xi++) {
      const xRow = [];
      for (let yi = 0; yi < ys.length; yi++) {
        const yRow = new Float64Array(zs.length);
        for (let zi = 0; zi < zs.length; zi++) {
          const r = simulateTotal(2, xs[xi], ys[yi], zs[zi], theta_flat);
          yRow[zi] = r;
          if (r > bestRev) {
            bestRev = r;
            bestX = xs[xi];
            bestY = ys[yi];
            bestZ = zs[zi];
          }
          done++;
        }
        xRow.push(yRow);
      }
      grid.push(xRow);
      if (progressCb) progressCb(done / total);
    }
    return {
      xs,
      ys,
      zs,
      grid,
      best: { X: bestX, Y: bestY, Z: bestZ, revenue: bestRev },
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
  function monthlyAggregation(level, params) {
    const start = new Date(D.start_iso);
    const buckets = new Map();
    const isL2 = level === 2;
    const Y = params.Y;
    const X = params.X;
    const Z = params.Z || 0;
    const theta = params.theta_flat || 0;
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
      const isUp = P_mfrr >= 1;
      const isDn = P_mfrr <= -1;
      const up = isUp ? up_offer : 0;
      const dn = isDn ? dn_offer : 0;
      const DA_rev = da_sold * P_da * 0.25;
      const Up_rev = up * P_mfrr * 0.25;
      const Dn_rev = -dn * P_mfrr * 0.25;
      let imb = 0,
        flat = 0;
      if (isL2) {
        const Q_pos = da_sold + up - dn;
        const short = Q_pos > D.q_pot[i] ? Q_pos - D.q_pot[i] : 0;
        // Guard against NaN p_imb (April rows): treat as 0 cost rather than
        // letting NaN poison the entire month's bucket.
        const pimb = D.p_imb[i];
        if (!isNaN(pimb)) {
          imb = short * pimb * 0.25;
          flat = short * theta * 0.25;
        }
      }
      const b = buckets.get(key) || { DA: 0, up: 0, dn: 0, imb: 0, flat: 0 };
      b.DA += DA_rev;
      b.up += Up_rev;
      b.dn += Dn_rev;
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
        up: b.up,
        dn: b.dn,
        imb: b.imb,
        flat: b.flat,
        total: b.DA + b.up + b.dn - b.imb - b.flat,
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
    topConcentration,
    monthlyAggregation,
    totalPotMWhInWindow,
    tsAt,
  };
})();

if (typeof module !== "undefined") module.exports = Engine;
