#!/usr/bin/env python3
"""Project 12-lead electrode sites onto the Complete Anatomy skin meshes."""
from __future__ import annotations

import json
import heapq
import struct
from pathlib import Path

import numpy as np
import pyvista as pv
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "public/models"
LANDMARKS_FILE = PUBLIC / "ecg-landmarks.json"
SEX_MODELS = {
    "male": PUBLIC / "catalog/male-2024-integumentary-system.glb",
    "female": PUBLIC / "catalog/female-2024-integumentary-system.glb",
}
LIMB_TARGETS = {
    # RL/LL remain at the lower abdomen near the iliac crest, using the
    # corresponding side-specific abdominal skin patches.
    "RL": ("Skin (Abdomen; Right)", (-4.3, -7.8, 2.5)),
    "LL": ("Skin (Abdomen; Left)", (4.3, -7.8, 2.5)),
}
ARM_TARGETS = {
    "RA": "Skin (Thorax; Right)",
    "LA": "Skin (Thorax; Left)",
}


def read_glb(path: Path) -> tuple[dict, memoryview]:
    raw = path.read_bytes()
    magic, version, total = struct.unpack_from("<4sII", raw)
    if magic != b"glTF" or version != 2 or total != len(raw):
        raise ValueError(f"Invalid GLB 2 file: {path}")
    offset = 12
    document = None
    binary = None
    while offset < len(raw):
        length, chunk_type = struct.unpack_from("<I4s", raw, offset)
        chunk = memoryview(raw)[offset + 8 : offset + 8 + length]
        if chunk_type == b"JSON":
            document = json.loads(chunk.tobytes())
        elif chunk_type == b"BIN\x00":
            binary = chunk
        offset += 8 + length
    if document is None or binary is None:
        raise ValueError(f"Missing JSON or binary chunk in {path}")
    return document, binary


def accessor(document: dict, binary: memoryview, index: int) -> np.ndarray:
    item = document["accessors"][index]
    view = document["bufferViews"][item["bufferView"]]
    dtype = {5121: np.dtype("u1"), 5123: np.dtype("<u2"), 5125: np.dtype("<u4"), 5126: np.dtype("<f4")}[item["componentType"]]
    components = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[item["type"]]
    stride = view.get("byteStride", dtype.itemsize * components)
    offset = view.get("byteOffset", 0) + item.get("byteOffset", 0)
    values = np.ndarray(
        (item["count"], components),
        dtype=dtype,
        buffer=binary,
        offset=offset,
        strides=(stride, dtype.itemsize),
    )
    return values[:, 0] if components == 1 else values


def local_matrix(node: dict) -> np.ndarray:
    if "matrix" in node:
        return np.asarray(node["matrix"], dtype=float).reshape(4, 4).T
    translation = np.asarray(node.get("translation", (0, 0, 0)), dtype=float)
    scale = np.asarray(node.get("scale", (1, 1, 1)), dtype=float)
    x, y, z, w = node.get("rotation", (0, 0, 0, 1))
    rotation = np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ],
    )
    matrix = np.eye(4)
    matrix[:3, :3] = rotation @ np.diag(scale)
    matrix[:3, 3] = translation
    return matrix


def skin_surfaces(path: Path) -> dict[str, pv.PolyData]:
    document, _ = read_glb(path)
    gltf_scene = pv.read(path)

    def find_node(block: pv.MultiBlock | pv.DataSet, target: str):
        if not isinstance(block, pv.MultiBlock):
            return None
        for index, child in enumerate(block):
            if block.get_block_name(index) == target:
                return child
            match = find_node(child, target)
            if match is not None:
                return match
        return None

    def polydata_leaves(block) -> list[pv.PolyData]:
        if isinstance(block, pv.MultiBlock):
            return [leaf for child in block for leaf in polydata_leaves(child)]
        if isinstance(block, pv.PolyData):
            return [block]
        return []

    output = {}
    for index, node in enumerate(document["nodes"]):
        name = node.get("name", "")
        if not name.startswith("Skin (") or "mesh" not in node:
            continue
        block = find_node(gltf_scene, f"Node_{index}")
        leaves = polydata_leaves(block) if block is not None else []
        if not leaves:
            continue
        surface = leaves[0].triangulate()
        for leaf in leaves[1:]:
            surface = surface.merge(leaf.triangulate(), merge_points=True)
        output[name] = surface.triangulate()
    return output


