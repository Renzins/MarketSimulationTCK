// optim-sens.js — parameter sensitivity / importance for the optimisers.
// SHARED by both backtester pages (index.html wind park + bess.html BESS):
// pure math (mirrored 1:1 in tests_bess.py) plus the three Plotly renderers.
// No engine access — every function takes plain data the caller evaluated.
//
// WHY: the optimiser reports one argmax, but not every optimised value carries
// the same information — a down-split rebalance wait of 660 that loses only a
// few % when set to 24 is noise, not signal. These functions turn the work the
// optimiser already does (thousands of seeded random evaluations + sweeps
// around the winner) into an importance report:
//
//   LOCAL (one-at-a-time at the found optimum — "OAT"):
//     weight — worst % of revenue lost by moving ONE param across its sweep
//              range while everything else stays at the optimum.
//     band   — contiguous range around the optimum staying within `tol`
//              (default 1%) of it: "any value in here is as good".
//     shape  — flat / up / down / peaked (+ `sharp` when a single grid step
//              next to the optimum already loses > 5%).
//     edge   — the optimum sits on the sweep boundary (saturated lever — on
//              this dataset usually the no-price-impact liquidity levers).
//   GLOBAL (over the seeded random-search population):
//     rho     — Spearman rank correlation param ↔ revenue: direction over the
//               whole sampled space, not just near the optimum.
//     topBand — [q25, q75] of the param among the top-decile samples: where
//               good configs cluster; ≈ the full range ⇒ doesn't decide much.
//     interactionScores — pairwise non-additivity (tertile-binned two-way
//               residuals): which params act "in tandem". Indicative, not an
//               exact Sobol decomposition.
//
// CAVEATS (also in the README): OAT weight is only meaningful AT an optimum
// (from a non-optimal point a param whose sweep only finds improvements
// correctly reads ~0); population stats are correlational over independent
// uniform sampling; both are reproducible (seeded RNG) but only as good as
// the sweep grids.

