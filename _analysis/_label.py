#!/usr/bin/env python3
"""Independent media-buyer labeling — v2 (target_roas read directly from raw CSV).

Refined rubric:
- target_roas: from raw CSV per row (commercial truth — TheSwaf=2.2, IwaStore=3.5)
- 0-conv burner cut: 0 purchases with >=$200 spend
- scale: mature spend + ROAS >= 1.4*target with >=10 purchases
        OR small spend but >=8 purchases AND ROAS >= 1.5*target (early winner)
- cut: spend >= $1000 AND ROAS < 0.7*target  (clear loser at scale)
       OR spend >= $500 AND ROAS < 0.4*target (sustained loser)
- refresh: fatigue=fatigued AND spend>=$300 (iterate or replace)
- keep: ROAS >= target AND mature
       OR ROAS >= 0.7*target AND spend>=$500 (working zone, monitor)
- test_more: insufficient signal
"""
import csv
from collections import Counter

# Per-business defaults if row target_roas is missing/zero (sanity fallback only)
TARGET_FALLBACK = {"TheSwaf": 2.2, "IwaStore": 3.5}


def parse_float(value):
    if value is None or value == "":
        return 0.0
    try:
        return float(value)
    except ValueError:
        return 0.0


def label_row(row):
    biz = row["business_name"]
    spend = parse_float(row["spend"])
    purchases = parse_float(row["purchases"])
    roas = parse_float(row["roas"])
    fatigue = (row.get("fatigue_status") or "none").strip()
    target = parse_float(row.get("target_roas")) or TARGET_FALLBACK.get(biz, 2.0)
    ratio = roas / target if target > 0 else 0

    # Hard cut: 0 purchases yet meaningful spend
    if purchases == 0 and spend >= 200:
        return ("cut", f"0 purchases on ${spend:.0f} — sustained zero-conv burn, kill")

    # Strong scale signal — mature
    if spend >= 500 and purchases >= 10 and ratio >= 1.4:
        return ("scale", f"ROAS {roas:.2f} = {ratio:.0%} of target {target} with {purchases:.0f} buys — scale")

    # Early scale: small spend but high purchase + strong ROAS
    if purchases >= 8 and ratio >= 1.5:
        return ("scale", f"ROAS {roas:.2f} = {ratio:.0%} of target with {purchases:.0f} buys despite ${spend:.0f} — early scale candidate")

    # Hard cut at scale
    if spend >= 1000 and ratio < 0.7:
        return ("cut", f"ROAS {roas:.2f} = {ratio:.0%} of target after ${spend:.0f} — clear loser at scale, cut")

    # Sustained loser
    if spend >= 500 and ratio < 0.4:
        return ("cut", f"ROAS {roas:.2f} = {ratio:.0%} of target — sustained loser")

    # Refresh: fatigue signal with enough spend to be meaningful
    if fatigue == "fatigued" and spend >= 300:
        if ratio >= 1.0:
            return ("refresh", f"Fatigued winner (ROAS {roas:.2f}, {ratio:.0%} of target) — iterate / new variant")
        return ("refresh", f"Fatigued + below target ({ratio:.0%}) — replace with fresh iteration")

    # Keep: at-or-above target with enough data
    if ratio >= 1.0 and (spend >= 500 or purchases >= 5):
        return ("keep", f"ROAS {roas:.2f} at/above target {target} — stable, let it ride")

    # Working zone — below target but not catastrophic, mature spend
    if ratio >= 0.7 and spend >= 500:
        return ("keep", f"ROAS {roas:.2f} below target ({ratio:.0%}) but in working zone — monitor, no aggressive move")

    # Insufficient signal
    return ("test_more", f"Thin data (spend=${spend:.0f}, purchases={purchases:.0f}, ROAS {roas:.2f}) — accumulate")


def main():
    in_path = "/Users/harmelek/Adsecute/_analysis/01-raw-with-v1.csv"
    out_path = "/Users/harmelek/Adsecute/_analysis/03-my-labels.csv"

    out_rows = []
    with open(in_path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            label, reason = label_row(row)
            out_rows.append(
                {
                    "creative_id": row["creative_id"],
                    "business_name": row["business_name"],
                    "name": row["name"],
                    "spend": row["spend"],
                    "purchases": row["purchases"],
                    "roas": row["roas"],
                    "fatigue_status": row["fatigue_status"],
                    "age_days": row["age_days"],
                    "target_roas": row["target_roas"],
                    "my_label": label,
                    "my_reason": reason,
                }
            )

    with open(out_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(out_rows[0].keys()))
        writer.writeheader()
        writer.writerows(out_rows)
    print(f"Wrote {len(out_rows)} rows to {out_path}")

    counter = Counter(r["my_label"] for r in out_rows)
    by_biz = {biz: Counter() for biz in TARGET_FALLBACK}
    for r in out_rows:
        by_biz[r["business_name"]][r["my_label"]] += 1

    print("\nDistribution:")
    for k in ("scale", "keep", "refresh", "cut", "test_more"):
        print(f"  {k}: {counter[k]}")
    print("\nBy business:")
    for biz, c in by_biz.items():
        parts = [f"{k}={c[k]}" for k in ("scale", "keep", "refresh", "cut", "test_more")]
        print(f"  {biz}: {' '.join(parts)}")


if __name__ == "__main__":
    main()
