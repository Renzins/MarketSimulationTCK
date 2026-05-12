"""Scratch analysis for the TL-quadrant divergence in the mFRR/aFRR-POS scatter.

Goal: quantify how often mFRR is dead/down WHILE aFRR-POS clears above DA,
test whether that state is predictable from observable lagged signals, and
estimate the headline value of routing volume conditionally.

Runs against the project's JS-side data (data.js + the chunked 4-s price
file) — parses them as JSON-ish blobs, no pandas required. Standalone; not
hooked into the test suite.
"""
from __future__ import annotations
import json, re, sys, os, time
from pathlib import Path
BASE = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# 1. Load data.js — main per-ISP arrays
# ---------------------------------------------------------------------------
def parse_data_js(path):
    text = path.read_text(encoding="utf-8")
    blob = text[text.index("{"):text.rindex("}") + 1]
    return json.loads(blob)

print("Loading data.js…", flush=True)
t0 = time.time()
D = parse_data_js(BASE / "data.js")
print(f"  n = {D['n']:,}  ({time.time()-t0:.1f}s)")

# Convert to numpy-free Python lists (small dataset, ~43k rows)
n = D["n"]
p_mfrr = D["p_mfrr"]                       # may contain None
p_da   = D["p_da"]
da_fc  = D["da_forecast"]

# ---------------------------------------------------------------------------
# 2. Load data-afrr-15min.js — favourable-only aFRR averages (used here just
#    for the per-ISP "was aFRR-POS active at all" gate, since AST_POS could
#    clear in any slot — we'll get raw 4-s for the actual spreads below)
# ---------------------------------------------------------------------------
def parse_jsdata(path):
    text = path.read_text(encoding="utf-8")
    blob = text[text.index("{"):text.rindex("}") + 1]
    return json.loads(blob)

# ---------------------------------------------------------------------------
# 3. Load chunked 4-s price file — AFRR_PRICES = isp_idx[], spread_x10[]
# ---------------------------------------------------------------------------
print("Loading chunked 4-s aFRR price file…", flush=True)
t0 = time.time()
meta = parse_jsdata(BASE / "data-afrr-prices-meta.js")
n_pos_entries = meta["n_pos_entries"]
n_chunks = meta["n_chunks"]

isp_idx = []
spread_x10 = []
for k in range(1, n_chunks + 1):
    chunk = parse_jsdata(BASE / f"data-afrr-prices-{k:03d}.js")
    isp_idx.extend(chunk["isp_idx"])
    spread_x10.extend(chunk["spread_x10"])
print(f"  entries: {len(isp_idx):,}  ({time.time()-t0:.1f}s)")
assert len(isp_idx) == meta["n_entries"], "chunk concatenation length mismatch"

# Slice into POS (upward) and NEG (downward) — per the preprocess layout.
pos_isp    = isp_idx[:n_pos_entries]
pos_spread = spread_x10[:n_pos_entries]   # = (AST_POS − p_da) * 10, int32
neg_isp    = isp_idx[n_pos_entries:]
neg_spread = spread_x10[n_pos_entries:]
print(f"  POS slots: {len(pos_isp):,}   NEG slots: {len(neg_isp):,}")

# ---------------------------------------------------------------------------
# H1 — TL-quadrant magnitude (POS scatter)
# Define mFRR direction by sign at thresholds ±1 (matches engine.js convention).
# "mFRR dead or down" ⇔  pmf ≤ +1.  Actually let's be more careful and split:
#    mFRR up   = pmf >= +1
#    mFRR dead = -1 < pmf < +1
#    mFRR dn   = pmf <= -1
# TL = (mFRR dead OR dn) AND aFRR-POS spread > 0
# ---------------------------------------------------------------------------
print("\n=== H1: TL quadrant of mFRR/aFRR-POS scatter ===")
tl_dead = 0   # mFRR in dead band, aFRR-POS > 0
tl_down = 0   # mFRR ≤ -1,         aFRR-POS > 0
tr      = 0   # mFRR ≥ +1,         aFRR-POS > 0   (agreement upward)
br      = 0   # mFRR ≥ +1,         aFRR-POS < 0
bl      = 0   # mFRR ≤ -1 or dead, aFRR-POS < 0
total_pos_slots_with_pmfrr = 0

# For sum of aFRR-POS spread in TL (to estimate revenue if we were collecting
# that aFRR while routing AWAY from mFRR for those slots)
tl_dead_sum_spread = 0.0
tl_down_sum_spread = 0.0
tr_sum_spread      = 0.0