const OptimSens = (() => {
  // ------------------------------------------------------------------ math
  // percentile with linear interpolation on a SORTED array — same convention
  // as engine.js winsorisation (idx = p/100 · (N−1)).
  function percentile(sorted, p) {
    const N = sorted.length;
    if (N === 0) return NaN;
    const idx = (p / 100) * (N - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  function _ranks(a) {
    const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const rk = new Array(a.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const r = (i + j) / 2 + 1; // average rank across ties
      for (let k = i; k <= j; k++) rk[idx[k][1]] = r;
      i = j + 1;
    }
    return rk;
  }

  function spearman(xs, ys) {
    const rx = _ranks(xs), ry = _ranks(ys);
    const n = rx.length;
    if (n < 2) return 0;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += rx[i]; my += ry[i]; }
    mx /= n; my /= n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      const dx = rx[i] - mx, dy = ry[i] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
  }

  // curve = [{v, r}] sorted by v (must include vStar); rStar = optimum revenue.
  function weightAndBand(curve, vStar, rStar, tol) {
    tol = tol == null ? 0.01 : tol;
    const denom = Math.max(1, Math.abs(rStar));
    const loss = curve.map((p) => (rStar - p.r) / denom);
    let iStar = 0;
    for (let i = 1; i < curve.length; i++)
      if (Math.abs(curve[i].v - vStar) < Math.abs(curve[iStar].v - vStar)) iStar = i;
    let weight = 0;
    for (const L of loss) if (L > weight) weight = L;
    let lo = iStar, hi = iStar;
    while (lo > 0 && loss[lo - 1] <= tol) lo--;
    while (hi < curve.length - 1 && loss[hi + 1] <= tol) hi++;
    let shape;
    if (weight <= tol) shape = "flat";
    else {
      const rFirst = curve[0].r, rLast = curve[curve.length - 1].r;
      if (rStar - Math.max(rFirst, rLast) <= tol * denom) shape = rLast >= rFirst ? "up" : "down";
      else shape = "peaked";
    }
    const nbLoss = Math.max(
      iStar > 0 ? loss[iStar - 1] : 0,
      iStar < curve.length - 1 ? loss[iStar + 1] : 0,
    );
    return {
      weight,
      band: [curve[lo].v, curve[hi].v],
      shape,
      sharp: nbLoss > 0.05,
      edge: iStar === 0 || iStar === curve.length - 1,
    };
  }

  // pop = [{sample, revenue}] from the seeded random phase.
  function globalStats(pop, key, decile) {
    const xs = pop.map((p) => p.sample[key]);
    const ys = pop.map((p) => p.revenue);
    const rho = spearman(xs, ys);
    const byRev = [...pop].sort((a, b) => b.revenue - a.revenue);
    const nTop = Math.max(10, Math.floor(pop.length * (decile == null ? 0.1 : decile)));
    const top = byRev.slice(0, nTop).map((p) => p.sample[key]).sort((a, b) => a - b);
    const all = [...xs].sort((a, b) => a - b);
    return {
      rho,
      topBand: [percentile(top, 25), percentile(top, 75)],
      range: [all[0], all[all.length - 1]],
    };
  }

  function _bins(vals) {
    const uniq = [...new Set(vals)].sort((a, b) => a - b);
    if (uniq.length <= 3) return vals.map((v) => uniq.indexOf(v));
    const sorted = [...vals].sort((a, b) => a - b);
    const q1 = percentile(sorted, 100 / 3), q2 = percentile(sorted, 200 / 3);
    return vals.map((v) => (v <= q1 ? 0 : v <= q2 ? 1 : 2));
  }

  // Pairwise non-additivity over the population: tertile-bin both params,
  // fit grand + row + column effects on the (count-weighted) cell means, and
  // score the pair by the RMS residual as a fraction of |rStar|. Pairs with
  // fewer than 6 populated (>= minCell) cells are skipped.
  function interactionScores(pop, keys, rStar, minCell) {
    minCell = minCell == null ? 20 : minCell;
    const denom = Math.max(1, Math.abs(rStar));
    const ys = pop.map((p) => p.revenue);
    const binsBy = {};
    for (const k of keys) binsBy[k] = _bins(pop.map((p) => p.sample[k]));
    const out = [];
    for (let a = 0; a < keys.length; a++) {
      for (let b = a + 1; b < keys.length; b++) {
        const ba = binsBy[keys[a]], bb = binsBy[keys[b]];
        const sum = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        const cnt = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (let i = 0; i < ys.length; i++) { sum[ba[i]][bb[i]] += ys[i]; cnt[ba[i]][bb[i]]++; }
        let g = 0, gn = 0, valid = 0;
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
          if (cnt[r][c] >= minCell) { g += sum[r][c]; gn += cnt[r][c]; valid++; }
        if (valid < 6 || gn === 0) continue;
        g /= gn;
        const rowE = [0, 0, 0], colE = [0, 0, 0];
        for (let r = 0; r < 3; r++) {
          let s = 0, n = 0;
          for (let c = 0; c < 3; c++) if (cnt[r][c] >= minCell) { s += sum[r][c]; n += cnt[r][c]; }
          rowE[r] = n > 0 ? s / n - g : 0;
        }
        for (let c = 0; c < 3; c++) {
          let s = 0, n = 0;
          for (let r = 0; r < 3; r++) if (cnt[r][c] >= minCell) { s += sum[r][c]; n += cnt[r][c]; }
          colE[c] = n > 0 ? s / n - g : 0;
        }
        let se = 0, sw = 0;
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
          if (cnt[r][c] < minCell) continue;
          const e = sum[r][c] / cnt[r][c] - (g + rowE[r] + colE[c]);
          se += cnt[r][c] * e * e;
          sw += cnt[r][c];
        }
        out.push({ a: keys[a], b: keys[b], score: Math.sqrt(se / sw) / denom });
      }
    }
    out.sort((x, y) => y.score - x.score);
    return out;
  }

  // ------------------------------------------------------------- renderers
  // Self-contained theme (same dark palette as charts.js / bess-charts.js).
  const LAYOUT = {
    paper_bgcolor: "#11161c",
    plot_bgcolor: "#11161c",
    font: { color: "#e6edf3", family: "system-ui, sans-serif", size: 12 },
    margin: { t: 28, r: 60, b: 50, l: 60 },
    xaxis: { gridcolor: "#262d36", linecolor: "#3a4350", zerolinecolor: "#3a4350" },
    yaxis: { gridcolor: "#262d36", linecolor: "#3a4350", zerolinecolor: "#3a4350" },
    hoverlabel: { bgcolor: "#1f2630", bordercolor: "#3a4350", font: { color: "#e6edf3" } },
    legend: { bgcolor: "rgba(0,0,0,0)", orientation: "h", x: 0, y: 1.14 },
  };
  const CONFIG = {
    responsive: true,
    displaylogo: false,
    scrollZoom: true,
    modeBarButtonsToRemove: ["lasso2d", "select2d", "toImage"],
  };
  const DIM = "#7d8590";

  //  drawWeights — horizontal bars: max % of revenue lost moving ONE param
  //    across its sweep range (others at the optimum). Yellow = the optimum
  //    sits on a sweep edge (saturated lever).
  function drawWeights(targetId, perParam) {
    const keys = Object.keys(perParam).sort((a, b) => perParam[a].weight - perParam[b].weight);
    const traces = [{
      x: keys.map((k) => perParam[k].weight * 100),
      y: keys,
      type: "bar",
      orientation: "h",
      marker: { color: keys.map((k) => (perParam[k].edge ? "#e3b341" : "#58a6ff")) },
      customdata: keys.map((k) => {
        const s = perParam[k];
        return `1%-band ${s.band[0]} … ${s.band[1]} · ${s.shape} · ρ ${s.rho.toFixed(2)}`;
      }),
      hovertemplate: "%{y}: −%{x:.1f}%<br>%{customdata}<extra></extra>",
    }];
    const layout = Object.assign({}, LAYOUT, {
      margin: { t: 20, r: 18, b: 40, l: 150 },
      yaxis: { ...LAYOUT.yaxis, automargin: true, tickfont: { size: 11 } },
      xaxis: { ...LAYOUT.xaxis, title: "weight = max % of revenue lost (one-at-a-time)" },
    });
    Plotly.react(targetId, traces, layout, CONFIG);
  }

  //  drawCurves — Δ revenue vs optimum for the top-6 weighted params,
  //    x normalized to each param's sweep range; dots mark the optimum.
  function drawCurves(targetId, curves, perParam, rStar) {
    const denom = Math.max(1, Math.abs(rStar));
    const keys = Object.keys(perParam)
      .sort((a, b) => perParam[b].weight - perParam[a].weight)
      .slice(0, 6);
    const palette = ["#58a6ff", "#3fb950", "#f85149", "#e3b341", "#bc8cff", "#f0883e"];
    const traces = [];
    keys.forEach((k, ki) => {
      const c = curves[k];
      const vMin = c[0].v, vMax = c[c.length - 1].v, span = vMax - vMin || 1;
      traces.push({
        x: c.map((p) => ((p.v - vMin) / span) * 100),
        y: c.map((p) => ((p.r - rStar) / denom) * 100),
        customdata: c.map((p) => p.v),
        type: "scatter",
        mode: "lines",
        name: k,
        line: { color: palette[ki % palette.length], width: 2 },
        hovertemplate: `${k} = %{customdata}<br>Δ %{y:.1f}%<extra></extra>`,
      });
      const s = perParam[k];
      traces.push({
        x: [((s.vStar - vMin) / span) * 100],
        y: [0],
        type: "scatter",
        mode: "markers",
        marker: { color: palette[ki % palette.length], size: 9, line: { color: "#0d1117", width: 1 } },
        showlegend: false,
        hovertemplate: `${k} optimum = ${s.vStar}<extra></extra>`,
      });
    });
    const layout = Object.assign({}, LAYOUT, {
      margin: { t: 20, r: 18, b: 44, l: 55 },
      xaxis: { ...LAYOUT.xaxis, title: "parameter range (min → max, normalized %)" },
      yaxis: { ...LAYOUT.yaxis, title: "Δ revenue vs optimum (%)" },
      legend: { bgcolor: "rgba(0,0,0,0)", orientation: "h", x: 0, y: 1.18, font: { size: 10 } },
    });
    Plotly.react(targetId, traces, layout, CONFIG);
  }

  //  drawHeatmap — 2-D sweep of the strongest interacting pair around the
  //    optimum (others fixed); ★ marks the found optimum.
  function drawHeatmap(targetId, heat) {
    if (!heat) {
      Plotly.react(targetId, [{ x: [], y: [], type: "scatter" }],
        Object.assign({}, LAYOUT, { annotations: [{ text: "No interaction pair to map", showarrow: false, font: { color: DIM } }] }), CONFIG);
      return;
    }
    const xLab = heat.vb.map(String), yLab = heat.va.map(String);
    const traces = [
      {
        x: xLab, y: yLab, z: heat.z,
        type: "heatmap",
        colorscale: "Viridis",
        colorbar: { title: { text: "Δ% vs opt", side: "right" }, tickfont: { color: "#e6edf3" } },
        hovertemplate: `${heat.b} = %{x} · ${heat.a} = %{y}<br>Δ %{z:.1f}%<extra></extra>`,
      },
      {
        x: [String(heat.bStar)], y: [String(heat.aStar)],
        type: "scatter", mode: "markers",
        marker: { symbol: "star", size: 14, color: "#ffffff", line: { color: "#0d1117", width: 1 } },
        showlegend: false, hovertemplate: "optimum<extra></extra>",
      },
    ];
    const layout = Object.assign({}, LAYOUT, {
      margin: { t: 20, r: 18, b: 60, l: 70 },
      xaxis: { ...LAYOUT.xaxis, title: heat.b, type: "category", automargin: true },
      yaxis: { ...LAYOUT.yaxis, title: heat.a, type: "category", automargin: true },
    });
    Plotly.react(targetId, traces, layout, CONFIG);
  }

  return { percentile, spearman, weightAndBand, globalStats, interactionScores, drawWeights, drawCurves, drawHeatmap };
})();

if (typeof module !== "undefined") module.exports = OptimSens;
