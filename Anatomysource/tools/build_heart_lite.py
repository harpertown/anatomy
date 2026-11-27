#!/usr/bin/env python3
"""Build a compact male heart GLB without changing its source topology."""

from __future__ import annotations

import json
import math
import struct
import subprocess
import tempfile
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public/models/heart.glb"
OUTPUT = ROOT / "public/models/catalog/male-heart-lite.glb"
POSITION_QUANTIZATION_BITS = "16"
ATTRIBUTE_QUANTIZATION_BITS = "16"


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


def accessor_values(document: dict, binary: bytearray, accessor_index: int) -> list[tuple[float, ...]]:
    accessor = document["accessors"][accessor_index]
    view = document["bufferViews"][accessor["bufferView"]]
    component_count = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[accessor["type"]]
    component_format = {5121: "B", 5123: "H", 5125: "I", 5126: "f"}[accessor["componentType"]]
    component_bytes = struct.calcsize(component_format)
    element_bytes = component_count * component_bytes
    stride = view.get("byteStride", element_bytes)
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    return [
        struct.unpack_from("<" + component_format * component_count, binary, start + index * stride)
        for index in range(accessor["count"])
    ]


def snap_nearby_mesh_edges(document: dict, binary: bytearray) -> int:
    """Snap almost-coincident source boundary vertices before shared-grid quantization."""
    mesh_points: list[tuple[tuple[float, float, float], int, int, int]] = []
    all_positions: list[tuple[float, float, float]] = []

    for mesh_index, mesh in enumerate(document.get("meshes", [])):
        for primitive in mesh.get("primitives", []):
            if primitive.get("mode", 4) != 4:
                continue
            position_accessor = primitive.get("attributes", {}).get("POSITION")
            if position_accessor is None:
                continue
            positions = accessor_values(document, binary, position_accessor)
            all_positions.extend(positions)
            if "indices" in primitive:
                indices = [int(value[0]) for value in accessor_values(document, binary, primitive["indices"])]
            else:
                indices = list(range(len(positions)))

            edge_counts: Counter[tuple[int, int]] = Counter()
            for offset in range(0, len(indices) - 2, 3):
                triangle = indices[offset : offset + 3]
                for edge in (
                    tuple(sorted((triangle[0], triangle[1]))),
                    tuple(sorted((triangle[1], triangle[2]))),
                    tuple(sorted((triangle[2], triangle[0]))),
                ):
                    edge_counts[edge] += 1
            boundary_vertices = {vertex for edge, count in edge_counts.items() if count == 1 for vertex in edge}
            mesh_points.extend(
                (positions[index], mesh_index, position_accessor, index)
                for index in boundary_vertices
            )

    if not mesh_points or not all_positions:
        return 0

    minimum = [min(position[axis] for position in all_positions) for axis in range(3)]
    maximum = [max(position[axis] for position in all_positions) for axis in range(3)]
    scene_scale = max((maximum[axis] - minimum[axis]) / 2 for axis in range(3))
    tolerance = (2 * scene_scale / 32767) * 0.8
    if tolerance <= 0:
        return 0

    spatial_hash: dict[tuple[int, int, int], list[int]] = defaultdict(list)
    for point_index, (position, _mesh_index, _accessor, _vertex_index) in enumerate(mesh_points):
        cell = tuple(math.floor(value / tolerance) for value in position)
        spatial_hash[cell].append(point_index)

    nearest: dict[int, int] = {}
    max_distance_sq = tolerance * tolerance
    for point_index, (position, mesh_index, _accessor, _vertex_index) in enumerate(mesh_points):
        cell = tuple(math.floor(value / tolerance) for value in position)
        best: tuple[float, int] | None = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    neighbor_cell = (cell[0] + dx, cell[1] + dy, cell[2] + dz)
                    for candidate in spatial_hash.get(neighbor_cell, []):
                        candidate_position, candidate_mesh, _candidate_accessor, _candidate_vertex = mesh_points[candidate]
                        if candidate_mesh == mesh_index:
                            continue
                        distance_sq = sum((position[axis] - candidate_position[axis]) ** 2 for axis in range(3))
                        pair = (distance_sq, candidate)
                        if distance_sq < max_distance_sq and (best is None or pair < best):
                            best = pair
        if best is not None:
            nearest[point_index] = best[1]

    pairs = [
        (point_index, candidate)
        for point_index, candidate in nearest.items()
        if point_index < candidate and nearest.get(candidate) == point_index
    ]
    positions_by_accessor: dict[int, dict[int, tuple[float, float, float]]] = defaultdict(dict)
    for left, right in pairs:
        left_position, _left_mesh, left_accessor, left_vertex = mesh_points[left]
        right_position, _right_mesh, right_accessor, right_vertex = mesh_points[right]
        midpoint = tuple((left_position[axis] + right_position[axis]) / 2 for axis in range(3))
        positions_by_accessor[left_accessor][left_vertex] = midpoint
        positions_by_accessor[right_accessor][right_vertex] = midpoint

    for accessor_index, updates in positions_by_accessor.items():
        accessor = document["accessors"][accessor_index]
        view = document["bufferViews"][accessor["bufferView"]]
        stride = view.get("byteStride", 12)
        start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        for vertex_index, position in updates.items():
            struct.pack_into("<fff", binary, start + vertex_index * stride, *position)
        updated_positions = accessor_values(document, binary, accessor_index)
        accessor["min"] = [min(position[axis] for position in updated_positions) for axis in range(3)]
        accessor["max"] = [max(position[axis] for position in updated_positions) for axis in range(3)]

    return len(pairs)


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
    binary_chunks = [index for index, (kind, _payload) in enumerate(chunks) if kind == 0x004E4942]
    if len(binary_chunks) != 1:
        raise ValueError("Expected exactly one GLB binary chunk")
    binary_index = binary_chunks[0]
    binary = bytearray(chunks[binary_index][1])
    snapped_pairs = snap_nearby_mesh_edges(document, binary)
    chunks[binary_index] = (0x004E4942, bytes(binary))
    if snapped_pairs:
        print(f"Matched {snapped_pairs} near-coincident mesh-edge pairs")

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
                "npx", "--yes", "@gltf-transform/cli", "meshopt",
                str(clean_source),
                str(OUTPUT),
                # Medium avoids high-mode 8-bit normal filtering that can make
                # neighboring anatomical surfaces look like separate patches.
                "--level", "medium",
                # A scene-wide position grid keeps shared boundary coordinates aligned.
                "--quantization-volume", "scene",
                "--quantize-position", POSITION_QUANTIZATION_BITS,
                "--quantize-normal", ATTRIBUTE_QUANTIZATION_BITS,
                "--quantize-texcoord", ATTRIBUTE_QUANTIZATION_BITS,
            ],
            check=True,
            cwd=ROOT,
        )
    print(f"Created {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