for k, i in enumerate(pos_isp):
    pmf = p_mfrr[i]
    if pmf is None:
        continue
    sp = pos_spread[k] * 0.1   # AST_POS − p_da
    total_pos_slots_with_pmfrr += 1
    if pmf >= 1:
        if sp >= 0: tr += 1; tr_sum_spread += sp
        else:       br += 1
    elif pmf <= -1:
        if sp >= 0: tl_down += 1; tl_down_sum_spread += sp
        else:       bl += 1
    else:  # dead band
        if sp >= 0: tl_dead += 1; tl_dead_sum_spread += sp
        else:       bl += 1

def pct(v, base): return f"{v:,} ({100*v/base:.1f}%)"

print(f"  Total POS slots with mFRR data: {total_pos_slots_with_pmfrr:,}")
print(f"  TR (mFRR ≥ +1, aFRR-POS ≥ 0):   {pct(tr,      total_pos_slots_with_pmfrr)}   sum_spread = {tr_sum_spread:,.0f} €/MWh·slot")
print(f"  TL/dead (mFRR dead, aFRR > 0):  {pct(tl_dead, total_pos_slots_with_pmfrr)}   sum_spread = {tl_dead_sum_spread:,.0f}")
print(f"  TL/down (mFRR ≤ -1, aFRR > 0):  {pct(tl_down, total_pos_slots_with_pmfrr)}   sum_spread = {tl_down_sum_spread:,.0f}")
print(f"  BR (mFRR ≥ +1, aFRR < 0):       {pct(br, total_pos_slots_with_pmfrr)}")
print(f"  BL (mFRR ≤ -1 or dead, aFRR<0): {pct(bl, total_pos_slots_with_pmfrr)}")
tl_total = tl_dead + tl_down
print(f"  TL TOTAL (mFRR not up, aFRR>0): {pct(tl_total, total_pos_slots_with_pmfrr)}   sum_spread = {tl_dead_sum_spread+tl_down_sum_spread:,.0f}")
print(f"  Mean aFRR-POS spread in TL (€/MWh): {(tl_dead_sum_spread+tl_down_sum_spread)/max(1,tl_total):.2f}")
print(f"  Mean aFRR-POS spread in TR (€/MWh): {tr_sum_spread/max(1,tr):.2f}")

# ---------------------------------------------------------------------------
# H4 — split of TL slots into dead-band vs down-firing mFRR
# Already computed above; ratio matters for interpretation:
#   if dead/down >> 1, then mFRR is mostly idle (the "easy" divergence:
#   route to aFRR when mFRR sits out)
#   if dead/down ≈ 1, then mFRR is actively going DOWN while aFRR goes UP
#   (the markets actively disagree — more interesting)
# ---------------------------------------------------------------------------
print(f"\n=== H4: TL composition — dead vs actively-down ===")
print(f"  TL dead-band:    {pct(tl_dead, tl_total)}")
print(f"  TL mFRR-down:    {pct(tl_down, tl_total)}")

# ---------------------------------------------------------------------------
# H2 — persistence: of the ISPs that are "TL on average" (i.e. avg POS spread
# > 0 in that ISP AND mFRR is dead/down), does the property persist into the
# next ISP?
# We'd want a one-step Markov: P(TL_{i+1} | TL_i)  vs  P(TL_{i+1})
# Need per-ISP aggregations first.
# ---------------------------------------------------------------------------
print("\n=== H2: persistence of the TL state across consecutive ISPs ===")
# build per-ISP avg AST_POS spread (sum over active slots / 225 — 4s)
sum_pos_by_isp = [0.0]*n
n_active_pos_by_isp = [0]*n
for k, i in enumerate(pos_isp):
    sum_pos_by_isp[i] += pos_spread[k] * 0.1
    n_active_pos_by_isp[i] += 1
# avg aFRR-POS spread per ISP (225-divisor, idle slots = 0)
avg_pos_spread = [(sum_pos_by_isp[i] + n_active_pos_by_isp[i] * 0) / 225 for i in range(n)]
# Wait — we want the spread = AST_POS − p_da. Already that. The 225-divisor
# treats null slots as 0 spread, which means "0 €/MWh in that slot" — that's
# the "earnings rate" not the "spread vs DA". For sign-direction purposes the
# distinction matters mainly at the threshold. Use the natural definition:
#    is_tl_isp[i] = (mFRR not up) AND (any positive-spread slot exists)
# i.e. there was at least one slot above DA in the ISP. Tighter:
#    is_tl_isp[i] = (mFRR not up) AND (sum_pos_spread / n_active > 0)
# Use the average of ACTIVE slots (so we ignore idle).

