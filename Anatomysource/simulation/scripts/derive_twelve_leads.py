#!/usr/bin/env python3
"""Derive the standard 12 leads from simulated electrode potentials in CSV."""
from __future__ import annotations

import argparse
import csv
from pathlib import Path

import numpy as np

ELECTRODES = ("RA", "LA", "LL", "V1", "V2", "V3", "V4", "V5", "V6")
LEADS = ("I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6")


def derive(row: dict[str, str]) -> dict[str, float]:
    ra, la, ll = (float(row[name]) for name in ("RA", "LA", "LL"))
    vw = (ra + la + ll) / 3.0  # Wilson central terminal
    return {
        "I": la - ra,
        "II": ll - ra,
        "III": ll - la,
        "aVR": 1.5 * (ra - vw),
        "aVL": 1.5 * (la - vw),
        "aVF": 1.5 * (ll - vw),
        **{lead: float(row[lead]) - vw for lead in ("V1", "V2", "V3", "V4", "V5", "V6")},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("electrodes_csv", type=Path, help="time_s,RA,LA,LL,V1,V2,V3,V4,V5,V6 columns; all potentials in one unit")
    parser.add_argument("output_csv", type=Path)
    args = parser.parse_args()

    with args.electrodes_csv.open(newline="") as source:
        reader = csv.DictReader(source)
        missing = {"time_s", *ELECTRODES} - set(reader.fieldnames or ())
        if missing:
            raise SystemExit(f"Missing input columns: {', '.join(sorted(missing))}")
        rows = list(reader)
    if not rows:
        raise SystemExit("Input contains no samples")

    args.output_csv.parent.mkdir(parents=True, exist_ok=True)
    with args.output_csv.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=("time_s", *LEADS))
        writer.writeheader()
        for row_number, row in enumerate(rows, start=2):
            try:
                time = float(row["time_s"])
                leads = derive(row)
            except (TypeError, ValueError) as error:
                raise SystemExit(f"Invalid numeric value on input row {row_number}: {error}") from error
            if not np.isfinite(time) or not all(np.isfinite(value) for value in leads.values()):
                raise SystemExit(f"Non-finite value on input row {row_number}")
            writer.writerow({"time_s": time, **leads})
    print(f"Wrote {len(rows):,} samples and 12 leads to {args.output_csv}")
    print("RL is a ground/reference electrode and is not part of the standard lead equations.")


if __name__ == "__main__":
    main()
