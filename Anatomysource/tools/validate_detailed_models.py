#!/usr/bin/env python3
"""Validate recovered Detailed Model assets against their source manifests."""

from __future__ import annotations

import json
import hashlib
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "public/models/detailed/catalog.json"
SOURCE_ROOT = ROOT / "assets/source/detailed"
PUBLIC_ROOT = ROOT / "public/models/detailed"


def read_json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"{path.relative_to(ROOT)}: {exc}") from exc


def main() -> int:
    errors: list[str] = []
    catalog = read_json(CATALOG_PATH)
    models = catalog.get("models") if isinstance(catalog, dict) else None
    if not isinstance(models, list):
        print("ERROR catalog must contain a models array")
        return 1

    ids = [model.get("id") for model in models]
    if len(ids) != len(set(ids)):
        errors.append("catalog contains duplicate model ids")

    structure_names = {
        entry["cid"]: entry["name"]
        for entry in read_json(ROOT / "assets/source/en.json").get("items", [])
        if isinstance(entry.get("cid"), int) and isinstance(entry.get("name"), str)
    }
    mesh_count = complete_count = macos_complete_count = texture_payloads = referenced_buffers = present_buffers = 0
    verified_texture_payloads = 0
    for model in models:
        slug = model.get("id")
        if not isinstance(slug, str) or not slug:
            errors.append("catalog entry has no string id")
            continue

        source_dir = SOURCE_ROOT / slug
        public_dir = PUBLIC_ROOT / slug
        for filename in ("model_description.json", "assets.json", "assets.gltf"):
            if not (source_dir / filename).is_file():
                errors.append(f"{slug}: missing source {filename}")
        thumbnail = model.get("thumbnail")
        if not isinstance(thumbnail, str) or not (ROOT / "public" / thumbnail.lstrip("/")).is_file():
            errors.append(f"{slug}: missing thumbnail")

        source_gltf_path = source_dir / "assets.gltf"
        source_gltf = read_json(source_gltf_path) if source_gltf_path.is_file() else {}
        source_assets_path = source_dir / "assets.json"
        source_assets = read_json(source_assets_path) if source_assets_path.is_file() else {}
        source_structures = source_assets.get("structures", [])
        expected_structures = [
            {"name": structure_names.get(item.get("cid")), "cid": item.get("cid"), "structureId": item.get("id")}
            for item in source_structures
        ]
        if any(not item["name"] for item in expected_structures):
            errors.append(f"{slug}: source structures contain an unknown English label")
        if model.get("structures") != expected_structures:
            errors.append(f"{slug}: catalog structure labels do not match source metadata")
        source_buffers = source_gltf.get("buffers", [])
        referenced_buffers += len(source_buffers)
        valid_source_uris = set()
        for buffer in source_buffers:
            uri = buffer.get("uri")
            if not isinstance(uri, str):
                errors.append(f"{slug}: source buffer has no URI")
                continue
            path = source_dir / uri
            if path.is_file() and path.stat().st_size == buffer.get("byteLength"):
                present_buffers += 1
                stem = Path(uri).name.split(".")[0]
                if len(stem) == 32 and hashlib.md5(path.read_bytes()).hexdigest() != stem:
                    errors.append(f"{slug}: MD5 mismatch for {uri}")
                else:
                    valid_source_uris.add(uri)
                is_texture = any(part in uri.lower() for part in ("pvr/", "dds/", "astc/", "ktx", "png/", "rgba/"))
                if is_texture:
                    texture_payloads += 1
                    if len(stem) != 32 or hashlib.md5(path.read_bytes()).hexdigest() == stem:
                        verified_texture_payloads += 1

        geometry_available = bool(model.get("geometryAvailable"))
        mesh_count += geometry_available
        complete = bool(model.get("complete"))
        complete_count += complete
        macos_geometry_uris = {
            buffer["uri"] for buffer in source_buffers
            if isinstance(buffer.get("uri"), str)
            and buffer["uri"].endswith((".vertex.bin", ".index.bin"))
        }
        macos_texture_uris = {
            buffer["uri"] for buffer in source_buffers
            if isinstance(buffer.get("uri"), str) and "dds/" in buffer["uri"].lower()
        }
        macos_complete = bool(macos_geometry_uris and macos_texture_uris) and (
            macos_geometry_uris | macos_texture_uris
        ).issubset(valid_source_uris)
        macos_complete_count += macos_complete
        if model.get("platform") != "macOS" or bool(model.get("platformComplete")) != macos_complete:
            errors.append(f"{slug}: macOS platform-complete metadata disagrees with mesh/DDS availability")
        preview_file = model.get("previewFile")
        if geometry_available:
            if not isinstance(preview_file, str):
                errors.append(f"{slug}: geometry is marked available without a preview file")
                continue
            preview_path = ROOT / "public" / preview_file.lstrip("/")
            if not preview_path.is_file():
                errors.append(f"{slug}: missing preview file {preview_file}")
                continue
            preview = read_json(preview_path)
            preview_images = preview.get("images", [])
            for image_index, image in enumerate(preview_images):
                uri = image.get("uri")
                if not isinstance(uri, str) or not (preview_path.parent / uri).is_file():
                    errors.append(f"{slug}: missing preview image {uri!r} at index {image_index}")
            preview_textures = preview.get("textures", [])
            for texture_index, texture in enumerate(preview_textures):
                source_index = texture.get("source")
                if not isinstance(source_index, int) or not 0 <= source_index < len(preview_images):
                    errors.append(f"{slug}: texture {texture_index} has invalid image source {source_index!r}")
            for material_index, material in enumerate(preview.get("materials", [])):
                texture_infos = [
                    material.get("pbrMetallicRoughness", {}).get("baseColorTexture"),
                    material.get("normalTexture"),
                    material.get("occlusionTexture"),
                    material.get("emissiveTexture"),
                ]
                for texture_info in texture_infos:
                    if texture_info is None:
                        continue
                    texture_index = texture_info.get("index")
                    if not isinstance(texture_index, int) or not 0 <= texture_index < len(preview_textures):
                        errors.append(
                            f"{slug}: material {material_index} has invalid texture reference {texture_index!r}"
                        )
            preview_buffers = preview.get("buffers", [])
            if not preview_buffers:
                errors.append(f"{slug}: geometry preview has no buffers")
            for buffer in preview_buffers:
                uri = buffer.get("uri")
                path = preview_path.parent / uri if isinstance(uri, str) else None
                if path is None or not path.is_file():
                    errors.append(f"{slug}: missing preview buffer {uri}")
                elif path.stat().st_size != buffer.get("byteLength"):
                    errors.append(f"{slug}: byteLength mismatch for preview buffer {uri}")
            accessors = preview.get("accessors", [])
            views = preview.get("bufferViews", [])
            for accessor_index, accessor in enumerate(accessors):
                view_index = accessor.get("bufferView")
                if not isinstance(view_index, int) or not 0 <= view_index < len(views):
                    errors.append(f"{slug}: accessor {accessor_index} has invalid bufferView")
                if not isinstance(accessor.get("count"), int) or accessor["count"] < 1:
                    errors.append(f"{slug}: accessor {accessor_index} has invalid count")
            for mesh_index, mesh in enumerate(preview.get("meshes", [])):
                for primitive_index, primitive in enumerate(mesh.get("primitives", [])):
                    accessor_refs = list(primitive.get("attributes", {}).values())
                    if primitive.get("indices") is not None:
                        accessor_refs.append(primitive["indices"])
                    for accessor_index in accessor_refs:
                        if not isinstance(accessor_index, int) or not 0 <= accessor_index < len(accessors):
                            errors.append(
                                f"{slug}: mesh {mesh_index} primitive {primitive_index} "
                                f"has invalid accessor {accessor_index}"
                            )

            for structure in source_structures:
                expected_name = structure_names.get(structure.get("cid"))
                if not expected_name:
                    errors.append(f"{slug}: no English label for structure cid {structure.get('cid')}")
                    continue
                for sni in structure.get("sni", []):
                    node_index = sni.get("gltf")
                    if not isinstance(node_index, int) or not 0 <= node_index < len(preview.get("nodes", [])):
                        errors.append(f"{slug}: structure {structure.get('id')} has invalid glTF node")
                        continue
                    node = preview["nodes"][node_index]
                    extras = node.get("extras", {})
                    if node.get("name") != expected_name:
                        errors.append(f"{slug}: node {node_index} is not labeled {expected_name!r}")
                    if extras.get("appNodeId") != sni.get("id"):
                        errors.append(f"{slug}: node {node_index} lost its original app node id")
                    if extras.get("structureId") != structure.get("id") or extras.get("cid") != structure.get("cid"):
                        errors.append(f"{slug}: node {node_index} lost its source structure identifiers")
        elif preview_file is not None:
            errors.append(f"{slug}: unavailable geometry has a previewFile")

        all_source_buffers_present = bool(source_buffers) and all(
            isinstance(buffer.get("uri"), str)
            and (source_dir / buffer["uri"]).is_file()
            and (source_dir / buffer["uri"]).stat().st_size == buffer.get("byteLength")
            for buffer in source_buffers
        )
        if complete != all_source_buffers_present:
            errors.append(f"{slug}: complete flag disagrees with source buffer availability")

    print(
        f"Models: {len(models)}; geometry previews: {mesh_count}; complete source sets: {complete_count}; "
        f"macOS mesh+texture sets: {macos_complete_count}; "
        f"source buffers present: {present_buffers}/{referenced_buffers}; "
        f"texture payloads present: {texture_payloads}; MD5 verified: {verified_texture_payloads}"
    )
    if errors:
        print(f"Validation errors: {len(errors)}")
        for error in errors:
            print(f"- {error}")
        return 1
    print("Validation passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
