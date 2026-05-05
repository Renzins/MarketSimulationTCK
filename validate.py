"""
Mirror of the JS engine simulation, run in Python on the real dataset.
Used to:
  (a) cross-verify that the JS engine logic is correct,
  (b) compute ground-truth Level 1 / Level 2 optima,
  (c) generate the findings summary numerics.

Stays exactly aligned with engine.js — every formula here matches the JS.
"""

import json
import time

import numpy as np
import pandas as pd


def load_data():
    import os
    base = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(base, "wind-park-tool", "data.js"), "r") as f:
        text = f.read()
    # Strip the "const WIND_DATA = " prefix and trailing semicolon/comments
    start = text.index("{")
    end = text.rindex("}") + 1
    raw = json.loads(text[start:end])
    return {
        "n": raw["n"],
        "F": np.asarray(raw["da_forecast"], dtype=np.float64),
        "ID": np.asarray(raw["id_forecast"], dtype=np.float64),
        "P_da": np.asarray(raw["p_da"], dtype=np.float64),
        "P_mfrr_raw": np.asarray(raw["p_mfrr"], dtype=np.float64),
        "Q_pot": np.asarray(raw["q_pot"], dtype=np.float64),
        "P_imb_raw": np.asarray(raw["p_imb"], dtype=np.float64),
        "offsets": np.asarray(raw["offsets"], dtype=np.int64),
        "start_iso": raw["start_iso"],
    }


def winsorize(x, p_low, p_high):
    lo = np.percentile(x, p_low)
    hi = np.percentile(x, p_high)
    return np.clip(x, lo, hi), (lo, hi)


def simulate_total(D, level, X, Y, Z=0.0, theta_flat=0.0):
    """Mirror of engine.js simulate logic AFTER the audit corrections:
      * whole-MW DA bid, withheld and trusted_rev (floor)
      * mFRR-dn offer = Q_da_sold (curtailment, independent of Y)
      * Q_position = Q_da_sold + Q_up - Q_dn
    """
    F = D["F"]
    ID = D["ID"]
    P_da = D["P_da"]
    P_mfrr = D["P_mfrr"]
    above = P_da >= X
    da_sold = np.floor(np.where(above, F, F * (1 - Y)) + 1e-9)
    Q_w = np.floor(np.where(above, 0.0, F - da_sold) + 1e-9)
    if level == 2:
        rev_diff = ID - F
        trusted_raw = Z * rev_diff
        up_extra = np.where(trusted_raw > 0, np.floor(trusted_raw + 1e-9), 0.0)
    else:
        up_extra = np.zeros_like(F)
    Q_up_offer = Q_w + up_extra
    Q_dn_offer = da_sold  # curtailment capped at DA position
    is_up = P_mfrr >= 1
    is_dn = P_mfrr <= -1
    up = np.where(is_up, Q_up_offer, 0.0)
    dn = np.where(is_dn, Q_dn_offer, 0.0)
    DA_rev = da_sold * P_da
    Up_rev = up * P_mfrr
    Dn_rev = -dn * P_mfrr
    if level == 2:
        Q_pos = da_sold + up - dn
        Q_pot = D["Q_pot"]
        short = np.maximum(0.0, Q_pos - Q_pot)
        P_imb = D["P_imb"]
        imb = short * P_imb
        flat = short * theta_flat
    else:
        short = np.zeros_like(F)
        imb = np.zeros_like(F)
        flat = np.zeros_like(F)
    rev = (DA_rev + Up_rev + Dn_rev - imb - flat) * 0.25
    return rev.sum(), {
        "DA": (DA_rev * 0.25).sum(),
        "up": (Up_rev * 0.25).sum(),
        "dn": (Dn_rev * 0.25).sum(),
        "imb": (imb * 0.25).sum() if level == 2 else 0.0,
        "flat": (flat * 0.25).sum() if level == 2 else 0.0,
        "n_short": int((short > 1e-6).sum()) if level == 2 else 0,
        "total_short_MWh": float((short * 0.25).sum()) if level == 2 else 0.0,
    }


