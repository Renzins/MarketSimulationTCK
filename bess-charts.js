// bess-charts.js — Plotly renderers for the BESS backtester page.
//
// All functions are PURE drawers: target element id + pre-computed simResult.
//
// EXPORTS
//   drawDaForecast(id, sim, params, startIdx, endIdx)
//     lag-24h DA forecast vs actual price + discharge/charge ISP markers.
//   drawTimeSeries(id, sim, params, startIdx, endIdx)
//     SoC (the only LINE, right axis) + DA-sold blue bar + mFRR/aFRR
//     discharge stacks (positive) / charge stacks (negative). Sectioned
//     per-ISP P&L tooltip carried over from the wind-park page.
//   drawBids(id, sim, startIdx, endIdx)
//     balancing bid lifecycle (price × time), product-coloured, status by
//     symbol (cleared / rested / repriced ★ — reactive ask re-pricing; a
//     rested offer is plotted at its ASK, a cleared one at the clearing price).
//   drawOps(id, sim)            — cycling & duration bars.
//   drawSocStats(id, sim, params) — SoC safety bars (time pinned in the
//     lower/upper red zones, dynamic wrt the configured zone percentages).
//   drawMonthly(id, monthly)    — decomposition stacks.
//   drawHistogram(id, perISPRev)— per-ISP revenue distribution.

