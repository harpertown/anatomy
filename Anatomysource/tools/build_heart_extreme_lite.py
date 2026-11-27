#!/usr/bin/env python3
"""Build an aggressively compact male heart while retaining its animation."""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from build_heart_super_lite import (
    LITE_SOURCE,
    POSITION_QUANTIZATION_BITS,
    ATTRIBUTE_QUANTIZATION_BITS,
    ROOT,
    build_heart_texture_tiers,
    read_glb_document,
)
from build_heart_lite import SOURCE, prepare_glb


OUTPUT = ROOT / "public/models/catalog/male-heart-extreme-lite.glb"
def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="heart-extreme-lite-") as temp_dir:
        clean_source = Path(temp_dir) / "male-heart-clean.glb"
        prepare_glb(SOURCE, clean_source)
        texture_sizes = build_heart_texture_tiers(read_glb_document(LITE_SOURCE))
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

    texture_bytes = texture_sizes["extremelite"]
    print(
        f"Created {OUTPUT.relative_to(ROOT)}; "
        f"extreme lite textures {texture_bytes / 1_000_000:.2f} MB "
        f"({texture_bytes:,} bytes)."
    )


if __name__ == "__main__":
    main()
