#!/usr/bin/env python3
"""Build a lighter male heart GLB while preserving its names and animation."""

from __future__ import annotations

import json
import struct
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public/models/heart.glb"
OUTPUT = ROOT / "public/models/catalog/male-heart-lite.glb"
RATIO = "0.40"
ERROR = "0.003"


def collect_accessor_refs(document: dict) -> set[int]:
    refs: set[int] = set()
    for mesh in document.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            refs.update(primitive.get("attributes", {}).values())
            if "indices" in primitive:
                refs.add(primitive["indices"])
            for target in primitive.get("targets", []):
                refs.update(target.values())
    for animation in document.get("animations", []):
        for sampler in animation.get("samplers", []):
            refs.add(sampler["input"])
            refs.add(sampler["output"])
    for skin in document.get("skins", []):
        if "inverseBindMatrices" in skin:
            refs.add(skin["inverseBindMatrices"])
    return refs


def remap_accessors(document: dict) -> None:
    """Drop orphaned accessor definitions left in the extracted source GLB."""
    refs = collect_accessor_refs(document)
    old_to_new: dict[int, int] = {}
    accessors = []
    for old_index, accessor in enumerate(document.get("accessors", [])):
        if old_index in refs:
            old_to_new[old_index] = len(accessors)
            accessors.append(accessor)
    document["accessors"] = accessors

    def remap(index: int) -> int:
        return old_to_new[index]

    for mesh in document.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            primitive["attributes"] = {
                key: remap(index) for key, index in primitive.get("attributes", {}).items()
            }
            if "indices" in primitive:
                primitive["indices"] = remap(primitive["indices"])
            for target in primitive.get("targets", []):
                for key, index in target.items():
                    target[key] = remap(index)
    for animation in document.get("animations", []):
        for sampler in animation.get("samplers", []):
            sampler["input"] = remap(sampler["input"])
            sampler["output"] = remap(sampler["output"])
    for skin in document.get("skins", []):
        if "inverseBindMatrices" in skin:
            skin["inverseBindMatrices"] = remap(skin["inverseBindMatrices"])


def prepare_glb(source: Path, destination: Path) -> None:
    data = source.read_bytes()
    if data[:4] != b"glTF":
        raise ValueError(f"Not a binary glTF file: {source}")
    version, declared_length = struct.unpack_from("<II", data, 4)
    if version != 2 or declared_length != len(data):
        raise ValueError(f"Unexpected GLB header in {source}")

    chunks = []
    offset = 12
    while offset < len(data):
        length, chunk_type = struct.unpack_from("<II", data, offset)
        start = offset + 8
        chunks.append((chunk_type, data[start : start + length]))
        offset = start + length
    json_chunks = [payload for kind, payload in chunks if kind == 0x4E4F534A]
    if len(json_chunks) != 1:
        raise ValueError("Expected exactly one GLB JSON chunk")
    document = json.loads(json_chunks[0])
    remap_accessors(document)

    encoded_json = json.dumps(document, separators=(",", ":")).encode("utf-8")
    encoded_json += b" " * (-len(encoded_json) % 4)
    output_chunks = [(0x4E4F534A, encoded_json)]
    output_chunks.extend((kind, payload) for kind, payload in chunks if kind != 0x4E4F534A)
    total_length = 12 + sum(8 + len(payload) for _, payload in output_chunks)
    with destination.open("wb") as output:
        output.write(b"glTF" + struct.pack("<II", 2, total_length))
        for kind, payload in output_chunks:
            output.write(struct.pack("<II", len(payload), kind))
            output.write(payload)


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="heart-lite-") as temp_dir:
        clean_source = Path(temp_dir) / "male-heart-clean.glb"
        prepare_glb(SOURCE, clean_source)
        subprocess.run(
            [
                "npx",
                "--yes",
                "@gltf-transform/cli",
                "simplify",
                str(clean_source),
                str(OUTPUT),
                "--ratio",
                RATIO,
                "--error",
                ERROR,
                "--lock-border",
                "true",
            ],
            check=True,
            cwd=ROOT,
        )
    print(f"Created {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
