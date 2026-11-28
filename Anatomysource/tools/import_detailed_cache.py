#!/usr/bin/env python3
"""Import manifest-verified Detailed Model payloads from a copied app cache."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import shutil
import struct
import subprocess
from pathlib import Path
from shutil import which


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "assets/source/detailed"
PUBLIC_ROOT = ROOT / "public/models/detailed"
CATALOG_PATH = PUBLIC_ROOT / "catalog.json"
ENGLISH_PATH = ROOT / "assets/source/en.json"


def read_json(path: Path):
    return json.loads(path.read_text())


def buffer_is_valid(path: Path, buffer: dict) -> bool:
    if not path.is_file() or path.stat().st_size != buffer.get("byteLength"):
        return False
    stem = Path(buffer["uri"]).name.split(".")[0]
    return len(stem) != 32 or hashlib.md5(path.read_bytes()).hexdigest() == stem


def rebuild_buffer_from_views(source: dict, buffer_index: int, cache_dir: Path, buffer: dict) -> bytes | None:
    """Reassemble an ODR buffer from its named glTF bufferView cache chunks."""
    length = buffer.get("byteLength")
    if not isinstance(length, int) or length <= 0:
        return None
    views = [view for view in source.get("bufferViews", []) if view.get("buffer", 0) == buffer_index]
    if not views:
        return None
    payload = bytearray(length)
    covered_until = 0
    for view in sorted(views, key=lambda item: item.get("byteOffset", 0)):
        name = view.get("name")
        offset = view.get("byteOffset", 0)
        size = view.get("byteLength")
        if not isinstance(name, str) or not isinstance(offset, int) or not isinstance(size, int):
            return None
        chunk = cache_dir / f"{name}_{size}.bin"
        if not chunk.is_file() or chunk.stat().st_size != size or offset != covered_until or offset + size > length:
            return None
        payload[offset:offset + size] = chunk.read_bytes()
        covered_until = offset + size
    if covered_until != length:
        return None
    stem = Path(buffer.get("uri", "")).name.split(".")[0]
    if len(stem) == 32 and hashlib.md5(payload).hexdigest() != stem:
        return None
    return bytes(payload)


def dds_header(width: int, height: int, linear_size: int, compression: int) -> bytes:
    """Build a single mip DDS header around an app DXT payload."""
    if compression not in (33777, 33779):
        raise ValueError(f"unsupported DXT format: {compression}")
    flags = 0x1 | 0x2 | 0x4 | 0x1000 | 0x80000
    fourcc = b"DXT1" if compression == 33777 else b"DXT5"
    words = [
        124, flags, height, width, linear_size, 0, 1,
        *([0] * 11),
        32, 0x4, struct.unpack("<I", fourcc)[0], 0, 0, 0, 0, 0,
        0x1000, 0, 0, 0, 0,
    ]
    return b"DDS " + struct.pack("<31I", *words)


def extract_preview_textures(source: dict, source_dir: Path, public_dir: Path) -> tuple[list[dict], list[dict]]:
    """Decode the model's app DXT atlases to browser-friendly PNG images."""
    ffmpeg = which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to decode Detailed Model textures")
    texture_dir = public_dir / "textures"
    texture_dir.mkdir(parents=True, exist_ok=True)
    images = []
    textures = []
    for index, texture in enumerate(source.get("textures", [])):
        dds = texture.get("extensions", {}).get("3D4M_compressed_texture_dds")
        if not dds or not dds.get("sources"):
            continue
        view = source["bufferViews"][dds["sources"][0]]
        buffer = source["buffers"][view.get("buffer", 0)]
        payload_path = source_dir / buffer["uri"]
        if not buffer_is_valid(payload_path, buffer):
            continue
        offset = view.get("byteOffset", 0)
        size = view["byteLength"]
        with payload_path.open("rb") as raw:
            raw.seek(offset)
            payload = raw.read(size)
        if len(payload) != size:
            continue
        image_name = f"texture-{index}.png"
        destination = texture_dir / image_name
        source_size = (dds["width"], dds["height"])
        existing_size = None
        if destination.is_file():
            with destination.open("rb") as existing:
                header = existing.read(24)
            if len(header) >= 24 and header[:8] == b"\x89PNG\r\n\x1a\n":
                existing_size = struct.unpack(">II", header[16:24])
        if existing_size != source_size:
            temporary = texture_dir / f".texture-{index}.dds"
            temporary.write_bytes(
                dds_header(dds["width"], dds["height"], len(payload), dds["compression"]) + payload
            )
            try:
                subprocess.run(
                    [ffmpeg, "-v", "error", "-i", str(temporary), "-frames:v", "1", "-y", str(destination)],
                    check=True,
                )
            finally:
                temporary.unlink(missing_ok=True)
        image_index = len(images)
        images.append({"uri": f"textures/{image_name}", "mimeType": "image/png", "name": texture.get("name", image_name)})
        clean_texture = {"source": image_index, "name": texture.get("name", image_name)}
        if "sampler" in texture:
            clean_texture["sampler"] = texture["sampler"]
        textures.append(clean_texture)
    return images, textures