def nearest_surface_point(surface: pv.PolyData, target: tuple[float, float, float]) -> tuple[np.ndarray, float]:
    _, closest = surface.find_closest_cell(np.asarray(target, dtype=float), return_closest_point=True)
    point = np.asarray(closest, dtype=float)
    return point, float(np.linalg.norm(point - np.asarray(target, dtype=float)))


def point_on_horizontal_chest_section(surface: pv.PolyData, target: np.ndarray, level_y: float) -> tuple[np.ndarray, float]:
    section = surface.slice(normal=(0, 1, 0), origin=(0, level_y, 0))
    if section.n_cells == 0:
        raise ValueError(f"No chest-surface section at the V4 level y={level_y:.4f}")
    _, closest = section.find_closest_cell(target, return_closest_point=True)
    point = np.asarray(closest, dtype=float)
    return point, float(np.linalg.norm(point - target))


def midpoint_along_horizontal_skin(
    surface: pv.PolyData,
    start: np.ndarray,
    end: np.ndarray,
    level_y: float,
) -> tuple[np.ndarray, float]:
    """Find V5 halfway along the V4-to-V6 chest-surface contour."""
    section = surface.slice(normal=(0, 1, 0), origin=(0, level_y, 0))
    if section.n_cells == 0:
        raise ValueError(f"No chest-surface section at the V4 level y={level_y:.4f}")

    points = section.points
    adjacency: list[dict[int, float]] = [dict() for _ in points]

    def connect(first: int, second: int, distance: float) -> None:
        adjacency[first][second] = min(adjacency[first].get(second, float("inf")), distance)
        adjacency[second][first] = min(adjacency[second].get(first, float("inf")), distance)

    line_data = section.lines
    offset = 0
    while offset < len(line_data):
        count = int(line_data[offset])
        indices = line_data[offset + 1 : offset + count + 1]
        offset += count + 1
        for first, second in zip(indices[:-1], indices[1:]):
            first, second = int(first), int(second)
            connect(first, second, float(np.linalg.norm(points[first] - points[second])))

    # App skin areas are separate meshes; join their contour vertices across
    # tiny seams so the midpoint follows the body surface instead of a chord.
    for first, second in cKDTree(points).query_pairs(r=0.08):
        first, second = int(first), int(second)
        connect(first, second, float(np.linalg.norm(points[first] - points[second])))

    start_index = int(np.argmin(np.linalg.norm(points - start, axis=1)))
    end_index = int(np.argmin(np.linalg.norm(points - end, axis=1)))
    if np.linalg.norm(points[start_index] - start) > 0.2 or np.linalg.norm(points[end_index] - end) > 0.2:
        raise ValueError("V4 or V6 is too far from the horizontal chest-surface contour")

    distances = [float("inf")] * len(points)
    previous = [-1] * len(points)
    distances[start_index] = 0.0
    queue = [(0.0, start_index)]
    while queue:
        distance, current = heapq.heappop(queue)
        if distance != distances[current]:
            continue
        if current == end_index:
            break
        for neighbor, edge_length in adjacency[current].items():
            candidate = distance + edge_length
            if candidate < distances[neighbor]:
                distances[neighbor] = candidate
                previous[neighbor] = current
                heapq.heappush(queue, (candidate, neighbor))

    path_length = distances[end_index]
    if not np.isfinite(path_length):
        raise ValueError("V4 and V6 lie on disconnected horizontal chest-surface contours")

    route = []
    current = end_index
    while current >= 0:
        route.append(current)
        current = previous[current]
    route.reverse()

    half_distance = path_length / 2
    traversed = 0.0
    for first, second in zip(route[:-1], route[1:]):
        edge_length = float(np.linalg.norm(points[second] - points[first]))
        if traversed + edge_length >= half_distance:
            fraction = (half_distance - traversed) / edge_length if edge_length else 0.0
            midpoint = points[first] * (1 - fraction) + points[second] * fraction
            return np.asarray(midpoint, dtype=float), path_length
        traversed += edge_length
    return np.asarray(points[end_index], dtype=float), path_length


