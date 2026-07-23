// forecast-app.js — UI controller for the Forecast page.
//
// The password → PAT-unlock → dispatch → poll → fetch lifecycle lives in the
// shared gh-run.js (GhRun) module, together with the encrypted PAT blob and
// the full SECURITY rationale — this file only knows how to RENDER a
// forecast object and how to cache/restore it per tab.
//
// FLOW: on load nothing is fetched (the PAT isn't unlocked); a completed
// run from earlier in this tab is restored from sessionStorage. "Run
// forecast" is one shot per click — GhRun dispatches forecast.yml on the
// private repo, waits for it, and hands the parsed forecast.json to
// onResult below; there is no interval / cron loop.

(() => {
  // sessionStorage key for the last completed forecast (per-tab cache).
  // Bump the version suffix if forecast.json's shape ever changes so a
  // stale-shaped cache can't be rendered. Holds only the forecast OUTPUT —
  // never the PAT or password (see gh-run.js SECURITY).
  const FORECAST_CACHE_KEY = "tck.forecast.v1";

  const $lastUpdated = document.getElementById("last-updated");

  const state = {
    lastForecastTimestamp: null, // ISO string from forecast.json, for the header
  };

  function updateLastUpdated() {
    $lastUpdated.textContent = GhRun.relativeTime(state.lastForecastTimestamp);
  }
  setInterval(updateLastUpdated, 30 * 1000);

  // =====================================================================
  //  RENDER
  // =====================================================================
  // Draw a forecast object. Shared by a fresh fetch and the session-cache
  // restore path, so a restored run looks identical to a just-fetched one.
  function renderForecastObject(forecast) {
    state.lastForecastTimestamp = forecast.generated_at || null;
    updateLastUpdated();
    const horizons = forecast.horizons || [];
    ForecastCharts.drawProbabilityBars("prob-chart", horizons);
    ForecastCharts.drawExpectedPriceLine("price-chart", horizons);
    ForecastCharts.renderHorizonTable("horizon-table", horizons);
  }

  // Restore the last completed forecast for this tab, if any. Pure redraw
  // from sessionStorage — never touches the network or the PAT, so it works
  // before any password is entered. Returns true if something was drawn.
  function restoreCachedForecast() {
    let raw;
    try {
      raw = sessionStorage.getItem(FORECAST_CACHE_KEY);
    } catch (_) {
      return false;
    }
    if (!raw) return false;
    try {
      const forecast = JSON.parse(raw);
      if (!forecast || !Array.isArray(forecast.horizons)) return false;
      renderForecastObject(forecast);
      return true;
    } catch (_) {
      return false; // corrupt / stale-shaped cache — ignore
    }
  }

  // =====================================================================
  //  INIT
  // =====================================================================
  GhRun.attach({
    workflowFile: "forecast.yml",
    outputPath: "forecast.json",
    runLabel: "Run forecast",
    progressVerb: "computing",
    // Called only for a successful run with no error field in the payload;
    // GhRun sets the green "refreshed" status only after this returns.
    onResult: (forecast) => {
      renderForecastObject(forecast);
      // Cache the completed forecast for this tab so navigating to the
      // Backtester / Graphs and back keeps it on screen (sessionStorage
      // survives same-tab navigation/reload, clears on tab close).
      try {
        sessionStorage.setItem(FORECAST_CACHE_KEY, JSON.stringify(forecast));
      } catch (_) {
        /* storage disabled or full — caching is non-critical */
      }
    },
  });

  if (restoreCachedForecast()) {
    GhRun.setStatus("restored last forecast (this tab) — Run forecast to refresh", null);
  } else {
    GhRun.setStatus("idle — enter password to begin", null);
  }
})();
