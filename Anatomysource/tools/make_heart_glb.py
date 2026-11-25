#!/usr/bin/env python3
"""Build a heart GLB with source morph targets and heart animation tracks."""

from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

HEART_CLUSTER = "86e1552543b353b5a288737c11304168_Heart"


def align4(data: bytearray) -> None:
    data.extend(b"\0" * (-len(data) % 4))


def accessor_refs(mesh: dict) -> set[int]:
    refs: set[int] = set()
    for primitive in mesh.get("primitives", []):
        refs.update(primitive.get("attributes", {}).values())
        if "indices" in primitive:
            refs.add(primitive["indices"])
        for target in primitive.get("targets", []):
            refs.update(target.values())
    return refs


def view_refs(accessors: dict) -> set[int]:
    refs: set[int] = set()
    if "bufferView" in accessors:
        refs.add(accessors["bufferView"])
    sparse = accessors.get("sparse", {})
    for key in ("indices", "values"):
        if "bufferView" in sparse.get(key, {}):
            refs.add(sparse[key]["bufferView"])
    return refs


def decode_source_normal(packed: int) -> tuple[float, float, float]:
    x = (packed & 0xFFFF) / 65535.0 * 2.0 - 1.0
    y = ((packed >> 16) & 0xFFFF) / 65535.0 * 2.0 - 1.0
    length_part = abs(1.0 - x * x - y * y)
    scale = length_part**0.5
    return (2.0 * x * scale, 2.0 * y * scale, 2.0 * length_part - 1.0)