def point_on_midclavicular_chest_line(
    surface: pv.PolyData,
    target: np.ndarray,
    x_midclavicular: float,
    level_y: float,
) -> tuple[np.ndarray, float]:
    section = surface.slice(normal=(0, 1, 0), origin=(0, level_y, 0))
    line_ids = section.lines
    offset = 0
    intersections = []
    while offset < len(line_ids):
        count = int(line_ids[offset])
        indices = line_ids[offset + 1 : offset + count + 1]
        offset += count + 1
        for first, second in zip(indices[:-1], indices[1:]):
            a, b = section.points[first], section.points[second]
            if min(a[0], b[0]) - 1e-8 <= x_midclavicular <= max(a[0], b[0]) + 1e-8:
                fraction = 0.0 if abs(b[0] - a[0]) < 1e-10 else (x_midclavicular - a[0]) / (b[0] - a[0])
                intersections.append(np.array((x_midclavicular, level_y, a[2] + fraction * (b[2] - a[2]))) )
    if not intersections:
        raise ValueError(f"No chest-surface point on the midclavicular line at y={level_y:.4f}")
    point = max(intersections, key=lambda candidate: candidate[2]) if target[2] == float("inf") else min(
        intersections, key=lambda candidate: abs(candidate[2] - target[2])
    )
    distance = float(np.linalg.norm(point[:2] - target[:2])) if target[2] == float("inf") else float(np.linalg.norm(point - target))
    return point, distance


