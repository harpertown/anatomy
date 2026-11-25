#!/usr/bin/env python3
"""Extract cardiac conduction meshes from the bundled nervous-system GLBs."""

from __future__ import annotations

import argparse
import json
import math
import struct
from pathlib import Path


def read_glb(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    if data[:4] != b"glTF":
        raise ValueError(f"not a GLB file: {path}")
    json_length, json_type = struct.unpack_from("<II", data, 12)
    if json_type != 0x4E4F534A:
        raise ValueError(f"first GLB chunk is not JSON: {path}")
    gltf = json.loads(data[20:20 + json_length])
    offset = 20 + json_length
    binary_length, binary_type = struct.unpack_from("<II", data, offset)
    if binary_type != 0x004E4942:
        raise ValueError(f"second GLB chunk is not BIN: {path}")
    return gltf, data[offset + 8:offset + 8 + binary_length]


def matrix_multiply(a: list[list[float]], b: list[list[float]]) -> list[list[float]]:
    return [[sum(a[r][k] * b[k][c] for k in range(4)) for c in range(4)] for r in range(4)]


def local_matrix(node: dict) -> list[list[float]]:
    if "matrix" in node:
        values = node["matrix"]
        return [[values[c * 4 + r] for c in range(4)] for r in range(4)]
    x, y, z, w = node.get("rotation", [0, 0, 0, 1])
    sx, sy, sz = node.get("scale", [1, 1, 1])
    tx, ty, tz = node.get("translation", [0, 0, 0])
    return [
        [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y - z * w) * sy, 2 * (x * z + y * w) * sz, tx],
        [2 * (x * y + z * w) * sx, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z - x * w) * sz, ty],
        [2 * (x * z - y * w) * sx, 2 * (y * z + x * w) * sy, (1 - 2 * (x * x + y * y)) * sz, tz],
        [0, 0, 0, 1],
    ]


def node_world_matrix(gltf: dict, node_index: int) -> list[list[float]]:
    parents = {}
    for parent_index, node in enumerate(gltf["nodes"]):
        for child in node.get("children", []):
            parents[child] = parent_index
    chain = []
    current = node_index
    while current in parents:
        chain.append(current)
        current = parents[current]
    chain.append(current)
    result = [[1 if r == c else 0 for c in range(4)] for r in range(4)]
    for index in reversed(chain):
        result = matrix_multiply(result, local_matrix(gltf["nodes"][index]))
    return result