def main():
    D = load_data()
    print(f"Loaded {D['n']} ISPs.")

    # Apply winsorization (10/90 default for both)
    p_mfrr_w, mfrr_bounds = winsorize(D["P_mfrr_raw"], 10, 90)
    p_imb_w, imb_bounds = winsorize(D["P_imb_raw"], 10, 90)
    D["P_mfrr"] = p_mfrr_w
    D["P_imb"] = p_imb_w
    print(f"mFRR winsor bounds (10/90): [{mfrr_bounds[0]:.2f}, {mfrr_bounds[1]:.2f}]")
    print(f"imb  winsor bounds (10/90): [{imb_bounds[0]:.2f}, {imb_bounds[1]:.2f}]")

    # ===== Naive baselines =====
    print()
    print("=== Naive baselines (sell everything to DA) ===")
    naive_l1, parts1 = simulate_total(D, 1, X=-1e9, Y=0.0)
    print(f"Level 1 naive: {naive_l1:,.0f} EUR  parts: {parts1}")
    naive_l2, parts2 = simulate_total(D, 2, X=-1e9, Y=0.0, Z=0.0, theta_flat=30)
    print(f"Level 2 naive: {naive_l2:,.0f} EUR  parts: {parts2}")

    # ===== Level 1 sweep =====
    print()
    print("=== Level 1 sweep ===")
    xs = np.arange(-100, 301, 10)  # -100..300 step 10
    ys = np.arange(0, 1.01, 0.05)  # 0..1 step 0.05
    grid = np.zeros((len(xs), len(ys)))
    t0 = time.time()
    for i, x in enumerate(xs):
        for j, y in enumerate(ys):
            grid[i, j], _ = simulate_total(D, 1, X=x, Y=y)
    t1 = time.time()
    print(f"Sweep took {t1 - t0:.2f}s ({len(xs) * len(ys)} combos)")
    bi, bj = np.unravel_index(np.argmax(grid), grid.shape)
    bX, bY, bRev = xs[bi], ys[bj], grid[bi, bj]
    print(f"Best Level 1: X={bX} EUR/MWh, Y={bY:.2f}, revenue={bRev:,.0f} EUR")
    print(f"Improvement vs naive: +{bRev - naive_l1:,.0f} EUR ({(bRev / naive_l1 - 1) * 100:+.2f}%)")

    # Show top-5 (X,Y) configurations
    flat = grid.flatten()
    top_idx = np.argsort(flat)[-5:][::-1]
    print("Top 5 Level 1 configurations:")
    for idx in top_idx:
        i, j = np.unravel_index(idx, grid.shape)
        print(f"  X={xs[i]:5.0f}  Y={ys[j]:.2f}  rev={grid[i, j]:,.0f}")

    # Show 1-D best Y per X (peek at structure)
    print()
    print("Best Y for each X (sample):")
    for i in [0, 5, 10, 15, 20, 25, 30, 35, 40]:
        bj = np.argmax(grid[i])
        print(f"  X={xs[i]:5.0f}  best Y={ys[bj]:.2f}  rev={grid[i, bj]:,.0f}")

    # ===== Robustness check Level 1 =====
    print()
    print("=== Level 1 robustness ===")
    # Compute per-ISP revenue at the L1 optimum using the corrected logic.
    F = D["F"]; ID = D["ID"]; P_da = D["P_da"]; P_mfrr = D["P_mfrr"]
    above = P_da >= bX
    da_sold = np.floor(np.where(above, F, F * (1 - bY)) + 1e-9)
    Q_w = np.floor(np.where(above, 0.0, F - da_sold) + 1e-9)
    Q_dn_offer = da_sold  # capped at DA
    is_up = P_mfrr >= 1
    is_dn = P_mfrr <= -1
    up = np.where(is_up, Q_w, 0.0)
    dn = np.where(is_dn, Q_dn_offer, 0.0)
    perISP = (da_sold * P_da + up * P_mfrr - dn * P_mfrr) * 0.25
    sorted_rev = np.sort(perISP)
    top1pct_n = max(1, len(perISP) // 100)
    top1pct = sorted_rev[-top1pct_n:].sum()
    print(f"Total revenue at optimum: {perISP.sum():,.0f}")
    print(f"Top 1% ISPs ({top1pct_n}) contribute: {top1pct:,.0f} ({top1pct / perISP.sum() * 100:.1f}%)")
    # If we drop best 100 ISPs, does optimum shift?
    drop_n = 100
    drop_idx = np.argsort(perISP)[-drop_n:]
    keep_mask = np.ones(len(perISP), dtype=bool)
    keep_mask[drop_idx] = False
    print(f"\nDropping top {drop_n} ISPs by revenue at optimum...")
    grid2 = np.zeros_like(grid)
    for i, x in enumerate(xs):
        for j, y in enumerate(ys):
            ab = P_da >= x
            ds = np.floor(np.where(ab, F, F * (1 - y)) + 1e-9)
            Qw = np.floor(np.where(ab, 0.0, F - ds) + 1e-9)
            up2 = np.where(is_up, Qw, 0.0)
            dn2 = np.where(is_dn, ds, 0.0)
            perISP2 = (ds * P_da + up2 * P_mfrr - dn2 * P_mfrr) * 0.25
            grid2[i, j] = perISP2[keep_mask].sum()
    bi2, bj2 = np.unravel_index(np.argmax(grid2), grid2.shape)
    print(f"Best Level 1 after dropping top 100: X={xs[bi2]}  Y={ys[bj2]:.2f}  rev={grid2[bi2, bj2]:,.0f}")
    print(f"  Original best was X={bX}  Y={bY:.2f}")

    # Save grid for reference
    np.savez("level1_grid.npz", xs=xs, ys=ys, grid=grid)

    # ===== Level 2 sweep =====
    print()
    print("=== Level 2 sweep ===")
    zs = np.arange(0, 1.01, 0.1)
    grid_l2 = np.zeros((len(xs), len(ys), len(zs)))
    t0 = time.time()
    for i, x in enumerate(xs):
        for j, y in enumerate(ys):
            for k, z in enumerate(zs):
                grid_l2[i, j, k], _ = simulate_total(D, 2, X=x, Y=y, Z=z, theta_flat=30)
    t1 = time.time()
    print(f"Sweep took {t1 - t0:.2f}s ({len(xs) * len(ys) * len(zs)} combos)")
    bi, bj, bk = np.unravel_index(np.argmax(grid_l2), grid_l2.shape)
    bX, bY, bZ = xs[bi], ys[bj], zs[bk]
    bRev = grid_l2[bi, bj, bk]
    print(f"Best Level 2: X={bX}  Y={bY:.2f}  Z={bZ:.2f}  revenue={bRev:,.0f}")
    print(f"Improvement vs naive: +{bRev - naive_l2:,.0f} EUR ({(bRev / naive_l2 - 1) * 100:+.2f}%)")

    # Top 10 L2
    flat = grid_l2.flatten()
    top_idx = np.argsort(flat)[-10:][::-1]
    print("Top 10 Level 2 configurations:")
    for idx in top_idx:
        i, j, k = np.unravel_index(idx, grid_l2.shape)
        print(f"  X={xs[i]:5.0f}  Y={ys[j]:.2f}  Z={zs[k]:.2f}  rev={grid_l2[i, j, k]:,.0f}")

    # Compare Z=0 vs best Z at the same (X,Y)
    print()
    rev_z0_at_best, _ = simulate_total(D, 2, X=bX, Y=bY, Z=0.0, theta_flat=30)
    print(f"At optimal (X,Y), revenue with Z=0: {rev_z0_at_best:,.0f}")
    print(f"At optimal (X,Y), revenue with Z={bZ}: {bRev:,.0f}")
    print(f"Z benefit at this (X,Y): +{bRev - rev_z0_at_best:,.0f}")

    # Imbalance cost decomposition at optimum
    _, parts_opt = simulate_total(D, 2, X=bX, Y=bY, Z=bZ, theta_flat=30)
    print(f"\nDecomposition at L2 optimum:")
    for k, v in parts_opt.items():
        print(f"  {k}: {v:,.2f}")

    np.savez("level2_grid.npz", xs=xs, ys=ys, zs=zs, grid=grid_l2)


if __name__ == "__main__":
    main()