def main() -> None:
    landmarks = json.loads(LANDMARKS_FILE.read_text())
    for sex, path in SEX_MODELS.items():
        if not path.is_file():
            raise SystemExit(f"Missing app skin model: {path}")
        surfaces = skin_surfaces(path)
        context_surfaces = pv.MultiBlock()
        for name, surface in surfaces.items():
            if any(region in name for region in ("Thorax", "Back", "Abdomen", "Neck", "Shoulder", "Quadrant of Breast")):
                context_surfaces.append(surface, name=name)
        surface_output = ROOT / "simulation/results" / f"{sex}-app-electrode-skin.vtm"
        surface_output.parent.mkdir(parents=True, exist_ok=True)
        context_surfaces.save(surface_output)
        thorax_names = [name for name in surfaces if name in ("Skin (Thorax; Left)", "Skin (Thorax; Right)")]
        thorax_names.extend(name for name in surfaces if "Quadrant of Breast" in name)
        if len(thorax_names) < 2:
            raise SystemExit(f"Could not find both thorax skin meshes in {path.name}")
        thorax_surface = surfaces[thorax_names[0]]
        for name in thorax_names[1:]:
            thorax_surface = thorax_surface.merge(surfaces[name], merge_points=True)
        thorax_surface = thorax_surface.triangulate()
        data = landmarks["models"][sex]
        reference_chest = data.setdefault("chestElectrodeReference", data["chestElectrodes"].copy())
        reference_chest["V5"] = (
            (np.asarray(reference_chest["V4"], dtype=float) + np.asarray(reference_chest["V6"], dtype=float)) / 2
        ).tolist()
        projected_chest, projection_distances = {}, {}
        for lead, target in reference_chest.items():
            point, distance = nearest_surface_point(thorax_surface, target)
            if distance > 2.5:
                raise SystemExit(f"{sex} {lead} is {distance:.2f} model units from thorax skin")
            projected_chest[lead] = point.round(5).tolist()
            projection_distances[lead] = round(distance, 4)
        # Use rib 5/6 geometry for the fifth-intercostal level, and place V4
        # on the anterior skin at the skeleton-derived midclavicular line.
        v4_level = data["references"]["fifthIntercostalY"]
        v4_target = np.asarray(reference_chest["V4"], dtype=float)
        v4_target[0] = data["references"]["leftMidclavicularX"]
        v4_target[1] = v4_level
        v4_point, v4_distance = point_on_midclavicular_chest_line(
            thorax_surface,
            v4_target,
            data["references"]["leftMidclavicularX"],
            v4_level,
        )
        projected_chest["V4"] = v4_point.round(5).tolist()
        projection_distances["V4"] = round(v4_distance, 4)
        v3_midpoint = (
            np.asarray(projected_chest["V2"], dtype=float)
            + np.asarray(projected_chest["V4"], dtype=float)
        ) / 2
        projected_chest["V3"] = v3_midpoint.round(5).tolist()
        _, projection_distances["V3"] = nearest_surface_point(thorax_surface, tuple(v3_midpoint))
        # V6 is placed at the midaxillary line at V4's horizontal level. When
        # the anterior axillary line is ambiguous, place V5 halfway along the
        # skin contour from V4 to V6 at that same level.
        v6_target = np.asarray(reference_chest["V6"], dtype=float)
        v6_target[1] = v4_level
        v6_point, v6_distance = point_on_horizontal_chest_section(thorax_surface, v6_target, v4_level)
        projected_chest["V6"] = v6_point.round(5).tolist()
        projection_distances["V6"] = round(v6_distance, 4)
        v5_point, v5_surface_path_length = midpoint_along_horizontal_skin(
            thorax_surface,
            np.asarray(projected_chest["V4"], dtype=float),
            v6_point,
            v4_level,
        )
        projected_chest["V5"] = v5_point.round(5).tolist()
        projection_distances["V5"] = round(float(np.linalg.norm(v5_point - np.asarray(reference_chest["V5"]))), 4)

        projected_limb, limb_distances = {}, {}
        for lead, surface_name in ARM_TARGETS.items():
            surface = surfaces.get(surface_name)
            if surface is None:
                raise SystemExit(f"Missing app skin surface {surface_name} in {path.name}")
            target = data["references"]["trapezoidLigamentCenters"][lead]
            point, distance = nearest_surface_point(surface, target)
            if distance > 3.0:
                raise SystemExit(f"{sex} {lead} trapezoid-ligament projection is {distance:.2f} model units from skin")
            projected_limb[lead] = point.round(5).tolist()
            limb_distances[lead] = round(distance, 4)
        for lead, (surface_name, target) in LIMB_TARGETS.items():
            surface = surfaces.get(surface_name)
            if surface is None:
                raise SystemExit(f"Missing app skin surface {surface_name} in {path.name}")
            point, distance = nearest_surface_point(surface, target)
            if distance > 3.0:
                raise SystemExit(f"{sex} {lead} placement seed is {distance:.2f} model units from skin")
            projected_limb[lead] = point.round(5).tolist()
            limb_distances[lead] = round(distance, 4)

        data["chestElectrodes"] = projected_chest
        data["limbElectrodes"] = projected_limb
        data["electrodeProjection"] = {
            "surfaceModel": path.name,
            "method": "native GLB surface triangles; V5 surface midpoint and V6 constrained to the V4 horizontal plane",
            "V3Placement": "3D coordinate midpoint between V2 and V4",
            "V5Placement": "surface-path midpoint between V4 and V6 at the V4 horizontal level",
            "V4ToV6SurfacePathLengthModelUnits": round(v5_surface_path_length, 5),
            "limbElectrodeRegions": {
                "RA": "right upper chest skin over the trapezoid ligament",
                "LA": "left upper chest skin over the trapezoid ligament",
                "RL": "right lower torso near the iliac crest",
                "LL": "left lower torso near the iliac crest",
            },
            "V4HorizontalPlane": {
                "modelY": round(v4_level, 5),
                "skeletonFifthIntercostalY": data["references"]["fifthIntercostalY"],
                "offsetFromSkeletonReference": round(v4_level - data["references"]["fifthIntercostalY"], 4),
            },
            "maximumSeedDistanceModelUnits": max(*projection_distances.values(), *limb_distances.values()),
            "seedDistancesModelUnits": {**projection_distances, **limb_distances},
        }
        integumentary_name = f"{sex}-2024-integumentary-system.glb"
        if integumentary_name not in data["sourceModels"]:
            data["sourceModels"].append(integumentary_name)
            print(f"{sex}: projected RA/LA over the trapezoid ligaments, V1–V6 to thorax, and RL/LL to lower torso skin")
        print("  max projection distance:", data["electrodeProjection"]["maximumSeedDistanceModelUnits"], "model units")
        print("  exported placement surfaces:", surface_output)

    LANDMARKS_FILE.write_text(json.dumps(landmarks, indent=2) + "\n")
    print(f"Updated {LANDMARKS_FILE}")


if __name__ == "__main__":
    main()
