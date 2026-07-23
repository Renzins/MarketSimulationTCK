// gh-run.js — shared GitHub-Actions run client for the Forecast and Bid-data
// pages.
//
// One page = one output file produced by one workflow_dispatch workflow in
// the PRIVATE repo below. This module owns the entire run lifecycle the two
// pages used to duplicate (~230 lines each — the duplication is where the
// "error payload overwritten by a green refreshed" bug and the PAT-rotation
// trap both came from):
//
//   password → unlockPAT (PBKDF2 → AES-GCM on the blob below)
//            → dispatch the workflow (the server re-checks the password)
//            → poll the WORKFLOW-SCOPED run list until the run completes
//            → fetch the output file (raw media type)
//            → hand the parsed payload to the page's onResult
//
// PAT ROTATION
// ============
// Encrypt the new PAT with encrypt-pat.html and paste the snippet over
// ENCRYPTED_PAT below. This file is the ONLY copy — both pages pick it up.
// (Historically the blob was pasted into forecast-app.js AND bids-app.js;
// rotating only one silently broke the other page.)
//
// SECURITY
// ========
// What's in the source repo: ENCRYPTED_PAT = { iterations, salt, iv,
// ciphertext } — random-looking base64, no PAT, no password. PBKDF2
// (SHA-256, 600k iterations) makes each password guess cost ~1 s; AES-GCM
// gives a clean wrong-key signal (OperationError). What's never in the repo
// or in browser storage: the plaintext PAT and the password. The PAT exists
// in memory only between unlock and finishRun/pagehide; the password stays
// in the masked input and leaves the browser only inside the HTTPS dispatch
// body (the workflow's first step checks it server-side against
// RUN_PASSWORD, so the client-side crypto is not the only gate).
//
// FETCH MODE
// ==========
// Output files are fetched with the GitHub "raw" media type + cache:
// no-store: streams the file directly (up to 100 MB), no base64 step, and
// immune to the Contents API's 1 MB inline limit — one fetch mode for both
// the ~2 KB forecast.json and the ~1 MB bids.json.
//
// PAGE CONTRACT (both pages ship the same control ids):
//   #repo-display  #pwd-input  #activate-btn  #status-text
//   GhRun.attach({ workflowFile, outputPath, runLabel, progressVerb,
//                  onResult })
//     onResult(payload) — render + cache. Called only when the run succeeded
//     AND the payload carries no `error` field; the green "refreshed" status
//     is set only after onResult returns, so an error payload stays on
//     screen instead of being overwritten.
//   GhRun.setStatus(text, kind) / GhRun.relativeTime(iso) — shared helpers
//     for the pages' restore/idle status lines.

