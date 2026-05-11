// charts.js — Plotly renderers for the Backtester page.
//
// All functions are PURE drawers: they take a target element id, pre-computed
// arrays / stats and a Plotly layout. No DOM mutation outside the chart div.
//
// EXPORTS
//   drawTimeSeries(targetId, level, simResult, params, startIdx, endIdx)
//     One day → many weeks of DA-sold (line) + mFRR up/dn (bars or fills) +
//     optional Q_pot (L2). Single hover trace owns the sectioned tooltip.
//
//   drawMonthly(targetId, level, monthly)
//     Stacked bar per calendar month showing decomposition.
//
//   drawHistogram(targetId, perISPRev)
//     Per-ISP revenue distribution (log-Y, ~80 bins).
//
//   drawHeatmap(targetId, grid, xs, ys, axisLabels, markX, markY, onClick)
//     Optimisation-surface heatmap (Plotly heatmap + click handler).
//
// TOOLTIP DESIGN
// ==============
// All four visible traces have hoverinfo:'skip'. A 5th invisible scatter at
// y = chart-top owns the unified tooltip. This avoids the duplicated-tooltip
// problem that plagues Plotly's "x unified" mode when multiple traces have
// hovertemplate. The tooltip is sectioned (Forecast / DA market / Balancing /
// Imbalance / P&L) and shows each section ONLY when relevant.
//
// PERFORMANCE
// ===========
//   - useBars = N <= 600 (~6 days). Above that, switches to scattergl with
//     filled-area mFRR traces for >40k-point full-dataset views.
//   - tickformat / hoverformat are %d/%m/%Y for European date display.

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

  // Tooltip colour palette — used by drawTimeSeries's per-ISP tooltip and
  // the P&L breakdown equation. Picked to match the chart bar palette so
  // the visual cues line up: green = upward / positive revenue, red =
  // downward / cost, blue = MW (volume), yellow = €/MWh (price), orange =
  // Q_pot (physical generation), grey = operators / asides.
  const TT_COL = {
    mw: "#58a6ff",
    price: "#ffd166",
    posRev: "#3fb950",
    negRev: "#f85149",
    pot: "#f0883e",
    dim: "#7d8590",
  };
  function ttMW(v, signed) {
    const sign = signed && v > 0 ? "+" : "";
    return `<span style="color:${TT_COL.mw}">${sign}${fmtMW(v)}</span>`;
  }
  function ttPrice(v) {
    return `<span style="color:${TT_COL.price}">${fmtPrice(v)}</span>`;
  }
  function ttRev(v, signed) {
    const c = v >= 0 ? TT_COL.posRev : TT_COL.negRev;
    const sign = signed && v >= 0 ? "+" : "";
    return `<b style="color:${c}">${sign}${fmtEUR(v)}</b>`;
  }
  function ttPot(v) {
    return `<span style="color:${TT_COL.pot}">${fmtMW(v)}</span>`;
  }
  // Build the P&L equation line: "150 + 30 − 24 = +156 €".
  // terms is an array of numbers; only non-zero entries (|v| ≥ 0.5) are
  // shown. Operators are dimmed; terms are coloured by sign; total is
  // bolded.
  function ttEquation(terms, total) {
    const nonZero = terms.filter((v) => Math.abs(v) >= 0.5);
    const totalCol = total >= 0 ? TT_COL.posRev : TT_COL.negRev;
    const totalStr = `<b style="color:${totalCol};font-size:13px">${total >= 0 ? "+" : ""}${fmtEUR(total)}</b>`;
    if (nonZero.length === 0) {
      return `<span style="color:${TT_COL.dim}">0 =</span> ${totalStr}`;
    }
    const fmtTerm = (v) => {
      const c = v >= 0 ? TT_COL.posRev : TT_COL.negRev;
      const absStr = Math.round(Math.abs(v)).toLocaleString("en-US");
      return `<span style="color:${c}">${absStr}</span>`;
    };
    let html = "";
    for (let i = 0; i < nonZero.length; i++) {
      const v = nonZero[i];
      if (i === 0) {
        html =
          v >= 0
            ? fmtTerm(v)
            : `<span style="color:${TT_COL.dim}">−</span>${fmtTerm(v)}`;
      } else {
        const op = v >= 0 ? "+" : "−";
        html += ` <span style="color:${TT_COL.dim}">${op}</span> ${fmtTerm(v)}`;
      }
    }
    html += ` <span style="color:${TT_COL.dim}">=</span> ${totalStr}`;
    return html;
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
    // mFRR active MW per ISP (post |P_mfrr|≥1 gate). The perISP.Q_up /
    // Q_dn arrays carry total OFFERED volume (mFRR + aFRR) — split here
    // so the time-series bars can render mFRR-only and aFRR-only stacks
    // separately. mFRR active = total minus the aFRR offered portion at
    // the s split. We don't store mFRR active in perISP, so derive from
    // ratios: with s constant across ISPs the mFRR offered fraction is
    // round(s × total) / total; but s is single-valued so we can use
    // per-ISP Q_up_afrr_disp (dispatched) for the aFRR bar height and
    // (Q_up - Q_up_afrr_offered) ≈ mFRR offered for the mFRR bar — the
    // simpler approach is: aFRR DISPATCHED MW (already gated + scaled)
    // for the aFRR bar; mFRR ACTIVE MW = (Q_up - Q_up_afrr_offered) when
    // mFRR cleared, else 0. We have Q_*_afrr_disp directly.
    // Per-ISP arrays. Most are direct lookups; the mFRR-active and
    // aFRR-offered/dispatched arrays are derived from the engine's
    // per-ISP outputs + the s parameter, so the tooltip and the bar
    // heights both stay in sync with simulate().
    const upMfrrActive = new Array(N); // mFRR-up MW that fired this ISP
    const dnMfrrActive = new Array(N); // negative-signed for the bar
    const upAfrrOffered = new Array(N); // aFRR-up MW we ROUTED to aFRR
    const dnAfrrOffered = new Array(N);
    const upAfrrDisp = new Array(N); // dispatched (avg) MW = offered × n_pos/225
    const dnAfrrDisp = new Array(N); // negative-signed for the bar
    // S3 (Level-3 speculation) bars: oversold MW (positive y, green hatched)
    // and the defensive-bid curtailment volume (negative y, red hatched).
    // Both are 0 for L1/L2 and for L3 ISPs where S3 didn't trigger.
    const s3Intraday = new Array(N);
    const s3Curtail = new Array(N); // negative-signed
    const pot = new Array(N);
    const f_arr = new Array(N);
    const id_arr = new Array(N);
    const pda_arr = new Array(N);
    const pmfrr_arr = new Array(N);
    const pimb_arr = new Array(N);
    const apos_arr = new Array(N);
    const aneg_arr = new Array(N);
    const npos_arr = new Array(N);
    const nneg_arr = new Array(N);
    // vwap_1h captured here so the tooltip's S3 section can reference it
    // by chart-row index (the .map callback below has no `i` in scope).
    const vwap_arr = new Array(N);
    const rev = new Array(N);
    const short = new Array(N);
    const sUpParam =
      params && params.s_up != null ? Math.max(0, Math.min(1, params.s_up)) : 1;
    const sDnParam =
      params && params.s_dn != null ? Math.max(0, Math.min(1, params.s_dn)) : 1;
    for (let k = 0; k < N; k++) {
      const i = clampedStart + k; // global ISP index
      const k_p = i - winStart; // perISP-array index
      ts[k] = Engine.tsAt(i);
      da[k] = simResult.perISP.Q_da_sold[k_p];
      // Reconstruct the OFFERED split via the same round-and-remainder
      // engine.simulate uses (per direction), so the visualised offers
      // match exactly even when s_up != s_dn.
      const Q_up_offer = simResult.perISP.Q_up[k_p];
      const Q_dn_offer = simResult.perISP.Q_dn[k_p];
      const Q_up_mfrr = Math.round(sUpParam * Q_up_offer);
      const Q_dn_mfrr = Math.round(sDnParam * Q_dn_offer);
      const Q_up_afrr = Q_up_offer - Q_up_mfrr;
      const Q_dn_afrr = Q_dn_offer - Q_dn_mfrr;
      const isUp = D.p_mfrr[i] >= 1;
      const isDn = D.p_mfrr[i] <= -1;
      upMfrrActive[k] = isUp ? Q_up_mfrr : 0;
      dnMfrrActive[k] = -(isDn ? Q_dn_mfrr : 0);
      upAfrrOffered[k] = Q_up_afrr;
      dnAfrrOffered[k] = Q_dn_afrr;
      upAfrrDisp[k] = simResult.perISP.Q_up_afrr_disp
        ? simResult.perISP.Q_up_afrr_disp[k_p]
        : 0;
      dnAfrrDisp[k] = -(simResult.perISP.Q_dn_afrr_disp
        ? simResult.perISP.Q_dn_afrr_disp[k_p]
        : 0);
      s3Intraday[k] = simResult.perISP.Q_s3_intraday
        ? simResult.perISP.Q_s3_intraday[k_p]
        : 0;
      s3Curtail[k] = -(simResult.perISP.Q_s3_curtail
        ? simResult.perISP.Q_s3_curtail[k_p]
        : 0);
      pot[k] = D.q_pot[i];
      f_arr[k] = D.da_forecast[i];
      id_arr[k] = D.id_forecast[i];
      pda_arr[k] = D.p_da[i];
      pmfrr_arr[k] = D.p_mfrr[i];
      pimb_arr[k] = D.p_imb[i];
      apos_arr[k] = D.avg_p_pos ? D.avg_p_pos[i] : 0;
      aneg_arr[k] = D.avg_p_neg ? D.avg_p_neg[i] : 0;
      // Use FAVOURABLE counts so the tooltip's "% of ISP" matches the
      // dispatched MW reported alongside it (engine.js scales by
      // n_*_fav/225 too). Falls back to n_pos / n_neg when an older
      // data file lacks the favourable arrays — engine.js wires the
      // fallback in init().
      npos_arr[k] = D.afrr_n_pos_fav ? D.afrr_n_pos_fav[i] : 0;
      nneg_arr[k] = D.afrr_n_neg_fav ? D.afrr_n_neg_fav[i] : 0;
      vwap_arr[k] = D.vwap_1h ? D.vwap_1h[i] : NaN;
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
      // European-style timestamp DD/MM/YYYY HH:MM
      const dd = String(t.getUTCDate()).padStart(2, "0");
      const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
      const yyyy = t.getUTCFullYear();
      const hh = String(t.getUTCHours()).padStart(2, "0");
      const mn = String(t.getUTCMinutes()).padStart(2, "0");
      const stamp = `${dd}/${mm}/${yyyy} ${hh}:${mn}`;
      let s = `<b>${stamp} UTC</b><br>`;

      // Accumulator for the per-ISP P&L equation rendered at the bottom.
      // Only non-zero entries are shown ("DA + mFRR-up − imb = total").
      const terms = [];

      // --- Forecast ---
      const fcLines = [`DA forecast: ${ttMW(f_arr[k])}`];
      if (level >= 2) {
        const rev_diff = id_arr[k] - f_arr[k];
        const diffCol = rev_diff >= 0 ? TT_COL.posRev : TT_COL.negRev;
        const sign = rev_diff > 0 ? "+" : "";
        fcLines.push(
          `ID forecast: ${ttMW(id_arr[k])} <span style="color:${TT_COL.dim}">(<span style="color:${diffCol}">${sign}${rev_diff.toFixed(1)}</span> MW)</span>`,
        );
        fcLines.push(`Q_pot (actual): ${ttPot(pot[k])}`);
      }
      s += section("Forecast", fcLines);

      // --- DA market ---
      const daRev = da[k] * pda_arr[k] * 0.25;
      terms.push(daRev);
      const daLines = [
        `Sold: ${ttMW(da[k])} @ ${ttPrice(pda_arr[k])}`,
        `DA revenue: ${ttRev(daRev)}`,
      ];
      s += section("DA market", daLines);

      // --- mFRR (only if something fired) ---
      const upMfrrMW = upMfrrActive[k];
      const dnMfrrMW = -dnMfrrActive[k];
      const mfrrLines = [];
      const upMfrrRev = upMfrrMW * pmfrr_arr[k] * 0.25;
      const dnMfrrRev = -dnMfrrMW * pmfrr_arr[k] * 0.25;
      if (upMfrrMW > 0.5) {
        terms.push(upMfrrRev);
        mfrrLines.push(
          `<span style="color:${TT_COL.posRev}">▲ mFRR-up</span>: ${ttMW(upMfrrMW)} @ ${ttPrice(pmfrr_arr[k])}`,
        );
        mfrrLines.push(`mFRR-up rev: ${ttRev(upMfrrRev)}`);
      } else if (dnMfrrMW > 0.5) {
        terms.push(dnMfrrRev);
        mfrrLines.push(
          `<span style="color:${TT_COL.negRev}">▼ mFRR-dn</span>: ${ttMW(dnMfrrMW)} @ ${ttPrice(pmfrr_arr[k])}`,
        );
        mfrrLines.push(`mFRR-dn rev: ${ttRev(dnMfrrRev)}`);
      } else {
        const pmf = pmfrr_arr[k];
        if (pmf > -1 && pmf < 1) {
          mfrrLines.push(
            `<span style="color:${TT_COL.dim}">— no clearing (P_mFRR ${ttPrice(pmf)} inside ±1 dead band)</span>`,
          );
        } else if (pmf >= 1) {
          mfrrLines.push(
            `<span style="color:${TT_COL.dim}">— mFRR-up cleared @ ${ttPrice(pmf)} but no mFRR offer placed (s_up = ${sUpParam.toFixed(2)})</span>`,
          );
        } else {
          mfrrLines.push(
            `<span style="color:${TT_COL.dim}">— mFRR-dn cleared @ ${ttPrice(pmf)} but no mFRR offer placed</span>`,
          );
        }
      }
      s += section("mFRR market", mfrrLines);

      // --- aFRR (per-direction, gated by profitability) ---
      // Revenue uses the AVERAGED price × Q_offered × 0.25 — which equals
      // integrating the 4-second slot prices directly (NaN slots → 0).
      // Dispatched MW (n_pos/225 × Q_offered) is shown so the user can
      // see "how much of the ISP did the system actually use us for".
      const upAfrrOffer = upAfrrOffered[k];
      const dnAfrrOffer = dnAfrrOffered[k];
      const upAfrrDispMW = upAfrrDisp[k];
      const dnAfrrDispMW = -dnAfrrDisp[k];
      const upAfrrRev = apos_arr[k] > 0 ? upAfrrOffer * apos_arr[k] * 0.25 : 0;
      const dnAfrrRev = aneg_arr[k] < 0 ? -dnAfrrOffer * aneg_arr[k] * 0.25 : 0;
      if (upAfrrOffer > 0 || dnAfrrOffer > 0) {
        const afrrLines = [];
        if (upAfrrOffer > 0) {
          if (apos_arr[k] > 0) {
            terms.push(upAfrrRev);
            afrrLines.push(
              `<span style="color:#56d364">△ aFRR-up</span>: ${ttMW(upAfrrOffer)} offered, dispatched ${ttMW(upAfrrDispMW)} (${((npos_arr[k] / 225) * 100).toFixed(0)} % of ISP) @ avg ${ttPrice(apos_arr[k])}`,
            );
            afrrLines.push(`aFRR-up rev: ${ttRev(upAfrrRev)}`);
          } else {
            afrrLines.push(
              `<span style="color:${TT_COL.dim}">— aFRR-up: ${ttMW(upAfrrOffer)} available but avg_p_pos = ${ttPrice(apos_arr[k])} ≤ 0 (not bid)</span>`,
            );
          }
        }
        if (dnAfrrOffer > 0) {
          if (aneg_arr[k] < 0) {
            terms.push(dnAfrrRev);
            afrrLines.push(
              `<span style="color:#fa7970">▽ aFRR-dn</span>: ${ttMW(dnAfrrOffer)} offered, dispatched ${ttMW(dnAfrrDispMW)} (${((nneg_arr[k] / 225) * 100).toFixed(0)} % of ISP) @ avg ${ttPrice(aneg_arr[k])}`,
            );
            afrrLines.push(`aFRR-dn rev: ${ttRev(dnAfrrRev)}`);
          } else {
            afrrLines.push(
              `<span style="color:${TT_COL.dim}">— aFRR-dn: ${ttMW(dnAfrrOffer)} available but avg_p_neg = ${ttPrice(aneg_arr[k])} ≥ 0 (not bid)</span>`,
            );
          }
        }
        s += section("aFRR market", afrrLines);
      }

      // --- S3 (Level-3 speculation), only if oversold this ISP ---
      const s3X = s3Intraday[k];
      if (s3X > 0.5) {
        const vwap = vwap_arr[k];
        const s3Lines = [];
        const idRev = vwap * s3X * 0.25;
        terms.push(idRev);
        s3Lines.push(
          `<span style="color:${TT_COL.posRev}">▲ ID oversell</span>: ${ttMW(s3X)} @ VWAP1H ${ttPrice(vwap)}`,
        );
        s3Lines.push(`Intraday rev: ${ttRev(idRev)}`);
        const curtX = -s3Curtail[k];
        if (curtX > 0.5) {
          const pmfrr = pmfrr_arr[k];
          const curtRev = curtX * (-pmfrr) * 0.25;
          terms.push(curtRev);
          // Defensive bid is a stop-loss: clears whenever p_mfrr ≤ bid_price.
          // p_mfrr < 0 → grid pays the wind farm (windfall).
          // p_mfrr > 0 → wind farm pays (capped at bid_price · X).
          const label = pmfrr < 0
            ? `▼ Defensive FIRED (windfall — grid paid us ${ttPrice(-pmfrr)})`
            : `▼ Defensive FIRED (stop-loss — we paid ${ttPrice(pmfrr)})`;
          s3Lines.push(
            `<span style="color:${TT_COL.negRev}">${label}</span>: ${ttMW(curtX)} curtailed @ p_mfrr ${ttPrice(pmfrr)}`,
          );
          s3Lines.push(`Curtailment rev: ${ttRev(curtRev)}`);
        } else {
          s3Lines.push(
            `<span style="color:${TT_COL.dim}">— Defensive bid not fired (settling at p_imb)</span>`,
          );
        }
        s += section("S3 oversell", s3Lines);
      }

      // --- Imbalance (L2 only, only if shortfall) ---
      if (level >= 2 && short[k] > 0.01) {
        const imbCost = short[k] * pimb_arr[k] * 0.25;
        const flatCost = short[k] * theta * 0.25;
        // Imbalance and flat penalty enter the equation as NEGATIVE terms.
        terms.push(-imbCost);
        if (theta > 0) terms.push(-flatCost);
        const imbLines = [
          `Shortfall: ${ttMW(short[k])}`,
          `P_imb: ${ttPrice(pimb_arr[k])}`,
          `Imbalance cost: ${ttRev(-imbCost)}`,
        ];
        if (theta > 0) {
          imbLines.push(`Flat penalty (θ=${theta}): ${ttRev(-flatCost)}`);
        }
        s += section("Imbalance", imbLines);
      }

      // --- Total — full P&L equation breakdown ---
      // Each non-zero component appears, coloured by sign, joined with
      // dim operators. Example: "150 + 30 − 24 = +156 €".
      s += `<span style="color:${TT_COL.dim};font-size:10px;letter-spacing:.04em;text-transform:uppercase">ISP P&amp;L</span><br>${ttEquation(terms, rev[k])}`;
      return s;
    });

    // ---- Visible traces (no hover - hover comes from dedicated trace) ----
    // Four bars/areas now: mFRR-up + aFRR-up (positive y) and mFRR-dn +
    // aFRR-dn (negative y). Stacked via barmode:'relative' so the user
    // can see the mFRR vs aFRR composition at a glance. aFRR bars use
    // the DISPATCHED MW (offered × n_*/225) so 30-%-active ISPs show a
    // 30 %-tall bar — making "when aFRR fired and when not" visible.
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
          y: upMfrrActive,
          type: "bar",
          name: "mFRR-up (MW)",
          marker: { color: "rgba(63,185,80,0.85)" },
          hoverinfo: "skip",
        },
        {
          x: ts,
          y: upAfrrDisp,
          type: "bar",
          name: "aFRR-up dispatched (MW avg)",
          marker: { color: "rgba(86,211,100,0.55)" },
          hoverinfo: "skip",
        },
        // S3 intraday oversell — same green family, diagonal hatching to
        // visually separate from mFRR/aFRR contributions.
        {
          x: ts,
          y: s3Intraday,
          type: "bar",
          name: "S3 ID oversell (MW)",
          marker: {
            color: "rgba(63,185,80,0.85)",
            pattern: { shape: "/", size: 6, solidity: 0.45 },
          },
          hoverinfo: "skip",
        },
        {
          x: ts,
          y: dnMfrrActive,
          type: "bar",
          name: "mFRR-dn (MW)",
          marker: { color: "rgba(248,81,73,0.85)" },
          hoverinfo: "skip",
        },
        {
          x: ts,
          y: dnAfrrDisp,
          type: "bar",
          name: "aFRR-dn dispatched (MW avg)",
          marker: { color: "rgba(250,121,112,0.55)" },
          hoverinfo: "skip",
        },
        // S3 defensive curtailment — same red family, diagonal hatching.
        {
          x: ts,
          y: s3Curtail,
          type: "bar",
          name: "S3 defensive curtail (MW)",
          marker: {
            color: "rgba(248,81,73,0.85)",
            pattern: { shape: "/", size: 6, solidity: 0.45 },
          },
          hoverinfo: "skip",
        },
      ];
      if (level >= 2) {
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
      // Multi-week scattergl mode. mFRR + aFRR overlap rather than stack
      // (filled areas) — the legend distinguishes them by color.
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
          y: upMfrrActive,
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
          y: upAfrrDisp,
          type: "scattergl",
          mode: "lines",
          name: "aFRR-up dispatched (MW)",
          line: { color: "#56d364", width: 1.0, dash: "dot" },
          fill: "tozeroy",
          fillcolor: "rgba(86,211,100,0.18)",
          hoverinfo: "skip",
        },
        // S3 intraday oversell — scattergl can't render diagonal hatching,
        // so we use a distinct longdashdot pattern instead. Same green family.
        {
          x: ts,
          y: s3Intraday,
          type: "scattergl",
          mode: "lines",
          name: "S3 ID oversell (MW)",
          line: { color: "#3fb950", width: 1.2, dash: "longdashdot" },
          fill: "tozeroy",
          fillcolor: "rgba(63,185,80,0.30)",
          hoverinfo: "skip",
        },
        {
          x: ts,
          y: dnMfrrActive,
          type: "scattergl",
          mode: "lines",
          name: "mFRR-dn (MW)",
          line: { color: "#f85149", width: 1.2 },
          fill: "tozeroy",
          fillcolor: "rgba(248,81,73,0.25)",
          hoverinfo: "skip",
        },
        {
          x: ts,
          y: dnAfrrDisp,
          type: "scattergl",
          mode: "lines",
          name: "aFRR-dn dispatched (MW)",
          line: { color: "#fa7970", width: 1.0, dash: "dot" },
          fill: "tozeroy",
          fillcolor: "rgba(250,121,112,0.18)",
          hoverinfo: "skip",
        },
        // S3 defensive curtailment — distinct longdashdot pattern.
        {
          x: ts,
          y: s3Curtail,
          type: "scattergl",
          mode: "lines",
          name: "S3 defensive curtail (MW)",
          line: { color: "#f85149", width: 1.2, dash: "longdashdot" },
          fill: "tozeroy",
          fillcolor: "rgba(248,81,73,0.30)",
          hoverinfo: "skip",
        },
      ];
      if (level >= 2) {
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
      // For bar mode the chart stacks mFRR + aFRR + s3 (relative barmode),
      // so the visible top is da + upMfrr + upAfrr + s3Intraday.
      const v = Math.max(
        da[k],
        upMfrrActive[k] + upAfrrDisp[k] + s3Intraday[k],
        pot[k] || 0,
      );
      if (v > yMax) yMax = v;
      const lower = dnMfrrActive[k] + dnAfrrDisp[k] + s3Curtail[k]; // all negative
      if (lower < yMin) yMin = lower;
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
      // Relative barmode stacks bars with the same sign (mFRR-up + aFRR-up
      // form one positive stack; mFRR-dn + aFRR-dn form one negative
      // stack). The DA line and Q_pot line stay overlaid on top.
      barmode: "relative",
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
        // European date format on tick labels and on the unified hover guideline
        tickformat: "%d/%m/%Y",
        hoverformat: "%d/%m/%Y %H:%M",
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
  // Five stacks per month (six if you count L2 cost stacks): DA, mFRR-up,
  // mFRR-dn, aFRR-up, aFRR-dn. Each market and direction is its own
  // colour so the user can see month-to-month which markets actually
  // contribute, and which would be zeroed by the s split.
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
        y: monthly.map((m) => m.up_mfrr),
        type: "bar",
        name: "mFRR-up",
        marker: { color: "#3fb950" },
      },
      {
        x: months,
        y: monthly.map((m) => m.up_afrr),
        type: "bar",
        name: "aFRR-up",
        marker: { color: "#56d364" },
      },
      {
        x: months,
        y: monthly.map((m) => m.dn_mfrr),
        type: "bar",
        name: "mFRR-dn",
        marker: { color: "#f85149" },
      },
      {
        x: months,
        y: monthly.map((m) => m.dn_afrr),
        type: "bar",
        name: "aFRR-dn",
        marker: { color: "#fa7970" },
      },
    ];
    if (level >= 2) {
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
    if (level === 3) {
      // S3 contributions — same green/red colour family as mFRR but with
      // diagonal-hatch pattern to set them apart visually.
      traces.push({
        x: months,
        y: monthly.map((m) => m.s3_intraday || 0),
        type: "bar",
        name: "S3 ID sale",
        marker: {
          color: "#3fb950",
          pattern: { shape: "/", size: 6, solidity: 0.45 },
        },
      });
      traces.push({
        x: months,
        y: monthly.map((m) => m.s3_curtail || 0),
        type: "bar",
        name: "S3 curtail",
        marker: {
          color: "#f85149",
          pattern: { shape: "/", size: 6, solidity: 0.45 },
        },
      });
      traces.push({
        x: months,
        y: monthly.map((m) => -(m.s3_extra_cost || 0)),
        type: "bar",
        name: "−S3 extra imb",
        marker: {
          color: "#bc8cff",
          pattern: { shape: "/", size: 6, solidity: 0.45 },
        },
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
