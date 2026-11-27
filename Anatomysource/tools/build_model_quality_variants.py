#!/usr/bin/env python3
"""Build low/medium/high mesh and texture variants for the offline model library.

The source anatomy and original-quality assets are left intact. Reduced tiers
use meshoptimizer simplification with locked mesh borders, then EXT_meshopt
compression and a scene-wide quantization grid. Heart and integumentary meshes
retain their source topology to avoid disturbing thin or layered surfaces.
"""

from __future__ import annotations

import argparse
import json
import struct
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public/models"
CATALOG_PATH = PUBLIC / "catalog.json"
TEXTURE_DIR = PUBLIC / "textures"
TIERS = {
    "low": {"ratio": "0.60", "error": "0.0005", "position": "16", "normal": "12", "texcoord": "12"},
    "medium": {"ratio": "0.82", "error": "0.00025", "position": "16", "normal": "14", "texcoord": "14"},
    "high": {"ratio": "0.94", "error": "0.0001", "position": "16", "normal": "16", "texcoord": "16"},
}
TEXTURE_TIERS = {
    "low": (512, 68, 80),
    "medium": (1024, 82, 88),
    "high": (2048, 90, 94),
}
LEGACY_HEART_IDS = {
    "male-2024-heart-lite": "high",
    "male-2024-heart-super-lite": "medium",
    "male-2024-heart-extreme-lite": "low",
}


def unpack_glb(path: Path) -> tuple[dict, list[tuple[int, bytes]]]:
    data = path.read_bytes()
    if data[:4] != b"glTF" or struct.unpack_from("<II", data, 4) != (2, len(data)):
        raise ValueError(f"Invalid GLB header: {path}")
    chunks: list[tuple[int, bytes]] = []
    offset = 12
    document = None
    while offset < len(data):
        length, kind = struct.unpack_from("<II", data, offset)
        offset += 8
        payload = data[offset:offset + length]
        if len(payload) != length:
            raise ValueError(f"Truncated GLB chunk: {path}")
        offset += length
        if kind == 0x4E4F534A:
            document = json.loads(payload)
        chunks.append((kind, payload))
    if document is None:
        raise ValueError(f"No JSON chunk in {path}")
    return document, chunks


def pack_glb(path: Path, document: dict, chunks: list[tuple[int, bytes]]) -> None:
    encoded_json = json.dumps(document, separators=(",", ":")).encode("utf-8")
    encoded_json += b" " * (-len(encoded_json) % 4)
    chunks = [(kind, encoded_json if kind == 0x4E4F534A else payload) for kind, payload in chunks]
    total = 12 + sum(8 + len(payload) for _, payload in chunks)
    with path.open("wb") as output:
        output.write(b"glTF" + struct.pack("<II", 2, total))
        for kind, payload in chunks:
            output.write(struct.pack("<II", len(payload), kind))
            output.write(payload)


def prune_orphan_accessors(document: dict) -> None:
    """Remove malformed exporter-only accessors not referenced by the scene."""
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
            refs.update((sampler["input"], sampler["output"]))
    for skin in document.get("skins", []):
        if "inverseBindMatrices" in skin:
            refs.add(skin["inverseBindMatrices"])
    remap: dict[int, int] = {}
    accessors = []
    for index, accessor in enumerate(document.get("accessors", [])):
        if index not in refs:
            continue
        remap[index] = len(accessors)
        accessors.append(accessor)
    document["accessors"] = accessors

    def update(index: int) -> int:
        return remap[index]

    for mesh in document.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            primitive["attributes"] = {key: update(index) for key, index in primitive.get("attributes", {}).items()}
            if "indices" in primitive:
                primitive["indices"] = update(primitive["indices"])
            for target in primitive.get("targets", []):
                for key, index in target.items():
                    target[key] = update(index)
    for animation in document.get("animations", []):
        for sampler in animation.get("samplers", []):
            sampler["input"] = update(sampler["input"])
            sampler["output"] = update(sampler["output"])
    for skin in document.get("skins", []):
        if "inverseBindMatrices" in skin:
            skin["inverseBindMatrices"] = update(skin["inverseBindMatrices"])


def prepare_source(source: Path, destination: Path) -> None:
    document, chunks = unpack_glb(source)
    prune_orphan_accessors(document)
    pack_glb(destination, document, chunks)


def model_output_path(model: dict, quality: str) -> Path:
    stem = Path(model["file"]).stem
    return PUBLIC / "catalog" / "quality" / f"{stem}-{quality}.glb"


def make_variant(source: Path, output: Path, quality: str, system: str) -> None:
    tier = TIERS[quality]
    preserve_topology = system in {"Heart", "Integumentary System"}
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="anatomy-quality-") as temp_dir:
        prepared = Path(temp_dir) / "prepared.glb"
        prepare_source(source, prepared)
        working = prepared
        # Keep heart and skin surfaces untouched to avoid amplifying seams,
        # clipping, and depth-fighting at thin or layered part boundaries.
        if not preserve_topology:
            simplified = Path(temp_dir) / "simplified.glb"
            subprocess.run([
                "npx", "--yes", "@gltf-transform/cli", "simplify",
                str(working), str(simplified), "--ratio", tier["ratio"],
                "--error", tier["error"], "--lock-border", "true",
            ], check=True, cwd=ROOT)
            working = simplified
        subprocess.run([
            "npx", "--yes", "@gltf-transform/cli", "meshopt",
            str(working), str(output), "--level", "medium",
            "--quantization-volume", "scene",
            "--quantize-position", "16" if preserve_topology else tier["position"],
            "--quantize-normal", tier["normal"],
            "--quantize-texcoord", tier["texcoord"],
        ], check=True, cwd=ROOT)


