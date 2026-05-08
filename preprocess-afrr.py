"""
preprocess-afrr.py — build data-afrr.js from ast_afrr_data.csv.

WHAT THIS DOES
==============
The aFRR scheduled-activation file (ast_afrr_data.csv) is at 4-second
cadence — about 7.9 million rows over 12 months. Each row has:

    DATETIME_UTC, AST_POS, AST_NEG

AST_POS = positive activation price (upward), AST_NEG = negative
activation price (downward). NaN means NO activation in that direction
during that 4-second slot.

By convention we DO NOT combine this with main data.js — the prices
must stay at 4-second resolution, never averaged up to 15 min. For the
"% activated" bar charts we only need counts per ISP, so this script
aggregates the 4-second activation INDICATORS into 15-min bins
indexed identically to main data.js's offsets[]:

    n_total[i]  — count of 4s slots that fell in ISP i's 15-min window
    n_pos[i]    — count of those slots where AST_POS is non-null (upward)
    n_neg[i]    — count of those slots where AST_NEG is non-null (downward)
    n_any[i]    — count where at least one direction is non-null

For the typical 15-min ISP we expect n_total ≈ 225 (15 × 60 / 4 = 225).
ISPs that fall before the aFRR data starts (2025-05-01) have n_total = 0.

OUTPUT FORMAT
=============
Outputs data-afrr.js with a global AFRR_DATA object:

    {
      n: 43070,                              // matches main data.js's n
      afrr_start_iso: "2025-05-01T00:00:00Z",
      afrr_end_iso:   "2026-05-01T21:59:56Z",
      n_total: [...],                        // length n, Int16 range
      n_pos:   [...],
      n_neg:   [...],
      n_any:   [...],
    }

Indexing matches main data.js: AFRR_DATA.n_total[i] corresponds to the
SAME ISP as WIND_DATA.da_forecast[i].

DATA REFRESH
============
Re-run after replacing ast_afrr_data.csv. data.js (main) must already
be up to date — this script reads it for the offsets[] timeline.
"""

import io
import json
import math
import os
import sys
import time

import numpy as np
import pandas as pd

# Force UTF-8 stdout on Windows so Unicode characters print cleanly.
if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

BASE = os.path.dirname(os.path.abspath(__file__))
AFRR_CSV = os.path.join(BASE, "ast_afrr_data.csv")
DATA_JS = os.path.join(BASE, "data.js")
OUT = os.path.join(BASE, "data-afrr.js")
# Per-slot spread file is split into chunks so each fits comfortably under
# GitHub's 50 MB warning threshold (and well under the 100 MB hard limit).
# The meta file is tiny; chunk files target ≤ 30 MB each.
OUT_PRICES_META = os.path.join(BASE, "data-afrr-prices-meta.js")
OUT_PRICES_CHUNK_FMT = os.path.join(BASE, "data-afrr-prices-{:03d}.js")
PRICES_CHUNK_TARGET_MB = 30


