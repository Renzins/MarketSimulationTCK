// graphs-app.js — UI controller for the Graphs page (graphs.html).
//
// ARCHITECTURE
// ============
// Loads the same WIND_DATA + Engine bootstrap as the Backtester so the
// simulation window state is shared (changing sim window on either page
// affects both — but each page reads/writes Engine.setWindow() in its own
// updateAll path). Charts are computed by GraphsEngine and rendered by
// GraphsCharts.
//
// The page is structured into:
//   - Setup group:   sim date range, winsorize spread (10/90), surplus/deficit thresholds (±30)
//   - Bucket counts: wind / solar / DA price bands / matched-panel levels
//   - 7 charts:
//       1-2: 1-D box plot, spread by wind, SURPLUS / DEFICIT
//       3-4: 1-D box plot, spread by solar, SURPLUS / DEFICIT
//       5-6: 2-D heatmap, spread by Wind × Solar, DEFICIT / SURPLUS
//       7-9: matched-by-DA-band panels: Wind / Solar / Renewables (wind+solar)
//   - aFRR placeholder card (no data yet)
//
// Quantile bin boundaries are recomputed on every `updateAll()` from the
// values within the current Engine window.
//
// IMPORTANT INVARIANTS
// ====================
//   - Surplus/deficit thresholds (±30 default) define a dead band:
//     ISPs with baltic_imb_vol strictly between thresholds are excluded
//     from BOTH regimes. Setting both to 0 reproduces sign-only behaviour.
//   - Date inputs are text DD/MM/YYYY, same as the Backtester.

