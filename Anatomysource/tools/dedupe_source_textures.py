#!/usr/bin/env python3
"""Deduplicate decoded model textures and repoint their GLB/material references."""

from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEXTURES = ROOT / "public/models/textures"
MODELS = ROOT / "public/models"
GLB_JSON = 0x4E4F534A
KEEP_NAMES = {"filling_heart.png", "filling_heart_normal.png"}


def rewrite_glb(path: Path, replacements: dict[str, str]) -> bool:
    data = path.read_bytes()
    if data[:4] != b"glTF":
        return False
    chunks: list[tuple[int, bytes]] = []
    offset = 12
    changed = False
    while offset < len(data):
        length, kind = struct.unpack_from("<II", data, offset)
        chunk = data[offset + 8:offset + 8 + length]
        offset += 8 + length
        if kind == GLB_JSON:
            document = json.loads(chunk)

            def replace(value):
                nonlocal changed
                if isinstance(value, dict):
                    return {key: replace(item) for key, item in value.items()}
                if isinstance(value, list):
                    return [replace(item) for item in value]
                if isinstance(value, str) and value in replacements:
                    changed = True
                    return replacements[value]
                return value

            document = replace(document)
            chunk = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode()
            chunk += b" " * ((-len(chunk)) % 4)
        chunks.append((kind, chunk))
    if not changed:
        return False
    output = bytearray(b"glTF" + struct.pack("<II", 2, 0))
    for kind, chunk in chunks:
        output += struct.pack("<II", len(chunk), kind) + chunk
    struct.pack_into("<I", output, 8, len(output))
    path.write_bytes(output)
    return True


def replace_mapping(value, replacements: dict[str, str]) -> bool:
    changed = False
    if isinstance(value, dict):
        for key, item in value.items():
            if isinstance(item, str) and item in replacements:
                value[key] = replacements[item]
                changed = True
            else:
                changed |= replace_mapping(item, replacements)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            if isinstance(item, str) and item in replacements:
                value[index] = replacements[item]
                changed = True
            else:
                changed |= replace_mapping(item, replacements)
    return changed


def main() -> None:
    replacements: dict[str, str] = {}
    canonical: dict[str, Path] = {}
    removed = 0
    for path in TEXTURES.glob("*.png"):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()[:24]
        existing = canonical.get(digest)
        if existing:
            replacements[path.name] = existing.name
            if path.name not in KEEP_NAMES:
                path.unlink()
                removed += 1
        else:
            canonical[digest] = path

    for path in TEXTURES.glob("*materials.json"):
        data = json.loads(path.read_text())
        if replace_mapping(data, replacements):
            path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")

    rewritten = 0
    for path in MODELS.rglob("*.glb"):
        rewritten += rewrite_glb(path, replacements)

    print(f"Deduplicated {removed} texture files; updated {rewritten} GLBs and material maps.")


if __name__ == "__main__":
    main()
