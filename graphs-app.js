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
            // Compare tab uses the same 4-s data for slot-level analysis;
            // re-render it now that AFRR_PRICES is available so the user
            // sees the slot-level upgrade automatically.
            if (typeof scheduleCmpUpdate === "function") scheduleCmpUpdate();
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

  // =====================================================================
  //  mFRR vs aFRR SUB-TAB
  //  Joint analysis. Independent state from the mFRR / aFRR sub-tabs.
  //  Sim range defaults to the intersection of main-data range and the
  //  aFRR data extent (since aFRR spreads are NaN before 2025-05-01).
  // =====================================================================
  MfrrAfrrEngine.init();

  const cmpState = {
    sim: {
      from: afrrMinDate > dataMinDate ? afrrMinDate : dataMinDate,
      to: afrrMaxDate < dataMaxDate ? afrrMaxDate : dataMaxDate,
    },
    dayType: "all",
    // Two independent winsor percentile pairs. mFRR uses one bound for
    // both ISP and slot modes (per-ISP distribution is the same in both).
    // aFRR uses different bounds per mode because the per-ISP-aggregated
    // and per-4-s-entry distributions are quantitatively different.
    winsorMfrrLo: 10,
    winsorMfrrHi: 90,
    winsorAfrrLo: 10,
    winsorAfrrHi: 90,
  };

  function cmpSetupHTML() {
    return `
      <div class="control sim-range">
        <label>Simulation date range<span class="unit">DD/MM/YYYY</span></label>
        <div class="slider-row two">
          <input type="text" inputmode="numeric" placeholder="DD/MM/YYYY"
                 pattern="\\d{2}/\\d{2}/\\d{4}" maxlength="10"
                 id="g-cmp-sim-from" value="${isoToEU(cmpState.sim.from)}">
          <span>→</span>
          <input type="text" inputmode="numeric" placeholder="DD/MM/YYYY"
                 pattern="\\d{2}/\\d{2}/\\d{4}" maxlength="10"
                 id="g-cmp-sim-to" value="${isoToEU(cmpState.sim.to)}">
          <button type="button" class="btn small" id="g-cmp-sim-reset" title="Reset to full aFRR range">↻</button>
        </div>
        <div class="param-desc">
          <p>Restricts the comparison to ISPs in this window. The aFRR
             portion is clamped to ${isoToEU(afrrMinDate)} → ${isoToEU(afrrMaxDate)}
             (before that, avg_p_pos / avg_p_neg are zero so spreads are
             undefined and ISPs are excluded).</p>
        </div>
      </div>

      <div class="control">
        <label>Day type filter</label>
        <div class="day-type-toggle g-cmp-day-type-toggle">
          <button type="button" class="btn small preset${cmpState.dayType === "all" ? " active" : ""}" data-day-type="all">All days</button>
          <button type="button" class="btn small preset${cmpState.dayType === "weekend-holiday" ? " active" : ""}" data-day-type="weekend-holiday">Weekends + holidays</button>
          <button type="button" class="btn small preset${cmpState.dayType === "workday" ? " active" : ""}" data-day-type="workday">Workdays only</button>
        </div>
        <div class="param-desc">
          <p>Independent from the mFRR / aFRR tabs. Useful for asking
             whether the markets agree differently on weekends than on
             workdays (system imbalance regimes can shift).</p>
        </div>
      </div>

      <div class="control winsor">
        <label>Winsorize mFRR spread (percentiles)</label>
        <div class="slider-row two winsor-row">
          <span class="winsor-input">
            <input type="number" id="g-cmp-winsor-mfrr-lo" value="${cmpState.winsorMfrrLo}" min="0" max="50" step="1">
            <span class="winsor-cap" id="g-cmp-winsor-mfrr-cap-lo">(…)</span>
          </span>
          <span>/</span>
          <span class="winsor-input">
            <input type="number" id="g-cmp-winsor-mfrr-hi" value="${cmpState.winsorMfrrHi}" min="50" max="100" step="1">
            <span class="winsor-cap" id="g-cmp-winsor-mfrr-cap-hi">(…)</span>
          </span>
        </div>
        <div class="param-desc">
          <p>Clip mFRR spread (p_mfrr − p_da) at the chosen percentiles
             before any sign / correlation / scatter computation. Without
             this, the few ±10 000 €/MWh outliers in the dataset dominate
             the Pearson correlation and squash the scatter cloud to a
             single pixel near the origin.</p>
        </div>
      </div>

      <div class="control winsor">
        <label>Winsorize aFRR spread (percentiles)</label>
        <div class="slider-row two winsor-row">
          <span class="winsor-input">
            <input type="number" id="g-cmp-winsor-afrr-lo" value="${cmpState.winsorAfrrLo}" min="0" max="50" step="1">
            <span class="winsor-cap" id="g-cmp-winsor-afrr-cap-lo">(…)</span>
          </span>
          <span>/</span>
          <span class="winsor-input">
            <input type="number" id="g-cmp-winsor-afrr-hi" value="${cmpState.winsorAfrrHi}" min="50" max="100" step="1">
            <span class="winsor-cap" id="g-cmp-winsor-afrr-cap-hi">(…)</span>
          </span>
        </div>
        <div class="param-desc">
          <p>Applied separately to POS and NEG aFRR spreads using their
             own per-direction percentile points (so positive-side and
             negative-side outliers get clipped at appropriately scaled
             bounds). In slot mode, percentiles are over the per-4-s
             entries (millions of points); in the ISP-level fallback, over
             the favourable-only ISP averages.</p>
        </div>
      </div>
    `;
  }

  function renderCmpCards() {
    document.getElementById("g-cmp-setup-params").innerHTML = cmpSetupHTML();
  }

  let cmpUpdateTimer = null;
  function scheduleCmpUpdate() {
    clearTimeout(cmpUpdateTimer);
    cmpUpdateTimer = setTimeout(updateCmp, 60);
  }

  // ----- Chart-drawer helpers (kept inline; no separate file for now) -----

  // Standard Plotly layout / config for the new charts. Reuses the dark
  // palette from the rest of the page (graphs-charts.js's LAYOUT).
  const CMP_LAYOUT = {
    paper_bgcolor: "#11161c",
    plot_bgcolor: "#11161c",
    font: { color: "#e6edf3", family: "system-ui, sans-serif", size: 12 },
    margin: { t: 60, r: 18, b: 60, l: 80 },
    xaxis: { gridcolor: "#262d36", linecolor: "#3a4350", zerolinecolor: "#3a4350" },
    yaxis: { gridcolor: "#262d36", linecolor: "#3a4350", zerolinecolor: "#3a4350" },
    hoverlabel: { bgcolor: "#1f2630", bordercolor: "#3a4350", font: { color: "#e6edf3" } },
  };
  const CMP_CFG = {
    responsive: true,
    displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d"],
  };

  // Joint direction matrix: 3 × 4 heatmap with numeric annotations.
  // Used for both ISP-level and slot-level modes — same shape, different
  // semantics for the column labels (configurable via labelMode).
  function drawCmpMatrix(targetId, result, labelMode) {
    const mRows = ["mFRR Up (≥ +1)", "mFRR Down (≤ −1)", "mFRR Dead (|·|<1)"];
    const aCols =
      labelMode === "slot"
        ? [
            "aFRR slot: POS only",
            "aFRR slot: NEG only",
            "aFRR slot: Both",
            "aFRR slot: Neither",
          ]
        : ["aFRR Up only", "aFRR Down only", "aFRR Both", "aFRR Neither"];
    const cells = result.cells;
    const total = result.total || 1;
    // Plotly heatmap z is [row][col].
    const annotations = [];
    for (let m = 0; m < 3; m++) {
      for (let a = 0; a < 4; a++) {
        const n = cells[m][a];
        const pct = (n / total) * 100;
        annotations.push({
          x: aCols[a],
          y: mRows[m],
          text: `<b>${n.toLocaleString("en-US")}</b><br><span style="font-size:9px;color:#9aa5b1">${pct.toFixed(1)}%</span>`,
          showarrow: false,
          font: { size: 11, color: "#0d1117" },
          align: "center",
        });
      }
    }
    const traces = [
      {
        type: "heatmap",
        z: cells,
        x: aCols,
        y: mRows,
        colorscale: [
          [0, "#1d2c50"],
          [0.5, "#7d8fad"],
          [1, "#ffd166"],
        ],
        showscale: true,
        colorbar: { title: { text: "ISP count", side: "right" } },
        hovertemplate:
          "%{y}<br>%{x}<br>n = %{z:,}<extra></extra>",
      },
    ];
    // Larger left/bottom margins so the "mFRR direction (broadcast)" axis
    // title and the long mFRR/aFRR tick labels ("mFRR Up (≥ +1)" etc.)
    // don't collide with each other or get clipped at narrow viewports.
    const layout = Object.assign({}, CMP_LAYOUT, {
      title: {
        text: `Joint direction · n = ${total.toLocaleString("en-US")} ${labelMode === "slot" ? "4-s slots" : "ISPs"}`,
        font: { size: 14, color: "#e6edf3" },
      },
      margin: { t: 60, r: 18, b: 90, l: 150 },
      xaxis: {
        ...CMP_LAYOUT.xaxis,
        type: "category",
        title: { text: labelMode === "slot" ? "aFRR slot type" : "aFRR direction", standoff: 14 },
        automargin: true,
      },
      yaxis: {
        ...CMP_LAYOUT.yaxis,
        type: "category",
        title: { text: "mFRR direction (broadcast)", standoff: 14 },
        autorange: "reversed",
        automargin: true,
      },
      annotations,
    });
    Plotly.react(targetId, traces, layout, CMP_CFG);
  }

  // Sign-agreement bar: 4 segments, one stack.
  // Colour code: agreement greens, disagreement reds (matches the rest
  // of the site's palette).
  function drawCmpSignBar(targetId, result, title, subtitle) {
    const { counts, total } = result;
    const tot = total || 1;
    const segs = [
      ["Both POS (agree, mkts above DA)", "#3fb950", counts.ppos],
      ["mFRR+ / aFRR− (disagree)", "#f0883e", counts.pneg],
      ["mFRR− / aFRR+ (disagree)", "#bc8cff", counts.npos],
      ["Both NEG (agree, mkts below DA)", "#f85149", counts.nneg],
    ];
    const traces = segs.map(([name, colour, n]) => ({
      type: "bar",
      name,
      x: ["agreement"],
      y: [(n / tot) * 100],
      customdata: [[n, tot]],
      marker: { color: colour, line: { color: "#0d1117", width: 1 } },
      hovertemplate:
        `<b>${name}</b><br>%{y:.2f}%<br>%{customdata[0]:,} / %{customdata[1]:,} ISPs<extra></extra>`,
    }));
    const annotations = [];
    let cum = 0;
    for (const [, , n] of segs) {
      const pct = (n / tot) * 100;
      if (pct >= 4) {
        annotations.push({
          x: "agreement",
          y: cum + pct / 2,
          xref: "x",
          yref: "y",
          text: `<b>${pct.toFixed(1)}%</b>`,
          showarrow: false,
          font: { color: "#0d1117", size: 13 },
        });
      }
      cum += pct;
    }
    const layout = Object.assign({}, CMP_LAYOUT, {
      title: {
        text: `${title}<br><span style="font-size:11px;color:#9aa5b1">${subtitle} · n = ${tot.toLocaleString("en-US")}</span>`,
        font: { size: 14, color: "#e6edf3" },
      },
      barmode: "stack",
      yaxis: {
        ...CMP_LAYOUT.yaxis,
        title: "% of ISPs",
        range: [0, 100],
        ticksuffix: "%",
      },
      xaxis: { ...CMP_LAYOUT.xaxis, type: "category", showticklabels: false },
      annotations,
      legend: {
        orientation: "h",
        x: 0,
        y: -0.2,
        bgcolor: "rgba(0,0,0,0)",
        font: { color: "#e6edf3", size: 11 },
      },
      showlegend: true,
    });
    Plotly.react(targetId, traces, layout, CMP_CFG);
  }

  // Scatter of mFRR spread vs aFRR spread. scattergl handles 8k points
  // efficiently; semi-transparent dots so density shows through.
  function drawCmpScatter(targetId, result, title, yAxisLabel) {
    const traces = [
      {
        type: "scattergl",
        mode: "markers",
        x: result.x,
        y: result.y,
        marker: {
          color: "#7ee787",
          size: 4,
          opacity: 0.35,
          line: { width: 0 },
        },
        hovertemplate:
          "mFRR spread: %{x:.1f} €/MWh<br>aFRR spread: %{y:.1f} €/MWh<extra></extra>",
        name: "",
      },
    ];
    // y = x reference line — agreement axis.
    const allVals = [];
    for (const v of result.x) if (isFinite(v)) allVals.push(v);
    for (const v of result.y) if (isFinite(v)) allVals.push(v);
    if (allVals.length > 0) {
      allVals.sort((a, b) => a - b);
      const p1 = allVals[Math.floor(allVals.length * 0.01)];
      const p99 = allVals[Math.floor(allVals.length * 0.99)];
      const lo = Math.min(p1, -10);
      const hi = Math.max(p99, 10);
      traces.push({
        type: "scattergl",
        mode: "lines",
        x: [lo, hi],
        y: [lo, hi],
        line: { color: "#f85149", width: 1, dash: "dash" },
        name: "y = x (agreement)",
        hoverinfo: "skip",
      });
    }
    const subtitle = result.subsampled
      ? `n = ${result.n.toLocaleString("en-US")} (showing ${result.x.length.toLocaleString("en-US")} subsampled)`
      : `n = ${result.n.toLocaleString("en-US")}`;
    const layout = Object.assign({}, CMP_LAYOUT, {
      title: {
        text: `${title}<br><span style="font-size:11px;color:#9aa5b1">${subtitle}</span>`,
        font: { size: 14, color: "#e6edf3" },
      },
      xaxis: {
        ...CMP_LAYOUT.xaxis,
        title: "mFRR spread (p_mfrr − p_da, €/MWh)",
        zeroline: true,
        zerolinecolor: "#5a6470",
      },
      yaxis: {
        ...CMP_LAYOUT.yaxis,
        title: yAxisLabel,
        zeroline: true,
        zerolinecolor: "#5a6470",
      },
      showlegend: false,
    });
    Plotly.react(targetId, traces, layout, CMP_CFG);
  }

  // Build the stats scoreboard HTML.
  // Two modes: "isp" (15-min ISP-level, fast, fallback before 4-s loads)
  //            "slot" (4-s slot-level, requires AFRR_PRICES loaded).
  function renderCmpStats(s, mode) {
    const fmtInt = (n) => (n || 0).toLocaleString("en-US");
    const fmtPct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) + "%" : "—");
    const fmtCorr = (c) => (isFinite(c) ? c.toFixed(3) : "—");
    let html;
    if (mode === "slot") {
      // Slot-level: every metric is in units of 4-s slots / entries.
      // Confidence is overstated because mFRR is broadcast 225× per ISP —
      // flagged in the help line for the correlation tile.
      html = `
        <div class="cmp-stat">
          <div class="cmp-stat-label">4-s slots in window</div>
          <div class="cmp-stat-val">${fmtInt(s.nSlots)}</div>
          <div class="cmp-stat-help">${fmtInt(s.nIspsWithAfrr)} ISPs with aFRR data</div>
        </div>
        <div class="cmp-stat">
          <div class="cmp-stat-label">aFRR active entries (POS / NEG)</div>
          <div class="cmp-stat-val">
            <span style="color:#3fb950">${fmtInt(s.nPos)}</span>
            <span style="color:#9aa5b1"> · </span>
            <span style="color:#f85149">${fmtInt(s.nNeg)}</span>
          </div>
          <div class="cmp-stat-help">${fmtPct(s.nPos + s.nNeg, s.nSlots)} of slots had at least one direction cleared</div>
        </div>
        <div class="cmp-stat">
          <div class="cmp-stat-label">Co-fire (mFRR ↑ AND aFRR POS slot)</div>
          <div class="cmp-stat-val" style="color:#3fb950">${fmtInt(s.nCoUpPos)}</div>
          <div class="cmp-stat-help">${fmtPct(s.nCoUpPos, s.nPos)} of POS-direction 4-s slots fell inside an mFRR-up ISP</div>
        </div>
        <div class="cmp-stat">
          <div class="cmp-stat-label">Co-fire (mFRR ↓ AND aFRR NEG slot)</div>
          <div class="cmp-stat-val" style="color:#f85149">${fmtInt(s.nCoDnNeg)}</div>
          <div class="cmp-stat-help">${fmtPct(s.nCoDnNeg, s.nNeg)} of NEG-direction 4-s slots fell inside an mFRR-dn ISP</div>
        </div>
        <div class="cmp-stat">
          <div class="cmp-stat-label">Sign-agreement (POS direction)</div>
          <div class="cmp-stat-val">${fmtPct(s.nSignAgreePos, s.nPos)}</div>
          <div class="cmp-stat-help">Per POS-direction 4-s slot: sign(mFRR spread) = sign(aFRR spread). n = ${fmtInt(s.nPos)}</div>
        </div>
        <div class="cmp-stat">
          <div class="cmp-stat-label">Sign-agreement (NEG direction)</div>
          <div class="cmp-stat-val">${fmtPct(s.nSignAgreeNeg, s.nNeg)}</div>
          <div class="cmp-stat-help">Same metric on NEG-direction slots. Heavily skewed to "both negative" by construction.</div>
        </div>
        <div class="cmp-stat">
          <div class="cmp-stat-label">Pearson correlation (all entries)</div>
          <div class="cmp-stat-val">${fmtCorr(s.corr)}</div>
          <div class="cmp-stat-help">mFRR vs aFRR spread across ${fmtInt(s.nCorr)} entries. <strong>Independent obs ≈ n_ISPs</strong>; mFRR is broadcast 225× so don't over-interpret confidence here.</div>
        </div>
      `;
    } else {
      // ISP-level fallback (used only while 4-s data is loading).
      html = `
        <div class="cmp-stat">
          <div class="cmp-stat-label">ISPs in window</div>
          <div class="cmp-stat-val">${fmtInt(s.nTotal)}</div>
          <div class="cmp-stat-help">ISP-level mode (4-s data still loading)</div>
        </div>
        <div class="cmp-stat">
          <div class="cmp-stat-label">mFRR fires (Up / Dn)</div>
          <div class="cmp-stat-val">
            <span style="color:#3fb950">${fmtInt(s.nMfrrUp)}</span>
            <span style="color:#9aa5b1"> · </span>
            <span style="color:#f85149">${fmtInt(s.nMfrrDn)}</span>
          </div>
          <div class="cmp-stat-help">${fmtPct(s.nMfrrUp + s.nMfrrDn, s.nTotal)} of ISPs</div>
        </div>
        <div class="cmp-stat">
          <div class="cmp-stat-label">aFRR fires (Up / Dn / Both)</div>
          <div class="cmp-stat-val">
            <span style="color:#3fb950">${fmtInt(s.nAfrrUp)}</span>
            <span style="color:#9aa5b1"> · </span>
            <span style="color:#f85149">${fmtInt(s.nAfrrDn)}</span>
            <span style="color:#9aa5b1"> · </span>
            <span style="color:#ffd166">${fmtInt(s.nAfrrBoth)}</span>
          </div>
          <div class="cmp-stat-help">${fmtPct(s.nAfrrUp + s.nAfrrDn + s.nAfrrBoth, s.nTotal)} of ISPs</div>
        </div>
        <div class="cmp-stat">
          <div class="cmp-stat-label">Co-fire (mFRR ↑ AND aFRR ↑)</div>
          <div class="cmp-stat-val" style="color:#3fb950">${fmtInt(s.nCoUp)}</div>
          <div class="cmp-stat-help">${fmtPct(s.nCoUp, s.nMfrrUp)} of mFRR-up ISPs also had aFRR-up activity</div>
        </div>
        <div class="cmp-stat">
          <div class="cmp-stat-label">Co-fire (mFRR ↓ AND aFRR ↓)</div>
          <div class="cmp-stat-val" style="color:#f85149">${fmtInt(s.nCoDn)}</div>
          <div class="cmp-stat-help">${fmtPct(s.nCoDn, s.nMfrrDn)} of mFRR-dn ISPs also had aFRR-dn activity</div>
        </div>
        <div class="cmp-stat">
          <div class="cmp-stat-label">Sign-agreement (Up direction)</div>
          <div class="cmp-stat-val">${fmtPct(s.signAgreePos * s.nSignAgreePos, s.nSignAgreePos)}</div>
          <div class="cmp-stat-help">mFRR spread sign matches aFRR-up spread sign, n = ${fmtInt(s.nSignAgreePos)} ISPs</div>
        </div>
        <div class="cmp-stat">
          <div class="cmp-stat-label">Pearson correlation</div>
          <div class="cmp-stat-val">${fmtCorr(s.corrPos)}</div>
          <div class="cmp-stat-help">mFRR spread vs aFRR-up spread, n = ${fmtInt(s.nCorrPos)} ISPs (where both defined)</div>
        </div>
      `;
    }
    document.getElementById("g-cmp-stats").innerHTML = html;
  }

  // Live preview of the per-direction winsor cap values. Mirrors the
  // backtester's "(≤ ...)/(≥ ...)" preview style. Picks the slot-mode
  // aFRR bounds when 4-s data is loaded (those are the bounds the charts
  // actually use), else falls back to ISP-level aFRR bounds.
  function updateCmpWinsorCaps() {
    const fmt = (v) => {
      if (!isFinite(v)) return "—";
      const abs = Math.abs(v);
      if (abs >= 1000) return Math.round(v).toLocaleString("en-US");
      if (abs >= 100) return v.toFixed(0);
      return v.toFixed(1);
    };
    const setCap = (id, v, prefix) => {
      const el = document.getElementById(id);
      if (el) el.textContent = `(${prefix} ${fmt(v)} €/MWh)`;
    };
    const mB = MfrrAfrrEngine.getCurrentBounds("mfrr");
    if (mB) {
      setCap("g-cmp-winsor-mfrr-cap-lo", mB.lo, "≤");
      setCap("g-cmp-winsor-mfrr-cap-hi", mB.hi, "≥");
    }
    // Use slot-level bounds when 4-s data is loaded; fall back to ISP.
    const useSlot = MfrrAfrrEngine.isSlotDataLoaded();
    const aBp = MfrrAfrrEngine.getCurrentBounds(useSlot ? "slot" : "isp", "pos");
    const aBn = MfrrAfrrEngine.getCurrentBounds(useSlot ? "slot" : "isp", "neg");
    // The aFRR caps shown summarise both POS and NEG side cap ranges:
    // lo = min of pos-lo/neg-lo, hi = max of pos-hi/neg-hi. Tooltip-style
    // single line; if the user needs per-direction precision they can
    // open the per-direction charts (axes are labelled).
    if (aBp && aBn) {
      const lo = Math.min(aBp.lo, aBn.lo);
      const hi = Math.max(aBp.hi, aBn.hi);
      setCap("g-cmp-winsor-afrr-cap-lo", lo, "≤");
      setCap("g-cmp-winsor-afrr-cap-hi", hi, "≥");
    }
  }

  function updateCmp() {
    const progEl = document.getElementById("g-cmp-progress");
    const { start, end } = rangeToIdx(cmpState.sim.from, cmpState.sim.to);
    Engine.setWindow(start, end);
    MfrrAfrrEngine.setDayTypeFilter(cmpState.dayType);
    MfrrAfrrEngine.setWinsorMfrr(cmpState.winsorMfrrLo, cmpState.winsorMfrrHi);
    MfrrAfrrEngine.setWinsorAfrr(cmpState.winsorAfrrLo, cmpState.winsorAfrrHi);

    // Prefer slot-level analysis (per-4-s) — it's what the user asked
    // for. If the lazy-loaded 4-s price file isn't ready, render the
    // ISP-level fallback and trigger the load; re-renders automatically
    // once the load completes (see loadAfrrPriceData below).
    if (MfrrAfrrEngine.isSlotDataLoaded()) {
      progEl.textContent = "computing (4-s mode)…";
      setTimeout(() => {
        const t0 = performance.now();
        renderCmpStats(MfrrAfrrEngine.slotLevelStats(), "slot");
        drawCmpMatrix("g-cmp-matrix", MfrrAfrrEngine.slotLevelMatrix(), "slot");
        drawCmpSignBar(
          "g-cmp-sign-pos",
          MfrrAfrrEngine.slotLevelSignAgreement("pos"),
          "Sign agreement — aFRR POS slots",
          "Per 4-s POS slot: sign(p_mfrr − p_da) vs sign(AST_POS − p_da)",
        );
        drawCmpSignBar(
          "g-cmp-sign-neg",
          MfrrAfrrEngine.slotLevelSignAgreement("neg"),
          "Sign agreement — aFRR NEG slots",
          "Per 4-s NEG slot: sign(p_mfrr − p_da) vs sign(AST_NEG − p_da)",
        );
        drawCmpScatter(
          "g-cmp-scatter-pos",
          MfrrAfrrEngine.slotLevelScatter("pos"),
          "mFRR spread (broadcast) vs aFRR POS spread",
          "aFRR POS spread (AST_POS − p_da, €/MWh)",
        );
        drawCmpScatter(
          "g-cmp-scatter-neg",
          MfrrAfrrEngine.slotLevelScatter("neg"),
          "mFRR spread (broadcast) vs aFRR NEG spread",
          "aFRR NEG spread (AST_NEG − p_da, €/MWh)",
        );
        const ms = Math.round(performance.now() - t0);
        progEl.textContent = `done in ${ms} ms (4-s mode)`;
        updateCmpWinsorCaps();
      }, 30);
    } else {
      // ISP-level fallback while 4-s data loads.
      progEl.textContent = "loading 4-second aFRR price data… (ISP-level shown meanwhile)";
      setTimeout(() => {
        const t0 = performance.now();
        renderCmpStats(MfrrAfrrEngine.statsScoreboard(), "isp");
        drawCmpMatrix("g-cmp-matrix", MfrrAfrrEngine.agreementMatrix(), "isp");
        drawCmpSignBar(
          "g-cmp-sign-pos",
          MfrrAfrrEngine.signAgreement("pos"),
          "Sign agreement — aFRR-up direction (ISP-level)",
          "spread = avg_p_pos − p_da (only ISPs with avg_p_pos > 0)",
        );
        drawCmpSignBar(
          "g-cmp-sign-neg",
          MfrrAfrrEngine.signAgreement("neg"),
          "Sign agreement — aFRR-dn direction (ISP-level)",
          "spread = avg_p_neg − p_da (only ISPs with avg_p_neg < 0)",
        );
        drawCmpScatter(
          "g-cmp-scatter-pos",
          MfrrAfrrEngine.spreadScatter("pos"),
          "mFRR spread vs aFRR-up spread (ISP-level)",
          "aFRR-up spread (avg_p_pos − p_da, €/MWh)",
        );
        drawCmpScatter(
          "g-cmp-scatter-neg",
          MfrrAfrrEngine.spreadScatter("neg"),
          "mFRR spread vs aFRR-dn spread (ISP-level)",
          "aFRR-dn spread (avg_p_neg − p_da, €/MWh)",
        );
        const ms = Math.round(performance.now() - t0);
        progEl.textContent = `done in ${ms} ms (ISP-level fallback — 4-s data still loading)`;
        updateCmpWinsorCaps();
      }, 30);
      // Kick off the lazy load. Will call scheduleCmpUpdate() on completion
      // (see loadAfrrPriceData hook below), at which point we'll re-render
      // in 4-s mode.
      loadAfrrPriceData();
    }
  }

  function bindCmpControls() {
    const fromEl = document.getElementById("g-cmp-sim-from");
    const toEl = document.getElementById("g-cmp-sim-to");
    const onSim = () => {
      let f = clampDate(parseEU(fromEl.value) || dataMinDate, dataMinDate, dataMaxDate);
      let t = clampDate(parseEU(toEl.value) || dataMaxDate, dataMinDate, dataMaxDate);
      if (f > t) [f, t] = [t, f];
      fromEl.value = isoToEU(f);
      toEl.value = isoToEU(t);
      cmpState.sim = { from: f, to: t };
      scheduleCmpUpdate();
    };
    fromEl.addEventListener("change", onSim);
    toEl.addEventListener("change", onSim);
    document.getElementById("g-cmp-sim-reset").addEventListener("click", () => {
      fromEl.value = isoToEU(afrrMinDate);
      toEl.value = isoToEU(afrrMaxDate);
      onSim();
    });
    document
      .querySelectorAll(".g-cmp-day-type-toggle .preset[data-day-type]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const t = btn.dataset.dayType;
          if (cmpState.dayType === t) return;
          cmpState.dayType = t;
          document
            .querySelectorAll(".g-cmp-day-type-toggle .preset[data-day-type]")
            .forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          scheduleCmpUpdate();
        });
      });
    // Winsor controls — mFRR and aFRR independently. Clamps to safe ranges
    // (lo ∈ [0,50], hi ∈ [50,100]); recomputes on every change.
    const wMLo = document.getElementById("g-cmp-winsor-mfrr-lo");
    const wMHi = document.getElementById("g-cmp-winsor-mfrr-hi");
    const onWinsorMfrr = () => {
      const lo = Math.max(0, Math.min(50, parseFloat(wMLo.value) || 0));
      const hi = Math.max(50, Math.min(100, parseFloat(wMHi.value) || 100));
      wMLo.value = lo;
      wMHi.value = hi;
      cmpState.winsorMfrrLo = lo;
      cmpState.winsorMfrrHi = hi;
      scheduleCmpUpdate();
    };
    wMLo.addEventListener("change", onWinsorMfrr);
    wMHi.addEventListener("change", onWinsorMfrr);
    const wALo = document.getElementById("g-cmp-winsor-afrr-lo");
    const wAHi = document.getElementById("g-cmp-winsor-afrr-hi");
    const onWinsorAfrr = () => {
      const lo = Math.max(0, Math.min(50, parseFloat(wALo.value) || 0));
      const hi = Math.max(50, Math.min(100, parseFloat(wAHi.value) || 100));
      wALo.value = lo;
      wAHi.value = hi;
      cmpState.winsorAfrrLo = lo;
      cmpState.winsorAfrrHi = hi;
      scheduleCmpUpdate();
    };
    wALo.addEventListener("change", onWinsorAfrr);
    wAHi.addEventListener("change", onWinsorAfrr);
    document.getElementById("g-cmp-recompute").addEventListener("click", updateCmp);
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
  // resized. We address this with two layers:
  //   1. On every tab click, force Plotly.Plots.resize on each chart in the
  //      newly-visible panel — but only after the next animation frame, so
  //      the browser has performed its layout pass with the new .active
  //      class applied.
  //   2. A global ResizeObserver watches every .chart div and re-runs
  //      Plotly.Plots.resize whenever the container's content-box size
  //      changes (display:none → block, window resize, font load, etc.).
  //      Idempotent and safe on un-rendered charts (guarded via
  //      `_fullLayout`).
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const section = btn.dataset.section;
      const panel = document.getElementById(`panel-${section}`);
      panel.classList.add("active");
      requestAnimationFrame(() => {
        panel.querySelectorAll(".chart").forEach((div) => {
          if (div._fullLayout) Plotly.Plots.resize(div);
        });
      });
      // Re-pin the engine window to whichever tab we just activated
      if (section === "afrr") {
        scheduleAfrrUpdate();
        // Kick off the lazy load of the 86 MB price file in the background.
        // Safe to call repeatedly — early-returns if already loaded/loading.
        loadAfrrPriceData();
      } else if (section === "compare") {
        scheduleCmpUpdate();
      } else {
        scheduleUpdate();
      }
    });
  });

  // Global ResizeObserver for all .chart elements. Triggers a Plotly resize
  // whenever a chart's container changes size, which catches all the
  // "rendered while hidden" cases the tab-click handler can't (e.g. the
  // initial display:none → block transition that fires when the user
  // first switches to the aFRR / compare tab).
  if (typeof ResizeObserver !== "undefined") {
    const chartResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const div = entry.target;
        if (div._fullLayout) {
          // rAF: let any in-flight layout settle before measuring again.
          requestAnimationFrame(() => {
            if (div.isConnected && div._fullLayout) Plotly.Plots.resize(div);
          });
        }
      }
    });
    document.querySelectorAll(".chart").forEach((div) => {
      chartResizeObserver.observe(div);
    });
  }

  // ---------- init -------------------------------------------------------
  renderCards();
  bindControls();
  renderAfrrCards();
  bindAfrrControls();
  renderCmpCards();
  bindCmpControls();
  updateAll();
  // Pre-compute aFRR + compare so switching tabs is instant
  setTimeout(updateAfrr, 200);
  setTimeout(updateCmp, 400);
})();