def model_texture_names(models: list[dict]) -> set[str]:
    names: set[str] = set()
    for model in models:
        path = PUBLIC / model["file"]
        if not path.is_file():
            continue
        document, _ = unpack_glb(path)
        for material in document.get("materials", []):
            extras = material.get("extras") or {}
            for key in ("formeOriginalAlbedoTexture", "formeOriginalNormalTexture"):
                name = extras.get(key)
                if name:
                    names.add(name)
    return names


def image_dimensions(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return struct.unpack_from(">II", data, 16)
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        kind = data[12:16]
        if kind == b"VP8X":
            return (1 + int.from_bytes(data[24:27], "little"), 1 + int.from_bytes(data[27:30], "little"))
        if kind == b"VP8L":
            bits = int.from_bytes(data[21:25], "little")
            return ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
        if kind == b"VP8 ":
            return (int.from_bytes(data[26:28], "little") & 0x3FFF, int.from_bytes(data[28:30], "little") & 0x3FFF)
    if data.startswith(b"\xff\xd8"):
        offset = 2
        while offset + 4 <= len(data):
            if data[offset] != 0xFF:
                offset += 1
                continue
            while offset < len(data) and data[offset] == 0xFF:
                offset += 1
            marker = data[offset]
            offset += 1
            if marker in {0xD8, 0xD9} or 0xD0 <= marker <= 0xD7:
                continue
            length = int.from_bytes(data[offset:offset + 2], "big")
            if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
                height, width = struct.unpack_from(">HH", data, offset + 3)
                return width, height
            offset += length
    raise ValueError(f"Cannot read image dimensions: {path}")


def build_texture_variants(models: list[dict], selected_names: set[str] | None = None) -> None:
    names = model_texture_names(models)
    if (TEXTURE_DIR / "filling_heart.png").is_file():
        names.add("filling_heart.png")
    if selected_names:
        names &= selected_names
    for name in sorted(names):
        source = TEXTURE_DIR / name
        if not source.is_file():
            raise FileNotFoundError(f"Missing source texture: {source}")
        is_normal = "normal" in name.lower()
        stem = Path(name).stem
        width, height = image_dimensions(source)
        for quality, (dimension, albedo_q, normal_q) in TEXTURE_TIERS.items():
            output = TEXTURE_DIR / f"{quality}-{stem}.webp"
            if output.exists():
                continue
            scale = min(1, dimension / max(width, height))
            output_width = max(1, round(width * scale))
            output_height = max(1, round(height * scale))
            subprocess.run([
                "cwebp", "-quiet", "-resize", str(output_width), str(output_height),
                "-q", str(normal_q if is_normal else albedo_q),
                str(source), "-o", str(output),
            ], check=True)


def prepare_catalog(models: list[dict], force: bool = False) -> list[dict]:
    models = [model for model in models if not model.get("generatedQualityVariant")]
    legacy = {model["id"]: model for model in models if model["id"] in LEGACY_HEART_IDS}
    base_models = [
        model for model in models
        if model["id"] not in LEGACY_HEART_IDS
        and model.get("system") not in {"Heart Lite", "Heart Super Lite", "Heart Extreme Lite"}
    ]
    male_heart = next((model for model in base_models if model["id"] == "male-2024-heart"), None)
    if male_heart:
        for model_id, quality in LEGACY_HEART_IDS.items():
            if model_id in legacy:
                continue
            stem = model_id.removeprefix("male-2024-")
            legacy[model_id] = {
                **male_heart,
                "id": model_id,
                "file": f"catalog/male-{stem}.glb",
                "quality": quality,
                "qualityBaseId": male_heart["id"],
            }
    variants: list[dict] = []
    for model in base_models:
        model["quality"] = "original"
        model["qualityBaseId"] = model["id"]
        for quality in ("low", "medium", "high"):
            if model["model"] == "Male" and model.get("system") == "Heart":
                legacy_id = next((id for id, tier in LEGACY_HEART_IDS.items() if tier == quality), None)
                variant = legacy.get(legacy_id) if legacy_id else None
                if variant is None:
                    raise RuntimeError(f"Missing existing male heart quality asset for {quality}.")
                variant.update({
                    "system": "Heart", "label": f"{model['model']} · Heart",
                    "quality": quality, "qualityBaseId": model["id"],
                })
                variants.append(variant)
                continue
            output = model_output_path(model, quality)
            if force or not output.exists():
                make_variant(PUBLIC / model["file"], output, quality, model.get("system", ""))
            variant = dict(model)
            variant.update({
                "id": f"{model['id']}-{quality}",
                "file": str(output.relative_to(PUBLIC)),
                "quality": quality,
                "qualityBaseId": model["id"],
                "generatedQualityVariant": True,
            })
            variants.append(variant)
    for model_id, quality in LEGACY_HEART_IDS.items():
        if model_id not in legacy:
            continue
        legacy_model = legacy[model_id]
        legacy_model.update({
            "system": "Heart", "label": "Male · Heart", "quality": quality,
            "qualityBaseId": "male-2024-heart",
        })
    return base_models + variants


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="rebuild existing model variants")
    parser.add_argument("--skip-textures", action="store_true", help="leave existing texture tiers untouched")
    args = parser.parse_args()
    catalog = json.loads(CATALOG_PATH.read_text())
    models = catalog.get("models", [])
    if not args.skip_textures:
        build_texture_variants(models)
    catalog["models"] = prepare_catalog(models, args.force)
    CATALOG_PATH.write_text(json.dumps(catalog, indent=2) + "\n")
    generated = sum(bool(model.get("generatedQualityVariant")) for model in catalog["models"])
    print(f"Wrote {len(catalog['models'])} catalog entries ({generated} generated quality variants).")


if __name__ == "__main__":
    main()
