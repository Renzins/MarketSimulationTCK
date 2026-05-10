"""
preprocess-afrr-15min.py — build data-afrr-15min.js with per-ISP averaged
aFRR prices.

WHY A SEPARATE FILE
===================
The Backtester's per-ISP simulation must price aFRR fast (one number per
direction per ISP). The full per-4-second AST_POS / AST_NEG file
(~86 MB) is way too big for that. So we compute, ONCE per data refresh,
two parallel arrays of length n (matching main data.js):

    avg_p_pos[i]   averaged AST_POS over 15-min ISP i (EUR/MWh)
    avg_p_neg[i]   averaged AST_NEG over 15-min ISP i (EUR/MWh)

AVERAGING CONVENTION (must agree with engine.js exactly)
========================================================
For each 15-min ISP, the average is the SUM of FAVOURABLE non-NaN 4-s
prices in that ISP, divided by 225 (the standard count: 15 min × 60 s
/ 4 s). NaN/blank slots, AND prices the wind park wouldn't have bid
on, are treated as 0 and contribute nothing to the sum.

Why filter before averaging: within a single ISP the 4-s prices can swing
sign — e.g. AST_NEG = {-10 EUR/MWh in slot 1, +50 EUR/MWh in slot 2, NaN
elsewhere}. A naive average gives (sum)/225 = +0.18 €/MWh, which under
the engine's per-direction profitability gate would mark the whole ISP
as "don't bid downward" and drop the +0.011 €/MW we'd have earned during
slot 1 alone. The fix is to filter before summing:

    AST_POS values ≤ 0 → replaced by 0 (we wouldn't bid into a
        money-losing upward direction)
    AST_NEG values ≥ 0 → replaced by 0 (we wouldn't bid into a
        downward direction where we'd be paying for the privilege)

After the filter, avg_p_pos is always ≥ 0 and avg_p_neg is always ≤ 0.
The ISP-level gate (avg_p_pos > 0 / avg_p_neg < 0) becomes equivalent
to "at least one favourable 4-s slot existed".

Why this is the right scaling: a 4-s slot's energy share of the ISP is
4/3600 hours, and an ISP is 15 min = 0.25 hours. So if a single 4-s slot
fires at 900 EUR/MWh and the rest are NaN:

    revenue per offered MW
      = 1 MW × 900 EUR/MWh × (4 s / 3600 s)
      = 1 EUR

Equivalently with our averaged price:

    avg_p_pos = (900 + 0 × 224) / 225 = 4 EUR/MWh
    revenue per offered MW = 1 MW × 4 EUR/MWh × 0.25 h = 1 EUR        ✓

POSITION FRACTION (used for L2 shortfall accounting)
====================================================
The same favourable-only logic applies to the position contribution: if
the wind park would only have bid 30 out of 100 dispatched POS slots,
its time-averaged dispatched MW is Q × 30/225, not Q × 100/225. So this
script also emits two FAVOURABLE-COUNT arrays:

    n_pos_fav[i]  count of 4-s slots in ISP i where AST_POS > 0
    n_neg_fav[i]  count of 4-s slots in ISP i where AST_NEG < 0

These are distinct from data-afrr.js's n_pos / n_neg (which count ALL
non-NaN slots regardless of sign).

DIRECTION CONVENTION
====================
AST_POS is the upward (positive activation) clearing price; AST_NEG is
the downward price. By convention POS is typically positive (system pays
generators to produce more) and NEG can be negative (system pays
generators to curtail). Revenue formulas in engine.js use:

    aFRR-up rev =  Q_up_afrr × avg_p_pos × 0.25
    aFRR-dn rev = −Q_dn_afrr × avg_p_neg × 0.25      (sign flip mirrors mFRR-dn)

NaN p_pos and p_neg both encode "no activation in that direction" — they
become 0 in the averaged file. So an ISP with no aFRR activity has
avg_p_pos = avg_p_neg = 0; the engine's aFRR terms contribute 0 to both
revenue and position.

EDGE CASES
==========
- ISPs before the aFRR data starts (2025-05-01) have no rows in the CSV,
  so their averages are 0 — consistent with engine.js's default
  zero-initialised arrays when AFRR_15MIN isn't loaded.
- Float32 storage with 2 dp rounding (matching p_mfrr / p_imb in
  data.js) keeps the JSON file ≲ 1 MB.

OUTPUT
======
Writes a single AFRR_15MIN global:

    {
      n: 43070,
      avg_p_pos: [...],   length n, EUR/MWh, rounded to 2 dp
      avg_p_neg: [...],   length n, EUR/MWh, rounded to 2 dp
      n_pos_fav: [...],   length n, Int16: 4-s slots where AST_POS > 0
      n_neg_fav: [...],   length n, Int16: 4-s slots where AST_NEG < 0
    }

DATA REFRESH
============
Run after replacing ast_afrr_data.csv:

    python preprocess-afrr-15min.py

data.js (main) and data-afrr.js must already be up to date — this script
reads data.js for the offsets[] timeline.
"""