is_tl_isp = [False]*n
for i in range(n):
    pmf = p_mfrr[i]
    if pmf is None: continue
    if pmf >= 1:  # mFRR up — not TL
        continue
    if n_active_pos_by_isp[i] == 0: continue   # no aFRR-POS activity
    mean_active = sum_pos_by_isp[i] / n_active_pos_by_isp[i]
    if mean_active > 0:
        is_tl_isp[i] = True

n_tl_isp  = sum(is_tl_isp)
print(f"  ISPs flagged TL (mFRR not up & avg active AST_POS > DA): {n_tl_isp:,} ({100*n_tl_isp/n:.1f}% of {n:,})")

# Persistence transition counts
n_tl_to_tl   = 0
n_tl_to_nottl = 0
n_nottl_to_tl = 0
for i in range(n-1):
    if is_tl_isp[i]:
        if is_tl_isp[i+1]: n_tl_to_tl += 1
        else:               n_tl_to_nottl += 1
    else:
        if is_tl_isp[i+1]: n_nottl_to_tl += 1
n_starts_tl = n_tl_to_tl + n_tl_to_nottl
n_starts_nottl = (n-1) - n_starts_tl
p_tl = n_tl_isp / n
p_tl_given_tl = n_tl_to_tl / max(1, n_starts_tl)
p_tl_given_nottl = n_nottl_to_tl / max(1, n_starts_nottl)
lift = p_tl_given_tl / max(1e-9, p_tl) if p_tl else 0
print(f"  P(TL next ISP):                          {p_tl:.3f}")
print(f"  P(TL next ISP | this ISP is TL):         {p_tl_given_tl:.3f}   (lift = {lift:.2f}×)")
print(f"  P(TL next ISP | this ISP is NOT TL):     {p_tl_given_nottl:.3f}")

# ---------------------------------------------------------------------------
# H3 — DA-level conditioning: does TL frequency / magnitude move with p_da?
# Bin p_da into quartiles and report TL stats per quartile.
# ---------------------------------------------------------------------------
print("\n=== H3: DA-level conditioning ===")
import statistics
pda_valid = [(i, p_da[i]) for i in range(n) if p_da[i] is not None]
pda_sorted = sorted(v for _, v in pda_valid)
q = [pda_sorted[int(p * (len(pda_sorted)-1))] for p in [0.25, 0.5, 0.75]]
bin_names = [f"≤{q[0]:.0f}", f"{q[0]:.0f}–{q[1]:.0f}", f"{q[1]:.0f}–{q[2]:.0f}", f">{q[2]:.0f}"]
def bin_idx(v, q):
    if v <= q[0]: return 0
    if v <= q[1]: return 1
    if v <= q[2]: return 2
    return 3
bin_stats = [{"n_isp":0, "n_tl":0, "sum_tl_spread":0.0, "n_pos_slots":0, "n_tl_slots":0} for _ in range(4)]
# Per-ISP tally
for i in range(n):
    if p_da[i] is None: continue
    b = bin_idx(p_da[i], q)
    bin_stats[b]["n_isp"] += 1
    if is_tl_isp[i]: bin_stats[b]["n_tl"] += 1
# Per-POS-slot tally
for k, i in enumerate(pos_isp):
    if p_da[i] is None: continue
    pmf = p_mfrr[i]
    if pmf is None or pmf >= 1: continue
    b = bin_idx(p_da[i], q)
    bin_stats[b]["n_pos_slots"] += 1
    sp = pos_spread[k] * 0.1
    if sp >= 0:
        bin_stats[b]["n_tl_slots"] += 1
        bin_stats[b]["sum_tl_spread"] += sp
print(f"  DA bins:  {bin_names}")
for b, s in enumerate(bin_stats):
    isp_tl_pct = 100 * s["n_tl"] / max(1, s["n_isp"])
    slot_tl_pct = 100 * s["n_tl_slots"] / max(1, s["n_pos_slots"])
    mean_tl_spread = s["sum_tl_spread"] / max(1, s["n_tl_slots"])
    print(f"  bin {b} ({bin_names[b]}): TL ISPs {s['n_tl']:>5}/{s['n_isp']:>5} = {isp_tl_pct:5.1f}%   TL slots {s['n_tl_slots']:>7}/{s['n_pos_slots']:>7} = {slot_tl_pct:5.1f}%   mean TL aFRR spread = {mean_tl_spread:6.1f} €/MWh")
