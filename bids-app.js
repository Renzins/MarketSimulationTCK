// bids-app.js — UI controller for the "Bid data" page.
//
// Sibling of forecast-app.js: the password → PAT-unlock → dispatch → poll →
// fetch lifecycle (and the encrypted PAT blob + SECURITY rationale) lives in
// the shared gh-run.js (GhRun) module. This file only knows the bids-route
// specifics: it renders eight price/volume histograms (4 recent UTC periods
// × up/down) with a client-side EE/LV/LT area filter, and trims the ~1 MB
// bids.json down to what sessionStorage can hold.
//
// The run poll is WORKFLOW-SCOPED (bids.yml), so it never picks up a
// forecast run and vice-versa — the two routes share a repo and a password
// but are otherwise independent.

(() => {
  // Per-tab cache of the last completed bids pull, so navigating away and
  // back keeps the charts. Holds only the bids OUTPUT — never the PAT or
  // password (see gh-run.js SECURITY).
  const BIDS_CACHE_KEY = "tck.bids.v1";

  // Direction colours (neutral, distinct — no good/bad implication).
  const C_UP = "#e8a13a"; // amber
  const C_DOWN = "#4c9be8"; // blue

  // Chart container ids, oldest → newest left to right. Four per direction.
  const TARGETS = {
    up: ["bid-up-0", "bid-up-1", "bid-up-2", "bid-up-3"],
    down: ["bid-down-0", "bid-down-1", "bid-down-2", "bid-down-3"],
  };

  const $lastUpdated = document.getElementById("last-updated");
  const $summary = document.getElementById("bids-summary");
  const $areaToggle = document.getElementById("area-toggle");
  const $areaAvail = document.getElementById("area-availability");

  const state = {
    lastTimestamp: null,
    // Full bids object from the last pull (or a trimmed cache restore), kept
    // in memory so switching scheduling area re-filters + redraws instantly
    // with NO re-fetch — bids.json holds all three areas at once.
    lastBids: null,
    // Selected scheduling area: "EE" | "LV" | "LT". Client-side view filter.
    area: "LV",
  };

  function updateLastUpdated() {
    $lastUpdated.textContent = GhRun.relativeTime(state.lastTimestamp);
  }
  setInterval(updateLastUpdated, 30 * 1000);

  // ---- UTC time formatting (bids are keyed by UTC delivery period) --------
  function hm(d) {
    return (
      String(d.getUTCHours()).padStart(2, "0") +
      ":" +
      String(d.getUTCMinutes()).padStart(2, "0")
    );
  }
  function periodLabel(startISO) {
    const d = new Date(startISO);
    if (isNaN(d)) return startISO;
    const e = new Date(d.getTime() + 15 * 60 * 1000); // +15 min PTU
    return `${hm(d)}–${hm(e)} UTC`;
  }

  // =====================================================================
  //  PARSE + RENDER
  // =====================================================================
  // Keep only mFRR bids. Scheduled (A05) and scheduled+direct (A07)
  // products are deliberately NOT distinguished — they're the same market
  // from a price/volume standpoint, so they're pooled per the spec.
  function isMfrr(b) {
    return (b.reserve || "mFRR") === "mFRR";
  }

  // The four most recent 15-minute delivery periods present in the data
  // (distinct delivery_start_utc), oldest → newest, left-padded to length 4
  // so the newest period always sits in the right-most chart slot.
  function selectRecentPeriods(bids) {
    const set = new Set();
    for (const b of bids) {
      if (isMfrr(b) && b.delivery_start_utc) set.add(b.delivery_start_utc);
    }
    const sorted = Array.from(set).sort(); // ISO 8601 sorts chronologically
    const recent = sorted.slice(-4);
    while (recent.length < 4) recent.unshift(null); // pad older (left) slots
    return recent;
  }

  function itemsForDirection(bids, periods, direction) {
    return TARGETS[direction].map((targetId, i) => {
      const pStart = periods[i];
      if (!pStart) return { targetId, label: "—", bids: [] };
      const inWindow = bids.filter(
        (b) =>
          isMfrr(b) &&
          b.direction === direction &&
          b.delivery_start_utc === pStart,
      );
      return { targetId, label: periodLabel(pStart), bids: inWindow };
    });
  }

  const AREA_LABELS = { EE: "Estonia", LV: "Latvia", LT: "Lithuania" };

  // Store a bids object and draw the currently-selected area. Shared by a
  // fresh fetch and the cache-restore path, so a restored pull looks
  // identical.
  function renderBidsObject(bidsJson) {
    state.lastBids = bidsJson;
    state.lastTimestamp = bidsJson.generated_at || null;
    updateLastUpdated();
    renderCurrentArea();
  }

  // Draw the eight histograms for state.area from the in-memory bids object.
  // Called on every area-toggle click — pure re-filter + redraw, no network.
  function renderCurrentArea() {
    const bidsJson = state.lastBids;
    if (!bidsJson) return;
    const area = state.area;
    const bids = Array.isArray(bidsJson.bids) ? bidsJson.bids : [];
    // Selected area, mFRR only (aFRR — EE-only — is intentionally not shown).
    const areaBids = bids.filter((b) => b.area === area && isMfrr(b));
    const periods = selectRecentPeriods(areaBids);

    BidCharts.drawDirectionSection(itemsForDirection(areaBids, periods, "up"), {
      color: C_UP,
      emptyMsg: `no ${area} mFRR up bids`,
    });
    BidCharts.drawDirectionSection(
      itemsForDirection(areaBids, periods, "down"),
      { color: C_DOWN, emptyMsg: `no ${area} mFRR down bids` },
    );

    // Reflect the active area on the toggle buttons.
    if ($areaToggle) {
      $areaToggle.querySelectorAll("button[data-area]").forEach((b) => {
        b.classList.toggle("active", b.getAttribute("data-area") === area);
      });
    }

    // Per-area availability note (does this area also publish aFRR, etc.).
    if ($areaAvail) {
      const summ = (bidsJson.area_summary || []).find((a) => a.area === area);
      const withData = summ ? summ.reserves_with_data || [] : [];
      const hasAfrr = withData.indexOf("aFRR") !== -1;
      $areaAvail.textContent =
        `${areaBids.length} ${area} mFRR bids` +
        (hasAfrr ? " · also publishes aFRR (not shown)" : "");
    }

    // Summary line under the controls.
    if ($summary) {
      const shown = periods.filter(Boolean);
      const range = shown.length
        ? `${periodLabel(shown[0]).replace(" UTC", "")} → ${periodLabel(
            shown[shown.length - 1],
          )}`
        : "—";
      const day = bidsJson.day_utc || "—";
      $summary.textContent =
        `${AREA_LABELS[area] || area} (${area}) mFRR · ${areaBids.length} bids for ${day} · ` +
        `${bids.length} total across ${(bidsJson.areas || []).join("/")} · ` +
        `most recent periods: ${range}`;
    }
  }

  // Shrink a bids object for sessionStorage: bids.json is ~6-10 MB (all
  // three areas, incl. EE aFRR) — well over the ~5 MB storage quota. The
  // charts only ever need each area's most recent mFRR periods, so keep just
  // those; the full object stays in memory (state.lastBids) for the tab.
  function trimForCache(bidsJson) {
    const bids = Array.isArray(bidsJson.bids) ? bidsJson.bids : [];
    const keepByArea = {};
    for (const b of bids) {
      if (!isMfrr(b) || !b.area || !b.delivery_start_utc) continue;
      (keepByArea[b.area] = keepByArea[b.area] || new Set()).add(
        b.delivery_start_utc,
      );
    }
    // Reduce each area to its 6 most recent periods (covers the 4 shown + margin).
    for (const a of Object.keys(keepByArea)) {
      keepByArea[a] = new Set(Array.from(keepByArea[a]).sort().slice(-6));
    }
    const kept = bids.filter(
      (b) =>
        isMfrr(b) &&
        keepByArea[b.area] &&
        keepByArea[b.area].has(b.delivery_start_utc),
    );
    return { ...bidsJson, bids: kept, _trimmed: true };
  }

  // Restore the last completed pull for this tab, if any. Pure redraw from
  // sessionStorage — never touches the network or the PAT.
  function restoreCachedBids() {
    let raw;
    try {
      raw = sessionStorage.getItem(BIDS_CACHE_KEY);
    } catch (_) {
      return false;
    }
    if (!raw) return false;
    try {
      const bidsJson = JSON.parse(raw);
      if (!bidsJson || !Array.isArray(bidsJson.bids)) return false;
      renderBidsObject(bidsJson);
      return true;
    } catch (_) {
      return false;
    }
  }

  // =====================================================================
  //  WIRING + INIT
  // =====================================================================
  // Scheduling-area toggle (EE / LV / LT). Pure client-side view switch —
  // re-filters the already-fetched bids and redraws; never hits the network.
  if ($areaToggle) {
    $areaToggle.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-area]");
      if (!btn) return;
      const area = btn.getAttribute("data-area");
      if (!area || area === state.area) return;
      state.area = area;
      // Reflect selection immediately (renderCurrentArea also does this, but
      // it early-returns when no pull has happened yet).
      $areaToggle.querySelectorAll("button[data-area]").forEach((b) => {
        b.classList.toggle("active", b.getAttribute("data-area") === area);
      });
      renderCurrentArea();
    });
  }

  GhRun.attach({
    workflowFile: "bids.yml",
    outputPath: "bids.json",
    runLabel: "Run bids pull",
    progressVerb: "fetching bids",
    // Called only for a successful run with no error field in the payload;
    // GhRun sets the green "refreshed" status only after this returns.
    onResult: (bidsJson) => {
      renderBidsObject(bidsJson);
      try {
        sessionStorage.setItem(BIDS_CACHE_KEY, JSON.stringify(trimForCache(bidsJson)));
      } catch (_) {
        /* storage disabled or full — caching is non-critical */
      }
    },
  });

  if (restoreCachedBids()) {
    GhRun.setStatus("restored last pull (this tab) — Run bids pull to refresh", null);
  } else {
    GhRun.setStatus("idle — enter password to begin", null);
  }
})();
