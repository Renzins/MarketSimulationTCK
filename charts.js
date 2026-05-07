// charts.js — all Plotly chart drawing for the backtester.
// Pure rendering: receives data + a target element id, returns nothing.

const Charts = (() => {
  const PLOTLY_LAYOUT_DEFAULTS = {
    paper_bgcolor: "#11161c",
    plot_bgcolor: "#11161c",
    font: { color: "#e6edf3", family: "system-ui, sans-serif", size: 12 },
    margin: { t: 28, r: 18, b: 50, l: 60 },
    xaxis: { gridcolor: "#262d36", linecolor: "#3a4350", zerolinecolor: "#3a4350" },
    yaxis: { gridcolor: "#262d36", linecolor: "#3a4350", zerolinecolor: "#3a4350" },
    hoverlabel: { bgcolor: "#1f2630", bordercolor: "#3a4350", font: { color: "#e6edf3" } },
    legend: { bgcolor: "rgba(0,0,0,0)", orientation: "h", x: 0, y: 1.12 },
  };

  const PLOTLY_CONFIG = {
    responsive: true,
    displaylogo: false,
    scrollZoom: true,
    modeBarButtonsToRemove: ["lasso2d", "select2d", "toImage"],
  };

  function fmtEUR(v) {
    return v.toLocaleString("en-US", { maximumFractionDigits: 0 }) + " €";
  }
  function fmtMW(v) {
    return v.toLocaleString("en-US", { maximumFractionDigits: 1 }) + " MW";
  }
  function fmtPrice(v) {
    return v.toLocaleString("en-US", { maximumFractionDigits: 2 }) + " €/MWh";
  }

  // ------------ TIME SERIES ---------------------------------------------
  // Renders DA-sold, mFRR up/down volumes, optionally Q_pot for level 2.
  // Single-trace tooltip strategy: ALL hover content is attached to a
  // dedicated invisible "hover trace" so the same tooltip never gets
  // rendered 2-4 times by Plotly's unified mode.
  // Window is [startIdx, endIdx). Switches to scattergl past ~600 points
  // to keep multi-week views responsive.
  function drawTimeSeries(targetId, level, simResult, params, startIdx, endIdx) {
    const D = Engine.getData();
    // perISP arrays are sized to the simulation window; map global ISP
    // index i → perISP index k_p = i - simResult.windowStart.
    const winStart = simResult.windowStart;
    const winEnd = simResult.windowEnd;
    const clampedStart = Math.max(startIdx, winStart);
    const clampedEnd = Math.min(endIdx, winEnd);
    const N = Math.max(0, clampedEnd - clampedStart);
    if (N <= 0) {
      Plotly.purge(targetId);
      return;
    }
    const BAR_THRESHOLD = 600;
    const useBars = N <= BAR_THRESHOLD;
    const theta = (params && params.theta_flat) || 0;

    const ts = new Array(N);
    const da = new Array(N);
    const up = new Array(N);
    const dn = new Array(N);
    const pot = new Array(N);
    const f_arr = new Array(N);
    const id_arr = new Array(N);
    const pda_arr = new Array(N);
    const pmfrr_arr = new Array(N);
    const pimb_arr = new Array(N);
    const rev = new Array(N);
    const short = new Array(N);
    for (let k = 0; k < N; k++) {
      const i = clampedStart + k; // global ISP index
      const k_p = i - winStart; // perISP-array index
      ts[k] = Engine.tsAt(i);
      da[k] = simResult.perISP.Q_da_sold[k_p];
      up[k] = simResult.perISP.Q_up[k_p];
      dn[k] = -simResult.perISP.Q_dn[k_p]; // negative bar (visual)
      pot[k] = D.q_pot[i];
      f_arr[k] = D.da_forecast[i];
      id_arr[k] = D.id_forecast[i];
      pda_arr[k] = D.p_da[i];
      pmfrr_arr[k] = D.p_mfrr[i];
      pimb_arr[k] = D.p_imb[i];
      rev[k] = simResult.perISP.revenue[k_p];
      short[k] = simResult.perISP.Q_short[k_p];
    }

    // ---- Build sectioned tooltip ----
    // Sections: Header / Forecast / DA market / Balancing / Imbalance / Total
    // Each section is shown only when relevant.
    function section(title, lines) {
      if (!lines.length) return "";
      return (
        `<span style="color:#7d8590;font-size:10px;letter-spacing:.04em;text-transform:uppercase">${title}</span><br>` +
        lines.join("<br>") +
        "<br>"
      );
    }
    const hover = ts.map((t, k) => {
      const stamp = t.toISOString().substring(0, 16).replace("T", " ");
      let s = `<b>${stamp} UTC</b><br>`;

      // --- Forecast ---
      const fcLines = [`DA forecast: ${fmtMW(f_arr[k])}`];
      if (level === 2) {
        const rev_diff = id_arr[k] - f_arr[k];
        const sign = rev_diff > 0 ? "+" : "";
        fcLines.push(
          `ID forecast: ${fmtMW(id_arr[k])} <span style="color:#7d8590">(${sign}${rev_diff.toFixed(1)} MW)</span>`,
        );
        fcLines.push(`Q_pot (actual): ${fmtMW(pot[k])}`);
      }
      s += section("Forecast", fcLines);

      // --- DA market ---
      const daLines = [
        `Sold: <b>${da[k].toFixed(0)} MW</b> @ ${fmtPrice(pda_arr[k])}`,
        `DA revenue: <b>${fmtEUR(da[k] * pda_arr[k] * 0.25)}</b>`,
      ];
      s += section("DA market", daLines);

      // --- Balancing (only if something fired) ---
      const upMW = up[k];
      const dnMW = -dn[k];
      const balLines = [];
      if (upMW > 0.5) {
        balLines.push(
          `<span style="color:#3fb950">▲ mFRR-up</span>: <b>${upMW.toFixed(0)} MW</b> @ ${fmtPrice(pmfrr_arr[k])}`,
        );
        balLines.push(
          `mFRR-up rev: <b>${fmtEUR(upMW * pmfrr_arr[k] * 0.25)}</b>`,
        );
      } else if (dnMW > 0.5) {
        balLines.push(
          `<span style="color:#f85149">▼ mFRR-dn</span>: <b>${dnMW.toFixed(0)} MW</b> @ ${fmtPrice(pmfrr_arr[k])}`,
        );
        balLines.push(
          `mFRR-dn rev: <b>${fmtEUR(-dnMW * pmfrr_arr[k] * 0.25)}</b>`,
        );
      } else {
        // Distinguish: market didn't clear vs. we had no offer to place
        const pmf = pmfrr_arr[k];
        if (pmf > -1 && pmf < 1) {
          balLines.push(
            `<span style="color:#7d8590">— no clearing (P_mFRR ${fmtPrice(pmf)} inside ±1 dead band)</span>`,
          );
        } else if (pmf >= 1) {
          balLines.push(
            `<span style="color:#7d8590">— mFRR-up cleared @ ${fmtPrice(pmf)} but we placed no offer</span>`,
          );
        } else {
          balLines.push(
            `<span style="color:#7d8590">— mFRR-dn cleared @ ${fmtPrice(pmf)} but we had no DA position to curtail</span>`,
          );
        }
      }
      s += section("Balancing", balLines);

      // --- Imbalance (L2 only, only if shortfall) ---
      if (level === 2 && short[k] > 0.01) {
        const imbCost = short[k] * pimb_arr[k] * 0.25;
        const flatCost = short[k] * theta * 0.25;
        const imbLines = [
          `Shortfall: <b>${fmtMW(short[k])}</b>`,
          `P_imb: ${fmtPrice(pimb_arr[k])}`,
          `Imbalance cost: <b style="color:#f85149">−${fmtEUR(imbCost)}</b>`,
        ];
        if (theta > 0) {
          imbLines.push(`Flat penalty (θ=${theta}): <b style="color:#f85149">−${fmtEUR(flatCost)}</b>`);
        }
        s += section("Imbalance", imbLines);
      }

      // --- Total ---
      const revColor = rev[k] >= 0 ? "#3fb950" : "#f85149";
      s += `<b style="color:${revColor};font-size:13px">ISP P&L: ${rev[k] >= 0 ? "+" : ""}${fmtEUR(rev[k])}</b>`;
      return s;
    });

    // ---- Visible traces (no hover - hover comes from dedicated trace) ----
    let traces;
    if (useBars) {
      traces = [
        {
          x: ts,
          y: da,
          type: "scatter",
          mode: "lines",
          name: "DA sold (MW)",
          line: { color: "#58a6ff", width: 2 },
          hoverinfo: "skip",
        },
        {
          x: ts,
          y: up,
          type: "bar",
          name: "mFRR-up (MW)",
          marker: { color: "rgba(63,185,80,0.75)" },
          hoverinfo: "skip",
        },
        {
          x: ts,
          y: dn,
          type: "bar",
          name: "mFRR-dn (MW)",
          marker: { color: "rgba(248,81,73,0.75)" },
          hoverinfo: "skip",
        },
      ];
      if (level === 2) {
        traces.push({
          x: ts,
          y: pot,
          type: "scatter",
          mode: "lines",
          name: "Q_pot (actual MW)",
          line: { color: "#f0883e", dash: "dash", width: 1.5 },
          hoverinfo: "skip",
        });
      }
    } else {
      // Multi-week scattergl mode
      traces = [
        {
          x: ts,
          y: da,
          type: "scattergl",
          mode: "lines",
          name: "DA sold (MW)",
          line: { color: "#58a6ff", width: 1.2 },
          hoverinfo: "skip",
        },
        {
          x: ts,
          y: up,
          type: "scattergl",
          mode: "lines",
          name: "mFRR-up (MW)",
          line: { color: "#3fb950", width: 1.2 },
          fill: "tozeroy",
          fillcolor: "rgba(63,185,80,0.25)",
          hoverinfo: "skip",
        },
        {
          x: ts,
          y: dn,
          type: "scattergl",
          mode: "lines",
          name: "mFRR-dn (MW)",
          line: { color: "#f85149", width: 1.2 },
          fill: "tozeroy",
          fillcolor: "rgba(248,81,73,0.25)",
          hoverinfo: "skip",
        },
      ];
      if (level === 2) {
        traces.push({
          x: ts,
          y: pot,
          type: "scattergl",
          mode: "lines",
          name: "Q_pot (actual MW)",
          line: { color: "#f0883e", dash: "dash", width: 1.0 },
          hoverinfo: "skip",
        });
      }
    }

    // Dedicated invisible HOVER trace — places markers at every ISP near
    // the top of the chart so wherever the user hovers in that ISP's
    // x-band, this single trace is what supplies the tooltip.
    let yMax = 0,
      yMin = 0;
    for (let k = 0; k < N; k++) {
      const v = Math.max(da[k], up[k], pot[k] || 0);
      if (v > yMax) yMax = v;
      if (dn[k] < yMin) yMin = dn[k];
    }
    const hoverY = new Array(N).fill(yMax * 1.05 || 1);
    traces.push({
      x: ts,
      y: hoverY,
      type: useBars ? "scatter" : "scattergl",
      mode: "markers",
      marker: { opacity: 0, size: 1 },
      showlegend: false,
      hovertemplate: "%{text}<extra></extra>",
      text: hover,
      name: "",
    });

    const dayCount = (ts[N - 1] - ts[0]) / 86400000;
    const layout = Object.assign({}, PLOTLY_LAYOUT_DEFAULTS, {
      barmode: "overlay",
      yaxis: {
        ...PLOTLY_LAYOUT_DEFAULTS.yaxis,
        title: "MW",
        zeroline: true,
        zerolinecolor: "#5a6470",
        zerolinewidth: 1,
      },
      xaxis: {
        ...PLOTLY_LAYOUT_DEFAULTS.xaxis,
        type: "date",
        title: `UTC · ${N.toLocaleString()} ISPs (${dayCount.toFixed(1)} d)${useBars ? "" : " · zoom in for bar mode"}`,
      },
      hovermode: "x",
      hoverlabel: {
        bgcolor: "#0d1117",
        bordercolor: "#3a4350",
        font: { color: "#e6edf3", size: 12, family: "system-ui, sans-serif" },
        align: "left",
      },
    });

    Plotly.react(targetId, traces, layout, PLOTLY_CONFIG);
  }

  // ------------ MONTHLY BARS --------------------------------------------
  function drawMonthly(targetId, level, monthly) {
    const months = monthly.map((m) => m.month);
    const traces = [
      {
        x: months,
        y: monthly.map((m) => m.DA),
        type: "bar",
        name: "DA",
        marker: { color: "#58a6ff" },
      },
      {
        x: months,
        y: monthly.map((m) => m.up),
        type: "bar",
        name: "mFRR-up",
        marker: { color: "#3fb950" },
      },
      {
        x: months,
        y: monthly.map((m) => m.dn),
        type: "bar",
        name: "mFRR-dn",
        marker: { color: "#f85149" },
      },
    ];
    if (level === 2) {
      traces.push({
        x: months,
        y: monthly.map((m) => -m.imb),
        type: "bar",
        name: "−imb cost",
        marker: { color: "#bc8cff" },
      });
      traces.push({
        x: months,
        y: monthly.map((m) => -m.flat),
        type: "bar",
        name: "−flat penalty",
        marker: { color: "#f0883e" },
      });
    }
    const layout = Object.assign({}, PLOTLY_LAYOUT_DEFAULTS, {
      barmode: "relative",
      yaxis: { ...PLOTLY_LAYOUT_DEFAULTS.yaxis, title: "EUR" },
      xaxis: { ...PLOTLY_LAYOUT_DEFAULTS.xaxis, title: "Month" },
    });
    Plotly.react(targetId, traces, layout, PLOTLY_CONFIG);
  }

  // ------------ HISTOGRAM -----------------------------------------------
  function drawHistogram(targetId, perISPRev) {
    const arr = Array.from(perISPRev);
    const traces = [
      {
        x: arr,
        type: "histogram",
        nbinsx: 80,
        marker: { color: "#58a6ff" },
      },
    ];
    const layout = Object.assign({}, PLOTLY_LAYOUT_DEFAULTS, {
      yaxis: { ...PLOTLY_LAYOUT_DEFAULTS.yaxis, title: "ISP count", type: "log" },
      xaxis: { ...PLOTLY_LAYOUT_DEFAULTS.xaxis, title: "Per-ISP revenue (EUR)" },
      bargap: 0.02,
    });
    Plotly.react(targetId, traces, layout, PLOTLY_CONFIG);
  }

  // ------------ HEATMAP -------------------------------------------------
  // grid: 2D array [xi][yi] of revenue values
  // xs, ys: axis tick values
  // axisLabels: { x: 'X (EUR/MWh)', y: 'Y (withhold)' }
  // markX, markY: current parameter location to highlight
  // onClick: optional callback (x, y) => void
  function drawHeatmap(targetId, grid, xs, ys, axisLabels, markX, markY, onClick) {
    // Plotly heatmap expects z[y][x] if x and y are swapped — let's transpose
    // so grid[xi][yi] becomes z[yi][xi]
    const z = [];
    for (let yi = 0; yi < ys.length; yi++) {
      const row = [];
      for (let xi = 0; xi < xs.length; xi++) row.push(grid[xi][yi]);
      z.push(row);
    }
    const traces = [
      {
        z,
        x: xs,
        y: ys,
        type: "heatmap",
        colorscale: "Viridis",
        hovertemplate:
          axisLabels.x +
          ": %{x}<br>" +
          axisLabels.y +
          ": %{y}<br>Revenue: %{z:,.0f} €<extra></extra>",
        colorbar: { title: { text: "EUR", side: "right" } },
      },
    ];
    if (markX !== null && markY !== null) {
      traces.push({
        x: [markX],
        y: [markY],
        mode: "markers",
        type: "scatter",
        marker: {
          symbol: "x",
          size: 16,
          color: "#ffd166",
          line: { color: "#000", width: 1.5 },
        },
        name: "Current",
        showlegend: false,
        hoverinfo: "skip",
      });
    }
    const layout = Object.assign({}, PLOTLY_LAYOUT_DEFAULTS, {
      xaxis: { ...PLOTLY_LAYOUT_DEFAULTS.xaxis, title: axisLabels.x },
      yaxis: { ...PLOTLY_LAYOUT_DEFAULTS.yaxis, title: axisLabels.y },
    });
    Plotly.react(targetId, traces, layout, PLOTLY_CONFIG).then(() => {
      const el = document.getElementById(targetId);
      if (onClick) {
        el.removeAllListeners && el.removeAllListeners("plotly_click");
        el.on("plotly_click", (e) => {
          if (!e.points || !e.points.length) return;
          const p = e.points[0];
          if (p.curveNumber === 0) onClick(p.x, p.y);
        });
      }
    });
  }

  return {
    drawTimeSeries,
    drawMonthly,
    drawHistogram,
    drawHeatmap,
    fmtEUR,
    fmtMW,
    fmtPrice,
  };
})();

if (typeof module !== "undefined") module.exports = Charts;