def default_visible_structure_ids(assets: dict) -> list[str]:
    """Resolve the app's selected composition layer to source structure IDs."""
    compositions = assets.get("compositions", [])
    if not compositions:
        return [item["id"] for item in assets.get("structures", []) if item.get("id")]
    composition = compositions[0]
    layers = composition.get("layers", [])
    layer_index = composition.get("default_layer", 0)
    if not isinstance(layer_index, int) or not 0 <= layer_index < len(layers):
        layer_index = 0
    visible_indexes: list[int] = []

    def visit(value) -> None:
        if isinstance(value, int):
            visible_indexes.append(value)
        elif isinstance(value, list):
            for child in value:
                visit(child)
        elif isinstance(value, dict):
            visit(value.get("children", []))

    visit(layers[layer_index].get("children", []))
    structures = assets.get("structures", [])
    return [
        structures[index]["id"]
        for index in dict.fromkeys(visible_indexes)
        if 0 <= index < len(structures) and structures[index].get("id")
    ]


def make_geometry_preview(source: dict, geometry_buffer_indices: list[int], labels: dict, assets: dict,
                          images: list[dict], textures: list[dict]) -> dict:
    preview = copy.deepcopy(source)
    index_remap = {old: new for new, old in enumerate(geometry_buffer_indices)}
    preview["buffers"] = [source["buffers"][i] for i in geometry_buffer_indices]
    view_remap = {}
    filtered_views = []
    for old_index, view in enumerate(source.get("bufferViews", [])):
        old_buffer = view.get("buffer", 0)
        if old_buffer not in index_remap:
            continue
        view_remap[old_index] = len(filtered_views)
        filtered = dict(view)
        filtered["buffer"] = index_remap[old_buffer]
        filtered_views.append(filtered)
    preview["bufferViews"] = filtered_views
    for accessor in preview.get("accessors", []):
        if "bufferView" in accessor:
            if accessor["bufferView"] not in view_remap:
                raise ValueError("geometry accessor refers to a non-geometry bufferView")
            accessor["bufferView"] = view_remap[accessor["bufferView"]]
        sparse = accessor.get("sparse", {})
        for part in (sparse.get("indices", {}), sparse.get("values", {})):
            if "bufferView" in part:
                if part["bufferView"] not in view_remap:
                    raise ValueError("sparse accessor refers to a non-geometry bufferView")
                part["bufferView"] = view_remap[part["bufferView"]]
    preview["images"] = images
    preview["textures"] = textures
    for key in ("extensionsUsed", "extensionsRequired"):
        if key in preview:
            preview[key] = [
                extension for extension in preview[key]
                if "texture" not in extension.lower()
            ]

    for structure in assets.get("structures", []):
        label = labels.get(structure.get("cid"))
        if not label:
            continue
        for sni in structure.get("sni", []):
            node_index = sni.get("gltf")
            if not isinstance(node_index, int) or not 0 <= node_index < len(preview.get("nodes", [])):
                continue
            node = preview["nodes"][node_index]
            app_node_id = node.get("name")
            node["name"] = label
            node["extras"] = {
                **node.get("extras", {}),
                "appNodeId": app_node_id or sni.get("id"),
                "structureId": structure.get("id"),
                "cid": structure.get("cid"),
            }
    return preview


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True, help="copied OnDemandResources directory")
    parser.add_argument("--dry-run", action="store_true", help="report matches without writing files")
    args = parser.parse_args()
    cache_dir = args.cache_dir.expanduser().resolve()
    if not cache_dir.is_dir():
        raise SystemExit(f"cache directory not found: {cache_dir}")

    catalog = read_json(CATALOG_PATH)
    labels = {item["cid"]: item["name"] for item in read_json(ENGLISH_PATH)["items"]}
    copied_buffers = geometry_models = complete_models = texture_buffers = platform_complete_models = 0
    unmatched_geometry = []
    for model in catalog["models"]:
        slug = model["id"]
        source_dir = SOURCE_ROOT / slug
        public_dir = PUBLIC_ROOT / slug
        source = read_json(source_dir / "assets.gltf")
        assets = read_json(source_dir / "assets.json")
        model["defaultVisibleStructureIds"] = default_visible_structure_ids(assets)
        reconstructed_texture_indices = set()
        for index, buffer in enumerate(source.get("buffers", [])):
            uri = buffer.get("uri")
            if not isinstance(uri, str) or not any(
                part in uri.lower() for part in ("pvr/", "dds/", "astc/", "ktx", "png/", "rgba/")
            ):
                continue
            target = source_dir / uri
            if buffer_is_valid(target, buffer):
                continue
            payload = rebuild_buffer_from_views(source, index, cache_dir, buffer)
            if payload is not None:
                reconstructed_texture_indices.add(index)
                if not args.dry_run:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(payload)
        geometry_indices = []
        available_geometry_uris = []
        available_texture_uris = []
        available_macos_texture_uris = []

        for index, buffer in enumerate(source.get("buffers", [])):
            uri = buffer.get("uri")
            if not isinstance(uri, str):
                continue
            expected_path = source_dir / uri
            if not buffer_is_valid(expected_path, buffer):
                cache_path = cache_dir / Path(uri).name
                if buffer_is_valid(cache_path, buffer):
                    if not args.dry_run:
                        expected_path.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(cache_path, expected_path)
                    copied_buffers += 1
            valid = buffer_is_valid(expected_path, buffer) or (
                args.dry_run and buffer_is_valid(cache_dir / Path(uri).name, buffer)
            ) or (args.dry_run and index in reconstructed_texture_indices)
            if valid and any(part in uri.lower() for part in ("pvr/", "dds/", "astc/", "ktx", "png/", "rgba/")):
                texture_buffers += 1
                available_texture_uris.append(uri)
                if "dds/" in uri.lower():
                    available_macos_texture_uris.append(uri)
            if valid and uri.endswith((".vertex.bin", ".index.bin", ".morph.bin")):
                geometry_indices.append(index)
                available_geometry_uris.append(uri)

        has_vertex = any(source["buffers"][i]["uri"].endswith(".vertex.bin") for i in geometry_indices)
        has_index = any(source["buffers"][i]["uri"].endswith(".index.bin") for i in geometry_indices)
        geometry_available = has_vertex and has_index
        macos_complete = geometry_available and bool(available_macos_texture_uris)
        all_payloads_available = bool(source.get("buffers")) and all(
            buffer_is_valid(source_dir / buffer["uri"], buffer)
            or (args.dry_run and buffer_is_valid(cache_dir / Path(buffer["uri"]).name, buffer))
            for buffer in source.get("buffers", [])
        )
        model["geometryBuffersAvailable"] = available_geometry_uris
        model["geometryAvailable"] = geometry_available
        model["textureBuffersAvailable"] = available_texture_uris
        model["texturesAvailable"] = bool(available_texture_uris)
        model["platformComplete"] = macos_complete
        model["platform"] = "macOS"
        model["complete"] = all_payloads_available
        if geometry_available:
            geometry_models += 1
            preview_file = f"/models/detailed/{slug}/preview.gltf"
            model["previewFile"] = preview_file
            images, textures = extract_preview_textures(source, source_dir, public_dir)
            preview = make_geometry_preview(source, geometry_indices, labels, assets, images, textures)
            if not args.dry_run:
                public_dir.mkdir(parents=True, exist_ok=True)
                for index in geometry_indices:
                    uri = source["buffers"][index]["uri"]
                    source_buffer = source_dir / uri
                    public_buffer = public_dir / Path(uri).name
                    if not buffer_is_valid(source_buffer, source["buffers"][index]):
                        cache_buffer = cache_dir / Path(uri).name
                        if buffer_is_valid(cache_buffer, source["buffers"][index]):
                            shutil.copy2(cache_buffer, source_buffer)
                    if not buffer_is_valid(public_buffer, source["buffers"][index]):
                        shutil.copy2(source_buffer, public_buffer)
                (ROOT / "public" / preview_file.lstrip("/")).write_text(
                    json.dumps(preview, separators=(",", ":")) + "\n"
                )
        else:
            unmatched_geometry.append(slug)
            model["previewFile"] = None
        complete_models += all_payloads_available
        platform_complete_models += macos_complete

    if not args.dry_run:
        CATALOG_PATH.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n")
    print(
        f"Cache files imported: {copied_buffers}; models with geometry: {geometry_models}/38; "
        f"complete source models: {complete_models}; macOS mesh+texture copies: {platform_complete_models}/38; "
        f"valid texture buffers: {texture_buffers}; "
        f"geometry unavailable: {', '.join(unmatched_geometry)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