(() => {
  // ---------- bootstrap --------------------------------------------------
  const D = Engine.init(WIND_DATA);
  GraphsEngine.init();

  const startTs = Engine.tsAt(0);
  const endTs = Engine.tsAt(D.n - 1);
  const fmtDateOnly = (d) => d.toISOString().substring(0, 10);
  const fmtDateEU = (d) => {
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = d.getUTCFullYear();
    return `${dd}/${mm}/${yyyy}`;
  };
  function parseEU(str) {
    if (!str) return null;
    const m = str.trim().match(/^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{4})$/);
    if (!m) return null;
    return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  function isoToEU(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  }
  document.getElementById("data-range").textContent =
    `${fmtDateEU(startTs)} → ${fmtDateEU(endTs)} (${D.n.toLocaleString()} ISPs)`;
  const dataMinDate = fmtDateOnly(startTs);
  const dataMaxDate = fmtDateOnly(endTs);

  // ---------- state ------------------------------------------------------
  const state = {
    sim: { from: dataMinDate, to: dataMaxDate },
    winsorMfrrLo: 10,
    winsorMfrrHi: 90,
    deficitThr: -30, // baltic_imb_vol ≤ this → deficit
    surplusThr: 30, // baltic_imb_vol ≥ this → surplus
    // Day-type filter: "all" | "weekend-holiday" | "workday".
    // "all" preserves the pre-feature behaviour (no filter); the other
    // two read Engine.getData().dayTypeMask, computed once at init from
    // ISO timestamps + the date-holidays plugin.
    dayType: "all",
    buckets: {
      wind: 4,
      solar: 4,
      daBand: 5,
      // Number of level rows in EVERY matched-by-DA chart (wind / solar /
      // renewables share the same level count for visual consistency).
      matchedLevels: 3,
    },
  };

  // ---------- generate setup cards ---------------------------------------
  function setupCardHTML() {
    return `
      <div class="control sim-range">
        <label>Simulation date range<span class="unit">DD/MM/YYYY</span></label>
        <div class="slider-row two">
          <input type="text" inputmode="numeric" placeholder="DD/MM/YYYY"
                 pattern="\\d{2}/\\d{2}/\\d{4}" maxlength="10"
                 id="g-sim-from" value="${isoToEU(state.sim.from)}">
          <span>→</span>
          <input type="text" inputmode="numeric" placeholder="DD/MM/YYYY"
                 pattern="\\d{2}/\\d{2}/\\d{4}" maxlength="10"
                 id="g-sim-to" value="${isoToEU(state.sim.to)}">
          <button type="button" class="btn small" id="g-sim-reset" title="Reset to full dataset">↻</button>
        </div>
        <div class="param-desc">
          <p>Restricts every box-plot and heatmap to ISPs in this window. Quantile bin boundaries are also derived within it.</p>
          <ul class="extremes">
            <li><b>Full dataset:</b> all 14+ months of data.</li>
            <li><b>Sub-period:</b> stress-test specific periods (e.g. summer only, single quarter).</li>
          </ul>
        </div>
      </div>

      <div class="control winsor">
        <label>Winsorize spread (percentiles)</label>
        <div class="slider-row two">
          <input type="number" id="g-winsor-lo" value="${state.winsorMfrrLo}" min="0" max="50" step="1">
          <span>/</span>
          <input type="number" id="g-winsor-hi" value="${state.winsorMfrrHi}" min="50" max="100" step="1">
        </div>
        <div class="param-desc">
          <p>Caps the spread (P<sub>mFRR</sub> − P<sub>DA</sub>) at the chosen percentiles within the window. Tames the −10 000 / +10 000 EUR/MWh outliers in the 2025–2026 data.</p>
          <ul class="extremes">
            <li><b>0 / 100:</b> raw outliers retained.</li>
            <li><b>10 / 90:</b> default — typical robustness for box plots.</li>
          </ul>
        </div>
      </div>

      <div class="control">
        <label>Surplus / deficit thresholds<span class="unit">MW</span></label>
        <div class="slider-row two">
          <input type="number" id="g-deficit-thr" value="${state.deficitThr}" step="1" style="width: 80px">
          <span>/</span>
          <input type="number" id="g-surplus-thr" value="${state.surplusThr}" step="1" style="width: 80px">
        </div>
        <div class="param-desc">
          <p>Classifies each ISP by the sum of LV+EE+LT imbalance volumes. ISPs with sum ≤ deficit threshold go into the DEFICIT graphs; sum ≥ surplus threshold into the SURPLUS graphs. Values strictly between (the dead band) are excluded.</p>
          <ul class="extremes">
            <li><b>−30 / +30 (default):</b> ignores small noise around zero.</li>
            <li><b>0 / 0:</b> every non-zero ISP counts, no neutral band.</li>
            <li><b>−100 / +100:</b> only large imbalances qualify; smaller datasets per regime.</li>
          </ul>
        </div>
      </div>

      <div class="control">
        <label>Day type filter</label>
        <div class="day-type-toggle g-day-type-toggle">
          <button type="button" class="btn small preset${state.dayType === "all" ? " active" : ""}" data-day-type="all">All days</button>
          <button type="button" class="btn small preset${state.dayType === "weekend-holiday" ? " active" : ""}" data-day-type="weekend-holiday">Weekends + holidays</button>
          <button type="button" class="btn small preset${state.dayType === "workday" ? " active" : ""}" data-day-type="workday">Workdays only</button>
        </div>
        <div class="param-desc">
          <p>Restricts every chart to ISPs of the chosen day type. Public-holiday detection runs through the <code>date-holidays</code> plugin for Latvia, Estonia and Lithuania — a date counts as a holiday if <em>any</em> of the three considers it a public holiday. Quantile bin boundaries and winsorisation percentiles are recomputed from the filtered subset.</p>
          <ul class="extremes">
            <li><b>All days (default):</b> no day-type filter.</li>
            <li><b>Weekends + holidays:</b> Sat/Sun and public holidays only.</li>
            <li><b>Workdays only:</b> Mon–Fri minus public holidays.</li>
          </ul>
        </div>
      </div>
    `;
  }

  function bucketCardHTML() {
    const def = (key, label, def_, max_, desc, ex) => `
      <div class="control">
        <label for="g-buck-${key}">${label}<span class="unit">bins</span></label>
        <div class="slider-row">
          <input type="range" id="g-buck-${key}" min="2" max="${max_}" step="1" value="${state.buckets[key]}">
          <input type="number" id="g-buck-${key}-num" value="${state.buckets[key]}" min="2" max="${max_}" step="1">
        </div>
        <div class="param-desc">
          <p>${desc}</p>
          <ul class="extremes">
            ${ex.map(([v, m]) => `<li><b>${v}:</b> ${m}</li>`).join("")}
          </ul>
        </div>
      </div>`;
    return [
      def(
        "wind",
        "Wind buckets",
        4,
        12,
        "Quantile bins for the Baltic wind forecast (used by the wind 1-D plots and the wind axis of the heatmap).",
        [
          ["2", "coarse — surplus vs deficit only"],
          ["8", "fine-grained, may have small per-bucket sample sizes"],
        ],
      ),
      def(
        "solar",
        "Solar buckets",
        4,
        12,
        "Quantile bins for the Baltic solar forecast (used by the solar 1-D plots and the solar axis of the heatmap).",
        [
          ["2", "coarse — daylight vs night roughly"],
          ["8", "fine — splits high-irradiance hours into multiple bands"],
        ],
      ),
      def(
        "daBand",
        "DA price bands",
        5,
        10,
        "Number of panels in the matched-by-DA chart. Each panel covers one quantile of DA price.",
        [
          ["3", "wide bands"],
          ["8", "fine bands — narrow panels, fewer ISPs each"],
        ],
      ),
      def(
        "matchedLevels",
        "Levels (matched panels)",
        3,
        6,
        "Number of level rows in each matched-by-DA chart. Applied to all three (wind / solar / renewables) for visual consistency. Within each DA-price panel, the level axis is split into this many global quantile bins.",
        [
          ["2", "Low / High only"],
          ["3", "Low / Mid / High (default)"],
          ["5", "Very-low / Low / Mid / High / Very-high"],
        ],
      ),
    ].join("");
  }

  function renderCards() {
    document.getElementById("g-setup-params").innerHTML = setupCardHTML();
    document.getElementById("g-bucket-params").innerHTML = bucketCardHTML();
  }

  // ---------- date helpers shared with backtester ------------------------
  function clampDate(s, lo, hi) {
    if (s < lo) return lo;
    if (s > hi) return hi;
    return s;
  }
  function idxAtOrAfter(dateStr) {
    const t = new Date(dateStr + "T00:00:00Z").getTime();
    const startMs = new Date(D.start_iso).getTime();
    const targetOffset = (t - startMs) / (D.step_min * 60000);
    let lo = 0,
      hi = D.n - 1,
      ans = D.n;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (D.offsets[mid] >= targetOffset) {
        ans = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return ans;
  }
  function rangeToIdx(fromStr, toStr) {
    const start = idxAtOrAfter(fromStr);
    const next = new Date(toStr + "T00:00:00Z");
    next.setUTCDate(next.getUTCDate() + 1);
    const end = idxAtOrAfter(next.toISOString().substring(0, 10));
    return { start, end };
  }

  // ---------- main update path -------------------------------------------
  let updateTimer = null;
  function scheduleUpdate() {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(updateAll, 60);
  }

  function updateAll() {
    const progEl = document.getElementById("g-progress");
    progEl.textContent = "computing…";
    setTimeout(() => {
      const t0 = performance.now();
      const { start, end } = rangeToIdx(state.sim.from, state.sim.to);
      Engine.setWindow(start, end);
      GraphsEngine.setRegimeThresholds(state.deficitThr, state.surplusThr);
      GraphsEngine.setDayTypeFilter(state.dayType);
      // setDayTypeFilter must run BEFORE maybeWinsorizeSpread — the winsor
      // cache key includes the filter, so toggling between day types
      // forces a fresh percentile derivation against the filtered subset.
      GraphsEngine.maybeWinsorizeSpread(state.winsorMfrrLo, state.winsorMfrrHi);

      const wB = state.buckets.wind;
      const sB = state.buckets.solar;
      const daB = state.buckets.daBand;
      const mL = state.buckets.matchedLevels;

      // Graphs 1 & 2: spread by wind, surplus & deficit
      const wSurp = GraphsEngine.spreadByAxisRegime("wind", "surplus", wB);
      const wDef = GraphsEngine.spreadByAxisRegime("wind", "deficit", wB);
      GraphsCharts.drawSpreadByBucket(
        "g-wind-surplus",
        wSurp,
        "SURPLUS",
        "Baltic Day-Ahead Wind Forecast",
        `SURPLUS — mFRR spread by Wind power (n=${wSurp.totalN.toLocaleString()})`,
      );
      GraphsCharts.drawSpreadByBucket(
        "g-wind-deficit",
        wDef,
        "DEFICIT",
        "Baltic Day-Ahead Wind Forecast",
        `DEFICIT — mFRR spread by Wind power (n=${wDef.totalN.toLocaleString()})`,
      );

      // Graphs 3 & 4: spread by solar
      const sSurp = GraphsEngine.spreadByAxisRegime("solar", "surplus", sB);
      const sDef = GraphsEngine.spreadByAxisRegime("solar", "deficit", sB);
      GraphsCharts.drawSpreadByBucket(
        "g-solar-surplus",
        sSurp,
        "SURPLUS",
        "Baltic Day-Ahead Solar Forecast",
        `SURPLUS — mFRR spread by Solar power (n=${sSurp.totalN.toLocaleString()})`,
      );
      GraphsCharts.drawSpreadByBucket(
        "g-solar-deficit",
        sDef,
        "DEFICIT",
        "Baltic Day-Ahead Solar Forecast",
        `DEFICIT — mFRR spread by Solar power (n=${sDef.totalN.toLocaleString()})`,
      );

      // Graphs 5 & 6: heatmap
      const hDef = GraphsEngine.spreadByWindSolarRegime("deficit", wB, sB);
      const hSurp = GraphsEngine.spreadByWindSolarRegime("surplus", wB, sB);
      GraphsCharts.drawWindSolarHeatmap(
        "g-heatmap-deficit",
        hDef,
        "DEFICIT",
        `DEFICIT — Spread by Wind × Solar (${wB}×${sB} bins)`,
      );
      GraphsCharts.drawWindSolarHeatmap(
        "g-heatmap-surplus",
        hSurp,
        "SURPLUS",
        `SURPLUS — Spread by Wind × Solar (${wB}×${sB} bins)`,
      );

      // Graphs 7-9: matched-by-DA (wind / solar / renewables)
      const matchedWind = GraphsEngine.absSpreadByWindMatchedByDABand(daB, mL);
      GraphsCharts.drawAbsSpreadMatchedPanels(
        "g-matched",
        matchedWind,
        `|Spread| by Wind Level — Matched by DA Price Band (${daB} panels × ${mL} levels)`,
      );
      const matchedSolar = GraphsEngine.absSpreadBySolarMatchedByDABand(daB, mL);
      GraphsCharts.drawAbsSpreadMatchedPanels(
        "g-matched-solar",
        matchedSolar,
        `|Spread| by Solar Level — Matched by DA Price Band (${daB} panels × ${mL} levels)`,
      );
      const matchedRenew = GraphsEngine.absSpreadByRenewablesMatchedByDABand(daB, mL);
      GraphsCharts.drawAbsSpreadMatchedPanels(
        "g-matched-renew",
        matchedRenew,
        `|Spread| by Renewables Level (Wind+Solar) — Matched by DA Price Band (${daB} panels × ${mL} levels)`,
      );

      const ms = Math.round(performance.now() - t0);
      progEl.textContent = `done in ${ms} ms`;
    }, 30);
  }

  // ---------- bind controls ----------------------------------------------
  function bindControls() {
    // Sim range — text inputs in DD/MM/YYYY
    const fromEl = document.getElementById("g-sim-from");
    const toEl = document.getElementById("g-sim-to");
    const onSim = () => {
      let f = clampDate(parseEU(fromEl.value) || dataMinDate, dataMinDate, dataMaxDate);
      let t = clampDate(parseEU(toEl.value) || dataMaxDate, dataMinDate, dataMaxDate);
      if (f > t) [f, t] = [t, f];
      fromEl.value = isoToEU(f);
      toEl.value = isoToEU(t);
      state.sim = { from: f, to: t };
      scheduleUpdate();
    };
    fromEl.addEventListener("change", onSim);
    toEl.addEventListener("change", onSim);
    document.getElementById("g-sim-reset").addEventListener("click", () => {
      fromEl.value = isoToEU(dataMinDate);
      toEl.value = isoToEU(dataMaxDate);
      onSim();
    });
    // Winsor
    const winLo = document.getElementById("g-winsor-lo");
    const winHi = document.getElementById("g-winsor-hi");
    const onWin = () => {
      state.winsorMfrrLo = Math.max(0, Math.min(50, parseFloat(winLo.value) || 0));
      state.winsorMfrrHi = Math.max(50, Math.min(100, parseFloat(winHi.value) || 100));
      winLo.value = state.winsorMfrrLo;
      winHi.value = state.winsorMfrrHi;
      scheduleUpdate();
    };
    winLo.addEventListener("change", onWin);
    winHi.addEventListener("change", onWin);
    // Regime thresholds
    const defThr = document.getElementById("g-deficit-thr");
    const surThr = document.getElementById("g-surplus-thr");
    const onThr = () => {
      let d = parseFloat(defThr.value);
      let s = parseFloat(surThr.value);
      if (isNaN(d)) d = 0;
      if (isNaN(s)) s = 0;
      if (d > s) [d, s] = [s, d];
      defThr.value = d;
      surThr.value = s;
      state.deficitThr = d;
      state.surplusThr = s;
      scheduleUpdate();
    };
    defThr.addEventListener("change", onThr);
    surThr.addEventListener("change", onThr);
    // Buckets
    for (const key of ["wind", "solar", "daBand", "matchedLevels"]) {
      const slider = document.getElementById(`g-buck-${key}`);
      const num = document.getElementById(`g-buck-${key}-num`);
      const onSet = (raw) => {
        let v = parseInt(raw, 10);
        if (isNaN(v)) return;
        v = Math.max(2, Math.min(parseInt(slider.max, 10), v));
        slider.value = v;
        num.value = v;
        state.buckets[key] = v;
        scheduleUpdate();
      };
      slider.addEventListener("input", (e) => onSet(e.target.value));
      num.addEventListener("change", (e) => onSet(e.target.value));
    }
    // Day-type toggle (mFRR section). Same interaction shape as the
    // existing direction-toggle — click to set, with one button .active.
    document
      .querySelectorAll(".g-day-type-toggle .preset[data-day-type]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const newType = btn.dataset.dayType;
          if (state.dayType === newType) return;
          state.dayType = newType;
          document
            .querySelectorAll(".g-day-type-toggle .preset[data-day-type]")
            .forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          scheduleUpdate();
        });
      });
    // Recompute (also clears cache)
    document.getElementById("g-recompute").addEventListener("click", updateAll);
  }

  // =====================================================================
  //  aFRR SUB-TAB
  //  Independent state from the mFRR sub-tab. Each tab has its own date
  //  range (because aFRR data only starts on 2025-05-01) and its own LV
  //  vs Baltic regime thresholds.
  // =====================================================================
  AfrrEngine.init();
  const afrrRange = AfrrEngine.getAfrrRange();
  const afrrMinDate = afrrRange ? afrrRange.from.substring(0, 10) : dataMinDate;
  const afrrMaxDate = afrrRange ? afrrRange.to.substring(0, 10) : dataMaxDate;

  const afrrState = {
    // Default the aFRR sim window to the aFRR data range (clamped)
    sim: {
      from: afrrMinDate > dataMinDate ? afrrMinDate : dataMinDate,
      to: afrrMaxDate < dataMaxDate ? afrrMaxDate : dataMaxDate,
    },
    // Winsorization is unused so far (no price-related charts yet) but kept
    // here so the same shape applies if/when we add 4-second price plots.
    winsorAfrrLo: 10,
    winsorAfrrHi: 90,
    // LV imbalance is ~1/3 magnitude of Baltic (LV alone, not summed).
    // Defaults reflect that.
    lvDeficit: -10,
    lvSurplus: +10,
    balticDeficit: -30,
    balticSurplus: +30,
    // "Rest of Baltic" = EE + LT (≈ 2/3 of full Baltic, so default ±20).
    // Used by the divergence chart only.
    restDeficit: -20,
    restSurplus: +20,
    // Bucket counts for aFRR price/spread charts (mirror mFRR section).
    buckets: {
      wind: 4,
      solar: 4,
      daBand: 5,
      matchedLevels: 3,
    },
    // Day-type filter: independent from the mFRR section's so the user can
    // e.g. analyse aFRR on workdays only while leaving the mFRR view
    // unfiltered. Same 3 states / same semantics as state.dayType.
    dayType: "all",
    // Lazy-load state for the 86 MB per-slot price file
    pricesLoaded: false,
    pricesLoading: false,
    // Direction filter for signed-spread charts: 'all' | 'pos' | 'neg'.
    // Matched-by-DA |spread| charts ignore this — they're always merged.
    direction: "all",
  };

  function afrrSetupHTML() {
    return `
      <div class="control sim-range">
        <label>Simulation date range<span class="unit">DD/MM/YYYY</span></label>
        <div class="slider-row two">
          <input type="text" inputmode="numeric" placeholder="DD/MM/YYYY"
                 pattern="\\d{2}/\\d{2}/\\d{4}" maxlength="10"
                 id="g-afrr-sim-from" value="${isoToEU(afrrState.sim.from)}">
          <span>→</span>
          <input type="text" inputmode="numeric" placeholder="DD/MM/YYYY"
                 pattern="\\d{2}/\\d{2}/\\d{4}" maxlength="10"
                 id="g-afrr-sim-to" value="${isoToEU(afrrState.sim.to)}">
          <button type="button" class="btn small" id="g-afrr-sim-reset" title="Reset to full aFRR range">↻</button>
        </div>
        <div class="param-desc">
          <p>Restricts every aFRR chart to ISPs in this window. The aFRR data
             starts on ${isoToEU(afrrMinDate)} and ends on ${isoToEU(afrrMaxDate)}, so the
             range is clamped accordingly.</p>
          <ul class="extremes">
            <li><b>Full aFRR range:</b> all 12 months of aFRR data.</li>
            <li><b>Sub-period:</b> stress-test specific seasons.</li>
          </ul>
        </div>
      </div>

      <div class="control winsor">
        <label>Winsorize aFRR price (percentiles)</label>
        <div class="slider-row two">
          <input type="number" id="g-afrr-winsor-lo" value="${afrrState.winsorAfrrLo}" min="0" max="50" step="1">
          <span>/</span>
          <input type="number" id="g-afrr-winsor-hi" value="${afrrState.winsorAfrrHi}" min="50" max="100" step="1">
        </div>
        <div class="param-desc">
          <p>Percentile clipping for AST_POS / AST_NEG prices. Currently
             unused — the activation bar charts only need null-vs-non-null
             status — but kept consistent with the mFRR setup so that
             upcoming 4-second price plots have a parameter ready.</p>
          <ul class="extremes">
            <li><b>0 / 100:</b> no winsorization.</li>
            <li><b>10 / 90:</b> default for box plots.</li>
          </ul>
        </div>
      </div>

      <div class="control">
        <label>LV imbalance thresholds<span class="unit">MW</span></label>
        <div class="slider-row two">
          <input type="number" id="g-afrr-lv-def-thr" value="${afrrState.lvDeficit}" step="1" style="width: 80px">
          <span>/</span>
          <input type="number" id="g-afrr-lv-sur-thr" value="${afrrState.lvSurplus}" step="1" style="width: 80px">
        </div>
        <div class="param-desc">
          <p>Classifies each ISP using <b>LV-only</b> imbalance volume
             (imbalance_volume_lv). LV alone is ≈ 1/3 the magnitude of Baltic, so
             defaults are tighter (±10 MW vs Baltic ±30).</p>
          <ul class="extremes">
            <li><b>−10 / +10 (default):</b> typical Latvia dead band.</li>
            <li><b>−5 / +5:</b> tighter — more ISPs qualify.</li>
            <li><b>−25 / +25:</b> only large LV imbalances qualify.</li>
          </ul>
        </div>
      </div>

      <div class="control">
        <label>Baltic imbalance thresholds<span class="unit">MW</span></label>
        <div class="slider-row two">
          <input type="number" id="g-afrr-bal-def-thr" value="${afrrState.balticDeficit}" step="1" style="width: 80px">
          <span>/</span>
          <input type="number" id="g-afrr-bal-sur-thr" value="${afrrState.balticSurplus}" step="1" style="width: 80px">
        </div>
        <div class="param-desc">
          <p>Classifies each ISP using <b>full Baltic</b> imbalance volume
             (LV + EE + LT). Same defaults as the mFRR section's regime
             thresholds (±30 MW).</p>
          <ul class="extremes">
            <li><b>−30 / +30 (default):</b> ignores small noise.</li>
            <li><b>0 / 0:</b> sign-only — every non-zero ISP counts.</li>
            <li><b>−100 / +100:</b> only large Baltic imbalances qualify.</li>
          </ul>
        </div>
      </div>

      <div class="control">
        <label>Rest-of-Baltic thresholds (EE+LT)<span class="unit">MW</span></label>
        <div class="slider-row two">
          <input type="number" id="g-afrr-rest-def-thr" value="${afrrState.restDeficit}" step="1" style="width: 80px">
          <span>/</span>
          <input type="number" id="g-afrr-rest-sur-thr" value="${afrrState.restSurplus}" step="1" style="width: 80px">
        </div>
        <div class="param-desc">
          <p>Used <em>only</em> by the divergence chart at the bottom.
             "Rest of Baltic" is computed as
             <code>baltic_imb_vol − lv_imb_vol</code> = EE + LT. EE+LT alone is
             ≈ 2/3 the magnitude of full Baltic, so the default (±20 MW) is
             tighter than the full-Baltic ±30.</p>
          <ul class="extremes">
            <li><b>−20 / +20 (default):</b> reasonable dead band for EE+LT.</li>
            <li><b>0 / 0:</b> sign-only.</li>
            <li><b>−50 / +50:</b> only large EE+LT imbalances qualify.</li>
          </ul>
        </div>
      </div>

      <div class="control">
        <label>Day type filter</label>
        <div class="day-type-toggle g-afrr-day-type-toggle">
          <button type="button" class="btn small preset${afrrState.dayType === "all" ? " active" : ""}" data-day-type="all">All days</button>
          <button type="button" class="btn small preset${afrrState.dayType === "weekend-holiday" ? " active" : ""}" data-day-type="weekend-holiday">Weekends + holidays</button>
          <button type="button" class="btn small preset${afrrState.dayType === "workday" ? " active" : ""}" data-day-type="workday">Workdays only</button>
        </div>
        <div class="param-desc">
          <p>Restricts every aFRR chart (activation bars, divergence, price/spread plots) to ISPs of the chosen day type. Public-holiday detection runs through the <code>date-holidays</code> plugin for Latvia, Estonia and Lithuania — a date counts as a holiday if <em>any</em> of the three considers it a public holiday. Independent from the mFRR section's filter.</p>
          <ul class="extremes">
            <li><b>All days (default):</b> no day-type filter.</li>
            <li><b>Weekends + holidays:</b> Sat/Sun and public holidays only.</li>
            <li><b>Workdays only:</b> Mon–Fri minus public holidays.</li>
          </ul>
        </div>
      </div>

      <!-- Bucket counts for aFRR PRICE / SPREAD charts -->
      <div class="control">
        <label for="g-afrr-buck-wind">Wind buckets<span class="unit">bins</span></label>
        <div class="slider-row">
          <input type="range" id="g-afrr-buck-wind" min="2" max="12" step="1" value="${afrrState.buckets.wind}">
          <input type="number" id="g-afrr-buck-wind-num" value="${afrrState.buckets.wind}" min="2" max="12" step="1">
        </div>
        <div class="param-desc">
          <p>Quantile bins for the Baltic wind forecast in the aFRR price plots
             (1-D wind boxes and the wind axis of the heatmap).</p>
        </div>
      </div>
      <div class="control">
        <label for="g-afrr-buck-solar">Solar buckets<span class="unit">bins</span></label>
        <div class="slider-row">
          <input type="range" id="g-afrr-buck-solar" min="2" max="12" step="1" value="${afrrState.buckets.solar}">
          <input type="number" id="g-afrr-buck-solar-num" value="${afrrState.buckets.solar}" min="2" max="12" step="1">
        </div>
        <div class="param-desc">
          <p>Quantile bins for the Baltic solar forecast in the aFRR price plots.</p>
        </div>
      </div>
      <div class="control">
        <label for="g-afrr-buck-daBand">DA price bands<span class="unit">bins</span></label>
        <div class="slider-row">
          <input type="range" id="g-afrr-buck-daBand" min="2" max="10" step="1" value="${afrrState.buckets.daBand}">
          <input type="number" id="g-afrr-buck-daBand-num" value="${afrrState.buckets.daBand}" min="2" max="10" step="1">
        </div>
        <div class="param-desc">
          <p>Number of DA-price panels in the matched-by-DA aFRR charts.</p>
        </div>
      </div>
      <div class="control">
        <label for="g-afrr-buck-matchedLevels">Levels (matched panels)<span class="unit">bins</span></label>
        <div class="slider-row">
          <input type="range" id="g-afrr-buck-matchedLevels" min="2" max="6" step="1" value="${afrrState.buckets.matchedLevels}">
          <input type="number" id="g-afrr-buck-matchedLevels-num" value="${afrrState.buckets.matchedLevels}" min="2" max="6" step="1">
        </div>
        <div class="param-desc">
          <p>Number of level rows inside each DA panel of the matched aFRR charts.</p>
        </div>
      </div>
    `;
  }

  function clampAfrrDate(s) {
    return clampDate(s, afrrMinDate, afrrMaxDate);
  }

  let afrrUpdateTimer = null;
  function scheduleAfrrUpdate() {
    clearTimeout(afrrUpdateTimer);
    afrrUpdateTimer = setTimeout(updateAfrr, 60);
  }

  function updateAfrr() {
    const progEl = document.getElementById("g-afrr-progress");
    progEl.textContent = "computing…";
    setTimeout(() => {
      const t0 = performance.now();
      // Set engine window to the aFRR sim range
      const { start, end } = rangeToIdx(afrrState.sim.from, afrrState.sim.to);
      Engine.setWindow(start, end);
      AfrrEngine.setLvThresholds(afrrState.lvDeficit, afrrState.lvSurplus);
      AfrrEngine.setBalticThresholds(afrrState.balticDeficit, afrrState.balticSurplus);
      AfrrEngine.setRestOfBalticThresholds(afrrState.restDeficit, afrrState.restSurplus);
      AfrrEngine.setDayTypeFilter(afrrState.dayType);

      const lvResult = AfrrEngine.activationRateByRegime("lv");
      const balticResult = AfrrEngine.activationRateByRegime("baltic");
      const divResult = AfrrEngine.activationRateByDivergence();

      AfrrCharts.drawActivationBars(
        "g-afrr-bars-lv",
        lvResult,
        "aFRR activation rate by Latvia imbalance regime",
      );
      AfrrCharts.drawActivationBars(
        "g-afrr-bars-baltic",
        balticResult,
        "aFRR activation rate by Baltic imbalance regime",
      );
      // Divergence chart reuses the same drawer with custom x-labels and
      // a custom subtitle so the user can read both threshold pairs.
      const divSubtitle =
        `LV thresholds: ${afrrState.lvDeficit} / +${afrrState.lvSurplus} MW · ` +
        `EE+LT thresholds: ${afrrState.restDeficit} / +${afrrState.restSurplus} MW`;
      AfrrCharts.drawActivationBars(
        "g-afrr-bars-divergence",
        divResult,
        "aFRR activation rate when LV and rest-of-Baltic disagree",
        ["LV+ / rest−", "LV− / rest+"],
        divSubtitle,
      );
      const ms = Math.round(performance.now() - t0);
      progEl.textContent = `done in ${ms} ms`;
      // If the price file is already loaded, re-render the price charts
      // (their inputs depend on the same window/threshold state).
      if (afrrState.pricesLoaded) updateAfrrPriceCharts();
    }, 30);
  }

  // ---------------------------------------------------------------
  // Lazy loader for the chunked price file.
  //
  // The 86 MB price data is split across N chunk files (currently 3,
  // each ~30 MB) so that no single file exceeds GitHub's 50 MB warning
  // threshold. Loading order:
  //
  //   1. Inject data-afrr-prices-meta.js → defines AFRR_PRICES_META
  //      (n_entries, n_pos_entries, n_chunks) and resets
  //      window.AFRR_PRICES_CHUNKS = [].
  //   2. Inject all chunk files in parallel. Each one assigns its piece
  //      to AFRR_PRICES_CHUNKS[c] (preserving global order).
  //   3. After every chunk has fired its onload, concatenate the chunks
  //      into a single Int32Array per column and expose as
  //      window.AFRR_PRICES — same shape AfrrSpreadEngine expects.
  //   4. Free the chunk references so the GC can release them.
  //
  // Total transfer is the same 86 MB but split into smaller files, which
  // also lets the browser fetch them in parallel (faster on multi-conn
  // hosts) and survive a single chunk's transient failure with a retry.
  // ---------------------------------------------------------------
  function loadAfrrPriceData() {
    if (afrrState.pricesLoaded) {
      updateAfrrPriceCharts();
      return;
    }
    if (afrrState.pricesLoading) return;
    afrrState.pricesLoading = true;
    document.getElementById("g-afrr-prices-loading-card").style.display = "";
    document.getElementById("g-afrr-prices-loading-status").textContent =
      "Fetching meta…";

    const cacheVer = "?v=12";
    const tStart = performance.now();

    // Step 1 — load the tiny meta file
    const sMeta = document.createElement("script");
    sMeta.src = "data-afrr-prices-meta.js" + cacheVer;
    sMeta.onerror = () => {
      afrrState.pricesLoading = false;
      document.getElementById("g-afrr-prices-loading-status").textContent =
        "Failed to load data-afrr-prices-meta.js — check the network tab.";
    };
    sMeta.onload = () => {
      const total = AFRR_PRICES_META.n_chunks;
      document.getElementById("g-afrr-prices-loading-status").textContent =
        `Fetching ${total} price chunks (≈ ${total * 30} MB total)…`;

      // Step 2 — inject all chunk scripts in parallel
      let loadedChunks = 0;
      let anyFailed = false;
      function onAnyChunkDone() {
        document.getElementById("g-afrr-prices-loading-status").textContent =
          `Loaded ${loadedChunks} / ${total} chunks…`;
        if (loadedChunks === total && !anyFailed) {
          // Step 3 — concatenate chunks into the AFRR_PRICES global
          assembleAfrrPrices();
          const elapsed = Math.round((performance.now() - tStart) / 1000);
          document.getElementById("g-afrr-prices-loading-status").textContent =
            `Loaded ${(AFRR_PRICES.n_entries / 1e6).toFixed(2)} M entries in ${elapsed} s. Rendering…`;
          AfrrSpreadEngine.init();
          afrrState.pricesLoaded = true;
          afrrState.pricesLoading = false;
          setTimeout(() => {
            document.getElementById("g-afrr-prices-loading-card").style.display = "none";
            document.getElementById("g-afrr-prices-section").style.display = "";
            updateAfrrPriceCharts();
          }, 60);
        }
      }
      for (let c = 0; c < total; c++) {
        const idx = String(c + 1).padStart(3, "0");
        const sc = document.createElement("script");
        sc.src = `data-afrr-prices-${idx}.js` + cacheVer;
        sc.onload = () => {
          loadedChunks++;
          onAnyChunkDone();
        };
        sc.onerror = () => {
          anyFailed = true;
          afrrState.pricesLoading = false;
          document.getElementById("g-afrr-prices-loading-status").textContent =
            `Failed to load chunk ${idx} — check the network tab.`;
        };
        document.head.appendChild(sc);
      }
    };
    document.head.appendChild(sMeta);
  }

  // Concatenate AFRR_PRICES_CHUNKS[*] into typed arrays and expose as
  // window.AFRR_PRICES. After this, the chunk references are released so
  // the GC can reclaim the duplicate memory.
  function assembleAfrrPrices() {
    const meta = AFRR_PRICES_META;
    const chunks = window.AFRR_PRICES_CHUNKS;
    const isp = new Int32Array(meta.n_entries);
    const spread = new Int32Array(meta.n_entries);
    let off = 0;
    for (let c = 0; c < meta.n_chunks; c++) {
      const ch = chunks[c];
      isp.set(ch.isp_idx, off);
      spread.set(ch.spread_x10, off);
      off += ch.isp_idx.length;
    }
    if (off !== meta.n_entries) {
      console.warn(
        `aFRR price chunk concatenation mismatch: got ${off}, expected ${meta.n_entries}`,
      );
    }
    window.AFRR_PRICES = {
      n_entries: meta.n_entries,
      n_pos_entries: meta.n_pos_entries,
      isp_idx: isp,
      spread_x10: spread,
    };
    // Release the chunked plain-array memory; AfrrSpreadEngine reads
    // window.AFRR_PRICES (the typed-array form) from here on.
    window.AFRR_PRICES_CHUNKS = null;
  }

  // Re-render the 9 aFRR price/spread charts. The first 6 (signed-spread
  // 1-D boxes + heatmaps) honour `afrrState.direction` (all/pos/neg). The
  // last 3 (matched-by-DA |spread|) are always merged.
  // Cache for the 3 matched-by-DA |spread| charts. They're direction-agnostic
  // (use spread_w_all in the engine), so toggling direction must NOT
  // invalidate this cache. Recompute only when window / daBins / mL / winsor
  // bounds change.
  let _afrrMatchedCache = null;
  // Re-entrancy guard: direction-toggle clicks during a still-running render
  // would otherwise interleave and cause flicker / wrong-titled charts.
  let _afrrUpdateRunning = false;
  let _afrrUpdatePending = false;

  async function updateAfrrPriceCharts() {
    if (!afrrState.pricesLoaded || !AfrrSpreadEngine.isLoaded()) return;
    if (_afrrUpdateRunning) { _afrrUpdatePending = true; return; }
    _afrrUpdateRunning = true;
    try {
      do {
        _afrrUpdatePending = false;
        await _runAfrrUpdate();
      } while (_afrrUpdatePending);
    } finally {
      _afrrUpdateRunning = false;
    }
  }

  // Yield to the event loop so the browser can paint between charts. Keeps
  // each main-thread task short enough that the "page unresponsive" dialog
  // never triggers.
  const _yieldUI = () => new Promise((r) => setTimeout(r, 0));

  async function _runAfrrUpdate() {
    const t0 = performance.now();
    AfrrSpreadEngine.setBalticThresholds(afrrState.balticDeficit, afrrState.balticSurplus);
    AfrrSpreadEngine.setDayTypeFilter(afrrState.dayType);
    const dir = afrrState.direction; // 'all' | 'pos' | 'neg'
    const wLo = afrrState.winsorAfrrLo;
    const wHi = afrrState.winsorAfrrHi;
    const wB = afrrState.buckets.wind;
    const sB = afrrState.buckets.solar;
    const daB = afrrState.buckets.daBand;
    const mL = afrrState.buckets.matchedLevels;

    const dirSuffix = dir === "all" ? "" : dir === "pos" ? " · POS only (↑)" : " · NEG only (↓)";
    const aFrrYLabel = dir === "all"
      ? "Spread: P_aFRR − P_DA (EUR/MWh)"
      : dir === "pos"
        ? "Spread: AST_POS − P_DA (EUR/MWh)"
        : "Spread: AST_NEG − P_DA (EUR/MWh)";

    const progressEl = document.getElementById("g-afrr-progress");
    let step = 0;
    const TOTAL_STEPS = 9;
    const setProg = (label) => {
      step++;
      if (progressEl) progressEl.textContent = `Rendering ${step}/${TOTAL_STEPS} — ${label}…`;
    };

    // ----- Winsor (direction-specific) -----
    setProg("winsorising spreads");
    await _yieldUI();
    AfrrSpreadEngine.maybeWinsorize(wLo, wHi, dir);

    // ----- Fused 6-chart pass (charts 1-6) -----
    setProg("computing regime/axis box stats");
    await _yieldUI();
    const fused = AfrrSpreadEngine.spreadByAxisAllRegimes(wB, sB, dir);

    // 1-D wind box plots
    setProg("wind surplus");
    await _yieldUI();
    GraphsCharts.drawSpreadByBucket(
      "g-afrr-spread-wind-surplus", fused.wind.surplus, "SURPLUS",
      "Baltic Day-Ahead Wind Forecast",
      `SURPLUS — aFRR spread by Wind power${dirSuffix} (n=${fused.wind.surplus.totalN.toLocaleString()})`,
      aFrrYLabel,
    );

    setProg("wind deficit");
    await _yieldUI();
    GraphsCharts.drawSpreadByBucket(
      "g-afrr-spread-wind-deficit", fused.wind.deficit, "DEFICIT",
      "Baltic Day-Ahead Wind Forecast",
      `DEFICIT — aFRR spread by Wind power${dirSuffix} (n=${fused.wind.deficit.totalN.toLocaleString()})`,
      aFrrYLabel,
    );

    // 1-D solar box plots
    setProg("solar surplus");
    await _yieldUI();
    GraphsCharts.drawSpreadByBucket(
      "g-afrr-spread-solar-surplus", fused.solar.surplus, "SURPLUS",
      "Baltic Day-Ahead Solar Forecast",
      `SURPLUS — aFRR spread by Solar power${dirSuffix} (n=${fused.solar.surplus.totalN.toLocaleString()})`,
      aFrrYLabel,
    );

    setProg("solar deficit");
    await _yieldUI();
    GraphsCharts.drawSpreadByBucket(
      "g-afrr-spread-solar-deficit", fused.solar.deficit, "DEFICIT",
      "Baltic Day-Ahead Solar Forecast",
      `DEFICIT — aFRR spread by Solar power${dirSuffix} (n=${fused.solar.deficit.totalN.toLocaleString()})`,
      aFrrYLabel,
    );

    // 2-D heatmaps
    setProg("heatmap deficit");
    await _yieldUI();
    GraphsCharts.drawWindSolarHeatmap(
      "g-afrr-heatmap-deficit", fused.heatmap.deficit, "DEFICIT",
      `DEFICIT — aFRR spread by Wind × Solar${dirSuffix} (${wB}×${sB} bins)`,
    );

    setProg("heatmap surplus");
    await _yieldUI();
    GraphsCharts.drawWindSolarHeatmap(
      "g-afrr-heatmap-surplus", fused.heatmap.surplus, "SURPLUS",
      `SURPLUS — aFRR spread by Wind × Solar${dirSuffix} (${wB}×${sB} bins)`,
    );

    // ----- Matched-by-DA |spread| (charts 7-9) — direction-agnostic -----
    // Cache key intentionally OMITS direction so toggling all/pos/neg reuses
    // the cached results and skips the heavy recomputation. The day-type
    // filter IS part of the key — switching workdays/weekends changes the
    // bin edges and the spread sample, so the cached panels would be wrong.
    const win = Engine.getWindow();
    const matchedKey = `${win.start}-${win.end}-${daB}-${mL}-${wLo}-${wHi}-${afrrState.dayType}`;
    let cache = _afrrMatchedCache;
    let matchedFromCache = true;
    if (!cache || cache.key !== matchedKey) {
      matchedFromCache = false;
      setProg("matched-by-DA (computing — first time / params changed)");
      await _yieldUI();
      AfrrSpreadEngine.maybeWinsorizeAll(wLo, wHi);
      const mWind = AfrrSpreadEngine.absSpreadByWindMatchedByDABand(daB, mL);
      await _yieldUI();
      const mSolar = AfrrSpreadEngine.absSpreadBySolarMatchedByDABand(daB, mL);
      await _yieldUI();
      const mRenew = AfrrSpreadEngine.absSpreadByRenewablesMatchedByDABand(daB, mL);
      cache = { key: matchedKey, mWind, mSolar, mRenew, daB, mL };
      _afrrMatchedCache = cache;
    } else {
      setProg("matched-by-DA (cached — direction-agnostic)");
    }
    await _yieldUI();
    GraphsCharts.drawAbsSpreadMatchedPanels(
      "g-afrr-matched-wind", cache.mWind,
      `|aFRR spread| by Wind Level — Matched by DA Price Band (${cache.daB} panels × ${cache.mL} levels)`,
    );
    GraphsCharts.drawAbsSpreadMatchedPanels(
      "g-afrr-matched-solar", cache.mSolar,
      `|aFRR spread| by Solar Level — Matched by DA Price Band (${cache.daB} panels × ${cache.mL} levels)`,
    );
    GraphsCharts.drawAbsSpreadMatchedPanels(
      "g-afrr-matched-renew", cache.mRenew,
      `|aFRR spread| by Renewables Level — Matched by DA Price Band (${cache.daB} panels × ${cache.mL} levels)`,
    );

    const ms = Math.round(performance.now() - t0);
    if (progressEl) {
      const cacheNote = matchedFromCache ? "; matched cached ✓" : "; matched recomputed";
      progressEl.textContent = `done in ${ms} ms (direction = ${dir}${cacheNote})`;
    }
  }

  function bindAfrrControls() {
    // Sim range
    const fromEl = document.getElementById("g-afrr-sim-from");
    const toEl = document.getElementById("g-afrr-sim-to");
    const onSim = () => {
      let f = clampAfrrDate(parseEU(fromEl.value) || afrrMinDate);
      let t = clampAfrrDate(parseEU(toEl.value) || afrrMaxDate);
      if (f > t) [f, t] = [t, f];
      fromEl.value = isoToEU(f);
      toEl.value = isoToEU(t);
      afrrState.sim = { from: f, to: t };
      scheduleAfrrUpdate();
    };
    fromEl.addEventListener("change", onSim);
    toEl.addEventListener("change", onSim);
    document.getElementById("g-afrr-sim-reset").addEventListener("click", () => {
      fromEl.value = isoToEU(afrrMinDate);
      toEl.value = isoToEU(afrrMaxDate);
      onSim();
    });
    // Winsor
    const winLo = document.getElementById("g-afrr-winsor-lo");
    const winHi = document.getElementById("g-afrr-winsor-hi");
    const onWin = () => {
      afrrState.winsorAfrrLo = Math.max(0, Math.min(50, parseFloat(winLo.value) || 0));
      afrrState.winsorAfrrHi = Math.max(50, Math.min(100, parseFloat(winHi.value) || 100));
      winLo.value = afrrState.winsorAfrrLo;
      winHi.value = afrrState.winsorAfrrHi;
      scheduleAfrrUpdate();
    };
    winLo.addEventListener("change", onWin);
    winHi.addEventListener("change", onWin);
    // LV thresholds
    const lvDef = document.getElementById("g-afrr-lv-def-thr");
    const lvSur = document.getElementById("g-afrr-lv-sur-thr");
    const onLv = () => {
      let d = parseFloat(lvDef.value);
      let s = parseFloat(lvSur.value);
      if (isNaN(d)) d = 0;
      if (isNaN(s)) s = 0;
      if (d > s) [d, s] = [s, d];
      lvDef.value = d;
      lvSur.value = s;
      afrrState.lvDeficit = d;
      afrrState.lvSurplus = s;
      scheduleAfrrUpdate();
    };
    lvDef.addEventListener("change", onLv);
    lvSur.addEventListener("change", onLv);
    // Baltic thresholds
    const balDef = document.getElementById("g-afrr-bal-def-thr");
    const balSur = document.getElementById("g-afrr-bal-sur-thr");
    const onBal = () => {
      let d = parseFloat(balDef.value);
      let s = parseFloat(balSur.value);
      if (isNaN(d)) d = 0;
      if (isNaN(s)) s = 0;
      if (d > s) [d, s] = [s, d];
      balDef.value = d;
      balSur.value = s;
      afrrState.balticDeficit = d;
      afrrState.balticSurplus = s;
      scheduleAfrrUpdate();
    };
    balDef.addEventListener("change", onBal);
    balSur.addEventListener("change", onBal);
    // Rest-of-Baltic thresholds (EE+LT, used only by divergence chart)
    const restDef = document.getElementById("g-afrr-rest-def-thr");
    const restSur = document.getElementById("g-afrr-rest-sur-thr");
    const onRest = () => {
      let d = parseFloat(restDef.value);
      let s = parseFloat(restSur.value);
      if (isNaN(d)) d = 0;
      if (isNaN(s)) s = 0;
      if (d > s) [d, s] = [s, d];
      restDef.value = d;
      restSur.value = s;
      afrrState.restDeficit = d;
      afrrState.restSurplus = s;
      scheduleAfrrUpdate();
    };
    restDef.addEventListener("change", onRest);
    restSur.addEventListener("change", onRest);
    // Day-type toggle (aFRR section). Independent from the mFRR side.
    // scheduleAfrrUpdate re-runs both the activation bars and (if loaded)
    // the price/spread charts via the existing chain.
    document
      .querySelectorAll(".g-afrr-day-type-toggle .preset[data-day-type]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const newType = btn.dataset.dayType;
          if (afrrState.dayType === newType) return;
          afrrState.dayType = newType;
          document
            .querySelectorAll(".g-afrr-day-type-toggle .preset[data-day-type]")
            .forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          scheduleAfrrUpdate();
        });
      });
    // Bucket counts (price charts only) — same pattern as the mFRR section
    for (const key of ["wind", "solar", "daBand", "matchedLevels"]) {
      const slider = document.getElementById(`g-afrr-buck-${key}`);
      const num = document.getElementById(`g-afrr-buck-${key}-num`);
      if (!slider || !num) continue;
      const onSet = (raw) => {
        let v = parseInt(raw, 10);
        if (isNaN(v)) return;
        v = Math.max(2, Math.min(parseInt(slider.max, 10), v));
        slider.value = v;
        num.value = v;
        afrrState.buckets[key] = v;
        // Bucket changes only matter to the price charts; if those haven't
        // been loaded yet we defer until they are.
        if (afrrState.pricesLoaded) updateAfrrPriceCharts();
      };
      slider.addEventListener("input", (e) => onSet(e.target.value));
      num.addEventListener("change", (e) => onSet(e.target.value));
    }
    // Recompute
    document.getElementById("g-afrr-recompute").addEventListener("click", () => {
      updateAfrr();
      // Also kick the price file load if user is asking for a full refresh
      if (afrrState.pricesLoaded) updateAfrrPriceCharts();
      else loadAfrrPriceData();
    });

    // Direction toggle (POS / NEG / All) for the signed-spread charts.
    // Buttons live in graphs.html under #g-afrr-prices-section. They're
    // present in the DOM at all times (just hidden until prices load), so
    // we can bind once at page init.
    document.querySelectorAll(".direction-toggle .preset[data-direction]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const newDir = btn.dataset.direction;
        if (afrrState.direction === newDir) return; // no-op
        afrrState.direction = newDir;
        document
          .querySelectorAll(".direction-toggle .preset[data-direction]")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        if (afrrState.pricesLoaded) updateAfrrPriceCharts();
      });
    });
  }

  function renderAfrrCards() {
    document.getElementById("g-afrr-setup-params").innerHTML = afrrSetupHTML();
  }

  // ---------- tabs -------------------------------------------------------
  // Cleared on every render to avoid duplicate listeners. Each tab's update
  // fires when it's activated (the engine window is shared, so we need to
  // re-pin it whenever we switch to a tab).
  //
  // Resize fix: aFRR activation bars are pre-rendered ~200 ms after page
  // load (see updateAfrr below) into a panel that's still display:none —
  // Plotly canvases get drawn at 0×0 and `responsive:true` only fires on
  // window resize, leaving them visibly broken until the user zoomed or
  // resized. Forcing Plotly.Plots.resize on every chart in the newly-active
  // panel re-measures against the now-visible container. Idempotent and
  // safe on un-rendered charts (guarded via `_fullLayout`).
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const section = btn.dataset.section;
      const panel = document.getElementById(`panel-${section}`);
      panel.classList.add("active");
      panel.querySelectorAll(".chart").forEach((div) => {
        if (div._fullLayout) Plotly.Plots.resize(div);
      });
      // Re-pin the engine window to whichever tab we just activated
      if (section === "afrr") {
        scheduleAfrrUpdate();
        // Kick off the lazy load of the 86 MB price file in the background.
        // Safe to call repeatedly — early-returns if already loaded/loading.
        loadAfrrPriceData();
      } else {
        scheduleUpdate();
      }
    });
  });

  // ---------- init -------------------------------------------------------
  renderCards();
  bindControls();
  renderAfrrCards();
  bindAfrrControls();
  updateAll();
  // Pre-compute aFRR so switching tabs is instant
  setTimeout(updateAfrr, 200);
})();
