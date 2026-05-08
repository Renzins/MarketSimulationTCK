// afrr-charts.js — Plotly renderers for the aFRR sub-tab.
//
// EXPORTS
//   drawActivationBars(targetId, result, title)
//     Two-bar stacked chart (Surplus | Deficit), with each bar split into
//     four mutually-exclusive segments that sum to 100 %:
//       Not activated      — AST_POS = NaN  AND  AST_NEG = NaN
//       Down only          — AST_NEG non-null, AST_POS NaN
//       Both               — AST_POS non-null AND AST_NEG non-null
//       Up only            — AST_POS non-null, AST_NEG NaN
//
//     `result` shape (see afrr-engine.js):
//       { surplus: { n_total, n_neither, n_neg_only, n_both, n_pos_only,
//                    pct_neither, pct_neg_only, pct_both, pct_pos_only,
//                    n_isps },
//         deficit: {...},
//         thresholds: {deficit, surplus},
//         level: 'lv' | 'baltic' }

const AfrrCharts = (() => {
  const LAYOUT = {
    paper_bgcolor: "#11161c",
    plot_bgcolor: "#11161c",
    font: { color: "#e6edf3", family: "system-ui, sans-serif", size: 12 },
    margin: { t: 70, r: 18, b: 60, l: 60 },
    xaxis: { gridcolor: "#262d36", linecolor: "#3a4350", zerolinecolor: "#3a4350" },
    yaxis: { gridcolor: "#262d36", linecolor: "#3a4350", zerolinecolor: "#3a4350" },
    hoverlabel: { bgcolor: "#1f2630", bordercolor: "#3a4350", font: { color: "#e6edf3" } },
  };
  const CFG = {
    responsive: true,
    displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"],
  };

  // 4-segment palette. Stack order (bottom → top):
  //   Not activated → Down only → Both → Up only
  //
  // Down/Up are anchored to the standard "downward = red, upward = green"
  // convention used elsewhere in the site; "Both" gets an amber tone so it's
  // unmistakably a separate state and doesn't blur into either direction.
  const COL_NOT = "#3a4350"; // grey
  const COL_DOWN = "#f0883e"; // orange/red — downward-only
  const COL_BOTH = "#ffd166"; // amber — both directions firing
  const COL_UP = "#3fb950"; // green — upward-only

  function fmtCount(n) {
    return n.toLocaleString("en-US");
  }
  function fmtPct(p) {
    return (p * 100).toFixed(2) + "%";
  }
  function fmtSegLabel(p) {
    // Bigger numbers use 1dp, very small ones use 2dp; very tiny ones omit.
    if (p < 0.005) return "";
    return (p * 100).toFixed(p < 0.05 ? 2 : 1) + "%";
  }

  // Build hover text for one segment of one bar. customdata[0] = count,
  // customdata[1] = total slots in that bar, customdata[2] = ISPs in regime.
  function _hoverTpl(segName) {
    return (
      `<b>%{x} — ${segName}</b><br>` +
      "%{y:.2f}%<br>" +
      "%{customdata[0]:,} / %{customdata[1]:,} 4s slots<br>" +
      "across %{customdata[2]:,} ISPs<extra></extra>"
    );
  }

  // `barLabels` is optional. Defaults to ["SURPLUS","DEFICIT"]; the divergence
  // chart passes ["LV+ / rest−", "LV− / rest+"].
  // `subtitleOverride` lets the divergence chart show its own thresholds line
  // instead of the regular level/threshold subtitle.
  function drawActivationBars(targetId, result, title, barLabels, subtitleOverride) {
    const bars = barLabels || ["SURPLUS", "DEFICIT"];
    const s = result.surplus;
    const d = result.deficit;

    // Per-segment percentages for each bar
    const segs = [
      // [name, colour, [surplus_pct, deficit_pct], [s_count, d_count]]
      ["Not activated", COL_NOT, [s.pct_neither * 100, d.pct_neither * 100], [s.n_neither, d.n_neither]],
      ["Down only (NEG)", COL_DOWN, [s.pct_neg_only * 100, d.pct_neg_only * 100], [s.n_neg_only, d.n_neg_only]],
      ["Both directions", COL_BOTH, [s.pct_both * 100, d.pct_both * 100], [s.n_both, d.n_both]],
      ["Up only (POS)", COL_UP, [s.pct_pos_only * 100, d.pct_pos_only * 100], [s.n_pos_only, d.n_pos_only]],
    ];

    const traces = segs.map(([name, colour, ys, counts]) => ({
      type: "bar",
      name,
      x: bars,
      y: ys,
      marker: { color: colour, line: { color: "#0d1117", width: 1 } },
      customdata: [
        [counts[0], s.n_total, s.n_isps],
        [counts[1], d.n_total, d.n_isps],
      ],
      hovertemplate: _hoverTpl(name),
    }));

    // In-segment percentage labels — accumulate cumulative y so labels sit
    // at the centre of each segment.
    const annotations = [];
    function pushLabels(barIdx, percentages) {
      let cum = 0;
      for (let k = 0; k < percentages.length; k++) {
        const p = percentages[k];
        if (p < 4) {
          // segment too thin to legibly label inside
          cum += p;
          continue;
        }
        annotations.push({
          x: bars[barIdx],
          y: cum + p / 2,
          xref: "x",
          yref: "y",
          text: `<b>${fmtSegLabel(p / 100)}</b>`,
          showarrow: false,
          // contrast colour: dark text on light segments, light on dark
          font: {
            color: k === 0 ? "#e6edf3" : k === 2 ? "#0d1117" : "#0d1117",
            size: 13,
          },
        });
        cum += p;
      }
    }
    pushLabels(0, [
      s.pct_neither * 100,
      s.pct_neg_only * 100,
      s.pct_both * 100,
      s.pct_pos_only * 100,
    ]);
    pushLabels(1, [
      d.pct_neither * 100,
      d.pct_neg_only * 100,
      d.pct_both * 100,
      d.pct_pos_only * 100,
    ]);

    // n=… header above each bar
    annotations.push({
      x: bars[0],
      y: 1.04,
      xref: "x",
      yref: "paper",
      text: `n=${fmtCount(s.n_total)} (${fmtCount(s.n_isps)} ISPs)`,
      showarrow: false,
      font: { size: 10, color: "#9aa5b1" },
    });
    annotations.push({
      x: bars[1],
      y: 1.04,
      xref: "x",
      yref: "paper",
      text: `n=${fmtCount(d.n_total)} (${fmtCount(d.n_isps)} ISPs)`,
      showarrow: false,
      font: { size: 10, color: "#9aa5b1" },
    });

    let subtitle;
    if (subtitleOverride) {
      subtitle = subtitleOverride;
    } else {
      subtitle =
        `${result.level === "lv" ? "LV" : "Baltic"} imbalance · ` +
        `thresholds: deficit ≤ ${result.thresholds.deficit} MW, ` +
        `surplus ≥ ${result.thresholds.surplus} MW`;
    }
    const layout = Object.assign({}, LAYOUT, {
      title: {
        text: `${title}<br><span style="font-size:11px;color:#9aa5b1">${subtitle}</span>`,
        font: { size: 14, color: "#e6edf3" },
      },
      barmode: "stack",
      yaxis: {
        ...LAYOUT.yaxis,
        title: "% of 4s slots",
        range: [0, 100],
        ticksuffix: "%",
      },
      xaxis: { ...LAYOUT.xaxis, type: "category" },
      annotations,
      legend: {
        orientation: "h",
        x: 0,
        y: 1.16,
        bgcolor: "rgba(0,0,0,0)",
        font: { color: "#e6edf3" },
      },
    });

    Plotly.react(targetId, traces, layout, CFG);
  }

  return { drawActivationBars };
})();

if (typeof module !== "undefined") module.exports = AfrrCharts;