def decode_source_tangent(packed: int) -> tuple[float, float, float, float]:
    x = (packed & 0x3FF) / 1023.0 * 2.0 - 1.0
    y = ((packed >> 10) & 0x3FF) / 1023.0 * 2.0 - 1.0
    z = ((packed >> 20) & 0x3FF) / 1023.0 * 2.0 - 1.0
    handedness = ((packed >> 30) & 0x3) * (2.0 / 3.0) - 1.0
    return (x, y, z, handedness)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--cluster-id", default=HEART_CLUSTER)
    parser.add_argument("--names-json", type=Path, help="decoded app language catalog for source structure names")
    parser.add_argument("--material-textures", type=Path, help="JSON mapping of original heart material names to extracted local maps")
    parser.add_argument("--runtime-material-samples", type=Path, help="read-only live MaterialBuffer samples used to match source material parameters")
    args = parser.parse_args()

    root = args.model_dir
    gltf = json.loads((root / "assets.gltf").read_text())
    assets = json.loads((root / "assets.json").read_text())
    names_by_cid: dict[int, str] = {}
    if args.names_json:
        language = json.loads(args.names_json.read_text())
        names_by_cid = {item["cid"]: item["name"] for item in language.get("items", []) if isinstance(item.get("cid"), int) and item.get("name")}
    material_textures = json.loads(args.material_textures.read_text()) if args.material_textures and args.material_textures.exists() else {}
    runtime_samples = json.loads(args.runtime_material_samples.read_text()) if args.runtime_material_samples and args.runtime_material_samples.exists() else {}
    runtime_material_samples = runtime_samples.get("ordinarySceneMaterialBufferSamples", [])
    clusters = assets["clusters"]
    structures = assets["structures"]
    cluster_by_id = {c["id"]: i for i, c in enumerate(clusters)}
    if args.cluster_id not in cluster_by_id:
        raise SystemExit(f"cluster not found: {args.cluster_id}")

    cluster_paths: dict[int, list[str]] = {}
    cluster_key_paths: dict[int, list[str]] = {}
    structure_names: dict[int, str] = {}
    selected_structures: set[int] = set()

    def walk(index: int, path: list[str], key_path: list[str]) -> None:
        cluster = clusters[index]
        label = cluster.get("id", "").partition("_")[2] or cluster["id"]
        path = path + [label]
        key_path = key_path + [cluster["id"]]
        for structure_index in cluster.get("structures", []):
            selected_structures.add(structure_index)
            cluster_paths.setdefault(structure_index, path)
            cluster_key_paths.setdefault(structure_index, key_path)
        for child in cluster.get("clusters", []):
            walk(child, path, key_path)

    walk(cluster_by_id[args.cluster_id], [], [])

    node_paths: dict[int, list[str]] = {}
    node_path_keys: dict[int, list[str]] = {}
    node_display_names: dict[int, str] = {}
    structure_names: dict[int, str] = {}
    for structure_index in sorted(selected_structures):
        structure = structures[structure_index]
        structure_id = structure["id"]
        structure_name = names_by_cid.get(structure.get("cid"), "")
        structure_name = structure_name or f"part {structure_id[:8]}"
        for name_ref in structure.get("sni", []):
            node_index = name_ref.get("gltf")
            if isinstance(node_index, int) and 0 <= node_index < len(gltf["nodes"]):
                node_paths[node_index] = cluster_paths[structure_index]
                node_path_keys[node_index] = cluster_key_paths[structure_index]
                node_display_names[node_index] = structure_name
                structure_names[node_index] = structure_id

    if not node_paths:
        raise SystemExit("heart cluster contains no glTF nodes")

    selected_nodes = sorted(node_paths)
    selected_node_set = set(selected_nodes)
    source_animations = []
    for animation in (gltf.get("animations", []) if args.cluster_id == HEART_CLUSTER else []):
        channels = [
            channel for channel in animation.get("channels", [])
            if channel.get("target", {}).get("node") in selected_node_set
        ]
        if not channels:
            continue
        used_samplers = sorted({channel["sampler"] for channel in channels})
        sampler_map = {old: new for new, old in enumerate(used_samplers)}
        source_animations.append({
            "name": "Heart cycle (30 frame data)",
            "channels": channels,
            "samplers": [json.loads(json.dumps(animation["samplers"][i])) for i in used_samplers],
            "sampler_map": sampler_map,
        })

    mesh_map: dict[int, int] = {}
    material_map: dict[int, int] = {}
    new_meshes: list[dict] = []
    new_materials: list[dict] = []
    for old_node_index in selected_nodes:
        old_mesh_index = gltf["nodes"][old_node_index].get("mesh")
        if old_mesh_index is None:
            continue
        if old_mesh_index not in mesh_map:
            mesh_map[old_mesh_index] = len(new_meshes)
            new_meshes.append(json.loads(json.dumps(gltf["meshes"][old_mesh_index])))
        for primitive in new_meshes[mesh_map[old_mesh_index]]["primitives"]:
            source_material = primitive.pop("material", None)
            primitive.pop("extensions", None)
            primitive["extras"] = {"formeSourceMaterial": source_material}
            if isinstance(source_material, int):
                if source_material not in material_map:
                    source = gltf["materials"][source_material]
                    material = json.loads(json.dumps(source))
                    forme_material = source.get("extensions", {}).get("3D4M_material", {})
                    material.pop("extensions", None)
                    # Complete Anatomy encodes lighting through its custom renderer;
                    # this near-white emissive factor washes out the diffuse map in PBR viewers.
                    material.pop("emissiveFactor", None)
                    pbr = material.get("pbrMetallicRoughness", {})
                    pbr.pop("baseColorTexture", None)
                    material.pop("normalTexture", None)
                    material.pop("occlusionTexture", None)
                    material.pop("emissiveTexture", None)
                    texture_fields = material_textures.get(source.get("name", ""), {})
                    source_fields = {}
                    if "reflection" in forme_material:
                        source_fields["formeOriginalReflection"] = forme_material["reflection"]
                    if "defaultOpacity" in forme_material:
                        source_fields["formeOriginalOpacity"] = forme_material["defaultOpacity"]
                    # Match captured runtime values by the complete source
                    # material signature. Apply only unambiguous matches.
                    for sample in runtime_material_samples:
                        normals_intensity = sample.get("normalsIntensity")
                        if not isinstance(normals_intensity, list) or len(normals_intensity) != 2:
                            continue
                        signature = (sample.get("metallic"), sample.get("roughness"), sample.get("reflectance"))

                        def matches(candidate: dict) -> bool:
                            candidate_pbr = candidate.get("pbrMetallicRoughness", {})
                            candidate_forme = candidate.get("extensions", {}).get("3D4M_material", {})
                            values = (
                                candidate_pbr.get("metallicFactor", 0.0),
                                candidate_pbr.get("roughnessFactor", 1.0),
                                candidate_forme.get("reflection"),
                            )
                            return all(
                                isinstance(left, (int, float)) and isinstance(right, (int, float))
                                and abs(left - right) < 0.00002
                                for left, right in zip(values, signature)
                            )

                        candidates = [candidate for candidate in gltf["materials"] if matches(candidate)]
                        if len(candidates) == 1 and candidates[0].get("name") == source.get("name"):
                            source_fields["formeRuntimeNormalIntensity"] = normals_intensity
                            break
                    material["extras"] = {**material.get("extras", {}), **source_fields, **texture_fields}
                    material_map[source_material] = len(new_materials)
                    new_materials.append(material)
                primitive["material"] = material_map[source_material]

    used_accessors: set[int] = set()
    for mesh in new_meshes:
        used_accessors.update(accessor_refs(mesh))
    for animation in source_animations:
        for sampler in animation["samplers"]:
            used_accessors.add(sampler["input"])
            used_accessors.add(sampler["output"])
    accessor_map = {old: new for new, old in enumerate(sorted(used_accessors))}
    new_accessors = [json.loads(json.dumps(gltf["accessors"][i])) for i in sorted(used_accessors)]
    for mesh in new_meshes:
        for primitive in mesh.get("primitives", []):
            primitive["attributes"] = {k: accessor_map[v] for k, v in primitive.get("attributes", {}).items()}
            if "indices" in primitive:
                primitive["indices"] = accessor_map[primitive["indices"]]
            for target in primitive.get("targets", []):
                for key, value in list(target.items()):
                    target[key] = accessor_map[value]

    old_views: set[int] = set()
    for accessor in new_accessors:
        old_views.update(view_refs(accessor))
    view_map: dict[int, int] = {}
    bin_data = bytearray()
    new_views: list[dict] = []
    source_buffers: dict[int, bytes] = {}
    for old_view_index in sorted(old_views):
        view = json.loads(json.dumps(gltf["bufferViews"][old_view_index]))
        buffer_index = view["buffer"]
        if buffer_index >= 3:
            raise ValueError(f"selected geometry refers to non-mesh buffer {buffer_index}")
        if buffer_index not in source_buffers:
            source_buffers[buffer_index] = (root / gltf["buffers"][buffer_index]["uri"]).read_bytes()
        source = source_buffers[buffer_index]
        start = view.get("byteOffset", 0)
        end = start + view["byteLength"]
        if end > len(source):
            raise ValueError(f"bufferView {old_view_index} exceeds source buffer")
        align4(bin_data)
        view_map[old_view_index] = len(new_views)
        view["buffer"] = 0
        view["byteOffset"] = len(bin_data)
        bin_data.extend(source[start:end])
        new_views.append(view)

    for accessor in new_accessors:
        if "bufferView" in accessor:
            accessor["bufferView"] = view_map[accessor["bufferView"]]
        sparse = accessor.get("sparse", {})
        for key in ("indices", "values"):
            if "bufferView" in sparse.get(key, {}):
                sparse[key]["bufferView"] = view_map[sparse[key]["bufferView"]]

    # The app's source renderer reads normals as one packed 2x16 octahedral
    # normal and tangents as one packed 10:10:10:2 word. Their glTF accessors
    # expose these words using nonstandard VEC2/VEC4 declarations, which
    # Three.js interprets as ordinary vectors. Decode them into standard glTF
    # float attributes so tangent-space normal maps use the source TBN frame.
    inverse_accessor_map = {new: old for old, new in accessor_map.items()}
    decoded_attributes: dict[tuple[int, str], int] = {}
    packed_source_buffers: dict[int, bytes] = {}
    for mesh in new_meshes:
        for primitive in mesh.get("primitives", []):
            attributes = primitive.get("attributes", {})
            for semantic, decoder, component_count, gltf_type in (
                ("NORMAL", decode_source_normal, 3, "VEC3"),
                ("TANGENT", decode_source_tangent, 4, "VEC4"),
            ):
                if semantic not in attributes:
                    continue
                current_accessor = attributes[semantic]
                key = (current_accessor, semantic)
                if key not in decoded_attributes:
                    old_accessor_index = inverse_accessor_map[current_accessor]
                    source_accessor = gltf["accessors"][old_accessor_index]
                    source_view = gltf["bufferViews"][source_accessor["bufferView"]]
                    source_buffer_index = source_view["buffer"]
                    if source_buffer_index not in packed_source_buffers:
                        packed_source_buffers[source_buffer_index] = (root / gltf["buffers"][source_buffer_index]["uri"]).read_bytes()
                    source_bytes = packed_source_buffers[source_buffer_index]
                    stride = source_view.get("byteStride", 4)
                    base_offset = source_view.get("byteOffset", 0) + source_accessor.get("byteOffset", 0)
                    values = []
                    for vertex in range(source_accessor["count"]):
                        packed = struct.unpack_from("<I", source_bytes, base_offset + vertex * stride)[0]
                        values.extend(decoder(packed))
                    align4(bin_data)
                    data_offset = len(bin_data)
                    bin_data.extend(struct.pack(f"<{len(values)}f", *values))
                    decoded_view_index = len(new_views)
                    new_views.append({
                        "buffer": 0,
                        "byteOffset": data_offset,
                        "byteLength": len(values) * 4,
                        "target": 34962,
                    })
                    decoded_accessor_index = len(new_accessors)
                    new_accessors.append({
                        "bufferView": decoded_view_index,
                        "componentType": 5126,
                        "count": source_accessor["count"],
                        "type": gltf_type,
                    })
                    decoded_attributes[key] = decoded_accessor_index
                attributes[semantic] = decoded_attributes[key]

    new_nodes: list[dict] = []
    node_map: dict[int, int] = {}
    cluster_nodes: dict[tuple[str, ...], int] = {}
    scene_roots: list[int] = []

    for old_node_index in selected_nodes:
        path = node_paths[old_node_index]
        for depth in range(1, len(path) + 1):
            key = tuple(node_path_keys[old_node_index][:depth])
            if key in cluster_nodes:
                continue
            cluster_index = len(new_nodes)
            cluster_nodes[key] = cluster_index
            new_nodes.append({
                "name": path[depth - 1],
                "extras": {"formeDisplayName": path[depth - 1], "formeIsCluster": True},
                "children": [],
            })
            if depth == 1:
                scene_roots.append(cluster_index)
            else:
                parent_key = tuple(node_path_keys[old_node_index][:depth - 1])
                parent_index = cluster_nodes[parent_key]
                new_nodes[parent_index]["children"].append(cluster_index)

    for old_node_index in selected_nodes:
        old_node = gltf["nodes"][old_node_index]
        old_mesh_index = old_node.get("mesh")
        if old_mesh_index is None:
            continue
        node_map[old_node_index] = len(new_nodes)
        node = {k: v for k, v in old_node.items() if k in ("translation", "rotation", "scale", "matrix", "weights")}
        node["name"] = node_display_names[old_node_index]
        node["extras"] = {
            "formeDisplayName": node_display_names[old_node_index],
            "formeSourceId": structure_names[old_node_index],
            "formeClusterPath": " / ".join(node_paths[old_node_index]),
        }
        node["mesh"] = mesh_map[old_mesh_index]
        new_nodes.append(node)
        parent_index = cluster_nodes[tuple(node_path_keys[old_node_index])]
        new_nodes[parent_index]["children"].append(node_map[old_node_index])

    new_animations = []
    for animation in source_animations:
        used_samplers = sorted(animation["sampler_map"], key=animation["sampler_map"].get)
        new_animations.append({
            "name": animation["name"],
            "samplers": [
                {
                    **sampler,
                    "input": accessor_map[sampler["input"]],
                    "output": accessor_map[sampler["output"]],
                }
                for sampler in animation["samplers"]
            ],
            "channels": [
                {
                    "sampler": animation["sampler_map"][channel["sampler"]],
                    "target": {
                        **channel["target"],
                        "node": node_map[channel["target"]["node"]],
                    },
                }
                for channel in animation["channels"]
                if channel["target"]["node"] in node_map
            ],
        })

    out_gltf = {
        "asset": {"version": "2.0", "generator": "Forme Anatomy WCAR extraction"},
        "scene": 0,
        "scenes": [{"nodes": scene_roots}],
        "nodes": new_nodes,
        "meshes": new_meshes,
        "materials": new_materials,
        "accessors": new_accessors,
        "bufferViews": new_views,
        "buffers": [{"byteLength": len(bin_data)}],
    }
    if new_animations:
        out_gltf["animations"] = new_animations
    json_chunk = json.dumps(out_gltf, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    json_chunk += b" " * (-len(json_chunk) % 4)
    align4(bin_data)
    total_len = 12 + 8 + len(json_chunk) + 8 + len(bin_data)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("wb") as f:
        f.write(b"glTF")
        f.write(struct.pack("<II", 2, total_len))
        f.write(struct.pack("<I4s", len(json_chunk), b"JSON"))
        f.write(json_chunk)
        f.write(struct.pack("<I4s", len(bin_data), b"BIN\0"))
        f.write(bin_data)

    print(f"Cluster: {args.cluster_id}")
    print(f"Structures: {len(selected_structures)}; scene nodes: {len(new_nodes)}; meshes: {len(new_meshes)}")
    print(f"Geometry buffer: {len(bin_data):,} bytes; animations: {len(new_animations)}; output: {args.out}")


if __name__ == "__main__":
    main()
