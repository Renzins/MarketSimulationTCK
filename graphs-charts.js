// graphs-charts.js — Plotly renderers for the Graphs page.
//
// EXPORTS
//   drawSpreadByBucket(targetId, result, regime, xaxisTitle, title)
//     1-D box plot — one box per bucket of wind / solar (used by graphs 1-4).
//
//   drawWindSolarHeatmap(targetId, result, regime, title)
//     2-D heatmap of median spread (graphs 5-6). Solar on Y, Wind on X,
//     each cell shows med/avg/σ/n in white text.
//
//   drawAbsSpreadMatchedPanels(targetId, result, title)
//     Multi-panel grouped box plots, one panel per DA price band (graphs 7-9).
//     Panel layout uses Plotly's `grid` to share the y-axis range across
//     panels (so volatility is visually comparable). Outliers are overlaid
//     as a separate scatter trace and clipped at yMax.
//
// COLOUR PALETTE
// ==============
// `paletteForN(N, stops)` samples a gradient between fixed colour stops at
// N evenly-spaced points. For N=4 it reproduces the original 4-colour set;
// for N=8 it produces 8 distinct shades — colours never cycle as bucket
// counts grow. Two stop tables:
//   STOPS_BUCKET       — pink → orange → green → teal (regime box plots)
//   STOPS_PANEL_LEVEL  — red → orange → blue (matched-panel level rows)
//
// BOX PLOT STYLING
// ================
// We feed pre-computed quartiles (q1, median, q3, lowerfence, upperfence) so
// Plotly doesn't have to crunch raw data. Critical: do NOT pass `mean` or
// `sd` — those cause Plotly to draw a diamond / 1-σ-arrow inside the box.
// Median + whiskers + outliers (overlaid scatter) is the traditional look.
//
// Outline: `#f0f6fc` (near-white) for visibility on the dark theme.

