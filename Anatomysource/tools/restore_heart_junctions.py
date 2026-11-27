#!/usr/bin/env python3
"""Restore source geometry at heart chamber junctions before final compression."""

from __future__ import annotations

import copy
import json
import struct
from pathlib import Path


PRESERVED_NODES = {
    "Left Atrium",
    "Left Auricle of Heart",
    "Posterolateral Wall of Left Atrium",
    "Right Atrium",
    "Lateral Wall of Right Atrium",
}
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
COMPONENT_BYTES = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
TYPE_COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}


def read_glb(path: Path) -> tuple[dict, bytearray, list[tuple[int, bytes]]]:
    data = path.read_bytes()
    if data[:4] != b"glTF":
        raise ValueError(f"Not a GLB file: {path}")
    version, length = struct.unpack_from("<II", data, 4)
    if version != 2 or length != len(data):
        raise ValueError(f"Invalid GLB header: {path}")

    offset = 12
    chunks = []
    document = None
    binary = bytearray()
    while offset < length:
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        start = offset + 8
        payload = data[start : start + chunk_length]
        offset = start + chunk_length
        if chunk_type == JSON_CHUNK:
            document = json.loads(payload)
        elif chunk_type == BIN_CHUNK:
            binary = bytearray(payload)
        else:
            chunks.append((chunk_type, payload))
    if document is None:
        raise ValueError(f"No JSON chunk in {path}")
    buffer_length = document.get("buffers", [{}])[0].get("byteLength", len(binary))
    return document, binary[:buffer_length], chunks


def write_glb(path: Path, document: dict, binary: bytearray, extra_chunks: list[tuple[int, bytes]]) -> None:
    document["buffers"][0]["byteLength"] = len(binary)
    json_data = json.dumps(document, separators=(",", ":")).encode("utf-8")
    json_data += b" " * (-len(json_data) % 4)
    binary_data = bytes(binary) + b"\0" * (-len(binary) % 4)
    chunks = [(JSON_CHUNK, json_data), (BIN_CHUNK, binary_data), *extra_chunks]
    total_length = 12 + sum(8 + len(payload) for _, payload in chunks)
    with path.open("wb") as output:
        output.write(b"glTF" + struct.pack("<II", 2, total_length))
        for chunk_type, payload in chunks:
            output.write(struct.pack("<II", len(payload), chunk_type))
            output.write(payload)


def mesh_nodes(document: dict) -> dict[str, dict]:
    return {
        node.get("name"): node
        for node in document.get("nodes", [])
        if node.get("name") in PRESERVED_NODES and node.get("mesh") is not None
    }


def accessor_bytes(document: dict, binary: bytearray, accessor_index: int) -> bytes:
    accessor = document["accessors"][accessor_index]
    if "sparse" in accessor:
        raise ValueError("Sparse accessors are not supported for preserved source meshes")
    view = document["bufferViews"][accessor["bufferView"]]
    if view.get("buffer", 0) != 0:
        raise ValueError("Expected preserved mesh data in the first GLB buffer")
    components = TYPE_COMPONENTS[accessor["type"]]
    component_bytes = COMPONENT_BYTES[accessor["componentType"]]
    element_bytes = components * component_bytes
    stride = view.get("byteStride", element_bytes)
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    if stride == element_bytes:
        end = start + accessor["count"] * element_bytes
        return bytes(binary[start:end])
    return b"".join(
        binary[start + index * stride : start + index * stride + element_bytes]
        for index in range(accessor["count"])
    )


def append_accessor(
    source_document: dict,
    source_binary: bytearray,
    target_document: dict,
    target_binary: bytearray,
    accessor_index: int,
) -> int:
    accessor = copy.deepcopy(source_document["accessors"][accessor_index])
    source_view = source_document["bufferViews"][accessor["bufferView"]]
    payload = accessor_bytes(source_document, source_binary, accessor_index)
    target_binary.extend(b"\0" * (-len(target_binary) % 4))
    view = {"buffer": 0, "byteOffset": len(target_binary), "byteLength": len(payload)}
    if "target" in source_view:
        view["target"] = source_view["target"]
    target_document["bufferViews"].append(view)
    target_binary.extend(payload)

    accessor["bufferView"] = len(target_document["bufferViews"]) - 1
    accessor["byteOffset"] = 0
    accessor.pop("sparse", None)
    target_document["accessors"].append(accessor)
    return len(target_document["accessors"]) - 1


def restore(source_path: Path, target_path: Path, output_path: Path) -> None:
    source, source_binary, _ = read_glb(source_path)
    target, target_binary, extra_chunks = read_glb(target_path)
    source_nodes = mesh_nodes(source)
    target_nodes = mesh_nodes(target)
    missing = PRESERVED_NODES - source_nodes.keys()
    if missing:
        raise ValueError(f"Source model is missing mesh nodes: {', '.join(sorted(missing))}")

    restored = []
    for name in sorted(PRESERVED_NODES):
        if name not in target_nodes:
            continue
        source_node = source_nodes[name]
        target_node = target_nodes[name]
        source_mesh = source["meshes"][source_node["mesh"]]
        target_mesh = target["meshes"][target_node["mesh"]]
        if len(source_mesh["primitives"]) != len(target_mesh["primitives"]):
            raise ValueError(f"Primitive count differs for {name}")

        for source_primitive, target_primitive in zip(source_mesh["primitives"], target_mesh["primitives"]):
            target_primitive["attributes"] = {
                semantic: append_accessor(source, source_binary, target, target_binary, index)
                for semantic, index in source_primitive.get("attributes", {}).items()
            }
            source_indices = source_primitive.get("indices")
            if source_indices is not None:
                target_primitive["indices"] = append_accessor(
                    source, source_binary, target, target_binary, source_indices
                )
            source_targets = source_primitive.get("targets", [])
            target_primitive["targets"] = [
                {
                    semantic: append_accessor(source, source_binary, target, target_binary, index)
                    for semantic, index in target_attributes.items()
                }
                for target_attributes in source_targets
            ]

        # Restored vertex data is in the original scene coordinate system.
        for transform in ("translation", "rotation", "scale", "matrix"):
            target_node.pop(transform, None)
        target_mesh["weights"] = copy.deepcopy(source_mesh.get("weights", target_mesh.get("weights", [])))
        restored.append(name)

    if not restored:
        raise ValueError("No matching chamber junction meshes found in target model")
    write_glb(output_path, target, target_binary, extra_chunks)
    print(f"Restored full-resolution junction geometry: {', '.join(restored)}")


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 4:
        raise SystemExit("Usage: restore_heart_junctions.py SOURCE.glb TARGET.glb OUTPUT.glb")
    restore(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
