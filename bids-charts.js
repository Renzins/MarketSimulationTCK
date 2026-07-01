// bids-charts.js — Plotly renderers for the "Bid data" page.
//
// The Bid data page shows, for the most recent four 15-minute delivery
// periods, the LV mFRR balancing-energy bid stack as a histogram:
//
//     X axis = price (€/MWh), binned
//     Y axis = MW offered (sum of every bid's volume that falls in the bin)
//
// Eight charts total: four periods × two directions (mFRR up / mFRR down).
// This module owns the histogram math (nice bin width, shared axes across a
// direction so the four periods are directly comparable) and the Plotly draw.
// The grouping upstream — pick the four most recent periods, split by
// direction, treat mFRR scheduled (A05) and scheduled+direct (A07) as one —
// lives in bids-app.js.

const BidCharts = (() => {
  const COMMON_LAYOUT = {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: "#c9d1d9", size: 11 },
    margin: { l: 50, r: 14, t: 30, b: 42 },
    bargap: 0,
    showlegend: false,
    xaxis: {
      gridcolor: "rgba(255,255,255,0.06)",
      zerolinecolor: "rgba(255,255,255,0.20)",
      title: { text: "price €/MWh", standoff: 4 },
    },
    yaxis: {
      gridcolor: "rgba(255,255,255,0.06)",
      zerolinecolor: "rgba(255,255,255,0.12)",
      rangemode: "tozero",
      title: { text: "MW offered", standoff: 4 },
    },
  };

  // Round a raw bin width up to a "nice" number (1 / 2 / 2.5 / 5 / 10 × 10^k)
  // so the price axis lands on readable boundaries. Targets ~14 bins across
  // the data range; floors at 1 €/MWh so a tight range can't produce
  // sub-euro bins.
  function niceBinWidth(range, target) {
    target = target || 14;
    if (!isFinite(range) || range <= 0) return 5;
    const raw = range / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return Math.max(1, nice * mag);
  }

  function cleanBid(b) {
    return (
      b &&
      b.price_eur_mwh != null &&
      isFinite(b.price_eur_mwh) &&
      b.volume_mw != null &&
      isFinite(b.volume_mw)
    );
  }

  // Draw one histogram into targetId. spec:
  //   { centers, mw, counts, binWidth, color, xRange, yRange, title,
  //     empty, emptyMsg }
  // Empty charts still render the axes + period title with a centred note so
  // the eight-panel grid stays visually regular when a window has no bids.
  function drawHistogram(targetId, spec) {
    const el = document.getElementById(targetId);
    if (!el) return;
    const s = spec || {};
    const layout = {
      ...COMMON_LAYOUT,
      title: {
        text: s.title || "",
        font: { size: 12, color: "#c9d1d9" },
        x: 0,
        xanchor: "left",
        y: 0.98,
        yanchor: "top",
      },
      xaxis: { ...COMMON_LAYOUT.xaxis, ...(s.xRange ? { range: s.xRange } : {}) },
      yaxis: { ...COMMON_LAYOUT.yaxis, ...(s.yRange ? { range: s.yRange } : {}) },
      annotations: s.empty
        ? [
            {
              text: s.emptyMsg || "no bids",
              showarrow: false,
              xref: "paper",
              yref: "paper",
              x: 0.5,
              y: 0.5,
              font: { color: "#7d8590", size: 12 },
            },
          ]
        : [],
    };
    const bw = s.binWidth || 1;
    const traces = s.empty
      ? []
      : [
          {
            type: "bar",
            x: s.centers,
            y: s.mw,
            width: bw * 0.98,
            marker: {
              color: s.color || "#58a6ff",
              line: { color: "rgba(0,0,0,0.35)", width: 0.5 },
            },
            customdata: (s.centers || []).map((c, i) => [
              c - bw / 2,
              c + bw / 2,
              (s.counts && s.counts[i]) || 0,
            ]),
            hovertemplate:
              "€%{customdata[0]:.0f} … %{customdata[1]:.0f}/MWh<br>" +
              "%{y:.1f} MW offered<br>%{customdata[2]} bid(s)<extra></extra>",
          },
        ];
    Plotly.react(el, traces, layout, {
      displayModeBar: false,
      responsive: true,
    });
  }

  // Render one direction's four period charts with SHARED price bins and a
  // shared MW (y) scale, so the four panels are directly comparable and you
  // can see the bid stack shift period-to-period.
  //   items: [{ targetId, label, bids:[{price_eur_mwh, volume_mw}] }] (len 4)
  //   opts:  { color, emptyMsg }
  function drawDirectionSection(items, opts) {
    opts = opts || {};
    const color = opts.color || "#58a6ff";
    const emptyMsg = opts.emptyMsg || "no bids in window";

    const all = items.flatMap((it) => (it.bids || []).filter(cleanBid));
    if (all.length === 0) {
      items.forEach((it) =>
        drawHistogram(it.targetId, {
          title: it.label,
          empty: true,
          emptyMsg,
          color,
        }),
      );
      return;
    }

    const prices = all.map((b) => b.price_eur_mwh);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const bw = niceBinWidth(max - min, 14);
    const lo = Math.floor(min / bw) * bw;
    let hi = Math.ceil(max / bw) * bw;
    if (hi <= lo) hi = lo + bw;
    const nb = Math.max(1, Math.round((hi - lo) / bw));
    const centers = Array.from({ length: nb }, (_, i) => lo + (i + 0.5) * bw);

    const perPeriod = items.map((it) => {
      const mw = new Array(nb).fill(0);
      const counts = new Array(nb).fill(0);
      for (const b of it.bids || []) {
        if (!cleanBid(b)) continue;
        let idx = Math.floor((b.price_eur_mwh - lo) / bw);
        if (idx < 0) idx = 0;
        if (idx >= nb) idx = nb - 1;
        mw[idx] += b.volume_mw;
        counts[idx] += 1;
      }
      return { mw, counts };
    });

    const yMax = Math.max(1e-6, ...perPeriod.flatMap((p) => p.mw));
    items.forEach((it, k) => {
      const p = perPeriod[k];
      drawHistogram(it.targetId, {
        centers,
        mw: p.mw,
        counts: p.counts,
        binWidth: bw,
        color,
        xRange: [lo, hi],
        yRange: [0, yMax * 1.08],
        title: it.label,
        empty: !p.mw.some((v) => v > 0),
        emptyMsg,
      });
    });
  }

  function clear(targetId) {
    const el = document.getElementById(targetId);
    if (el) Plotly.purge(el);
  }

  return { drawDirectionSection, drawHistogram, clear, niceBinWidth };
})();
