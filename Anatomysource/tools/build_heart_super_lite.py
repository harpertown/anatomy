#!/usr/bin/env python3
"""Build a compact, topology-preserving male heart and texture tiers."""

from __future__ import annotations

import json
import struct
import subprocess
import tempfile
from pathlib import Path

from build_heart_lite import ROOT, SOURCE, prepare_glb


OUTPUT = ROOT / "public/models/catalog/male-heart-super-lite.glb"
LITE_SOURCE = ROOT / "public/models/catalog/male-heart-lite.glb"
TEXTURE_DIRECTORY = ROOT / "public/models/textures"
POSITION_QUANTIZATION_BITS = "16"
ATTRIBUTE_QUANTIZATION_BITS = "16"
TEXTURE_TIERS = {
    "lite": ("2048", "86", "88"),
    "superlite": ("1200", "80", "84"),
    "extremelite": ("1024", "72", "78"),
}


def read_glb_document(path: Path) -> dict:
    data = path.read_bytes()
    declared_length = struct.unpack_from("<I", data, 8)[0]
    offset = 12
    while offset < declared_length:
        length, chunk_type = struct.unpack_from("<II", data, offset)
        chunk = data[offset + 8 : offset + 8 + length]
        offset += 8 + length
        if chunk_type == 0x4E4F534A:
            return json.loads(chunk)
    raise ValueError(f"No JSON chunk found in {path}")


def build_heart_texture_tiers(document: dict) -> dict[str, int]:
    names = {
        value
        for material in document.get("materials", [])
        for key, value in (material.get("extras") or {}).items()
        if key in {"formeOriginalAlbedoTexture", "formeOriginalNormalTexture"}
    }
    names.add("filling_heart.png")
    tier_sizes = {}
    for tier, (max_dimension, albedo_quality, normal_quality) in TEXTURE_TIERS.items():
        total_bytes = 0
        for name in sorted(names):
            source = TEXTURE_DIRECTORY / name
            if not source.is_file():
                raise FileNotFoundError(f"Heart texture not found: {source}")
            output = TEXTURE_DIRECTORY / f"{tier}-{source.stem}.webp"
            quality = normal_quality if "normal" in name.lower() else albedo_quality
            subprocess.run(
                [
                    "cwebp", "-quiet", "-resize", max_dimension,
                    max_dimension, "-q", quality, str(source), "-o", str(output),
                ],
                check=True,
            )
            total_bytes += output.stat().st_size
        tier_sizes[tier] = total_bytes
    return tier_sizes


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="heart-super-lite-") as temp_dir:
        clean_source = Path(temp_dir) / "male-heart-clean.glb"
        prepare_glb(SOURCE, clean_source)
        texture_tier_sizes = build_heart_texture_tiers(read_glb_document(LITE_SOURCE))
        subprocess.run(
            [
                "npx", "--yes", "@gltf-transform/cli", "meshopt",
                str(clean_source), str(OUTPUT),
                "--level", "medium",
                "--quantization-volume", "scene",
                "--quantize-position", POSITION_QUANTIZATION_BITS,
                "--quantize-normal", ATTRIBUTE_QUANTIZATION_BITS,
                "--quantize-texcoord", ATTRIBUTE_QUANTIZATION_BITS,
            ],
            check=True,
            cwd=ROOT,
        )
    texture_summary = ", ".join(
        f"{tier} textures {size / 1_000_000:.2f} MB"
        for tier, size in texture_tier_sizes.items()
    )
    print(f"Created {OUTPUT.relative_to(ROOT)}; {texture_summary}")


if __name__ == "__main__":
    main()
