"""Pressure-test the optima under different assumptions."""

import sys
import os
import time

import numpy as np

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from validate import load_data, simulate_total, winsorize  # noqa: E402


def main():
    D = load_data()

    # ---------- 1. Sensitivity to winsorization on mFRR -------------------
    print("=== Winsor sensitivity (Level 1) ===")
    print(f"{'mFRR pctl':>15s} {'best X':>8s} {'best Y':>8s} {'rev':>15s}")
    for (lo, hi) in [(0, 100), (5, 95), (10, 90), (20, 80), (25, 75)]:
        D["P_mfrr"], _ = winsorize(D["P_mfrr_raw"], lo, hi)
        D["P_imb"], _ = winsorize(D["P_imb_raw"], 10, 90)
        best = (-np.inf, 0, 0)
        for x in range(-100, 301, 10):
            for y in np.arange(0, 1.01, 0.05):
                r, _ = simulate_total(D, 1, x, y)
                if r > best[0]:
                    best = (r, x, y)
        print(f"  {lo:>3d}/{hi:<3d}        {best[1]:8.0f} {best[2]:8.2f} {best[0]:15,.0f}")

    print()
    print("=== Winsor sensitivity (Level 2) ===")
    print(f"{'mFRR':>10s} {'imb':>10s} {'X':>5s} {'Y':>6s} {'Z':>6s} {'rev':>15s}")
    for (mlo, mhi) in [(5, 95), (10, 90), (20, 80)]:
        for (ilo, ihi) in [(5, 95), (10, 90), (20, 80)]:
            D["P_mfrr"], _ = winsorize(D["P_mfrr_raw"], mlo, mhi)
            D["P_imb"], _ = winsorize(D["P_imb_raw"], ilo, ihi)
            best = (-np.inf, 0, 0, 0)
            for x in range(-100, 301, 20):
                for y in np.arange(0, 1.01, 0.1):
                    for z in np.arange(0, 1.01, 0.2):
                        r, _ = simulate_total(D, 2, x, y, z, 30)
                        if r > best[0]:
                            best = (r, x, y, z)
            print(f"  {mlo:>3d}/{mhi:<3d} {ilo:>3d}/{ihi:<3d}  {best[1]:5.0f} {best[2]:6.2f} {best[3]:6.2f} {best[0]:15,.0f}")

    # ---------- 2. theta_flat sensitivity --------------------------------
    print()
    print("=== theta sensitivity (Level 2, default winsor) ===")
    D["P_mfrr"], _ = winsorize(D["P_mfrr_raw"], 10, 90)
    D["P_imb"], _ = winsorize(D["P_imb_raw"], 10, 90)
    print(f"{'theta':>8s} {'X':>5s} {'Y':>6s} {'Z':>6s} {'rev':>15s} {'imb':>15s} {'flat':>15s}")
    for theta in [0, 10, 30, 60, 100]:
        best = (-np.inf, 0, 0, 0)
        for x in range(-100, 301, 20):
            for y in np.arange(0, 1.01, 0.1):
                for z in np.arange(0, 1.01, 0.2):
                    r, _ = simulate_total(D, 2, x, y, z, theta)
                    if r > best[0]:
                        best = (r, x, y, z)
        _, parts = simulate_total(D, 2, best[1], best[2], best[3], theta)
        print(f"  {theta:5.0f}   {best[1]:5.0f} {best[2]:6.2f} {best[3]:6.2f} {best[0]:15,.0f} {parts['imb']:15,.0f} {parts['flat']:15,.0f}")

    # ---------- 3. drop-best-N robustness check (L2) ---------------------
    print()
    print("=== Drop-top-N ISPs robustness (L2 at default optimum) ===")
    D["P_mfrr"], _ = winsorize(D["P_mfrr_raw"], 10, 90)
    D["P_imb"], _ = winsorize(D["P_imb_raw"], 10, 90)
    bX, bY, bZ = 50, 1.0, 1.0
    F = D["F"]; ID = D["ID"]; P_da = D["P_da"]; P_mfrr = D["P_mfrr"]
    P_imb = D["P_imb"]; Q_pot = D["Q_pot"]
    above = P_da >= bX
    da_sold = np.where(above, F, F * (1 - bY))
    Q_w = np.where(above, 0.0, F * bY)
    trusted = bZ * (ID - F)
    up_offer = Q_w + np.maximum(0.0, trusted)
    is_up = P_mfrr >= 1
    is_dn = P_mfrr <= -1
    up = np.where(is_up, up_offer, 0.0)
    dn = np.where(is_dn, Q_w, 0.0)
    Q_pos = da_sold + up
    short = np.maximum(0.0, Q_pos - Q_pot)
    perISP = (da_sold * P_da + up * P_mfrr - dn * P_mfrr - short * P_imb - short * 30) * 0.25
    print(f"  Baseline at L2 optimum: {perISP.sum():,.0f}")

    for drop_n in [10, 100, 500, 1000, 2000]:
        worst_idx = np.argsort(perISP)[:drop_n]  # most negative ISPs
        best_idx = np.argsort(perISP)[-drop_n:]  # most positive ISPs
        # Drop best N: re-search optimum
        keep = np.ones(len(perISP), dtype=bool)
        keep[best_idx] = False

        def grid_max():
            best = (-np.inf, 0, 0, 0)
            for x in range(-100, 301, 20):
                for y in np.arange(0, 1.01, 0.1):
                    for z in np.arange(0, 1.01, 0.2):
                        ab = P_da >= x
                        ds = np.where(ab, F, F * (1 - y))
                        Qw = np.where(ab, 0.0, F * y)
                        tr = z * (ID - F)
                        uo = Qw + np.maximum(0.0, tr)
                        u = np.where(is_up, uo, 0.0)
                        d = np.where(is_dn, Qw, 0.0)
                        Qp = ds + u
                        sh = np.maximum(0.0, Qp - Q_pot)
                        per = (ds * P_da + u * P_mfrr - d * P_mfrr - sh * P_imb - sh * 30) * 0.25
                        r = per[keep].sum()
                        if r > best[0]:
                            best = (r, x, y, z)
            return best

        b = grid_max()
        print(f"  Drop top {drop_n:>4d} ISPs by rev — new best: X={b[1]:>4.0f}  Y={b[2]:.2f}  Z={b[3]:.2f}  rev={b[0]:,.0f}")

    # ---------- 4. Naïve revenue under different theta -------------------
    print()
    print("=== Naive baseline at different θ ===")
    for theta in [0, 10, 30, 60, 100]:
        r, parts = simulate_total(D, 2, -1e9, 0.0, 0.0, theta)
        print(f"  theta={theta:3.0f}  naive={r:,.0f}  imb={parts['imb']:,.0f}  flat={parts['flat']:,.0f}")


if __name__ == "__main__":
    main()
