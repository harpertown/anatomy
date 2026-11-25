#!/usr/bin/env python3
"""Convert all complete system clusters in the extracted male/female body packs."""

from __future__ import annotations

import json
import re
import subprocess
import sys
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCES = [
    ROOT / "assets/source/male-2024",
    ROOT / "assets/source/model-964db2",
]
CONVERTER = ROOT / "tools/make_heart_glb.py"
TEXTURE_EXTRACTOR = ROOT / "tools/extract_heart_dds_textures.py"
HEART_ID = "86e1552543b353b5a288737c11304168_Heart"
DDS_RESOURCE_NAME = "97011e9ced214718b089dd41ea34bfcf.bin"


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def cluster_stats(assets: dict, gltf: dict, root_index: int) -> tuple[int, int]:
    clusters = assets["clusters"]
    structure_indexes: set[int] = set()

    def walk(index: int) -> None:
        cluster = clusters[index]
        structure_indexes.update(cluster.get("structures", []))
        for child in cluster.get("clusters", []):
            walk(child)

    walk(root_index)
    nodes: set[int] = set()
    meshes: set[int] = set()
    for structure_index in structure_indexes:
        for ref in assets["structures"][structure_index].get("sni", []):
            node_index = ref.get("gltf")
            if isinstance(node_index, int) and 0 <= node_index < len(gltf["nodes"]):
                nodes.add(node_index)
                mesh_index = gltf["nodes"][node_index].get("mesh")
                if isinstance(mesh_index, int):
                    meshes.add(mesh_index)
    return len(structure_indexes), len(nodes)


def extract_texture_args(source: Path, model_slug: str, system_slug: str, cluster_id: str) -> list[str]:
    """Extract original app DDS maps and return converter mapping arguments."""
    resources = Path(os.environ.get(
        "COMPLETE_ANATOMY_RESOURCES",
        "/Applications/Complete Anatomy.app/Contents/Resources",
    ))
    dds_resource = resources / "dds" / DDS_RESOURCE_NAME
    if not dds_resource.exists():
        return []
    prefix = f"{model_slug}-{system_slug}"
    mapping = ROOT / "public/models/textures" / f"{prefix}-materials.json"
    subprocess.run([
        sys.executable, str(TEXTURE_EXTRACTOR), "--model-dir", str(source),
        "--cluster-id", cluster_id, "--dds-resource", str(dds_resource),
        "--out-dir", str(ROOT / "public/models/textures"),
        "--filename-prefix", prefix, "--mapping-name", mapping.name,
    ], check=True)
    return ["--material-textures", str(mapping)]


def main() -> None:
    destination = ROOT / "public/models/catalog"
    destination.mkdir(parents=True, exist_ok=True)
    catalog: list[dict] = []
    language_file = ROOT / "assets/source/en.json"
    name_args = ["--names-json", str(language_file)] if language_file.exists() else []
    material_textures = ROOT / "public/models/textures/heart-materials.json"
    texture_args = ["--material-textures", str(material_textures)] if material_textures.exists() else []
    runtime_material_samples = ROOT / "public/models/environments/cape_hill_runtime_sample.json"
    runtime_sample_args = ["--runtime-material-samples", str(runtime_material_samples)] if runtime_material_samples.exists() else []

    for source in SOURCES:
        assets = json.loads((source / "assets.json").read_text())
        gltf = json.loads((source / "assets.gltf").read_text())
        description = json.loads((source / "model_description.json").read_text())
        model_name = description["name"]
        model_slug = slug(model_name)
        clusters = assets["clusters"]
        indexes_by_id = {c["id"]: i for i, c in enumerate(clusters)}

        heart_index = indexes_by_id.get(HEART_ID)
        if heart_index is None:
            raise SystemExit(f"{model_name}: Heart cluster not found")
        heart_path = ROOT / "public/models/heart.glb" if model_slug == "male-2024" else destination / f"{model_slug}-heart.glb"
        heart_texture_args = (
            texture_args if model_slug == "male-2024"
            else extract_texture_args(source, model_slug, "heart", HEART_ID)
        )
        subprocess.run([
            sys.executable, str(CONVERTER), "--model-dir", str(source),
            "--cluster-id", HEART_ID, "--out", str(heart_path), *name_args,
            *heart_texture_args,
            *(runtime_sample_args if model_slug == "male-2024" else []),
        ], check=True)
        structure_count, mesh_count = cluster_stats(assets, gltf, heart_index)
        catalog.append({
            "id": f"{model_slug}-heart",
            "label": f"{model_name} · Heart",
            "model": model_name,
            "system": "Heart",
            "file": "heart.glb" if model_slug == "male-2024" else f"catalog/{heart_path.name}",
            "structures": structure_count,
            "meshes": mesh_count,
        })

        for root_index in description["root_clusters"]:
            cluster = clusters[root_index]
            label = cluster["id"].split("_", 1)[-1]
            filename = f"{model_slug}-{slug(label)}.glb"
            output = destination / filename
            local_texture_args = extract_texture_args(
                source, model_slug, slug(label), cluster["id"]
            )
            subprocess.run([
                sys.executable, str(CONVERTER), "--model-dir", str(source),
                "--cluster-id", cluster["id"], "--out", str(output), *name_args,
                *local_texture_args,
            ], check=True)
            structure_count, mesh_count = cluster_stats(assets, gltf, root_index)
            catalog.append({
                "id": f"{model_slug}-{slug(label)}",
                "label": f"{model_name} · {label}",
                "model": model_name,
                "system": label,
                "file": f"catalog/{filename}",
                "structures": structure_count,
                "meshes": mesh_count,
            })

        # The app's complete arterial and venous trees are nested in the
        # Cardiovascular System root. Export them as independently selectable
        # models as well as retaining the combined cardiovascular model.
        for vessel_system in ("Arteries", "Veins"):
            vessel_id = next(
                (c["id"] for c in clusters if c["id"].endswith(f"_{vessel_system}")),
                None,
            )
            if vessel_id is None:
                raise SystemExit(f"{model_name}: {vessel_system} cluster not found")
            local_texture_args = extract_texture_args(source, model_slug, slug(vessel_system), vessel_id)
            filename = f"{model_slug}-{slug(vessel_system)}.glb"
            output = destination / filename
            subprocess.run([
                sys.executable, str(CONVERTER), "--model-dir", str(source),
                "--cluster-id", vessel_id, "--out", str(output), *name_args,
                *local_texture_args,
            ], check=True)
            vessel_index = indexes_by_id[vessel_id]
            structure_count, mesh_count = cluster_stats(assets, gltf, vessel_index)
            catalog.append({
                "id": f"{model_slug}-{slug(vessel_system)}",
                "label": f"{model_name} · {vessel_system}",
                "model": model_name,
                "system": vessel_system,
                "file": f"catalog/{filename}",
                "structures": structure_count,
                "meshes": mesh_count,
            })

    manifest = ROOT / "public/models/catalog.json"
    manifest.write_text(json.dumps({"models": catalog}, indent=2) + "\n")
    print(f"Wrote {len(catalog)} offline model choices to {manifest}")
    subprocess.run([
        sys.executable, str(ROOT / "tools/extract_conduction_nodes.py"),
        "--male", str(destination / "male-2024-nervous-system.glb"),
        "--female", str(destination / "female-2024-nervous-system.glb"),
        "--out", str(ROOT / "public/models/conduction-node-geometry.json"),
    ], check=True)
    subprocess.run([sys.executable, str(ROOT / "tools/dedupe_source_textures.py")], check=True)


if __name__ == "__main__":
    main()
