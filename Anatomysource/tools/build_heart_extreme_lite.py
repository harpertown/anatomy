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


OUTPUT = ROOT / "public/models/catalog/male-heart-extreme-lite.glb"
SIMPLIFICATION_RATIO = "0.50"
SIMPLIFICATION_ERROR = "0.003"


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="heart-extreme-lite-") as temp_dir:
        simplified_source = Path(temp_dir) / "male-heart-extreme-lite-simplified.glb"
        subprocess.run(
            [
                "npx", "--yes", "@gltf-transform/cli", "simplify",
                str(LITE_SOURCE), str(simplified_source),
                "--ratio", SIMPLIFICATION_RATIO,
                "--error", SIMPLIFICATION_ERROR,
                "--lock-border", "true",
            ],
            check=True,
            cwd=ROOT,
        )
        texture_sizes = build_heart_texture_tiers(read_glb_document(LITE_SOURCE))
        subprocess.run(
            [
                "npx", "--yes", "@gltf-transform/cli", "meshopt",
                str(simplified_source), str(OUTPUT),
                "--level", "high",
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
