#!/usr/bin/env python3
"""Extract original DXT1/DXT5 color and normal maps for a model cluster."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import struct
from pathlib import Path
from shutil import which

HEART_CLUSTER = "86e1552543b353b5a288737c11304168_Heart"


def dds_header(width: int, height: int, mip_count: int, linear_size: int, compression: int) -> bytes:
    flags = 0x1 | 0x2 | 0x4 | 0x1000 | 0x80000
    caps = 0x1000
    if mip_count > 1:
        flags |= 0x20000
        caps |= 0x8 | 0x400000
    if compression not in (33777, 33779):
        raise ValueError(f"unsupported DXT format: {compression}")
    fourcc = b"DXT1" if compression == 33777 else b"DXT5"
    words = [
        124, flags, height, width, linear_size, 0, mip_count,
        *([0] * 11),
        32, 0x4, struct.unpack("<I", fourcc)[0], 0, 0, 0, 0, 0,
        caps, 0, 0, 0, 0,
    ]
    return b"DDS " + struct.pack("<31I", *words)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--cluster-id", default=HEART_CLUSTER)
    parser.add_argument("--filename-prefix", default="heart-original", help="prefix used for extracted map filenames")
    parser.add_argument("--mapping-name", default="heart-materials.json", help="output material mapping filename")
    parser.add_argument("--dds-resource", type=Path, required=True, help="raw app Resources/dds/*.bin payload")
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()

    root = args.model_dir
    gltf = json.loads((root / "assets.gltf").read_text())
    assets = json.loads((root / "assets.json").read_text())
    clusters = assets["clusters"]
    structures = assets["structures"]
    cluster_by_id = {cluster["id"]: i for i, cluster in enumerate(clusters)}
    if args.cluster_id not in cluster_by_id:
        raise SystemExit(f"cluster not found: {args.cluster_id}")

    structure_indexes: set[int] = set()

    def walk(index: int) -> None:
        cluster = clusters[index]
        structure_indexes.update(cluster.get("structures", []))
        for child in cluster.get("clusters", []):
            walk(child)

    walk(cluster_by_id[args.cluster_id])
    material_indexes: set[int] = set()
    for structure_index in structure_indexes:
        for ref in structures[structure_index].get("sni", []):
            node_index = ref.get("gltf")
            if isinstance(node_index, int) and 0 <= node_index < len(gltf["nodes"]):
                mesh_index = gltf["nodes"][node_index].get("mesh")
                if isinstance(mesh_index, int):
                    for primitive in gltf["meshes"][mesh_index].get("primitives", []):
                        if isinstance(primitive.get("material"), int):
                            material_indexes.add(primitive["material"])

    args.out_dir.mkdir(parents=True, exist_ok=True)
    ffmpeg = which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("ffmpeg is required to convert the app's DXT maps into browser-friendly PNGs")
    resource_size = args.dds_resource.stat().st_size
    mapping: dict[str, dict[str, str | float]] = {}
    extracted: dict[tuple[int, str], str] = {}
    with args.dds_resource.open("rb") as raw:
        for material_index in sorted(material_indexes):
            material = gltf["materials"][material_index]
            mat_name = material.get("name") or f"material-{material_index}"
            fields = {
                "albedo": material.get("pbrMetallicRoughness", {}).get("baseColorTexture"),
                "normal": material.get("normalTexture"),
            }
            output_fields: dict[str, str | float] = {}
            for kind, texture_info in fields.items():
                if not texture_info:
                    continue
                texture = gltf["textures"][texture_info["index"]]
                dds = texture.get("extensions", {}).get("3D4M_compressed_texture_dds")
                if not dds or dds.get("compression") not in (33777, 33779):
                    raise SystemExit(f"unsupported original DDS texture for {mat_name} ({kind})")
                mip_views = [gltf["bufferViews"][view_index] for view_index in dds["sources"]]
                if any(view.get("buffer") != 9 for view in mip_views):
                    raise SystemExit(f"heart texture {mat_name} does not point into DDS resource buffer 9")
                mip_payloads = []
                for view in mip_views:
                    offset = view.get("byteOffset", 0)
                    length = view["byteLength"]
                    if offset + length > resource_size:
                        raise SystemExit(f"DDS view exceeds {args.dds_resource}: {offset}+{length}>{resource_size}")
                    raw.seek(offset)
                    payload = raw.read(length)
                    if len(payload) != length:
                        raise SystemExit(f"short read of DDS view at {offset}")
                    mip_payloads.append(payload)
                width, height = dds["width"], dds["height"]
                texture_index = texture_info["index"]
                key = (texture_index, kind)
                filename = extracted.get(key)
                if filename is None:
                    texture_stem = Path(texture.get("name", f"texture-{texture_index}")).stem
                    if kind == "normal" and texture_stem.endswith("_normal"):
                        texture_stem = texture_stem[:-7]
                    safe_stem = re.sub(r"[^A-Za-z0-9_-]+", "-", texture_stem).strip("-") or f"texture-{texture_index}"
                    filename = f"{args.filename_prefix}-{safe_stem}-{'normal' if kind == 'normal' else 'albedo'}.png"
                    destination = args.out_dir / filename
                    temporary_dds = args.out_dir / f".{filename}.tmp.dds"
                    temporary_dds.write_bytes(dds_header(width, height, len(mip_payloads), len(mip_payloads[0]), dds["compression"]) + b"".join(mip_payloads))
                    scale_args = ["-vf", "scale=1024:1024:flags=lanczos"]
                    subprocess.run([ffmpeg, "-v", "error", "-i", str(temporary_dds), *scale_args, "-frames:v", "1", "-y", str(destination)], check=True)
                    temporary_dds.unlink()
                    extracted[key] = filename
                    output_size = "1024x1024"
                    print(f"{filename}: decoded original DDS texture at {output_size} ({len(mip_payloads)} mip levels)")
                output_fields[f"formeOriginal{kind.title()}Texture"] = filename
                if kind == "normal" and "scale" in texture_info:
                    output_fields["formeOriginalNormalScale"] = texture_info["scale"]
            if output_fields:
                mapping[mat_name] = output_fields

    # The source renderer overlays this heart-specific filling layer on top of
    # each base atlas. Export it separately so the browser can reproduce that
    # material layer while keeping the original atlas UVs intact.
    texture_by_name = {texture.get("name"): i for i, texture in enumerate(gltf.get("textures", []))}
    for name in (("filling_heart.png", "filling_heart_normal.png") if args.cluster_id == HEART_CLUSTER else ()):
        texture_index = texture_by_name.get(name)
        if texture_index is None:
            continue
        texture = gltf["textures"][texture_index]
        dds = texture.get("extensions", {}).get("3D4M_compressed_texture_dds", {})
        if dds.get("compression") not in (33777, 33779):
            continue
        view = gltf["bufferViews"][dds["sources"][0]]
        if view.get("buffer") != 9:
            continue
        with args.dds_resource.open("rb") as raw:
            raw.seek(view.get("byteOffset", 0))
            payload = raw.read(view["byteLength"])
        temporary_dds = args.out_dir / f".{Path(name).stem}.dds"
        temporary_dds.write_bytes(dds_header(dds["width"], dds["height"], 1, len(payload), dds["compression"]) + payload)
        destination = args.out_dir / name
        subprocess.run([ffmpeg, "-v", "error", "-i", str(temporary_dds), "-frames:v", "1", "-y", str(destination)], check=True)
        temporary_dds.unlink()
        print(f"{name}: decoded original heart filling layer at {dds['width']}x{dds['height']}")

    (args.out_dir / args.mapping_name).write_text(json.dumps(mapping, indent=2) + "\n")
    print(f"Mapped {len(mapping)} source materials to {len(extracted)} decoded maps from {args.dds_resource}")


if __name__ == "__main__":
    main()
