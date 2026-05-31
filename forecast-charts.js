// forecast-charts.js — Plotly chart renderers for the Forecast page.
//
// Two charts:
//   drawProbabilityBars(targetId, horizons)
//     Stacked-bar per horizon: p_neg / p_zero / p_pos. Heights sum to 1.
//
//   drawExpectedPriceLine(targetId, horizons)
//     Two lines: model-weighted expected price (solid) and the
//     calendar-only baseline (dashed). EUR/MWh.
//
// Both take the horizons array straight from forecast.json. Each
// horizon entry has { h, minutes_ahead, delivery_time, p_neg, p_zero,
// p_pos, argmax, argmax_label, expected_imbalance_price_eur_mwh,
// expected_imbalance_price_baseline_eur_mwh }.
//
// Colour palette matches the rest of the site (style.css vars copied
// as JS constants — kept narrow so we don't drift if style.css changes).

const ForecastCharts = (() => {
  // Class colours: NEG = red (deficit, upward needed), POS = green
  // (surplus, downward needed), ZRO = grey/blue (calm).
  const C_NEG = "#f85149";
  const C_ZRO = "#7d8590";
  const C_POS = "#3fb950";
  const C_MODEL = "#58a6ff";
  const C_BASELINE = "#d29922";

  const COMMON_LAYOUT = {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: "#c9d1d9", size: 12 },
    margin: { l: 60, r: 20, t: 20, b: 70 },
    xaxis: {
      gridcolor: "rgba(255,255,255,0.06)",
      zerolinecolor: "rgba(255,255,255,0.12)",
      tickformat: "%H:%M",
    },
    yaxis: {
      gridcolor: "rgba(255,255,255,0.06)",
      zerolinecolor: "rgba(255,255,255,0.12)",
    },
    legend: {
      orientation: "h",
      x: 0,
      y: 1.08,
      bgcolor: "rgba(0,0,0,0)",
    },
    hovermode: "x unified",
  };

  function _xValues(horizons) {
    return horizons.map((h) => h.delivery_time);
  }

  // ----- chart 1: stacked probability bars -----------------------------
  function drawProbabilityBars(targetId, horizons) {
    const target = document.getElementById(targetId);
    if (!target) return;
    if (!horizons || horizons.length === 0) {
      Plotly.purge(target);
      return;
    }
    const x = _xValues(horizons);
    const traces = [
      {
        x,
        y: horizons.map((h) => h.p_neg),
        type: "bar",
        name: "NEG (deficit)",
        marker: { color: C_NEG },
        hovertemplate: "p_neg: %{y:.0%}<extra></extra>",
      },
      {
        x,
        y: horizons.map((h) => h.p_zero),
        type: "bar",
        name: "ZRO (balanced)",
        marker: { color: C_ZRO },
        hovertemplate: "p_zero: %{y:.0%}<extra></extra>",
      },
      {
        x,
        y: horizons.map((h) => h.p_pos),
        type: "bar",
        name: "POS (surplus)",
        marker: { color: C_POS },
        hovertemplate: "p_pos: %{y:.0%}<extra></extra>",
      },
    ];
    const layout = {
      ...COMMON_LAYOUT,
      barmode: "stack",
      yaxis: {
        ...COMMON_LAYOUT.yaxis,
        range: [0, 1],
        tickformat: ".0%",
        title: { text: "probability", standoff: 6 },
      },
      xaxis: {
        ...COMMON_LAYOUT.xaxis,
        title: { text: "delivery time (UTC)", standoff: 6 },
      },
    };
    Plotly.react(target, traces, layout, {
      displayModeBar: false,
      responsive: true,
    });
  }

  // ----- chart 2: expected imbalance price -----------------------------
  function drawExpectedPriceLine(targetId, horizons) {
    const target = document.getElementById(targetId);
    if (!target) return;
    if (!horizons || horizons.length === 0) {
      Plotly.purge(target);
      return;
    }
    const x = _xValues(horizons);
    const traces = [
      {
        x,
        y: horizons.map((h) => h.expected_imbalance_price_eur_mwh),
        type: "scatter",
        mode: "lines+markers",
        name: "model-weighted",
        line: { color: C_MODEL, width: 2 },
        marker: { size: 5 },
        hovertemplate: "model: %{y:.1f} €/MWh<extra></extra>",
      },
      {
        x,
        y: horizons.map(
          (h) => h.expected_imbalance_price_baseline_eur_mwh,
        ),
        type: "scatter",
        mode: "lines",
        name: "baseline (no model)",
        line: { color: C_BASELINE, width: 1.5, dash: "dash" },
        hovertemplate: "baseline: %{y:.1f} €/MWh<extra></extra>",
      },
    ];
    const layout = {
      ...COMMON_LAYOUT,
      yaxis: {
        ...COMMON_LAYOUT.yaxis,
        title: { text: "EUR/MWh", standoff: 6 },
      },
      xaxis: {
        ...COMMON_LAYOUT.xaxis,
        title: { text: "delivery time (UTC)", standoff: 6 },
      },
    };
    Plotly.react(target, traces, layout, {
      displayModeBar: false,
      responsive: true,
    });
  }

  // ----- per-horizon detail table --------------------------------------
  // Compact table. Highlights argmax cell. EUR values formatted to 1 dp.
  function renderHorizonTable(targetId, horizons) {
    const el = document.getElementById(targetId);
    if (!el) return;
    if (!horizons || horizons.length === 0) {
      el.innerHTML = "";
      return;
    }
    const header = `
      <thead><tr>
        <th>h</th>
        <th>delivery (UTC)</th>
        <th>p_neg</th>
        <th>p_zero</th>
        <th>p_pos</th>
        <th>argmax</th>
        <th>model €/MWh</th>
        <th>baseline €/MWh</th>
      </tr></thead>`;
    const fmtPct = (v) => (v * 100).toFixed(0) + "%";
    const fmtEUR = (v) => (v == null ? "—" : v.toFixed(1));
    const labelClass = (lbl) =>
      lbl === "NEG"
        ? "down"
        : lbl === "POS"
          ? "up"
          : "";
    const rows = horizons
      .map((h) => {
        const tCol = (key, lbl) => {
          const v = h[key];
          const highlight = h.argmax_label === lbl ? ' style="font-weight:600"' : "";
          return `<td${highlight}>${fmtPct(v)}</td>`;
        };
        return `
          <tr>
            <td>${h.h}</td>
            <td>${h.delivery_time}</td>
            ${tCol("p_neg", "NEG")}
            ${tCol("p_zero", "ZRO")}
            ${tCol("p_pos", "POS")}
            <td class="${labelClass(h.argmax_label)}">${h.argmax_label}</td>
            <td>${fmtEUR(h.expected_imbalance_price_eur_mwh)}</td>
            <td>${fmtEUR(h.expected_imbalance_price_baseline_eur_mwh)}</td>
          </tr>`;
      })
      .join("");
    el.innerHTML = `${header}<tbody>${rows}</tbody>`;
  }

  return {
    drawProbabilityBars,
    drawExpectedPriceLine,
    renderHorizonTable,
  };
})();