const GraphsCharts = (() => {
  const LAYOUT = {
    paper_bgcolor: "#11161c",
    plot_bgcolor: "#11161c",
    font: { color: "#e6edf3", family: "system-ui, sans-serif", size: 12 },
    margin: { t: 50, r: 18, b: 70, l: 60 },
    xaxis: { gridcolor: "#262d36", linecolor: "#3a4350", zerolinecolor: "#3a4350" },
    yaxis: { gridcolor: "#262d36", linecolor: "#3a4350", zerolinecolor: "#3a4350" },
    hoverlabel: { bgcolor: "#1f2630", bordercolor: "#3a4350", font: { color: "#e6edf3" } },
    showlegend: false,
  };
  const CFG = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ["lasso2d", "select2d"] };

  // Gradient stops for the bucketed plots. Each entry is [t∈[0,1], hex].
  // Bucket k of N samples the gradient at t = k / (N-1), so the palette
  // never repeats — it just becomes smoother as N grows.
  const STOPS_BUCKET = [
    [0.0, "#c4506f"], // pink/red - low
    [0.333, "#e8a06f"], // orange
    [0.667, "#a8d27a"], // light green
    [1.0, "#3fa07a"], // teal-green - high
  ];
  const STOPS_PANEL_LEVEL = [
    [0.0, "#e88f8f"], // red - low
    [0.5, "#f0c47a"], // orange - mid
    [1.0, "#7ab9e8"], // blue - high
  ];

  function _hexToRgb(hex) {
    const m = hex.replace("#", "");
    return [
      parseInt(m.slice(0, 2), 16),
      parseInt(m.slice(2, 4), 16),
      parseInt(m.slice(4, 6), 16),
    ];
  }
  function _rgbToHex(rgb) {
    return (
      "#" +
      rgb
        .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0"))
        .join("")
    );
  }
  function _colourAt(t, stops) {
    if (t <= stops[0][0]) return stops[0][1];
    if (t >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
    for (let i = 0; i < stops.length - 1; i++) {
      const [t0, h0] = stops[i];
      const [t1, h1] = stops[i + 1];
      if (t >= t0 && t <= t1) {
        const u = (t - t0) / (t1 - t0);
        const c0 = _hexToRgb(h0);
        const c1 = _hexToRgb(h1);
        return _rgbToHex(c0.map((v, j) => v + (c1[j] - v) * u));
      }
    }
    return stops[stops.length - 1][1];
  }
  // Sample N evenly-spaced colours along a stop list.
  function paletteForN(N, stops) {
    const out = new Array(N);
    for (let k = 0; k < N; k++) {
      const t = N === 1 ? 0.5 : k / (N - 1);
      out[k] = _colourAt(t, stops);
    }
    return out;
  }

  function fmtNum(v, decimals = 0) {
    if (!isFinite(v)) return "–";
    return Number(v).toFixed(decimals);
  }

  // ------------ 1-D box plots (spread by Wind/Solar bins) -----------------
  // result = { labels, boxes }, regime = 'SURPLUS'|'DEFICIT', xaxisTitle, title
  // Style: white outline / median for high contrast on dark theme. Mean
  // indicator (diamond) is omitted — the box only shows quartiles + whiskers
  // + outliers as separate scatter dots, matching the traditional look.
  function drawSpreadByBucket(targetId, result, regime, xaxisTitle, title) {
    const N = result.boxes.length;
    const colours = paletteForN(N, STOPS_BUCKET);
    const traces = [];
    for (let k = 0; k < N; k++) {
      const b = result.boxes[k];
      const c = colours[k];
      traces.push({
        type: "box",
        name: result.labels[k],
        x: [result.labels[k]],
        q1: [b.q1],
        median: [b.median],
        q3: [b.q3],
        lowerfence: [b.min],
        upperfence: [b.max],
        // No mean/sd → no in-box diamond / 1-σ arrow that confused the look
        boxpoints: false,
        fillcolor: c,
        line: { color: "#f0f6fc", width: 1.5 }, // near-white for contrast
        whiskerwidth: 0.45,
        hovertemplate:
          `<b>${result.labels[k]}</b><br>` +
          `med = ${fmtNum(b.median, 1)}<br>` +
          `avg = ${fmtNum(b.mean, 1)}<br>` +
          `σ = ${fmtNum(b.std, 1)}<br>` +
          `n = ${b.n}<extra></extra>`,
      });
      // Outliers as a separate scatter trace (Plotly's pre-computed-quartiles
      // API doesn't render outliers reliably — overlay them ourselves).
      if (b.outliers.length) {
        traces.push({
          type: "scatter",
          mode: "markers",
          x: b.outliers.map(() => result.labels[k]),
          y: b.outliers,
          marker: { color: "#f0f6fc", size: 4, opacity: 0.55 },
          hoverinfo: "y",
          showlegend: false,
        });
      }
    }
    const annotations = result.boxes.map((b, k) => ({
      x: result.labels[k],
      y: 1.06,
      xref: "x",
      yref: "paper",
      text: `n=${b.n}`,
      showarrow: false,
      font: { size: 10, color: "#9aa5b1" },
    }));
    const layout = Object.assign({}, LAYOUT, {
      title: { text: title, font: { size: 14, color: "#e6edf3" } },
      yaxis: {
        ...LAYOUT.yaxis,
        title: "Spread: P_mFRR − P_DA (EUR/MWh)",
        zeroline: true,
        zerolinecolor: "#f85149",
        zerolinewidth: 1,
      },
      xaxis: { ...LAYOUT.xaxis, title: xaxisTitle, type: "category" },
      annotations,
    });
    Plotly.react(targetId, traces, layout, CFG);
  }

  // ------------ 2-D heatmap (spread by Wind × Solar) ----------------------
  // result has wind, solar, cells (cells[sB][wB])
  function drawWindSolarHeatmap(targetId, result, regime, title) {
    const z = result.cells.map((row) => row.map((c) => (c.n > 0 ? c.median : null)));
    const annotations = [];
    for (let s = 0; s < result.solar.labels.length; s++) {
      for (let w = 0; w < result.wind.labels.length; w++) {
        const c = result.cells[s][w];
        if (c.n === 0) continue;
        annotations.push({
          x: result.wind.labels[w],
          y: result.solar.labels[s],
          text:
            `med=${fmtNum(c.median, 0)}<br>` +
            `avg=${fmtNum(c.mean, 0)}<br>` +
            `σ=${fmtNum(c.std, 0)}<br>` +
            `n=${c.n}`,
          showarrow: false,
          font: { size: 9, color: "#fff" },
          align: "center",
        });
      }
    }
    // Pick a colour scale that stays informative for both regimes:
    // Surplus → red shows positive (less negative) spread, blue more negative
    // Deficit → red shows higher positive spread
    const colorscale =
      regime === "SURPLUS"
        ? [
            [0, "#1d2c50"],
            [0.5, "#7d8fad"],
            [1, "#c4506f"],
          ]
        : [
            [0, "#3a8aab"],
            [0.5, "#f7d29c"],
            [1, "#7a1a36"],
          ];
    const traces = [
      {
        type: "heatmap",
        z,
        x: result.wind.labels,
        y: result.solar.labels,
        colorscale,
        zmid: 0,
        colorbar: { title: { text: "Median Spread (EUR/MWh)", side: "right" } },
        hovertemplate:
          "Wind: %{x}<br>Solar: %{y}<br>Median spread: %{z:.1f} EUR/MWh<extra></extra>",
      },
    ];
    const layout = Object.assign({}, LAYOUT, {
      title: { text: title, font: { size: 14, color: "#e6edf3" } },
      xaxis: { ...LAYOUT.xaxis, title: "Wind DA Forecast (MW)" },
      yaxis: { ...LAYOUT.yaxis, title: "Solar DA Forecast (MW)" },
      annotations,
    });
    Plotly.react(targetId, traces, layout, CFG);
  }

  // ------------ Multi-panel |spread| by Wind matched by DA Price Band ----
  // result has the renamed levelLabels / levelEdges fields (was windLabels).
  // axisLabel is what each box's category represents — e.g. "Wind level"
  // in the legend / level row.
  function drawAbsSpreadMatchedPanels(targetId, result, title) {
    const nPanels = result.panels.length;
    const nLevels = result.levelLabels.length;
    const traces = [];
    const annotations = [];
    const levelColours = paletteForN(nLevels, STOPS_PANEL_LEVEL);
    // Compute global y-max (95th percentile across all panels' whisker tops)
    let yMax = 0;
    let globalN = 0;
    for (const panel of result.panels) {
      for (const b of panel.boxes) {
        globalN += b.n;
        if (b.max > yMax) yMax = b.max;
        // Cap at 95th-percentile-style — exclude extreme outliers from
        // determining y-range, otherwise the boxes get squashed.
        for (const o of b.outliers) {
          if (o > yMax && o < yMax * 3) yMax = o;
        }
      }
    }
    yMax = yMax * 1.10 || 1;

    for (let p = 0; p < nPanels; p++) {
      const panel = result.panels[p];
      const axisIdx = p === 0 ? "" : p + 1;
      const xa = `x${axisIdx}`;
      const ya = `y${axisIdx}`;
      const xref = p === 0 ? "x" : `x${p + 1}`;
      const yref = p === 0 ? "y" : `y${p + 1}`;
      let panelN = 0;
      for (let w = 0; w < nLevels; w++) {
        const b = panel.boxes[w];
        panelN += b.n;
        const c = levelColours[w];
        traces.push({
          type: "box",
          xaxis: xa,
          yaxis: ya,
          name: result.levelLabels[w],
          x: [result.levelLabels[w]],
          q1: [b.q1],
          median: [b.median],
          q3: [b.q3],
          lowerfence: [b.min],
          upperfence: [b.max],
          // No mean/sd: clean traditional box
          boxpoints: false,
          fillcolor: c,
          line: { color: "#f0f6fc", width: 1.5 },
          whiskerwidth: 0.45,
          hovertemplate:
            `<b>${panel.daLabel} · ${result.levelLabels[w]}</b><br>` +
            `med = ${fmtNum(b.median, 1)}<br>` +
            `avg = ${fmtNum(b.mean, 1)}<br>` +
            `σ = ${fmtNum(b.std, 1)}<br>` +
            `n = ${b.n}<extra></extra>`,
          showlegend: false,
        });
        // Outliers as separate scatter overlay (capped at yMax so they don't
        // explode the panel range)
        if (b.outliers.length) {
          const cappedOutliers = b.outliers.filter((v) => v <= yMax);
          if (cappedOutliers.length) {
            traces.push({
              type: "scatter",
              mode: "markers",
              xaxis: xa,
              yaxis: ya,
              x: cappedOutliers.map(() => result.levelLabels[w]),
              y: cappedOutliers,
              marker: { color: "#f0f6fc", size: 3, opacity: 0.45 },
              hoverinfo: "y",
              showlegend: false,
            });
          }
        }
        // n annotation positioned in subplot data coords just above the box
        annotations.push({
          xref,
          yref,
          x: result.levelLabels[w],
          y: yMax * 0.97,
          text: `n=${b.n}`,
          showarrow: false,
          font: { size: 9, color: "#9aa5b1" },
        });
      }
      // Panel header in paper coords with total n
      const xrefDomain = p === 0 ? "x domain" : `x${p + 1} domain`;
      annotations.push({
        xref: xrefDomain,
        yref: "paper",
        x: 0.5,
        y: 1.04,
        text: `<b>DA: ${panel.daLabel}</b><br><span style="font-size:9px;color:#9aa5b1">n=${panelN.toLocaleString()}</span>`,
        showarrow: false,
        font: { size: 11, color: "#e6edf3" },
        align: "center",
      });
    }

    const panelWidth = 1 / nPanels;
    const layout = Object.assign({}, LAYOUT, {
      title: {
        text: `${title} · total n=${globalN.toLocaleString()}`,
        font: { size: 14, color: "#e6edf3" },
      },
      annotations,
      margin: { t: 80, r: 18, b: 70, l: 60 },
    });
    for (let p = 0; p < nPanels; p++) {
      const axisIdx = p === 0 ? "" : p + 1;
      const xKey = `xaxis${axisIdx}`;
      const yKey = `yaxis${axisIdx}`;
      layout[xKey] = {
        ...LAYOUT.xaxis,
        type: "category",
        domain: [p * panelWidth + 0.01, (p + 1) * panelWidth - 0.01],
        anchor: `y${axisIdx}`,
      };
      layout[yKey] = {
        ...LAYOUT.yaxis,
        title: p === 0 ? "|Spread| (EUR/MWh)" : "",
        range: [0, yMax],
        anchor: `x${axisIdx}`,
        showticklabels: p === 0,
      };
    }
    Plotly.react(targetId, traces, layout, CFG);
  }

  return {
    drawSpreadByBucket,
    drawWindSolarHeatmap,
    drawAbsSpreadMatchedPanels,
  };
})();

if (typeof module !== "undefined") module.exports = GraphsCharts;
