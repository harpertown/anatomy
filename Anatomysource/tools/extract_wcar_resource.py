#!/usr/bin/env python3
"""Extract one top-level text resource from Complete Anatomy Assets.wcar."""

from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path, PurePosixPath

from unpack_wcar import decode, parse_records


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack", required=True, type=Path, help="path to Assets.wcar")
    parser.add_argument("--resource", required=True, help="exact top-level resource path, such as en.json")
    parser.add_argument("--out", required=True, type=Path, help="output file")
    args = parser.parse_args()

    resource = PurePosixPath(args.resource)
    if resource.is_absolute() or len(resource.parts) != 1 or resource.name in (".", ".."):
        raise SystemExit("resource must be one top-level filename")
    matches = [record for record in parse_records(args.pack) if record[2] == resource.name]
    if len(matches) != 1:
        raise SystemExit(f"expected one WCAR record for {resource.name}, found {len(matches)}")

    offset, size, name = matches[0]
    with args.pack.open("rb") as pack:
        pack.seek(offset)
        payload = decode(pack.read(size))
    if name.endswith(".gzip"):
        payload = gzip.decompress(payload)
    json.loads(payload)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(payload)
    print(f"Extracted {name} ({len(payload):,} bytes) to {args.out.resolve()}")


if __name__ == "__main__":
    main()