def main():
    print("Loading main data.js…", flush=True)
    with open(DATA_JS, "r", encoding="utf-8") as f:
        text = f.read()
    main_obj = json.loads(text[text.index("{") : text.rindex("}") + 1])
    n = main_obj["n"]
    start_iso = main_obj["start_iso"]
    offsets = np.asarray(main_obj["offsets"], dtype=np.int64)
    print(f"  Main data n = {n:,}, start = {start_iso}")

    # Reference epoch — same as main data's start_iso, parsed to a naive UTC datetime
    ref_ts = pd.Timestamp(start_iso[:-1])  # strip trailing 'Z'

    print(f"Loading aFRR CSV ({os.path.getsize(AFRR_CSV) / 1e6:.0f} MB)…", flush=True)
    t0 = time.time()
    df = pd.read_csv(
        AFRR_CSV,
        dtype={"AST_POS": "float32", "AST_NEG": "float32"},
    )
    print(f"  rows: {len(df):,}  ({time.time() - t0:.1f}s)")

    print("Computing 15-min bin index per row…", flush=True)
    t0 = time.time()
    # Convert to ts as Series of int64 nanoseconds, then to seconds-since-ref
    df["ts"] = pd.to_datetime(df["DATETIME_UTC"])
    sec_since_ref = (
        df["ts"].dt.tz_localize(None) - ref_ts
    ).dt.total_seconds().to_numpy()
    bin_idx = (sec_since_ref / (15 * 60)).astype(np.int64)
    print(f"  bin range: [{bin_idx.min()}, {bin_idx.max()}]  ({time.time() - t0:.1f}s)")

    print("Aggregating activation counts per 15-min bin…", flush=True)
    t0 = time.time()
    pos_mask = df["AST_POS"].notna().to_numpy().astype(np.int32)
    neg_mask = df["AST_NEG"].notna().to_numpy().astype(np.int32)
    any_mask = (pos_mask | neg_mask).astype(np.int32)

    max_bin = int(bin_idx.max()) + 1
    n_total_by_bin = np.bincount(bin_idx, minlength=max_bin)
    n_pos_by_bin = np.bincount(bin_idx, weights=pos_mask, minlength=max_bin)
    n_neg_by_bin = np.bincount(bin_idx, weights=neg_mask, minlength=max_bin)
    n_any_by_bin = np.bincount(bin_idx, weights=any_mask, minlength=max_bin)
    print(f"  done ({time.time() - t0:.1f}s)")

    # Map main data.js offsets[i] to per-ISP arrays. ISPs whose offset is
    # outside the aFRR-data range get n_total = 0.
    print("Mapping to main data ISPs…", flush=True)
    n_total = np.zeros(n, dtype=np.int16)
    n_pos = np.zeros(n, dtype=np.int16)
    n_neg = np.zeros(n, dtype=np.int16)
    n_any = np.zeros(n, dtype=np.int16)
    valid = (offsets >= 0) & (offsets < max_bin)
    n_total[valid] = n_total_by_bin[offsets[valid]].astype(np.int16)
    n_pos[valid] = n_pos_by_bin[offsets[valid]].astype(np.int16)
    n_neg[valid] = n_neg_by_bin[offsets[valid]].astype(np.int16)
    n_any[valid] = n_any_by_bin[offsets[valid]].astype(np.int16)

    # Sanity stats
    n_with_data = int((n_total > 0).sum())
    print(f"  ISPs with at least 1 aFRR slot: {n_with_data:,} / {n:,}")
    print(
        f"  Median per-ISP slot counts: total={int(np.median(n_total[n_total > 0]))}, "
        f"pos_active={int(np.median(n_pos[n_total > 0]))}, "
        f"neg_active={int(np.median(n_neg[n_total > 0]))}, "
        f"any_active={int(np.median(n_any[n_total > 0]))}"
    )

    # aFRR data range in human-readable form
    afrr_start = df["ts"].iloc[0]
    afrr_end = df["ts"].iloc[-1]
    print(f"  aFRR range: {afrr_start} → {afrr_end}")

    out = {
        "n": n,
        "afrr_start_iso": afrr_start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "afrr_end_iso": afrr_end.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "n_total": n_total.tolist(),
        "n_pos": n_pos.tolist(),
        "n_neg": n_neg.tolist(),
        "n_any": n_any.tolist(),
    }

    print("Writing data-afrr.js…", flush=True)
    js = "// Auto-generated by preprocess-afrr.py — do not edit by hand.\n"
    js += "const AFRR_DATA = " + json.dumps(out, separators=(",", ":")) + ";\n"
    js += "if (typeof module !== 'undefined') module.exports = AFRR_DATA;\n"
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(js)
    sz = os.path.getsize(OUT) / 1024
    print(f"  wrote {OUT}: {sz:.0f} KB")

    # =========================================================================
    #  data-afrr-prices.js — every-4s spread file
    #
    #  For every 4-second slot in the aFRR CSV, emit ONE entry per non-null
    #  direction (so a slot with both POS and NEG active produces two entries).
    #  The "spread" is `price - p_da[isp_idx]`. Per the user's instruction we
    #  do NOT sample, average or combine prices; every individual 4s data
    #  point that has a price is preserved.
    #
    #  Storage strategy
    #  ----------------
    #  - Two parallel arrays of equal length (number of non-null directions).
    #  - isp_idx: Int32, 0..n-1.
    #  - spread:  Float32 rounded to 1 decimal (1 EUR/MWh ≪ typical noise).
    #
    #  File size in JSON form is large (tens of MB). The browser only loads
    #  this file when the aFRR sub-tab is opened.
    # =========================================================================
    print()
    print("Computing per-slot spreads (every 4s, no sampling)…", flush=True)
    t0 = time.time()
    p_da = np.asarray(main_obj["p_da"], dtype=np.float32)
    # For each 4s row, look up its ISP index in main data via bin -> isp lookup.
    # bin_idx[k] is the 15-min bin number for row k. We need to invert offsets[]
    # to find the data.js ISP index for any bin. Build reverse map once:
    bin_to_isp = np.full(max_bin + 1, -1, dtype=np.int32)
    bin_to_isp[offsets] = np.arange(n, dtype=np.int32)
    isp_idx_per_row = bin_to_isp[bin_idx]  # -1 if outside main data window
    valid_row = isp_idx_per_row >= 0
    # POS direction
    pos_active = valid_row & df["AST_POS"].notna().to_numpy()
    pos_isp = isp_idx_per_row[pos_active]
    pos_price = df["AST_POS"].to_numpy()[pos_active].astype(np.float32)
    pos_spread = pos_price - p_da[pos_isp]
    # NEG direction
    neg_active = valid_row & df["AST_NEG"].notna().to_numpy()
    neg_isp = isp_idx_per_row[neg_active]
    neg_price = df["AST_NEG"].to_numpy()[neg_active].astype(np.float32)
    neg_spread = neg_price - p_da[neg_isp]
    # Concatenate POS + NEG into one flat list (merged distribution per the
    # user's instruction). Round spreads to 1 decimal place.
    all_isp = np.concatenate([pos_isp, neg_isp]).astype(np.int32)
    all_spread = np.concatenate([pos_spread, neg_spread]).round(1).astype(np.float32)
    print(f"  total entries: {len(all_isp):,}  ({time.time() - t0:.1f}s)")
    print(
        f"  spread stats: min={all_spread.min():.1f}, max={all_spread.max():.1f}, "
        f"median={np.median(all_spread):.1f}"
    )

    print("Writing chunked data-afrr-prices files…", flush=True)
    t0 = time.time()
    # Layout: entries [0, n_pos_entries) are POS (upward, AST_POS - p_da),
    # entries [n_pos_entries, n_entries) are NEG (downward, AST_NEG - p_da).
    # The engine uses this boundary to filter by direction without storing
    # an extra per-entry direction byte.
    n_total = int(len(all_isp))
    n_pos_total = int(len(pos_isp))
    spread_x10 = (all_spread * 10).round().astype(np.int32)

    # Pick chunk count so each chunk is ≤ PRICES_CHUNK_TARGET_MB.
    # Empirically each entry costs ≈ 10 chars in JSON ("idx,spread_x10," etc.).
    chars_per_entry = 10
    max_entries_per_chunk = (PRICES_CHUNK_TARGET_MB * 1024 * 1024) // chars_per_entry
    n_chunks = max(1, math.ceil(n_total / max_entries_per_chunk))
    entries_per_chunk = math.ceil(n_total / n_chunks)
    print(
        f"  splitting {n_total:,} entries into {n_chunks} chunks "
        f"of ~{entries_per_chunk:,} entries each"
    )

    # Meta file (tiny). Reset CHUNKS array on (re)load so re-fetching is safe.
    meta_obj = {
        "n_entries": n_total,
        "n_pos_entries": n_pos_total,
        "n_chunks": n_chunks,
    }
    meta_js = "// Auto-generated by preprocess-afrr.py — do not edit by hand.\n"
    meta_js += (
        "const AFRR_PRICES_META = "
        + json.dumps(meta_obj, separators=(",", ":"))
        + ";\n"
    )
    meta_js += "if (typeof window !== 'undefined') window.AFRR_PRICES_CHUNKS = [];\n"
    with open(OUT_PRICES_META, "w", encoding="utf-8") as f:
        f.write(meta_js)
    print(
        f"  wrote {OUT_PRICES_META}: {os.path.getsize(OUT_PRICES_META) / 1024:.1f} KB"
    )

    # Chunk files. Each one assigns its piece to AFRR_PRICES_CHUNKS[c].
    # Order is preserved across files, so concatenation in chunk-index order
    # reproduces the original full arrays exactly.
    for c in range(n_chunks):
        start = c * entries_per_chunk
        end = min(start + entries_per_chunk, n_total)
        chunk_obj = {
            "isp_idx": all_isp[start:end].tolist(),
            "spread_x10": spread_x10[start:end].tolist(),
        }
        out_path = OUT_PRICES_CHUNK_FMT.format(c + 1)
        chunk_js = (
            f"// Auto-generated by preprocess-afrr.py — chunk {c + 1}/{n_chunks}.\n"
            f"AFRR_PRICES_CHUNKS[{c}] = "
            + json.dumps(chunk_obj, separators=(",", ":"))
            + ";\n"
        )
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(chunk_js)
        sz_mb = os.path.getsize(out_path) / (1024 * 1024)
        print(f"  wrote {out_path}: {sz_mb:.1f} MB ({end - start:,} entries)")
    print(f"  done in {time.time() - t0:.1f}s")

    # Tidy up any stale single-file output from earlier preprocessor versions
    legacy = os.path.join(BASE, "data-afrr-prices.js")
    if os.path.exists(legacy):
        os.remove(legacy)
        print(f"  removed legacy {legacy}")


if __name__ == "__main__":
    main()