import io
import json
import os
import sys
import time

import numpy as np
import pandas as pd

if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

BASE = os.path.dirname(os.path.abspath(__file__))
AFRR_CSV = os.path.join(BASE, "ast_afrr_data.csv")
DATA_JS = os.path.join(BASE, "data.js")
OUT = os.path.join(BASE, "data-afrr-15min.js")

# Standard 4-s slot count per 15-min ISP (15 × 60 / 4). Used as the
# denominator for the averaged price — see header comment.
SLOTS_PER_ISP = 225


def main():
    print("Loading main data.js…", flush=True)
    with open(DATA_JS, "r", encoding="utf-8") as f:
        text = f.read()
    main_obj = json.loads(text[text.index("{") : text.rindex("}") + 1])
    n = main_obj["n"]
    start_iso = main_obj["start_iso"]
    offsets = np.asarray(main_obj["offsets"], dtype=np.int64)
    print(f"  Main data n = {n:,}, start = {start_iso}")

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
    df["ts"] = pd.to_datetime(df["DATETIME_UTC"])
    sec_since_ref = (
        df["ts"].dt.tz_localize(None) - ref_ts
    ).dt.total_seconds().to_numpy()
    bin_idx = (sec_since_ref / (15 * 60)).astype(np.int64)
    print(f"  bin range: [{bin_idx.min()}, {bin_idx.max()}]  ({time.time() - t0:.1f}s)")

    print(
        "Aggregating averaged prices per 15-min bin (favourable-only filter)…",
        flush=True,
    )
    t0 = time.time()
    # Step 1 — fill NaN with 0 (no activation in that direction).
    pos_raw = df["AST_POS"].fillna(0.0).to_numpy(dtype=np.float64)
    neg_raw = df["AST_NEG"].fillna(0.0).to_numpy(dtype=np.float64)
    # Step 2 — favourable filter (see header for the rationale).
    # Only POS slots with price > 0 contribute to avg_p_pos; only NEG
    # slots with price < 0 contribute to avg_p_neg. This prevents
    # within-ISP cancellation from masking favourable sub-windows.
    pos = np.where(pos_raw > 0, pos_raw, 0.0)
    neg = np.where(neg_raw < 0, neg_raw, 0.0)
    pos_fav_mask = (pos_raw > 0).astype(np.int32)
    neg_fav_mask = (neg_raw < 0).astype(np.int32)
    max_bin = int(bin_idx.max()) + 1
    sum_pos_by_bin = np.bincount(bin_idx, weights=pos, minlength=max_bin)
    sum_neg_by_bin = np.bincount(bin_idx, weights=neg, minlength=max_bin)
    n_pos_fav_by_bin = np.bincount(bin_idx, weights=pos_fav_mask, minlength=max_bin)
    n_neg_fav_by_bin = np.bincount(bin_idx, weights=neg_fav_mask, minlength=max_bin)
    # Divide by the FIXED 225 (not by the actual row count): this gives
    # the right energy fraction even if some 4-s slots are missing from
    # the CSV. See header comment for the derivation.
    avg_pos_by_bin = sum_pos_by_bin / SLOTS_PER_ISP
    avg_neg_by_bin = sum_neg_by_bin / SLOTS_PER_ISP
    print(f"  done ({time.time() - t0:.1f}s)")

    # Map bin → ISP via offsets. ISPs whose offset falls outside the aFRR
    # data range stay at 0 (the array default).
    print("Mapping bins to main-data ISPs…", flush=True)
    avg_p_pos = np.zeros(n, dtype=np.float32)
    avg_p_neg = np.zeros(n, dtype=np.float32)
    n_pos_fav = np.zeros(n, dtype=np.int16)
    n_neg_fav = np.zeros(n, dtype=np.int16)
    valid = (offsets >= 0) & (offsets < max_bin)
    avg_p_pos[valid] = avg_pos_by_bin[offsets[valid]].astype(np.float32)
    avg_p_neg[valid] = avg_neg_by_bin[offsets[valid]].astype(np.float32)
    n_pos_fav[valid] = n_pos_fav_by_bin[offsets[valid]].astype(np.int16)
    n_neg_fav[valid] = n_neg_fav_by_bin[offsets[valid]].astype(np.int16)

    # Sanity stats
    print(
        f"  ISPs with avg_p_pos > 0: {(avg_p_pos > 0).sum():,} / {n:,}"
        f"   (favourable upward slots: median {int(np.median(n_pos_fav[n_pos_fav > 0])) if (n_pos_fav > 0).any() else 0} per ISP)"
    )
    print(
        f"  ISPs with avg_p_neg < 0: {(avg_p_neg < 0).sum():,} / {n:,}"
        f"   (favourable downward slots: median {int(np.median(n_neg_fav[n_neg_fav > 0])) if (n_neg_fav > 0).any() else 0} per ISP)"
    )
    # After the filter, avg_p_pos ≥ 0 and avg_p_neg ≤ 0 by construction.
    print(
        f"  avg_p_pos: min={avg_p_pos.min():.2f} median={np.median(avg_p_pos):.2f} "
        f"max={avg_p_pos.max():.2f}  (always ≥ 0 after filter)"
    )
    print(
        f"  avg_p_neg: min={avg_p_neg.min():.2f} median={np.median(avg_p_neg):.2f} "
        f"max={avg_p_neg.max():.2f}  (always ≤ 0 after filter)"
    )

    # ===========================================================================
    #  SANITY CHECKS — replay two worked examples
    # ===========================================================================
    print()
    print("Synthetic sanity check 1 — single 4-s slot at 900 EUR/MWh:")
    test_pos = np.array([900.0])
    test_pos_filtered = np.where(test_pos > 0, test_pos, 0.0)
    avg_test = test_pos_filtered.sum() / SLOTS_PER_ISP
    rev_per_mw = 1.0 * avg_test * 0.25
    print(f"  filtered POS sum = {test_pos_filtered.sum():.2f}")
    print(f"  avg_p_pos = sum / 225 = {avg_test:.4f} EUR/MWh")
    print(f"  rev per MW = avg × 0.25h = {rev_per_mw:.4f} EUR")
    expected = 900.0 / 225 / 4
    print(f"  expected = 900/225/4 = {expected:.4f} EUR  ", end="")
    print("OK" if abs(rev_per_mw - expected) < 1e-9 else "FAIL")

    print()
    print("Synthetic sanity check 2 — mixed-sign 15-min ISP:")
    print("  AST_NEG = [-10 EUR/MWh, +50 EUR/MWh, NaN×223]")
    print("  Old (no filter): avg = (-10 + 50)/225 = +0.178 → gate FAILS → 0 rev")
    print("  New (filter):    avg = (-10 + 0)/225 = -0.044 → gate PASSES → +0.011 €/MW")
    test_neg = np.array([-10.0, 50.0])
    test_neg_filtered = np.where(test_neg < 0, test_neg, 0.0)
    avg_neg_test = test_neg_filtered.sum() / SLOTS_PER_ISP
    rev_per_mw_dn = -1.0 * avg_neg_test * 0.25  # -Q × avg × 0.25 (mFRR-dn convention)
    print(f"  avg_p_neg = {avg_neg_test:.4f} EUR/MWh")
    print(f"  rev per MW (downward) = -avg × 0.25h = {rev_per_mw_dn:.4f} EUR")
    expected_dn = abs(-10.0) * (4 / 3600.0)  # direct integration over the 1 favourable 4-s slot
    print(f"  direct integration (1 slot × 4s × 10 €/MWh) = {expected_dn:.4f} EUR  ", end="")
    print("OK" if abs(rev_per_mw_dn - expected_dn) < 1e-9 else "FAIL")

    # Round to 2 dp to keep the JSON file size sane.
    out = {
        "n": n,
        "avg_p_pos": [round(float(v), 2) for v in avg_p_pos],
        "avg_p_neg": [round(float(v), 2) for v in avg_p_neg],
        "n_pos_fav": n_pos_fav.tolist(),
        "n_neg_fav": n_neg_fav.tolist(),
    }

    print()
    print("Writing data-afrr-15min.js…", flush=True)
    js = "// Auto-generated by preprocess-afrr-15min.py — do not edit by hand.\n"
    js += "const AFRR_15MIN = " + json.dumps(out, separators=(",", ":")) + ";\n"
    js += "if (typeof module !== 'undefined') module.exports = AFRR_15MIN;\n"
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(js)
    sz = os.path.getsize(OUT) / 1024
    print(f"  wrote {OUT}: {sz:.0f} KB")


if __name__ == "__main__":
    main()
