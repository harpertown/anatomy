#!/usr/bin/env python3
"""Extract one model folder from Complete Anatomy v5 Assets.wcar.

The WCAR table stores 256-byte records after its `strct5` marker. Most
payloads use the app's repeating `strct4` decoder; vertex, index, and morph
buffers are already raw. `.gzip` payloads are decompressed after decoding.
This writes model files only and never changes the app.
"""

from __future__ import annotations

import argparse
import gzip
import struct
from pathlib import Path, PurePosixPath

MAGIC = b"strct5"
KEY = b"strct4"
RECORD_SIZE = 256
FIRST_RECORD = len(MAGIC)


def parse_records(pack: Path) -> list[tuple[int, int, str]]:
    with pack.open("rb") as f:
        header = f.read(8)
        if len(header) != 8:
            raise ValueError("file is too short for a WCAR header")
        table_offset, table_size = struct.unpack("<II", header)
        if table_offset < 8 or table_offset + table_size > pack.stat().st_size:
            raise ValueError("WCAR table range is outside the file")
        f.seek(table_offset)
        table = f.read(table_size)

    if not table.startswith(MAGIC):
        raise ValueError(f"unsupported WCAR table marker: {table[:6]!r}")

    records: list[tuple[int, int, str]] = []
    count = (len(table) - FIRST_RECORD) // RECORD_SIZE
    for i in range(count):
        pos = FIRST_RECORD + i * RECORD_SIZE
        offset, size, path_len = struct.unpack_from("<III", table, pos)
        if not path_len:
            continue
        if path_len > RECORD_SIZE - 12:
            raise ValueError(f"invalid path length in record {i}: {path_len}")
        raw_path = table[pos + 12:pos + 12 + path_len]
        try:
            name = raw_path.decode("ascii")
        except UnicodeDecodeError as e:
            raise ValueError(f"non-ASCII path in record {i}") from e
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError(f"unsafe output path in record {i}: {name!r}")
        if offset + size > table_offset:
            raise ValueError(f"payload overlaps the table in record {i}: {name}")
        records.append((offset, size, name))
    return records


def decode(payload: bytes) -> bytes:
    return bytes((value - KEY[i % len(KEY)]) & 0xFF for i, value in enumerate(payload))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack", required=True, type=Path, help="path to Assets.wcar")
    parser.add_argument("--model-id", required=True, help="model ID folder to extract")
    parser.add_argument("--out", required=True, type=Path, help="output directory")
    args = parser.parse_args()

    prefix = args.model_id.rstrip("/") + "/"
    records = [r for r in parse_records(args.pack) if r[2].startswith(prefix)]
    if not records:
        raise SystemExit(f"no records found for model {args.model_id}")

    out_root = args.out.resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    total = 0
    with args.pack.open("rb") as f:
        for offset, size, name in records:
            relative = PurePosixPath(name).relative_to(args.model_id)
            target = (out_root / Path(*relative.parts)).resolve()
            if not target.is_relative_to(out_root):
                raise ValueError(f"output path escaped destination: {name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            f.seek(offset)
            payload = f.read(size)
            if len(payload) != size:
                raise ValueError(f"short payload while reading {name}")
            if not name.endswith((".vertex.bin", ".index.bin", ".morph.bin")):
                payload = decode(payload)
            if name.endswith(".gzip"):
                payload = gzip.decompress(payload)
            target.write_bytes(payload)
            total += len(payload)
            print(f"{relative}  {len(payload):,} bytes")
    print(f"Extracted {len(records)} files ({total:,} bytes) to {out_root}")


if __name__ == "__main__":
    main()
