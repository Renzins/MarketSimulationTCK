// graphs-fund-engine.js — pure analytics for the "Drivers & timing" Graphs
// sub-tab (and the reserves-tab option-value card). No DOM, no hidden state:
// every function takes explicit inputs, so the whole module is mirrored 1:1
// in tests.py (section D). Consumed by graphs-app.js together with the
// optional FUND_DATA global (data-fund.js) — the app guards for its absence.
//
// CONVENTIONS
//   idxs      — array of ISP indices already filtered (window + day type).
//   valFn(i)  — returns the value for ISP i (NaN/null = skip).
//   Percentiles use linear interpolation at idx = (p/100)·(N−1) — the same
//   convention as engine.js winsorisation and optim-sens.js.
//   leadLagCorr lag convention: r(lag) = corr(a[i], b[i+lag]) — a POSITIVE
//   peak lag means `a` LEADS `b` by that many ISPs.

const FundEngine = (() => {
  function percentile(sorted, p) {
    const N = sorted.length;
    if (N === 0) return NaN;
    const idx = (p / 100) * (N - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  // Pearson correlation over finite pairs only.
  function pearson(a, b) {
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      if (!isFinite(x) || !isFinite(y)) continue;
      n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
    }
    if (n < 3) return NaN;
    const cov = sab - (sa * sb) / n, va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
    return va <= 0 || vb <= 0 ? NaN : cov / Math.sqrt(va * vb);
  }

  // Same semantics as GraphsEngine's private binIndex: N+1 edges → bin 0..N−1,
  // lower edge inclusive, everything past the second-to-last edge → last bin.
  function binIndex(v, edges) {
    const N = edges.length - 1;
    for (let k = 0; k < N - 1; k++) if (v <= edges[k + 1]) return k;
    return N - 1;
  }

  // Distribution stats per group: keyFn(i) → 0..nGroups−1 (or −1 to skip).
  // Returns per-group { n, mean, q1, median, q3 } (nulls where empty).
  function groupStats(idxs, valFn, keyFn, nGroups) {
    const buf = [];
    for (let g = 0; g < nGroups; g++) buf.push([]);
    for (const i of idxs) {
      const g = keyFn(i);
      if (g < 0 || g >= nGroups) continue;
      const v = valFn(i);
      if (v == null || !isFinite(v)) continue;
      buf[g].push(v);
    }
    return buf.map((vals) => {
      if (!vals.length) return null;
      vals.sort((a, b) => a - b);
      let s = 0;
      for (const v of vals) s += v;
      return {
        n: vals.length,
        mean: s / vals.length,
        q1: percentile(vals, 25),
        median: percentile(vals, 50),
        q3: percentile(vals, 75),
      };
    });
  }

  // Cross-correlation by lag: r(lag) = pearson(a[i], b[i+lag]) over ISPs where
  // accept(i) && accept(i+lag) and both values are finite. Positive peak lag
  // ⇒ `a` leads `b`. n is the number of finite pairs at that lag.
  function leadLagCorr(n, aFn, bFn, maxLag, accept) {
    const out = [];
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      const xs = [], ys = [];
      const lo = Math.max(0, -lag), hi = Math.min(n, n - lag);
      for (let i = lo; i < hi; i++) {
        if (accept && (!accept(i) || !accept(i + lag))) continue;
        const x = aFn(i), y = bFn(i + lag);
        if (x == null || y == null || !isFinite(x) || !isFinite(y)) continue;
        xs.push(x); ys.push(y);
      }
      out.push({ lag, r: pearson(xs, ys), n: xs.length });
    }
    return out;
  }

  // Conditional event probability over a rows × cols grid.
  // rowFn/colFn(i) → cell coordinates (−1 skips the ISP); eventFn(i) → bool.
  // Returns { cnt, hit, p } as nRows×nCols matrices (p = NaN where cnt = 0).
  function condProb(idxs, eventFn, rowFn, nRows, colFn, nCols) {
    const cnt = [], hit = [];
    for (let r = 0; r < nRows; r++) {
      cnt.push(new Array(nCols).fill(0));
      hit.push(new Array(nCols).fill(0));
    }
    for (const i of idxs) {
      const r = rowFn(i), c = colFn(i);
      if (r < 0 || r >= nRows || c < 0 || c >= nCols) continue;
      cnt[r][c]++;
      if (eventFn(i)) hit[r][c]++;
    }
    const p = cnt.map((row, r) => row.map((cn, c) => (cn > 0 ? hit[r][c] / cn : NaN)));
    return { cnt, hit, p };
  }

  // Daily aggregation. dayKeyFn(i) → a sortable numeric day key (e.g. UTC ms
  // at midnight). spec = { name: { fn, agg } } with agg ∈ "mean" | "sum" |
  // "share" (share = fraction of the day's ISPs where fn(i) is truthy).
  // Skips NaN/null contributions for mean/sum; share counts every ISP.
  function dailyAgg(idxs, dayKeyFn, spec) {
    const names = Object.keys(spec);
    const acc = new Map();
    for (const i of idxs) {
      const k = dayKeyFn(i);
      let o = acc.get(k);
      if (!o) {
        o = { isps: 0 };
        for (const nm of names) o[nm] = { s: 0, n: 0 };
        acc.set(k, o);
      }
      o.isps++;
      for (const nm of names) {
        const { fn, agg } = spec[nm];
        const v = fn(i);
        if (agg === "share") {
          if (v) o[nm].s++;
          o[nm].n++;
        } else if (v != null && isFinite(v)) {
          o[nm].s += v;
          o[nm].n++;
        }
      }
    }
    const keys = [...acc.keys()].sort((a, b) => a - b);
    const series = {};
    for (const nm of names) {
      const { agg } = spec[nm];
      series[nm] = keys.map((k) => {
        const { s, n } = acc.get(k)[nm];
        if (agg === "sum") return s;
        return n > 0 ? s / n : NaN;
      });
    }
    return { dayKeys: keys, isps: keys.map((k) => acc.get(k).isps), series };
  }

  return { percentile, pearson, binIndex, groupStats, leadLagCorr, condProb, dailyAgg };
})();

if (typeof module !== "undefined") module.exports = FundEngine;