const GhRun = (() => {
  const REPO_OWNER = "Renzins";
  const REPO_NAME = "RetrievalTCK";

  // Encrypted PAT blob — paste output of encrypt-pat.html here (see PAT
  // ROTATION above). All four fields are base64.
  const ENCRYPTED_PAT = {
    iterations: 600000,
    salt: "QsLeE7XFZICRJJ+Xurw2vA==",
    iv: "4vbkJbJ0LWmuJK7k",
    ciphertext:
      "KMVQCivBgrhhg3ouq4S+NHQ6VH/6IktOf5yBFiWQOkm+Ipe6uKNFBggM4gBvNsA1h3LQsOS02WNB976gkZt6M6OBcugnJM+DKVq5tlvHma7R5JPP1XYFQI9tESxI0teN86qMcNdIjn0CVN791Q==",
  };

  const POLL_INTERVAL_MS = 5 * 1000; // 5 s
  const POLL_MAX_MS = 15 * 60 * 1000; // give up after 15 min

  const API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;

  // ---- DOM handles (identical ids on both pages) ------------------------
  const $repo = document.getElementById("repo-display");
  const $pwd = document.getElementById("pwd-input");
  const $btn = document.getElementById("activate-btn");
  const $status = document.getElementById("status-text");
  if ($repo) $repo.textContent = `${REPO_OWNER}/${REPO_NAME}`;

  // ---- state -------------------------------------------------------------
  let running = false;
  let currentPAT = null; // plaintext PAT, in memory only during a run
  let pollAbort = null;

  // ---- crypto ------------------------------------------------------------
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
          " PAT, and paste the snippet into gh-run.js.",
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

  // ---- UI helpers ----------------------------------------------------------
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

  // ---- GitHub API ----------------------------------------------------------
  function ghHeaders(extra) {
    if (!currentPAT) {
      throw new Error("PAT not unlocked — run with a valid password first.");
    }
    return {
      Authorization: `Bearer ${currentPAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(extra || {}),
    };
  }

  // GET wrapper: abort-aware, no-store. 401/403 throw — an expired/revoked
  // PAT will not heal by retrying. (GitHub also serves 403 for hard rate
  // limiting; at ~180 authenticated calls per 15-min run vs the 5000/h
  // limit, aborting fast on 403 is the accepted trade-off.) Every other
  // status is returned to the caller — the poll loop rides out transient
  // 5xx / secondary rate limits, one-shot callers turn !ok into a hard
  // error with the status detail.
  async function ghGet(url, signal, extraHeaders) {
    const res = await fetch(url, {
      headers: ghHeaders(extraHeaders),
      signal,
      cache: "no-store",
    });
    if (res.status === 401 || res.status === 403) {
      const detail = await res.text().catch(() => "");
      throw new Error(`GitHub auth failed: ${res.status} ${detail}`);
    }
    return res;
  }

  async function fetchOutput(cfg, signal) {
    const url = `${API}/contents/${cfg.outputPath}?ref=main`;
    const res = await ghGet(url, signal, {
      Accept: "application/vnd.github.raw+json",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`fetch ${cfg.outputPath} failed: ${res.status} ${detail}`);
    }
    return JSON.parse(await res.text());
  }

  // Dispatch returns the run-matching anchor: GitHub's own clock (Date
  // response header) when the browser exposes it, else the local clock
  // captured BEFORE the POST. In practice api.github.com does not include
  // Date in Access-Control-Expose-Headers, so cross-origin reads return
  // null and the pre-dispatch local timestamp is the working anchor — the
  // −2 s tolerance in findRecentRun plus GitHub's async run creation cover
  // ordinary clock skew.
  async function dispatchWorkflow(cfg, password, signal) {
    const beforeMs = Date.now();
    const url = `${API}/actions/workflows/${cfg.workflowFile}/dispatches`;
    const res = await fetch(url, {
      method: "POST",
      headers: { ...ghHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: { password, reason: "button" } }),
      signal,
    });
    if (res.status !== 204) {
      const detail = await res.text().catch(() => "");
      throw new Error(`dispatch failed: ${res.status} ${detail}`);
    }
    const serverMs = Date.parse(res.headers.get("date") || "");
    return isNaN(serverMs) ? beforeMs : serverMs;
  }

  // One list-runs attempt. Returns { run } on a match, { transient: status }
  // on a retryable non-OK response, {} when the run hasn't registered yet.
  async function findRecentRun(cfg, sinceMs, signal) {
    const url =
      `${API}/actions/workflows/${cfg.workflowFile}/runs` +
      `?event=workflow_dispatch&per_page=5`;
    const res = await ghGet(url, signal);
    if (!res.ok) return { transient: res.status };
    const data = await res.json();
    for (const r of data.workflow_runs || []) {
      if (new Date(r.created_at).getTime() >= sinceMs - 2000) return { run: r };
    }
    return {};
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      };
      const t = setTimeout(() => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function waitForRunCompletion(cfg, sinceMs, signal) {
    const start = Date.now();
    let lastElapsedMsg = -1;
    let runId = null;
    while (Date.now() - start < POLL_MAX_MS) {
      if (signal.aborted) throw new Error("aborted");
      let run = null;
      let transient = null;
      if (runId == null) {
        const f = await findRecentRun(cfg, sinceMs, signal);
        if (f.run) {
          run = f.run;
          runId = run.id;
        }
        transient = f.transient || null;
      } else {
        const res = await ghGet(`${API}/actions/runs/${runId}`, signal);
        if (res.ok) run = await res.json();
        else transient = res.status;
      }

      const elapsed = Math.floor((Date.now() - start) / 1000);
      if (elapsed !== lastElapsedMsg) {
        if (transient)
          setStatus(`GitHub returned ${transient} — retrying… ${elapsed} s`, "warn");
        else if (!run)
          setStatus(`waiting for run to register… ${elapsed} s`, "warn");
        else if (run.status === "completed")
          setStatus(
            `run ${run.conclusion} in ${elapsed} s`,
            run.conclusion === "success" ? "ok" : "err",
          );
        else setStatus(`${cfg.progressVerb}… ${elapsed} s elapsed`, "warn");
        lastElapsedMsg = elapsed;
      }

      if (run && run.status === "completed") return run;
      await sleep(POLL_INTERVAL_MS, signal);
    }
    throw new Error(`poll timed out after ${POLL_MAX_MS / 1000} s`);
  }

  // ---- run orchestration — one run per click, no automatic repeat ---------
  async function run(cfg) {
    const pwd = $pwd.value;
    if (!pwd) {
      setStatus("enter a password before running", "warn");
      $pwd.focus();
      return;
    }

    running = true;
    $btn.disabled = true;
    $pwd.disabled = true;
    setStatus("unlocking PAT…", "warn");

    try {
      currentPAT = await unlockPAT(pwd);
    } catch (err) {
      // OperationError = wrong password. Anything else = misconfig.
      const isWrongPwd = err && err.name === "OperationError";
      setStatus(
        isWrongPwd ? "wrong password" : `unlock failed: ${err.message}`,
        "err",
      );
      $pwd.value = "";
      finishRun(cfg);
      $pwd.focus();
      return;
    }

    // PAT unlocked — let the user abort the (potentially 15-minute) poll.
    $btn.textContent = "Cancel";
    $btn.classList.remove("primary");
    $btn.disabled = false;

    const startedLocal = Date.now(); // local clock, for the fast-fail heuristic
    try {
      setStatus("dispatching…", "warn");
      // Abort controller created BEFORE the dispatch so Cancel also bites
      // during a stalled POST, not just during the poll.
      pollAbort = new AbortController();
      // The same password unlocked the PAT locally and gates the run
      // server-side; a mismatch makes the workflow's first step fail fast.
      const sinceMs = await dispatchWorkflow(cfg, pwd, pollAbort.signal);
      const finished = await waitForRunCompletion(cfg, sinceMs, pollAbort.signal);
      if (finished.conclusion === "success") {
        const payload = await fetchOutput(cfg, pollAbort.signal);
        if (payload && payload.error) {
          // The workflow succeeded but the producer reported a failure —
          // keep this on screen; the charts keep their previous data.
          setStatus(`${cfg.outputPath} reports an error: ${payload.error}`, "err");
        } else {
          await cfg.onResult(payload);
          setStatus(`refreshed at ${new Date().toLocaleTimeString()}`, "ok");
        }
      } else {
        const conclusion = finished.conclusion || "failed";
        // The workflow's first step is the password check (~5 s): a fast
        // failure is almost certainly the server-side gate rejecting the
        // password even though decryption succeeded locally (e.g.
        // RUN_PASSWORD rotated without re-encrypting the PAT).
        const likelyAuth = Date.now() - startedLocal < 30000;
        setStatus(
          likelyAuth
            ? `workflow ${conclusion} — server-side password rejected`
            : `workflow ${conclusion} (see Actions tab for logs)`,
          "err",
        );
      }
    } catch (err) {
      if (err && (err.message === "aborted" || err.name === "AbortError")) {
        setStatus("run cancelled", null);
      } else {
        console.error(`${cfg.workflowFile} run failed:`, err);
        setStatus(`error: ${err.message}`, "err");
      }
    } finally {
      finishRun(cfg);
    }
  }

  // Tear down after a run ends for any reason (success, failure, wrong
  // password, cancel). Wipes the in-memory PAT and returns the UI to idle.
  // The password stays in the masked field so a re-run is one click; JS
  // strings are immutable so we drop references and let GC reclaim them.
  function finishRun(cfg) {
    running = false;
    currentPAT = null;
    pollAbort = null;
    $pwd.disabled = false;
    $btn.textContent = cfg.runLabel;
    $btn.classList.add("primary");
    $btn.disabled = false;
  }

  // ---- page wiring ---------------------------------------------------------
  function attach(cfg) {
    $btn.addEventListener("click", () => {
      if (running) {
        if (pollAbort) pollAbort.abort(); // Cancel: aborts fetches + sleep
      } else {
        run(cfg);
      }
    });
    // Enter in the password field starts a run (no-op while one is in
    // flight — the field is disabled then anyway).
    $pwd.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !running) {
        e.preventDefault();
        run(cfg);
      }
    });
    // Best-effort secret wipe when the page is closed or hidden.
    window.addEventListener("pagehide", () => {
      currentPAT = null;
    });
  }

  return { attach, setStatus, relativeTime };
})();
