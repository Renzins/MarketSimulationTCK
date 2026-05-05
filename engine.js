// engine.js — pure simulation logic for the Vanessa wind park backtester.
// No DOM access. Reads from a pre-loaded WIND_DATA global plus parameter
// objects. Results: per-ISP arrays, totals and decompositions.
//
// Sign conventions (verified against the spec's two worked Level 2 examples
// in preprocess.py):
//   DA revenue:    Q_da_sold * P_da                           [≥ 0]
//   mFRR-up rev:   Q_up * P_mfrr                              [+ when P_mfrr > 0]
//   mFRR-dn rev:   -Q_dn * P_mfrr                             [+ when P_mfrr < 0]
//   Imbalance:    -Q_short * P_imb                            [cost when short]
//   Flat penalty: -Q_short * theta_flat
//   per-ISP rev = (DA + up + dn - imb - flat) * 0.25          [MW * h]
//
// Physical constraints (revised after audit):
//   * All market quantities are WHOLE MW (balancing market only operates
//     in integer MW blocks). Q_da_sold, Q_w, trusted_rev and Q_dn_offer
//     are floored. Fractional MW between floor(.) and the actual forecast
//     are simply not traded.
//   * mFRR-dn (downward activation) is CURTAILMENT of an existing DA
//     position. A wind park can drop from Q_da_sold to 0; it cannot go
//     below 0. Therefore Q_dn_offer is capped at Q_da_sold and is
//     independent of the withholding parameter Y.
//   * When mFRR-dn activates, our promised delivery becomes
//     Q_da_sold - Q_dn, so Q_position = Q_da_sold + Q_up - Q_dn.
//     (mFRR-up and mFRR-dn cannot both fire in the same ISP because
//     P_mfrr is a single signed value.)