const BessCharts = (() => {
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
  const COL = {
    da: "#58a6ff",
    upM: "rgba(63,185,80,0.9)",
    upA: "rgba(86,211,100,0.6)",
    dnM: "rgba(248,81,73,0.9)",
    dnA: "rgba(250,121,112,0.6)",
    chg: "rgba(188,140,255,0.7)",
    soc: "#f0883e",
    fc: "#bc8cff",
    dim: "#7d8590",
    mw: "#58a6ff",
    price: "#ffd166",
    pos: "#3fb950",
    neg: "#f85149",
  };
  const fmtEUR = (v) => v.toLocaleString("en-US", { maximumFractionDigits: 0 }) + " €";
  const fmtMW = (v) => v.toLocaleString("en-US", { maximumFractionDigits: 1 }) + " MW";
  const fmtMWh = (v) => v.toLocaleString("en-US", { maximumFractionDigits: 1 }) + " MWh";
  const fmtPrice = (v) => (isNaN(v) ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: 2 }) + " €/MWh");

  function _redZones(params) {
    const cap = +params.cap_mwh || 40;
    return {
      cap,
      lo: ((+params.lower_red_pct || 20) / 100) * cap,
      hi: ((+params.upper_red_pct || 80) / 100) * cap,
    };
  }

  // span helpers shared by every window-scoped chart
  function _clamp(sim, startIdx, endIdx) {
    const s = Math.max(startIdx, sim.windowStart);
    const e = Math.min(endIdx, sim.windowEnd);
    return { s, e, N: Math.max(0, e - s) };
  }

  // ----------------------------------------------------------------------
  //  1. DA forecast vs actual + discharge/charge markers
  // ----------------------------------------------------------------------
  function drawDaForecast(targetId, sim, params, startIdx, endIdx) {
    const D = Engine.getData();
    const fcArr = BessEngine.daForecastArray();
    const { s, e, N } = _clamp(sim, startIdx, endIdx);
    if (N <= 0) {
      Plotly.purge(targetId);
      return;
    }
    const ws = sim.windowStart;
    const ts = new Array(N),
      fc = new Array(N),
      act = new Array(N);
    const disX = [],
      disY = [],
      chgX = [],
      chgY = [];
    for (let j = 0; j < N; j++) {
      const i = s + j,
        k = i - ws;
      const t = Engine.tsAt(i);
      ts[j] = t;
      fc[j] = isNaN(fcArr[i]) ? null : fcArr[i];
      act[j] = D.p_da[i];
      if (sim.daSell[k] > 0.01) {
        disX.push(t);
        disY.push(D.p_da[i]);
      } else if (sim.dir[k] === -1) {
        chgX.push(t);
        chgY.push(D.p_da[i]);
      }
    }
    const traces = [
      { x: ts, y: fc, type: "scatter", mode: "lines", name: "DA forecast (lag-24h)", line: { color: COL.fc, dash: "dash", width: 1.5 } },
      { x: ts, y: act, type: "scatter", mode: "lines", name: "DA actual", line: { color: COL.da, width: 2 } },
      { x: disX, y: disY, type: "scatter", mode: "markers", name: "DA discharge sold", marker: { color: COL.pos, symbol: "triangle-up", size: 9, line: { color: "#0d1117", width: 0.5 } } },
      { x: chgX, y: chgY, type: "scatter", mode: "markers", name: "charging", marker: { color: COL.da, symbol: "triangle-down", size: 7, opacity: 0.5 } },
    ];
    const layout = Object.assign({}, LAYOUT, {
      yaxis: { ...LAYOUT.yaxis, title: "DA price (€/MWh)" },
      xaxis: { ...LAYOUT.xaxis, type: "date", tickformat: "%d/%m/%Y", title: `UTC · ${N.toLocaleString()} ISPs` },
    });
    Plotly.react(targetId, traces, layout, CONFIG);
  }

  // ----------------------------------------------------------------------
  //  2. SoC time series — SoC line (right axis) + DA/balancing bars
  // ----------------------------------------------------------------------
  function drawTimeSeries(targetId, sim, params, startIdx, endIdx) {
    const D = Engine.getData();
    const { s, e, N } = _clamp(sim, startIdx, endIdx);
    if (N <= 0) {
      Plotly.purge(targetId);
      return;
    }
    const ws = sim.windowStart;
    const { cap, lo, hi } = _redZones(params);
    const useBars = N <= 600;
    const dayFilter = (params && params.dayTypeFilter) || "all";
    const filtering = dayFilter !== "all";
    const keepFn = (mv) => (dayFilter === "workday" ? mv === 0 : mv !== 0);

    const ts = new Array(N),
      da = new Array(N),
      upM = new Array(N),
      upA = new Array(N),
      dnM = new Array(N),
      dnA = new Array(N),
      chg = new Array(N),
      soc = new Array(N),
      hover = new Array(N);

    function section(title, lines) {
      if (!lines.length) return "";
      return `<span style="color:${COL.dim};font-size:10px;letter-spacing:.04em;text-transform:uppercase">${title}</span><br>` + lines.join("<br>") + "<br>";
    }
    const rev_ = (v) => `<b style="color:${v >= 0 ? COL.pos : COL.neg}">${v >= 0 ? "+" : ""}${fmtEUR(v)}</b>`;
    const ttp = (v) => `<span style="color:${COL.price}">${fmtPrice(v)}</span>`;
    const eq = (terms, total) => {
      const nz = terms.filter((v) => Math.abs(v) >= 0.5);
      const tc = total >= 0 ? COL.pos : COL.neg;
      const tot = `<b style="color:${tc};font-size:13px">${total >= 0 ? "+" : ""}${fmtEUR(total)}</b>`;
      if (!nz.length) return `<span style="color:${COL.dim}">0 =</span> ${tot}`;
      let html = "";
      nz.forEach((v, i) => {
        const c = v >= 0 ? COL.pos : COL.neg;
        const a = Math.round(Math.abs(v)).toLocaleString("en-US");
        if (i === 0) html = v >= 0 ? `<span style="color:${c}">${a}</span>` : `<span style="color:${COL.dim}">−</span><span style="color:${c}">${a}</span>`;
        else html += ` <span style="color:${COL.dim}">${v >= 0 ? "+" : "−"}</span> <span style="color:${c}">${a}</span>`;
      });
      return html + ` <span style="color:${COL.dim}">=</span> ${tot}`;
    };

    for (let j = 0; j < N; j++) {
      const i = s + j,
        k = i - ws;
      const t = Engine.tsAt(i);
      ts[j] = t;
      const kept = !filtering || keepFn(sim.dayType[k]);
      const dav = sim.daSell[k],
        uM = sim.upM[k],
        uA = sim.upA[k],
        uAoff = sim.upAoff ? sim.upAoff[k] : 0,
        dM = sim.dnM[k],
        dA = sim.dnA[k],
        dAoff = sim.dnAoff ? sim.dnAoff[k] : 0,
        co = sim.chgOther[k];
      da[j] = kept ? dav : null;
      upM[j] = kept ? uM : null;
      upA[j] = kept ? uA : null;
      dnM[j] = kept ? -dM : null;
      dnA[j] = kept ? -dA : null;
      chg[j] = kept ? -co : null;
      soc[j] = kept ? sim.soc[k] : null;
      if (!kept) {
        hover[j] = null;
        continue;
      }
      // tooltip
      const dd = String(t.getUTCDate()).padStart(2, "0");
      const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
      const hh = String(t.getUTCHours()).padStart(2, "0");
      const mn = String(t.getUTCMinutes()).padStart(2, "0");
      let s_ = `<b>${dd}/${mm}/${t.getUTCFullYear()} ${hh}:${mn} UTC</b><br>`;
      const socPct = ((sim.soc[k] / cap) * 100).toFixed(0);
      s_ += section("Battery", [
        `SoC: <span style="color:${COL.soc}">${fmtMWh(sim.soc[k])}</span> (${socPct}%)`,
        `Break-even sell: ${fmtPrice(sim.effCost[k])}`,
      ]);
      // --- Market prices (ALWAYS shown, even on idle ISPs) ---
      const Pmf = D.p_mfrr[i],
        Pda = D.p_da[i],
        Vw = D.vwap_1h ? D.vwap_1h[i] : NaN,
        Apos = D.avg_p_pos ? D.avg_p_pos[i] : 0,
        Aneg = D.avg_p_neg ? D.avg_p_neg[i] : 0;
      const posPct = D.afrr_n_pos_fav ? (D.afrr_n_pos_fav[i] / 225) * 100 : 0;
      const negPct = D.afrr_n_neg_fav ? (D.afrr_n_neg_fav[i] / 225) * 100 : 0;
      const mfNote = Pmf >= 1 ? "up clears" : Pmf <= -1 ? "dn clears" : "dead band ±1";
      s_ += section("Market prices", [
        `Day-ahead: ${ttp(Pda)}`,
        `Intraday VWAP: ${ttp(Vw)}`,
        `mFRR: ${ttp(Pmf)} <span style="color:${COL.dim}">(${mfNote})</span>`,
        `aFRR ▲ avg: ${ttp(Apos)} <span style="color:${COL.dim}">(active ${posPct.toFixed(0)}% of ISP)</span>`,
        `aFRR ▼ avg: ${ttp(Aneg)} <span style="color:${COL.dim}">(active ${negPct.toFixed(0)}% of ISP)</span>`,
      ]);
      const terms = [];
      const daLines = [];
      if (dav > 0.01) {
        daLines.push(`Sold: ${fmtMW(dav)} @ ${ttp(Pda)}`);
        daLines.push(`DA revenue: ${rev_(sim.revDA[k])}`);
        terms.push(sim.revDA[k]);
        s_ += section("DA market", daLines);
      } else if (sim.revDA[k] !== 0) {
        terms.push(sim.revDA[k]);
      }
      // --- Balancing discharge (aFRR: offered → dispatched at the favourable
      // fraction of the ISP, exactly like the wind park) ---
      const balUp = [];
      if (uM > 0.01) balUp.push(`<span style="color:${COL.pos}">▲ mFRR-up</span>: ${fmtMW(uM)} @ ${ttp(Pmf)}`);
      if (uAoff > 0.01) {
        if (uA > 0.001)
          balUp.push(`<span style="color:#56d364">△ aFRR-up</span>: ${fmtMW(uAoff)} offered → dispatched ${fmtMW(uA)} (${posPct.toFixed(0)}% of ISP) @ avg ${ttp(Apos)}`);
        else if (Apos > 0)
          balUp.push(`<span style="color:${COL.dim}">△ aFRR-up: ${fmtMW(uAoff)} offered — rested (avg ${ttp(Apos)} below the ask)</span>`);
        else
          balUp.push(`<span style="color:${COL.dim}">△ aFRR-up: ${fmtMW(uAoff)} offered but avg ${ttp(Apos)} ≤ 0 — not dispatched</span>`);
      }
      if (balUp.length) {
        balUp.push(`Discharge rev: ${rev_(sim.revUp[k])}`);
        terms.push(sim.revUp[k]);
        s_ += section("Balancing discharge", balUp);
      }
      // --- Charge (aFRR-dn likewise: offered → partial dispatch) ---
      const balDn = [];
      if (dM > 0.01) balDn.push(`<span style="color:${COL.neg}">▼ mFRR-dn</span>: ${fmtMW(dM)} @ ${ttp(Pmf)}`);
      if (dAoff > 0.01)
        balDn.push(`<span style="color:#fa7970">▽ aFRR-dn</span>: ${fmtMW(dAoff)} offered → dispatched ${fmtMW(dA)} (${negPct.toFixed(0)}% of ISP) @ avg ${ttp(Aneg)}`);
      if (co > 0.01) {
        const daB = sim.daBuy && sim.daBuy[k];
        balDn.push(daB
          ? `<span style="color:${COL.chg}">⤓ DA buy-low (committed D−1)</span>: ${fmtMW(co)} @ ${ttp(Pda)}`
          : `<span style="color:${COL.chg}">⤓ intraday</span>: ${fmtMW(co)} @ ${ttp(Vw)}`);
      }
      if (balDn.length) {
        const chgRev = sim.revDn[k] + sim.revChg[k];
        balDn.push(`Charge cashflow: ${rev_(chgRev)}`);
        terms.push(sim.revDn[k]);
        terms.push(sim.revChg[k]);
        s_ += section("Charge", balDn);
      } else if (sim.revDn[k] !== 0 || sim.revChg[k] !== 0) {
        // committed DA buy with zero absorbable volume: cash leg exists
        // (financial settlement) even though no charge volume is shown
        terms.push(sim.revDn[k]);
        terms.push(sim.revChg[k]);
      }
      if (Math.abs(sim.revID[k]) > 0.5) {
        const df = sim.divFlag ? sim.divFlag[k] : 0;
        s_ += section("Opportunistic", [
          df === 2
            ? `Divert MISS: DA bought back on intraday, but mFRR never reached the ask — energy retained: ${rev_(sim.revID[k])}`
            : `Diverted DA → mFRR-up, covered on intraday: ${rev_(sim.revID[k])}`,
        ]);
        terms.push(sim.revID[k]);
      }
      if (sim.short[k] > 0.01) {
        s_ += section("Imbalance (unmet DA)", [
          `Shortfall: ${fmtMWh(sim.short[k])}`,
          `Cost: ${rev_(-(sim.costImb[k] + sim.costFlat[k]))}`,
        ]);
        terms.push(-sim.costImb[k]);
        terms.push(-sim.costFlat[k]);
      }
      s_ += `<span style="color:${COL.dim};font-size:10px;letter-spacing:.04em;text-transform:uppercase">ISP P&amp;L</span><br>${eq(terms, sim.rev[k])}`;
      hover[j] = s_;
    }

    const gl = (t) => (useBars ? t : "scattergl");
    const traces = [];
    if (useBars) {
      traces.push(
        { x: ts, y: da, type: "bar", name: "DA sold (MW)", marker: { color: COL.da }, hoverinfo: "skip" },
        { x: ts, y: upM, type: "bar", name: "mFRR-up (MW)", marker: { color: COL.upM }, hoverinfo: "skip" },
        { x: ts, y: upA, type: "bar", name: "aFRR-up disp (MW)", marker: { color: COL.upA }, hoverinfo: "skip" },
        { x: ts, y: dnM, type: "bar", name: "mFRR-dn charge (MW)", marker: { color: COL.dnM }, hoverinfo: "skip" },
        { x: ts, y: dnA, type: "bar", name: "aFRR-dn charge (MW)", marker: { color: COL.dnA }, hoverinfo: "skip" },
        { x: ts, y: chg, type: "bar", name: "intraday/DA charge (MW)", marker: { color: COL.chg }, hoverinfo: "skip" },
      );
    } else {
      // multi-week: filled-area scattergl (overlap, not stacked)
      const area = (y, name, color, fill) => ({ x: ts, y, type: "scattergl", mode: "lines", name, line: { color, width: 1 }, fill: "tozeroy", fillcolor: fill, hoverinfo: "skip" });
      traces.push(
        area(da, "DA sold (MW)", COL.da, "rgba(88,166,255,0.25)"),
        area(upM, "mFRR-up (MW)", "#3fb950", "rgba(63,185,80,0.22)"),
        area(upA, "aFRR-up disp (MW)", "#56d364", "rgba(86,211,100,0.16)"),
        area(dnM, "mFRR-dn charge (MW)", "#f85149", "rgba(248,81,73,0.22)"),
        area(dnA, "aFRR-dn charge (MW)", "#fa7970", "rgba(250,121,112,0.16)"),
        area(chg, "intraday/DA charge (MW)", "#bc8cff", "rgba(188,140,255,0.18)"),
      );
    }
    // SoC line on the secondary (right) axis — the ONLY line per the spec.
    traces.push({ x: ts, y: soc, type: gl("scatter"), mode: "lines", name: "State of charge (MWh)", line: { color: COL.soc, width: 2 }, yaxis: "y2", hoverinfo: "skip" });

    // invisible hover trace (single source of the unified tooltip)
    let yMax = 1,
      yMin = 0;
    for (let j = 0; j < N; j++) {
      const up = (da[j] || 0) + (upM[j] || 0) + (upA[j] || 0);
      if (up > yMax) yMax = up;
      const dn = (dnM[j] || 0) + (dnA[j] || 0) + (chg[j] || 0);
      if (dn < yMin) yMin = dn;
    }
    const hoverY = new Array(N).fill(yMax * 1.05);
    if (filtering) for (let j = 0; j < N; j++) if (hover[j] == null) hoverY[j] = null;
    traces.push({ x: ts, y: hoverY, type: gl("scatter"), mode: "markers", marker: { opacity: 0, size: 1 }, showlegend: false, hovertemplate: "%{text}<extra></extra>", text: hover, name: "" });

    const layout = Object.assign({}, LAYOUT, {
      barmode: "relative",
      margin: { t: 28, r: 64, b: 50, l: 60 },
      yaxis: { ...LAYOUT.yaxis, title: "MW (charge − / discharge +)", zeroline: true, zerolinecolor: "#5a6470", zerolinewidth: 1 },
      yaxis2: {
        title: "SoC (MWh)",
        overlaying: "y",
        side: "right",
        range: [0, cap],
        gridcolor: "rgba(0,0,0,0)",
        zeroline: false,
        color: COL.soc,
      },
      xaxis: { ...LAYOUT.xaxis, type: "date", tickformat: "%d/%m/%Y", hoverformat: " ", title: `UTC · ${N.toLocaleString()} ISPs${useBars ? "" : " · zoom in for bar mode"}` },
      hovermode: useBars ? "x unified" : "x",
      hoverdistance: -1,
      hoverlabel: { bgcolor: "#0d1117", bordercolor: "#3a4350", font: { color: "#e6edf3", size: 12 }, align: "left" },
      // red-zone band on the SoC axis
      shapes: [
        { type: "rect", xref: "paper", x0: 0, x1: 1, yref: "y2", y0: hi, y1: cap, fillcolor: "rgba(248,81,73,0.07)", line: { width: 0 }, layer: "below" },
        { type: "rect", xref: "paper", x0: 0, x1: 1, yref: "y2", y0: 0, y1: lo, fillcolor: "rgba(248,81,73,0.07)", line: { width: 0 }, layer: "below" },
      ],
    });
    Plotly.react(targetId, traces, layout, CONFIG);
  }

  // ----------------------------------------------------------------------
  //  3. Balancing bid lifecycle
  // ----------------------------------------------------------------------
  function drawBids(targetId, sim, startIdx, endIdx) {
    const { s, e, N } = _clamp(sim, startIdx, endIdx);
    if (N <= 0) {
      Plotly.purge(targetId);
      return;
    }
    // group bids by (status, product, dir)
    const groups = {
      mUpC: { x: [], y: [], sz: [], name: "mFRR ↑ cleared", color: "#3fb950", symbol: "circle" },
      aUpC: { x: [], y: [], sz: [], name: "aFRR ↑ cleared", color: "#56d364", symbol: "diamond" },
      mDnC: { x: [], y: [], sz: [], name: "mFRR ↓ cleared", color: "#f85149", symbol: "circle" },
      aDnC: { x: [], y: [], sz: [], name: "aFRR ↓ cleared", color: "#fa7970", symbol: "diamond" },
      rest: { x: [], y: [], sz: [], name: "rested @ ask (no clear)", color: "#7d8590", symbol: "circle-open" },
      repC: { x: [], y: [], sz: [], name: "cleared @ raised ask", color: "#e3b341", symbol: "star" },
      repR: { x: [], y: [], sz: [], name: "repriced, rested (ask not reached)", color: "#e3b341", symbol: "star-open" },
    };
    const sizeOf = (mw) => Math.max(5, Math.min(22, 5 + mw));
    for (const bid of sim.bids) {
      if (bid.i < s || bid.i >= e) continue;
      const t = Engine.tsAt(bid.i);
      let g;
      if (bid.status === "repriced") g = groups.repR;
      else if (bid.status === "resting") g = groups.rest;
      else if (bid.rep) g = groups.repC;
      else if (bid.dir === 1) g = bid.prod === "mfrr" ? groups.mUpC : groups.aUpC;
      else g = bid.prod === "mfrr" ? groups.mDnC : groups.aDnC;
      g.x.push(t);
      g.y.push(bid.price);
      g.sz.push(sizeOf(bid.mw));
    }
    const traces = Object.values(groups)
      .filter((g) => g.x.length)
      .map((g) => ({
        x: g.x,
        y: g.y,
        type: "scattergl",
        mode: "markers",
        name: g.name,
        marker: { color: g.color, symbol: g.symbol, size: g.sz, line: { color: "#0d1117", width: 0.5 } },
        hovertemplate: `${g.name}<br>%{x|%d/%m %H:%M}<br>%{y:.1f} €/MWh<extra></extra>`,
      }));
    if (!traces.length) {
      Plotly.react(targetId, [{ x: [], y: [], type: "scattergl", mode: "markers" }], Object.assign({}, LAYOUT, { annotations: [{ text: "No balancing bids in this window", showarrow: false, font: { color: COL.dim } }] }), CONFIG);
      return;
    }
    const layout = Object.assign({}, LAYOUT, {
      yaxis: { ...LAYOUT.yaxis, title: "Bid / clearing price (€/MWh)" },
      xaxis: { ...LAYOUT.xaxis, type: "date", tickformat: "%d/%m %H:%M", title: "UTC · marker size ∝ MW" },
    });
    Plotly.react(targetId, traces, layout, CONFIG);
  }

  // ----------------------------------------------------------------------
  //  4. Operations summary (durations in hours)
  // ----------------------------------------------------------------------
  function drawOps(targetId, sim) {
    const st = sim.stats;
    const h = (isps) => isps * 0.25; // ISPs → hours
    const cats = ["Avg discharge block", "Avg charge block", "Avg idle gap"];
    const vals = [h(st.avgDisRun), h(st.avgChgRun), h(st.avgIdleGap)];
    const traces = [{ x: vals, y: cats, type: "bar", orientation: "h", marker: { color: ["#3fb950", "#f85149", "#7d8590"] }, hovertemplate: "%{x:.2f} h<extra></extra>" }];
    const layout = Object.assign({}, LAYOUT, {
      margin: { t: 20, r: 18, b: 40, l: 130 },
      yaxis: { ...LAYOUT.yaxis, automargin: true },
      xaxis: { ...LAYOUT.xaxis, title: "hours" },
    });
    Plotly.react(targetId, traces, layout, CONFIG);
  }

  // ----------------------------------------------------------------------
  //  5. SoC safety bars
  // ----------------------------------------------------------------------
  function drawSocStats(targetId, sim, params) {
    const c = sim.counts;
    const loPct = params && isFinite(+params.lower_red_pct) ? +params.lower_red_pct : 20;
    const hiPct = params && isFinite(+params.upper_red_pct) ? +params.upper_red_pct : 80;
    const cats = [`In lower red zone (≤${loPct}%)`, `In upper red zone (≥${hiPct}%)`, "DA short (→ imbalance)", "Balancing UNFULFILLED"];
    const vals = [c.lowRed, c.upRed, c.short, c.unfulfilled];
    const colors = ["#e3b341", "#e3b341", "#bc8cff", c.unfulfilled > 0 ? "#f85149" : "#3fb950"];
    const traces = [{ x: vals, y: cats, type: "bar", orientation: "h", marker: { color: colors }, hovertemplate: "%{x:,} ISPs<extra></extra>" }];
    const layout = Object.assign({}, LAYOUT, {
      margin: { t: 20, r: 18, b: 40, l: 160 },
      yaxis: { ...LAYOUT.yaxis, automargin: true },
      xaxis: { ...LAYOUT.xaxis, title: "ISP count" },
    });
    Plotly.react(targetId, traces, layout, CONFIG);
  }

  // ----------------------------------------------------------------------
  //  6. Monthly decomposition
  // ----------------------------------------------------------------------
  function drawMonthly(targetId, monthly) {
    const m = monthly.map((x) => x.month);
    const traces = [
      { x: m, y: monthly.map((x) => x.DA), type: "bar", name: "DA", marker: { color: "#58a6ff" } },
      { x: m, y: monthly.map((x) => x.up), type: "bar", name: "Balancing discharge", marker: { color: "#3fb950" } },
      { x: m, y: monthly.map((x) => x.dn), type: "bar", name: "Charge cashflow", marker: { color: "#f85149" } },
      { x: m, y: monthly.map((x) => x.charge), type: "bar", name: "Intraday/DA charge", marker: { color: "#bc8cff" } },
      { x: m, y: monthly.map((x) => x.intraday), type: "bar", name: "Opportunistic close", marker: { color: "#e3b341" } },
      { x: m, y: monthly.map((x) => -x.imb), type: "bar", name: "−imbalance", marker: { color: "#8957e5" } },
      { x: m, y: monthly.map((x) => -x.flat), type: "bar", name: "−flat penalty", marker: { color: "#f0883e" } },
    ];
    const layout = Object.assign({}, LAYOUT, {
      barmode: "relative",
      margin: { t: 28, r: 170, b: 50, l: 60 },
      yaxis: { ...LAYOUT.yaxis, title: "EUR", automargin: true },
      xaxis: { ...LAYOUT.xaxis, title: "Month", automargin: true },
      legend: { bgcolor: "rgba(0,0,0,0)", orientation: "v", x: 1.02, xanchor: "left", y: 1, yanchor: "top" },
    });
    Plotly.react(targetId, traces, layout, CONFIG);
  }

  // NB: the parameter-sensitivity renderers (weights / OAT curves / pair
  // heatmap) live in the SHARED optim-sens.js (OptimSens) — used by both
  // this page and the wind-park page.

  // ----------------------------------------------------------------------
  //  7. Per-ISP revenue histogram
  // ----------------------------------------------------------------------
  function drawHistogram(targetId, perISPRev) {
    const traces = [{ x: Array.from(perISPRev), type: "histogram", nbinsx: 80, marker: { color: "#58a6ff" } }];
    const layout = Object.assign({}, LAYOUT, {
      yaxis: { ...LAYOUT.yaxis, title: "ISP count", type: "log" },
      xaxis: { ...LAYOUT.xaxis, title: "Per-ISP revenue (EUR)" },
      bargap: 0.02,
    });
    Plotly.react(targetId, traces, layout, CONFIG);
  }

  return { drawDaForecast, drawTimeSeries, drawBids, drawOps, drawSocStats, drawMonthly, drawHistogram, fmtEUR, fmtMW };
})();

if (typeof module !== "undefined") module.exports = BessCharts;
