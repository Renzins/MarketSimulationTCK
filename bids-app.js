// bids-app.js — UI controller for the "Bid data" page.
//
// Sibling of forecast-app.js. Same private repo (Renzins/RetrievalTCK), same
// shared password unlocking the same encrypted GitHub PAT, same
// dispatch → poll → fetch → render shape. Only three things differ from the
// forecast route:
//   1. it dispatches the `bids.yml` workflow instead of `forecast.yml`;
//   2. it reads `bids.json` instead of `forecast.json` (via the GitHub "raw"
//      media type, because the bid list is ~1 MB and can exceed the Contents
//      API's 1 MB base64-inline limit on a busy day);
//   3. it renders eight price/volume histograms instead of the forecast charts.
//
// The run poll is WORKFLOW-SCOPED (/actions/workflows/bids.yml/runs), so it
// never picks up a forecast run and vice-versa — the two routes share a repo
// and a password but are otherwise independent.
//
// SECURITY: identical model to forecast-app.js. The repo ships only the
// ENCRYPTED_PAT blob (PBKDF2 → AES-GCM, keyed by the shared password); the
// plaintext PAT exists in memory only during a single run; the password is
// never persisted. See forecast-app.js for the full rationale.

(() => {
  // =====================================================================
  //  CONFIGURATION — mirrors forecast-app.js (same repo + same PAT blob)
  // =====================================================================
  const REPO_OWNER = "Renzins";
  const REPO_NAME = "RetrievalTCK";

  // The bids route's workflow file. This is the ONLY dispatch/poll target
  // that differs from the forecast page.
  const WORKFLOW_FILENAME = "bids.yml";

  // bids.json path within the private repo (committed at the root by
  // bids_run.py, same as forecast.json).
  const BIDS_PATH = "bids.json";

  // ---------------------------------------------------------------------
  //  Encrypted PAT blob — SAME blob as forecast-app.js. Both workflows live
  //  in the same repo, so one fine-grained PAT (Actions:read+write +
  //  Contents:read) dispatches both and reads both output files. Reuse the
  //  identical blob so the one shared password unlocks either page.
  // ---------------------------------------------------------------------
  const ENCRYPTED_PAT = {
    iterations: 600000,
    salt: "QsLeE7XFZICRJJ+Xurw2vA==",
    iv: "4vbkJbJ0LWmuJK7k",
    ciphertext:
      "KMVQCivBgrhhg3ouq4S+NHQ6VH/6IktOf5yBFiWQOkm+Ipe6uKNFBggM4gBvNsA1h3LQsOS02WNB976gkZt6M6OBcugnJM+DKVq5tlvHma7R5JPP1XYFQI9tESxI0teN86qMcNdIjn0CVN791Q==",
  };

  const POLL_INTERVAL_MS = 5 * 1000; // 5 s
  const POLL_MAX_MS = 15 * 60 * 1000; // give up after 15 min (bids run ~1-2 min)

  // Per-tab cache of the last completed bids pull, so navigating away and back
  // keeps the charts. Holds only the bids OUTPUT — never the PAT or password.
  const BIDS_CACHE_KEY = "tck.bids.v1";

  // Direction colours (neutral, distinct — no good/bad implication).
  const C_UP = "#e8a13a"; // amber
  const C_DOWN = "#4c9be8"; // blue

  // Chart container ids, oldest → newest left to right. Four per direction.
  const TARGETS = {
    up: ["bid-up-0", "bid-up-1", "bid-up-2", "bid-up-3"],
    down: ["bid-down-0", "bid-down-1", "bid-down-2", "bid-down-3"],
  };

  // =====================================================================
  //  DOM HANDLES
  // =====================================================================
  const $repo = document.getElementById("repo-display");
  const $pwd = document.getElementById("pwd-input");
  const $btn = document.getElementById("activate-btn");
  const $status = document.getElementById("status-text");
  const $lastUpdated = document.getElementById("last-updated");
  const $summary = document.getElementById("bids-summary");
  const $areaToggle = document.getElementById("area-toggle");
  const $areaAvail = document.getElementById("area-availability");

  $repo.textContent = `${REPO_OWNER}/${REPO_NAME}`;

  // =====================================================================
  //  STATE
  // =====================================================================
  const state = {
    running: false,
    currentPAT: null,
    pollAbort: null,
    lastTimestamp: null,
    // Full bids object from the last pull (or a trimmed cache restore), kept in
    // memory so switching scheduling area re-filters + redraws instantly with
    // NO re-fetch — bids.json holds all three areas at once.
    lastBids: null,
    // Selected scheduling area: "EE" | "LV" | "LT". Client-side view filter.
    area: "LV",
  };

  // =====================================================================
  //  CRYPTO — unlock the PAT with the typed password (identical to forecast)
  // =====================================================================
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function unlockPAT(password) {
    if (
      !ENCRYPTED_PAT.salt ||
      ENCRYPTED_PAT.salt.startsWith("REPLACE_") ||
      !ENCRYPTED_PAT.ciphertext ||
      ENCRYPTED_PAT.ciphertext.startsWith("REPLACE_")
    ) {
      throw new Error(
        "ENCRYPTED_PAT not configured. Open encrypt-pat.html, encrypt your" +
          " PAT, and paste the snippet into bids-app.js.",
      );
    }
    const salt = b64ToBytes(ENCRYPTED_PAT.salt);
    const iv = b64ToBytes(ENCRYPTED_PAT.iv);
    const ciphertext = b64ToBytes(ENCRYPTED_PAT.ciphertext);
    const passwordKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveKey"],
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations: ENCRYPTED_PAT.iterations,
        hash: "SHA-256",
      },
      passwordKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const plaintextBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    return new TextDecoder().decode(plaintextBuf);
  }

  // =====================================================================
  //  HELPERS
  // =====================================================================
  function setStatus(text, kind) {
    $status.textContent = text;
    $status.className = "winsor-cap";
    if (kind === "ok") $status.style.color = "var(--accent, #58a6ff)";
    else if (kind === "warn") $status.style.color = "#d29922";
    else if (kind === "err") $status.style.color = "#f85149";
    else $status.style.color = "";
  }

  function relativeTime(iso) {
    if (!iso) return "—";
    const t = new Date(iso).getTime();
    if (isNaN(t)) return iso;
    const diffSec = Math.max(0, (Date.now() - t) / 1000);
    if (diffSec < 60) return `${Math.floor(diffSec)} s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`;
    if (diffSec < 86400) {
      const h = Math.floor(diffSec / 3600);
      const m = Math.floor((diffSec % 3600) / 60);
      return `${h} h ${m} min ago`;
    }
    return new Date(iso).toUTCString();
  }

  function updateLastUpdated() {
    $lastUpdated.textContent = relativeTime(state.lastTimestamp);
  }
  setInterval(updateLastUpdated, 30 * 1000);

  function ghHeaders(extra) {
    if (!state.currentPAT) {
      throw new Error("PAT not unlocked — run with a valid password first.");
    }
    return {
      Authorization: `Bearer ${state.currentPAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(extra || {}),
    };
  }

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
  //  GITHUB API CALLS
  // =====================================================================
  // bids.json is fetched with the "raw" media type rather than the default
  // JSON+base64 representation: the file is ~1 MB and can top the Contents
  // API's 1 MB inline limit on a busy day, at which point the JSON form
  // returns empty content. The raw form streams the file directly (up to
  // 100 MB) and needs no base64 decode.
  async function fetchBidsJson() {
    const url =
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${BIDS_PATH}` +
      `?ref=main&_t=${Date.now()}`;
    const res = await fetch(url, {
      headers: ghHeaders({ Accept: "application/vnd.github.raw+json" }),
      cache: "no-store",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`fetch bids.json failed: ${res.status} ${detail}`);
    }
    const text = await res.text();
    return JSON.parse(text);
  }

  async function dispatchWorkflow(password) {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WORKFLOW_FILENAME}/dispatches`;
    const res = await fetch(url, {
      method: "POST",
      headers: { ...ghHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: "main",
        inputs: { password, reason: "button" },
      }),
    });
    if (res.status !== 204) {
      const detail = await res.text().catch(() => "");
      throw new Error(`dispatch failed: ${res.status} ${detail}`);
    }
  }

  async function findRecentRun(sinceMs) {
    const url =
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WORKFLOW_FILENAME}/runs` +
      `?event=workflow_dispatch&per_page=5`;
    const res = await fetch(url, { headers: ghHeaders() });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`list runs failed: ${res.status} ${detail}`);
    }
    const data = await res.json();
    const runs = data.workflow_runs || [];
    for (const r of runs) {
      const created = new Date(r.created_at).getTime();
      if (created >= sinceMs - 2000) return r;
    }
    return null;
  }

  async function waitForRunCompletion(sinceMs, signal) {
    const start = Date.now();
    let lastElapsedMsg = -1;
    let runId = null;
    while (Date.now() - start < POLL_MAX_MS) {
      if (signal && signal.aborted) throw new Error("aborted");
      let run;
      if (runId == null) {
        run = await findRecentRun(sinceMs);
        if (run) runId = run.id;
      } else {
        const r = await fetch(
          `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/runs/${runId}`,
          { headers: ghHeaders() },
        );
        if (r.ok) run = await r.json();
      }

      const elapsed = Math.floor((Date.now() - start) / 1000);
      if (elapsed !== lastElapsedMsg) {
        if (!run) setStatus(`waiting for run to register… ${elapsed} s`, "warn");
        else if (run.status === "completed")
          setStatus(
            `run ${run.conclusion} in ${elapsed} s`,
            run.conclusion === "success" ? "ok" : "err",
          );
        else setStatus(`fetching bids… ${elapsed} s elapsed`, "warn");
        lastElapsedMsg = elapsed;
      }

      if (run && run.status === "completed") return run;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`poll timed out after ${POLL_MAX_MS / 1000} s`);
  }

  // =====================================================================
  //  PARSE + RENDER
  // =====================================================================
  // Keep only LV mFRR bids. Scheduled (A05) and scheduled+direct (A07)
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

  // Store a bids object and draw the currently-selected area. Shared by a fresh
  // fetch and the cache-restore path, so a restored pull looks identical.
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

  // Shrink a bids object for sessionStorage: bids.json is ~6-10 MB (all three
  // areas, incl. EE aFRR) — well over the ~5 MB storage quota. The charts only
  // ever need each area's most recent mFRR periods, so keep just those; the
  // full object stays in memory (state.lastBids) for the current tab.
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

  async function fetchAndRender() {
    const bidsJson = await fetchBidsJson();
    if (bidsJson.error) {
      setStatus(`bids.json has error: ${bidsJson.error}`, "err");
      return bidsJson;
    }
    renderBidsObject(bidsJson);
    try {
      sessionStorage.setItem(BIDS_CACHE_KEY, JSON.stringify(trimForCache(bidsJson)));
    } catch (_) {
      /* storage disabled or full — caching is non-critical */
    }
    return bidsJson;
  }

  // =====================================================================
  //  RUN — one bids pull per click, no automatic repeat
  // =====================================================================
  async function runBids() {
    const pwd = $pwd.value;
    if (!pwd) {
      setStatus("enter a password before running", "warn");
      $pwd.focus();
      return;
    }

    state.running = true;
    $btn.disabled = true;
    $pwd.disabled = true;
    setStatus("unlocking PAT…", "warn");

    try {
      state.currentPAT = await unlockPAT(pwd);
    } catch (err) {
      const isWrongPwd = err && err.name === "OperationError";
      setStatus(
        isWrongPwd ? "wrong password" : `unlock failed: ${err.message}`,
        "err",
      );
      $pwd.value = "";
      finishRun();
      $pwd.focus();
      return;
    }

    $btn.textContent = "Cancel";
    $btn.classList.remove("primary");
    $btn.disabled = false;

    const sinceMs = Date.now();
    try {
      setStatus("dispatching…", "warn");
      await dispatchWorkflow(pwd);
      state.pollAbort = new AbortController();
      const run = await waitForRunCompletion(sinceMs, state.pollAbort.signal);
      if (run.conclusion === "success") {
        await fetchAndRender();
        setStatus(`refreshed at ${new Date().toLocaleTimeString()}`, "ok");
      } else {
        const conclusion = run.conclusion || "failed";
        const likelyAuth = Date.now() - sinceMs < 30000;
        setStatus(
          likelyAuth
            ? `workflow ${conclusion} — server-side password rejected`
            : `workflow ${conclusion} (see Actions tab for logs)`,
          "err",
        );
      }
    } catch (err) {
      if (err && err.message === "aborted") {
        setStatus("run cancelled", null);
      } else {
        console.error("bids run failed:", err);
        setStatus(`error: ${err.message}`, "err");
      }
    } finally {
      finishRun();
    }
  }

  function cancelRun() {
    if (state.pollAbort) state.pollAbort.abort();
  }

  function finishRun() {
    state.running = false;
    state.currentPAT = null;
    state.pollAbort = null;
    $pwd.disabled = false;
    $btn.textContent = "Run bids pull";
    $btn.classList.add("primary");
    $btn.disabled = false;
  }

  $btn.addEventListener("click", () => {
    if (state.running) cancelRun();
    else runBids();
  });

  $pwd.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !state.running) {
      e.preventDefault();
      runBids();
    }
  });

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

  window.addEventListener("pagehide", () => {
    state.currentPAT = null;
  });

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
  //  INIT
  // =====================================================================
  if (restoreCachedBids()) {
    setStatus("restored last pull (this tab) — Run bids pull to refresh", null);
  } else {
    setStatus("idle — enter password to begin", null);
  }
})();