const Engine = (() => {
  // ---------- typed-array view of the JSON data --------------------------
  let D = null;
  function init(rawData) {
    D = {
      n: rawData.n,
      start_iso: rawData.start_iso,
      step_min: rawData.step_min,
      offsets: new Int32Array(rawData.offsets),
      da_forecast: new Float32Array(rawData.da_forecast),
      id_forecast: new Float32Array(rawData.id_forecast),
      p_da: new Float32Array(rawData.p_da),
      p_mfrr_raw: new Float32Array(rawData.p_mfrr),
      q_pot: new Float32Array(rawData.q_pot),
      p_imb_raw: new Float32Array(rawData.p_imb),
    };
    // Working buffers for winsorized prices (filled by maybeWinsorize)
    D.p_mfrr = new Float32Array(D.n);
    D.p_imb = new Float32Array(D.n);
    cachedMfrrKey = null;
    cachedImbKey = null;
    return D;
  }

  function getData() {
    return D;
  }

  // ---------- winsorization with caching ---------------------------------
  let cachedMfrrKey = null;
  let cachedImbKey = null;

  function percentileValue(sorted, p) {
    // Linear-interpolated quantile; sorted is ascending Float32Array
    const N = sorted.length;
    if (N === 0) return 0;
    const idx = (p / 100) * (N - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  function applyWinsor(src, dst, pLow, pHigh) {
    const sorted = new Float32Array(src);
    sorted.sort();
    const lo = percentileValue(sorted, pLow);
    const hi = percentileValue(sorted, pHigh);
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      dst[i] = v < lo ? lo : v > hi ? hi : v;
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
  function simulate(level, params) {
    const { X, Y, Z = 0, theta_flat = 0 } = params;
    const N = D.n;
    const Q_da_sold = new Float32Array(N);
    const Q_up = new Float32Array(N);
    const Q_dn = new Float32Array(N);
    const Q_short = new Float32Array(N);
    const revenue = new Float32Array(N);
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
    let nNegRevWarn = 0; // count of ID < DA case (for L2 reporting)
    const isL2 = level === 2;
    for (let i = 0; i < N; i++) {
      const F = D.da_forecast[i];
      const ID = D.id_forecast[i];
      const P_da = D.p_da[i];
      const P_mfrr = D.p_mfrr[i];
      const aboveX = P_da >= X;
      // ---- whole-MW DA bid (balancing market is integer MW) ----
      const da_sold_raw = aboveX ? F : F * (1 - Y);
      const da_sold = Math.floor(da_sold_raw + 1e-9);
      // ---- withheld energy → mFRR-up offer (also whole MW) ----
      const Q_w_raw = aboveX ? 0 : F - da_sold;
      const Q_w = Math.floor(Q_w_raw + 1e-9);
      const trustedRevRaw = isL2 ? Z * (ID - F) : 0;
      if (isL2 && trustedRevRaw < 0) nNegRevWarn++;
      // Whole-MW positive ID revision
      const trustedExtra = trustedRevRaw > 0 ? Math.floor(trustedRevRaw + 1e-9) : 0;
      const Q_up_offer = Q_w + trustedExtra;
      // ---- mFRR-dn offer = curtailment of DA position (≤ Q_da_sold) ----
      // Independent of Y: a wind park can drop from Q_da_sold to 0 but
      // cannot produce a negative quantity, so the ceiling is Q_da_sold.
      const Q_dn_offer = da_sold;
      const isUp = P_mfrr >= 1;
      const isDn = P_mfrr <= -1;
      const up = isUp ? Q_up_offer : 0;
      const dn = isDn ? Q_dn_offer : 0;
      const DA_rev = da_sold * P_da;
      const Up_rev = up * P_mfrr;
      const Dn_rev = -dn * P_mfrr;
      // mFRR-dn reduces our promised production; mFRR-up increases it.
      const Q_pos = da_sold + up - dn;
      const Q_pot = isL2 ? D.q_pot[i] : F;
      const short = Q_pos > Q_pot ? Q_pos - Q_pot : 0;
      const P_imb = isL2 ? D.p_imb[i] : 0;
      const imb = isL2 ? short * P_imb : 0;
      const flat = isL2 ? short * theta_flat : 0;
      const rev = (DA_rev + Up_rev + Dn_rev - imb - flat) * 0.25;
      Q_da_sold[i] = da_sold;
      Q_up[i] = up;
      Q_dn[i] = dn;
      Q_short[i] = short;
      revenue[i] = rev;
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
    const N = D.n;
    const isL2 = level === 2;
    const F_arr = D.da_forecast;
    const ID_arr = D.id_forecast;
    const P_da_arr = D.p_da;
    const P_mfrr_arr = D.p_mfrr;
    const Q_pot_arr = D.q_pot;
    const P_imb_arr = D.p_imb;
    let total = 0;
    for (let i = 0; i < N; i++) {
      const F = F_arr[i];
      const P_da = P_da_arr[i];
      const P_mfrr = P_mfrr_arr[i];
      const aboveX = P_da >= X;
      const da_sold = (aboveX ? F : F * (1 - Y)) | 0; // floor to int via bitwise OR
      const Q_w = aboveX ? 0 : ((F - da_sold) | 0);
      const trustedRevRaw = isL2 ? Z * (ID_arr[i] - F) : 0;
      const trustedExtra = trustedRevRaw > 0 ? (trustedRevRaw | 0) : 0;
      const Q_up_offer = Q_w + trustedExtra;
      const Q_dn_offer = da_sold; // capped at DA position (curtailment)
      const isUp = P_mfrr >= 1;
      const isDn = P_mfrr <= -1;
      const up = isUp ? Q_up_offer : 0;
      const dn = isDn ? Q_dn_offer : 0;
      let rev = da_sold * P_da + up * P_mfrr - dn * P_mfrr;
      if (isL2) {
        const Q_pos = da_sold + up - dn; // mFRR-dn reduces position
        const Q_pot = Q_pot_arr[i];
        const short = Q_pos > Q_pot ? Q_pos - Q_pot : 0;
        rev -= short * (P_imb_arr[i] + theta_flat);
      }
      total += rev;
    }
    return total * 0.25;
  }

  // ---------- naive baseline (Y=0, Z=0): always sell to DA ---------------
  function naiveRevenue(level, theta_flat = 0) {
    return simulateTotal(level, 0, 0, 0, theta_flat);
  }

  // ---------- parameter sweeps -------------------------------------------
  // Returns { xs, ys, [zs], grid: 2D or 3D array, best: {X,Y,Z,revenue} }
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
    // Returns 3D grid grid[xi][yi][zi]; also best.
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
    // descending sum of top fraction
    const total = perISPRev.reduce((a, b) => a + b, 0);
    const topN = Math.max(1, Math.floor(perISPRev.length * fraction));
    let topSum = 0;
    for (let i = sorted.length - 1; i >= sorted.length - topN; i--) topSum += sorted[i];
    return { topN, topSum, totalSum: total, share: total !== 0 ? topSum / total : 0 };
  }

  // ---------- monthly aggregation ----------------------------------------
  // Returns array of { month: 'YYYY-MM', DA, up, dn, imb, flat, total }
  function monthlyAggregation(level, params) {
    const start = new Date(D.start_iso);
    const buckets = new Map(); // 'YYYY-MM' -> sums
    const isL2 = level === 2;
    const Y = params.Y;
    const X = params.X;
    const Z = params.Z || 0;
    const theta = params.theta_flat || 0;
    for (let i = 0; i < D.n; i++) {
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
      const dn_offer = da_sold; // curtailment capped at DA
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
        imb = short * D.p_imb[i] * 0.25;
        flat = short * theta * 0.25;
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

  // ---------- timestamp helper -------------------------------------------
  function tsAt(i) {
    const start = new Date(D.start_iso).getTime();
    return new Date(start + D.offsets[i] * D.step_min * 60000);
  }

  return {
    init,
    getData,
    maybeWinsorize,
    forceRewinsor,
    simulate,
    simulateTotal,
    naiveRevenue,
    sweepLevel1,
    sweepLevel2,
    topConcentration,
    monthlyAggregation,
    tsAt,
  };
})();

if (typeof module !== "undefined") module.exports = Engine;
