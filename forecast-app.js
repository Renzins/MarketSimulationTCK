// forecast-app.js — UI controller for the Forecast page.
//
// ARCHITECTURE
// ============
// This page is on a PUBLIC repo (GitHub Pages) but the model + data
// live in a SEPARATE PRIVATE repo (`reporun` per OVERVIEW.md). We talk
// to the private repo through a GitHub PAT that is encrypted at rest
// with the team's shared password (PBKDF2 → AES-GCM). The plaintext
// PAT only exists in browser memory between a successful Activate and
// the next Deactivate / reload.
//
// FLOW
// ====
//   On page load: do NOT fetch anything. Charts stay blank. Status
//     reads "idle — enter password to begin". The PAT is not yet
//     unlocked, so even the Contents API is unreachable.
//   Run forecast (one shot per click — NO automatic repeat):
//     1. Read typed password from #pwd-input.
//     2. unlockPAT(password) — PBKDF2-derive key + AES-GCM decrypt the
//        ENCRYPTED_PAT blob.
//        - Wrong password → AES-GCM auth-tag mismatch → caught here,
//          surface as "wrong password", clear field, stay blank.
//        - Right password → plaintext PAT in memory for this run only.
//     3. dispatchWorkflow(password) — fires off a SINGLE workflow run.
//     4. waitForRunCompletion — polls every 5 s until completed, giving
//        up after the 15-minute timeout.
//     5. fetchAndRender — read forecast.json + draw charts.
//     6. Wipe the in-memory PAT, return the button to "Run forecast".
//        The run happens exactly once. To get a fresh forecast the user
//        clicks the button again — there is no interval / cron loop.
//   Cancel (while a run is in flight): abort the poll, wipe the
//   in-memory PAT, re-enable controls. The last-rendered charts stay on
//   screen.
//
// SECURITY
// ========
// What's in the source repo:
//   - ENCRYPTED_PAT = { iterations, salt, iv, ciphertext } (all base64
//     random-looking bytes). No PAT, no password.
//   - The protective strength is whatever entropy the password has.
//     PBKDF2(SHA-256, 600 k+ iter) makes each guess cost ~1 s of
//     compute; AES-GCM gives a clean wrong-key signal.
// What's NEVER in the source repo:
//   - The PAT in plaintext.
//   - The password in any form (plaintext, hash, hint, autocomplete).
// What's in memory during a run:
//   - The decrypted PAT (local to a single run, dropped the moment the
//     run finishes or is cancelled).
//   - The typed password (input value). It stays in the masked field
//     between runs so a re-run is a single click; it is never persisted
//     to disk, browser storage or URL, and reload clears it.
// The server-side password gate inside the workflow is independent —
// even if someone breaks the client-side encryption, the workflow's
// first step still checks the typed password against RUN_PASSWORD and
// exits in ~5 s if wrong.