def read_accessor(gltf: dict, binary: bytes, accessor_index: int) -> list[tuple[float, ...]]:
    accessor = gltf["accessors"][accessor_index]
    view = gltf["bufferViews"][accessor["bufferView"]]
    formats = {5121: ("B", 1), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
    format_code, component_size = formats[accessor["componentType"]]
    component_count = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[accessor["type"]]
    item_size = component_size * component_count
    stride = view.get("byteStride", item_size)
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    return [
        struct.unpack_from(f"<{component_count}{format_code}", binary, start + i * stride)
        for i in range(accessor["count"])
    ]


def extract_node(gltf: dict, binary: bytes, display_name: str) -> dict:
    matches = [
        (index, node) for index, node in enumerate(gltf["nodes"])
        if node.get("extras", {}).get("formeDisplayName") == display_name
    ]
    if len(matches) != 1:
        raise ValueError(f"expected one {display_name} mesh, found {len(matches)}")
    node_index, node = matches[0]
    if "mesh" not in node:
        raise ValueError(f"{display_name} has no mesh")
    world = node_world_matrix(gltf, node_index)
    positions: list[list[float]] = []
    indices: list[int] = []
    for primitive in gltf["meshes"][node["mesh"]]["primitives"]:
        base = len(positions)
        source_positions = read_accessor(gltf, binary, primitive["attributes"]["POSITION"])
        for x, y, z in source_positions:
            point = [
                world[0][0] * x + world[0][1] * y + world[0][2] * z + world[0][3],
                world[1][0] * x + world[1][1] * y + world[1][2] * z + world[1][3],
                world[2][0] * x + world[2][1] * y + world[2][2] * z + world[2][3],
            ]
            positions.append(point)
        if "indices" in primitive:
            indices.extend(base + int(index[0]) for index in read_accessor(gltf, binary, primitive["indices"]))
        else:
            indices.extend(range(base, base + len(source_positions)))
    minimum = [min(point[axis] for point in positions) for axis in range(3)]
    maximum = [max(point[axis] for point in positions) for axis in range(3)]
    center = [(minimum[axis] + maximum[axis]) * 0.5 for axis in range(3)]
    radius = max(math.dist(center, point) for point in positions)
    return {
        "center": center,
        "radius": radius,
        "positions": positions,
        "indices": indices,
        "bounds": {"min": minimum, "max": maximum},
    }


def extract_named_meshes(gltf: dict, binary: bytes, display_name: str) -> list[dict]:
    matches = [node for node in gltf["nodes"]
               if node.get("extras", {}).get("formeDisplayName") == display_name]
    results = []
    for node in matches:
        if "mesh" not in node:
            continue
        # Extract by node index so repeated display names (the Purkinje
        # subendocardial branch meshes) remain separate and retain transforms.
        results.append(extract_node_at(gltf, binary, gltf["nodes"].index(node)))
    return results


def extract_node_at(gltf: dict, binary: bytes, node_index: int) -> dict:
    node = gltf["nodes"][node_index]
    world = node_world_matrix(gltf, node_index)
    positions: list[list[float]] = []
    indices: list[int] = []
    for primitive in gltf["meshes"][node["mesh"]]["primitives"]:
        base = len(positions)
        for x, y, z in read_accessor(gltf, binary, primitive["attributes"]["POSITION"]):
            positions.append([
                world[0][0] * x + world[0][1] * y + world[0][2] * z + world[0][3],
                world[1][0] * x + world[1][1] * y + world[1][2] * z + world[1][3],
                world[2][0] * x + world[2][1] * y + world[2][2] * z + world[2][3],
            ])
        if "indices" in primitive:
            indices.extend(base + int(index[0]) for index in read_accessor(gltf, binary, primitive["indices"]))
        else:
            indices.extend(range(base, base + len(positions) - base))
    minimum = [min(point[axis] for point in positions) for axis in range(3)]
    maximum = [max(point[axis] for point in positions) for axis in range(3)]
    center = [(minimum[axis] + maximum[axis]) * 0.5 for axis in range(3)]
    return {"center": center, "positions": positions, "indices": indices,
            "bounds": {"min": minimum, "max": maximum}}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--male", type=Path, required=True)
    parser.add_argument("--female", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    models = {}
    for sex, path in (("male-2024", args.male), ("female-2024", args.female)):
        gltf, binary = read_glb(path)
        models[sex] = {
            "source": path.name,
            "sinuatrial": extract_node(gltf, binary, "Sinuatrial Node"),
            "atrioventricular": extract_node(gltf, binary, "Atrioventricular Node"),
            "pathways": {
                "anteriorInternodal": extract_node(gltf, binary, "Anterior Internodal Tract"),
                "middleInternodal": extract_node(gltf, binary, "Middle Internodal Tract"),
                "posteriorInternodal": extract_node(gltf, binary, "Posterior Internodal Tract"),
                "hisBundle": extract_node(gltf, binary, "Trunk of Atrioventricular Bundle"),
                "rightBundle": extract_node(gltf, binary, "Right Bundle Branch of Atrioventricular Bundle"),
                "leftBundle": extract_node(gltf, binary, "Left Bundle Branch of Atrioventricular Bundle"),
                "purkinje": extract_named_meshes(gltf, binary, "Subendocardial Branches"),
            },
        }
    male_nodes = models["male-2024"]
    female_nodes = models["female-2024"]
    model_offset = [
        sum(female_nodes[key]["center"][axis] - male_nodes[key]["center"][axis] for key in ("sinuatrial", "atrioventricular")) / 2
        for axis in range(3)
    ]
    male_nodes["routeOffset"] = [0, 0, 0]
    female_nodes["routeOffset"] = model_offset
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({"models": models}, separators=(",", ":")) + "\n")
    print(f"Extracted cardiac nodes and conduction pathways for {len(models)} nervous-system models to {args.out}")


if __name__ == "__main__":
    main()
