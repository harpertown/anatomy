#!/usr/bin/env python3
"""Extract the original diffuse/specular cubemaps and BRDF LUT from IBL!."""

from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    raw = args.input.read_bytes()
    if raw[:4] != b"IBL!":
        raise ValueError("unsupported IBL resource signature")
    descriptors = [struct.unpack_from("<5I", raw, 12 + i * 20) for i in range(3)]
    diffuse, specular, brdf = descriptors
    if diffuse[1:4] != (128, 128, 1) or specular[1:4] != (512, 512, 6) or brdf[1:4] != (256, 256, 1):
        raise ValueError(f"unexpected IBL descriptors: {descriptors}")

    offset = 128
    chunks = []
    for name, descriptor in (("diffuse", diffuse), ("specular", specular), ("brdf", brdf)):
        size = descriptor[4]
        chunks.append((name, offset, size))
        offset += size
    if offset != len(raw):
        raise ValueError(f"descriptor payload ends at {offset}, file ends at {len(raw)}")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "source": args.input.name,
        "byteOrder": "little-endian",
        "formatIds": {"rgba16f": 51, "rg16f": 23},
        "diffuse": {"file": "cape_hill_diffuse_rgba16f.bin", "size": 128, "faces": 6, "format": "rgba16f"},
        "specular": {
            "file": "cape_hill_specular_rgba16f.bin",
            "baseSize": 512,
            "faces": 6,
            "format": "rgba16f",
            "mipSizes": [512, 256, 128, 64, 32, 16],
            "lodScale": 5,
        },
        "brdf": {"file": "cape_hill_brdf_rg16f.bin", "width": 256, "height": 256, "channels": 2, "format": "rg16f"},
        "faceOrder": ["+X", "-X", "+Y", "-Y", "+Z", "-Z"],
    }
    for name, start, size in chunks:
        filename = manifest[name]["file"]
        (args.output_dir / filename).write_bytes(raw[start : start + size])
    (args.output_dir / "cape_hill_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Extracted {len(chunks)} source IBL payloads to {args.output_dir}")


if __name__ == "__main__":
    main()