(() => {
  // =====================================================================
  //  CONFIGURATION — FILL THESE IN BEFORE DEPLOYING
  // =====================================================================
  // The owner + repository name of the PRIVATE repo that runs the
  // forecast and holds forecast.json. Example: "myorg" / "baltic-forecast".
  const REPO_OWNER = "Renzins";
  const REPO_NAME = "RetrievalTCK";

  // Workflow filename in .github/workflows/. Matches the YAML you
  // committed (default per OVERVIEW.md is "forecast.yml").
  const WORKFLOW_FILENAME = "forecast.yml";

  // forecast.json path within the private repo. Bare filename works
  // because reporun commits it at the root.
  const FORECAST_PATH = "forecast.json";

  // ---------------------------------------------------------------------
  //  Encrypted PAT blob — paste output of encrypt-pat.html here.
  //  All four fields are base64. The PAT itself is recoverable only
  //  with the matching password via Web Crypto PBKDF2 + AES-GCM.
  // ---------------------------------------------------------------------
  const ENCRYPTED_PAT = {
  iterations: 600000,
  salt:       "QsLeE7XFZICRJJ+Xurw2vA==",
  iv:         "4vbkJbJ0LWmuJK7k",
  ciphertext: "KMVQCivBgrhhg3ouq4S+NHQ6VH/6IktOf5yBFiWQOkm+Ipe6uKNFBggM4gBvNsA1h3LQsOS02WNB976gkZt6M6OBcugnJM+DKVq5tlvHma7R5JPP1XYFQI9tESxI0teN86qMcNdIjn0CVN791Q=="
};

  // Poll-for-completion cadence after a dispatch.
  const POLL_INTERVAL_MS = 5 * 1000; // 5 s
  const POLL_MAX_MS = 15 * 60 * 1000; // give up after 15 min

  // sessionStorage key for the last completed forecast (per-tab cache).
  // Bump the version suffix if forecast.json's shape ever changes so a
  // stale-shaped cache can't be rendered. Holds only the forecast OUTPUT —
  // never the PAT or password (see SECURITY note at the top of this file).
  const FORECAST_CACHE_KEY = "tck.forecast.v1";

  // =====================================================================
  //  DOM HANDLES
  // =====================================================================
  const $repo = document.getElementById("repo-display");
  const $pwd = document.getElementById("pwd-input");
  const $btn = document.getElementById("activate-btn");
  const $status = document.getElementById("status-text");
  const $lastUpdated = document.getElementById("last-updated");

  $repo.textContent = `${REPO_OWNER}/${REPO_NAME}`;

  // =====================================================================
  //  STATE
  // =====================================================================
  // running: a single forecast run currently in flight?
  // currentPAT: decrypted plaintext PAT, in memory only during a run.
  // pollAbort: AbortController for the in-flight poll so Cancel
  //   short-circuits cleanly.
  // lastForecastTimestamp: ISO string from forecast.json, for the header.
  const state = {
    running: false,
    currentPAT: null,
    pollAbort: null,
    lastForecastTimestamp: null,
  };

  // =====================================================================
  //  CRYPTO — unlock the PAT with the typed password
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
          " PAT, and paste the snippet into forecast-app.js.",
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
    // AES-GCM raises OperationError on auth-tag failure — that's our
    // wrong-password signal. Any other thrown error is a real bug.
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
    // kind: "ok" | "warn" | "err" | undefined (idle)
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
    $lastUpdated.textContent = relativeTime(state.lastForecastTimestamp);
  }
  setInterval(updateLastUpdated, 30 * 1000);

  function ghHeaders() {
    if (!state.currentPAT) {
      throw new Error("PAT not unlocked — Activate with a valid password first.");
    }
    return {
      Authorization: `Bearer ${state.currentPAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  function decodeContent(b64) {
    const clean = b64.replace(/\s+/g, "");
    const bytes = atob(clean);
    try {
      return decodeURIComponent(escape(bytes));
    } catch (_) {
      return bytes;
    }
  }

  // =====================================================================
  //  GITHUB API CALLS
  // =====================================================================
  async function fetchForecastJson() {
    const url =
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FORECAST_PATH}` +
      `?ref=main&_t=${Date.now()}`;
    const res = await fetch(url, { headers: ghHeaders() });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`fetch forecast.json failed: ${res.status} ${detail}`);
    }
    const meta = await res.json();
    if (!meta.content) throw new Error("forecast.json response has no content");
    return JSON.parse(decodeContent(meta.content));
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
        else setStatus(`computing… ${elapsed} s elapsed`, "warn");
        lastElapsedMsg = elapsed;
      }

      if (run && run.status === "completed") return run;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`poll timed out after ${POLL_MAX_MS / 1000} s`);
  }

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

  async function fetchAndRender() {
    const forecast = await fetchForecastJson();
    if (forecast.error) {
      setStatus(`forecast.json has error: ${forecast.error}`, "err");
      return forecast;
    }
    renderForecastObject(forecast);
    // Cache the completed forecast for this tab so navigating to the
    // Backtester / Graphs and back keeps it on screen (sessionStorage
    // survives same-tab navigation/reload, clears on tab close). Best-effort.
    try {
      sessionStorage.setItem(FORECAST_CACHE_KEY, JSON.stringify(forecast));
    } catch (_) {
      /* storage disabled or full — caching is non-critical */
    }
    return forecast;
  }

  // =====================================================================
  //  RUN — one forecast run per click, no automatic repeat
  // =====================================================================
  // A single click dispatches the workflow once, waits for it, redraws
  // the charts, then returns to idle. There is no interval / cron loop:
  // a fresh forecast only happens when the user clicks again.
  async function runForecast() {
    const pwd = $pwd.value;
    if (!pwd) {
      setStatus("enter a password before running", "warn");
      $pwd.focus();
      return;
    }

    // Enter "running" mode. The password field is disabled but keeps its
    // value so the next run is a single click. The button is briefly
    // disabled while the PAT unlocks (~1 s of PBKDF2), then becomes
    // Cancel for the long poll.
    state.running = true;
    $btn.disabled = true;
    $pwd.disabled = true;
    setStatus("unlocking PAT…", "warn");

    try {
      state.currentPAT = await unlockPAT(pwd);
    } catch (err) {
      // OperationError = wrong password. Anything else = misconfig.
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

    // PAT unlocked — let the user abort the (potentially 15-minute) poll.
    $btn.textContent = "Cancel";
    $btn.classList.remove("primary");
    $btn.disabled = false;

    const sinceMs = Date.now();
    try {
      setStatus("dispatching…", "warn");
      // The same password unlocked the PAT locally and gates the run
      // server-side. The dispatch proves they match: a mismatch makes
      // the workflow's first step auth-fail fast.
      await dispatchWorkflow(pwd);
      state.pollAbort = new AbortController();
      const run = await waitForRunCompletion(sinceMs, state.pollAbort.signal);
      if (run.conclusion === "success") {
        await fetchAndRender();
        setStatus(`refreshed at ${new Date().toLocaleTimeString()}`, "ok");
      } else {
        const conclusion = run.conclusion || "failed";
        // First step of the workflow is the password check (~5 s). A
        // fast failure is almost certainly the server-side gate
        // rejecting the password even though decryption succeeded
        // locally (e.g. RUN_PASSWORD rotated without re-encrypting the
        // PAT).
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
        console.error("forecast run failed:", err);
        setStatus(`error: ${err.message}`, "err");
      }
    } finally {
      finishRun();
    }
  }

  // Cancel an in-flight run: abort the poll. The runForecast finally
  // block (via finishRun) does the actual teardown.
  function cancelRun() {
    if (state.pollAbort) state.pollAbort.abort();
  }

  // Tear down after a run ends for any reason (success, failure, wrong
  // password, cancel). Wipes the in-memory PAT and returns the UI to its
  // idle, ready-to-run-again state. The password is left in the field so
  // the next run is one click. JS strings are immutable so we can't
  // scrub the bytes — just drop references and let GC reclaim them.
  function finishRun() {
    state.running = false;
    state.currentPAT = null;
    state.pollAbort = null;
    $pwd.disabled = false;
    $btn.textContent = "Run forecast";
    $btn.classList.add("primary");
    $btn.disabled = false;
  }

  $btn.addEventListener("click", () => {
    if (state.running) cancelRun();
    else runForecast();
  });

  // Enter in the password field starts a run (a no-op while one is
  // already in flight, since the field is disabled then anyway).
  $pwd.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !state.running) {
      e.preventDefault();
      runForecast();
    }
  });

  // Best-effort secret wipe when the page is closed or hidden. Doesn't
  // help against a hostile attacker with debugger access, but reduces
  // exposure to "left the tab open on a shared computer" scenarios.
  window.addEventListener("pagehide", () => {
    state.currentPAT = null;
  });

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
  // No initial network fetch — the PAT isn't unlocked yet. But if this tab
  // already produced a forecast earlier this session, restore it from the
  // per-tab cache so navigating away and back doesn't lose a completed run.
  if (restoreCachedForecast()) {
    setStatus("restored last forecast (this tab) — Run forecast to refresh", null);
  } else {
    setStatus("idle — enter password to begin", null);
  }
})();
