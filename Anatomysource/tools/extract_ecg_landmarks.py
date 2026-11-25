#!/usr/bin/env python3
"""Precompute schematic chest ECG sites from the bundled skeleton and muscle GLBs."""
import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
V1_V2_SUPERIOR_OFFSET = 0.18


def multiply(a, b):
    return [[sum(a[row][k] * b[k][col] for k in range(4)) for col in range(4)] for row in range(4)]


def local_matrix(node):
    if 'matrix' in node:
        values = node['matrix']
        return [[values[col * 4 + row] for col in range(4)] for row in range(4)]
    tx, ty, tz = node.get('translation', [0, 0, 0])
    sx, sy, sz = node.get('scale', [1, 1, 1])
    x, y, z, w = node.get('rotation', [0, 0, 0, 1])
    rotation = [
        [1 - 2 * (y*y + z*z), 2 * (x*y - z*w), 2 * (x*z + y*w)],
        [2 * (x*y + z*w), 1 - 2 * (x*x + z*z), 2 * (y*z - x*w)],
        [2 * (x*z - y*w), 2 * (y*z + x*w), 1 - 2 * (x*x + y*y)],
    ]
    matrix = [[0.0] * 4 for _ in range(4)]
    for row, scale in enumerate((sx, sy, sz)):
        for col in range(3):
            matrix[row][col] = rotation[row][col] * scale
    matrix[0][3], matrix[1][3], matrix[2][3], matrix[3][3] = tx, ty, tz, 1
    return matrix


def read_glb(path):
    data = path.read_bytes()
    json_length, _ = struct.unpack_from('<II', data, 12)
    document = json.loads(data[20:20 + json_length])
    offset = 20 + json_length
    binary = b''
    while offset < len(data):
        length, chunk_type = struct.unpack_from('<II', data, offset)
        offset += 8
        if chunk_type == 0x004E4942:
            binary = data[offset:offset + length]
            break
        offset += length
    return document, binary


def points_for_mesh(document, binary, mesh_index, world):
    points = []
    for primitive in document['meshes'][mesh_index]['primitives']:
        accessor = document['accessors'][primitive['attributes']['POSITION']]
        if accessor.get('componentType') != 5126 or accessor.get('type') != 'VEC3':
            continue
        view = document['bufferViews'][accessor['bufferView']]
        start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
        stride = view.get('byteStride', 12)
        for index in range(accessor['count']):
            x, y, z = struct.unpack_from('<fff', binary, start + index * stride)
            points.append(tuple(sum(world[row][col] * (x, y, z, 1)[col] for col in range(4)) for row in range(3)))
    return points


def named_meshes(path):
    document, binary = read_glb(path)
    result = []

    def walk(index, parent):
        node = document['nodes'][index]
        world = multiply(parent, local_matrix(node))
        if 'mesh' in node:
            result.append((node.get('name', ''), points_for_mesh(document, binary, node['mesh'], world)))
        for child in node.get('children', []):
            walk(child, world)

    for root in document['scenes'][document.get('scene', 0)]['nodes']:
        walk(root, [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])
    return result


def bounds(points):
    return tuple(min(p[i] for p in points) for i in range(3)), tuple(max(p[i] for p in points) for i in range(3))


def front_centroid(points):
    _, high = bounds(points)
    low, _ = bounds(points)
    cutoff = high[2] - (high[2] - low[2]) * 0.06
    front = [p for p in points if p[2] >= cutoff]
    return tuple(sum(p[i] for p in front) / len(front) for i in range(3))


def nearest_front_surface_z(points, x, y, count=40):
    nearest = sorted(points, key=lambda p: (p[0] - x) ** 2 + (p[1] - y) ** 2)[:count]
    return max(p[2] for p in nearest)


def extract_sex(sex):
    prefix = f'{sex}-2024'
    skeleton = named_meshes(ROOT / 'public/models/catalog' / f'{prefix}-skeletal-system.glb')
    chest = named_meshes(ROOT / 'public/models/catalog' / f'{prefix}-muscular-system.glb')
    connective = named_meshes(ROOT / 'public/models/catalog' / f'{prefix}-connective-tissue.glb')
    by_name = {}
    for name, points in skeleton:
        by_name.setdefault(name.lower(), []).append(points)

    def get(name):
        return by_name[name.lower()]

    sternum = get('Sternum')[0]
    sternum_low, sternum_high = bounds(sternum)
    rib4 = [front_centroid(group) for group in get('Fourth Rib')]
    rib5 = [front_centroid(group) for group in get('Fifth Rib')]
    rib6 = [front_centroid(group) for group in get('Sixth Rib')]
    fourth_space_y = sum(point[1] for point in rib4 + rib5) / len(rib4 + rib5)
    fifth_space_y = sum(point[1] for point in rib5 + rib6) / len(rib5 + rib6)
    v1_v2_y = fourth_space_y + V1_V2_SUPERIOR_OFFSET
    clavicles = get('Clavicle')
    left_clavicle = max(clavicles, key=lambda group: sum(point[0] for point in group) / len(group))
    clavicle_low, clavicle_high = bounds(left_clavicle)
    midclavicular_x = (clavicle_low[0] + clavicle_high[0]) / 2
    clavicle_at_midline = [point for point in left_clavicle if abs(point[0] - midclavicular_x) <= 0.35]
    infraclavicular_y = min(point[1] for point in clavicle_at_midline) - 1.2
    trapezoid_centers = []
    for name, points in connective:
        if name.lower() == 'trapezoid ligament':
            trapezoid_centers.append(tuple(sum(point[axis] for point in points) / len(points) for axis in range(3)))
    if len(trapezoid_centers) < 2:
        raise ValueError(f'{sex} connective-tissue model is missing paired trapezoid ligaments')
    right_trapezoid = min(trapezoid_centers, key=lambda point: point[0])
    left_trapezoid = max(trapezoid_centers, key=lambda point: point[0])

    chest_by_name = {}
    for name, points in chest:
        chest_by_name.setdefault(name.lower(), []).append(points)
    pectorals = chest_by_name['pectoralis major muscle']
    left_pectoral = max(pectorals, key=lambda group: sum(point[0] for point in group) / len(group))
    right_pectoral = min(pectorals, key=lambda group: sum(point[0] for point in group) / len(group))
    serratus = chest_by_name['serratus anterior muscle']
    left_serratus = max(serratus, key=lambda group: sum(point[0] for point in group) / len(group))

    right_sternal_x = sternum_low[0] - 0.08
    left_sternal_x = sternum_high[0] + 0.08
    v1 = (right_sternal_x, v1_v2_y, nearest_front_surface_z(right_pectoral, right_sternal_x, v1_v2_y))
    v2 = (left_sternal_x, v1_v2_y, nearest_front_surface_z(left_pectoral, left_sternal_x, v1_v2_y))
    v4 = (midclavicular_x, fifth_space_y, nearest_front_surface_z(left_pectoral, midclavicular_x, fifth_space_y))
    # V3 lies halfway between V2 and V4. V6 follows the lateral chest wall
    # represented by serratus. V5 is seeded halfway between V4 and V6; the
    # projection step places it halfway along the actual horizontal skin path.
    # Use the fifth intercostal space between ribs 5 and 6, not the rib-5 center.
    v3 = tuple((v2[i] + v4[i]) / 2 for i in range(3))
    serratus_level = [p for p in left_serratus if abs(p[1] - fifth_space_y) <= 0.55]
    v6_x = max(p[0] for p in serratus_level)
    v6 = (v6_x, fifth_space_y, nearest_front_surface_z(left_serratus, v6_x, fifth_space_y))
    v5 = tuple((v4[i] + v6[i]) / 2 for i in range(3))

    return {
        'sourceModels': [f'{prefix}-skeletal-system.glb', f'{prefix}-muscular-system.glb', f'{prefix}-connective-tissue.glb'],
        'references': {
            'sternalBordersX': [sternum_low[0], sternum_high[0]],
            'fourthIntercostalY': fourth_space_y,
            'v1V2LevelY': v1_v2_y,
            'v1V2SuperiorOffset': V1_V2_SUPERIOR_OFFSET,
            'fifthIntercostalY': fifth_space_y,
            'leftMidclavicularX': midclavicular_x,
            'infraclavicularY': infraclavicular_y,
            'trapezoidLigamentCenters': {
                'RA': list(right_trapezoid),
                'LA': list(left_trapezoid),
            },
        },
        'chestElectrodes': {name: list(point) for name, point in zip(('V1', 'V2', 'V3', 'V4', 'V5', 'V6'), (v1, v2, v3, v4, v5, v6))},
    }


output = {'models': {sex: extract_sex(sex) for sex in ('male', 'female')}}
for model in output['models'].values():
    for point in model['chestElectrodes'].values():
        for axis in range(3):
            point[axis] = round(point[axis], 4)
    for name, point in model['references'].items():
        if isinstance(point, dict):
            model['references'][name] = {key: [round(axis, 4) for axis in value] for key, value in point.items()}
        elif isinstance(point, list):
            model['references'][name] = [round(axis, 4) for axis in point]
        else:
            model['references'][name] = round(point, 4)
(ROOT / 'public/models/ecg-landmarks.json').write_text(json.dumps(output, indent=2) + '\n')
print('Wrote public/models/ecg-landmarks.json from skeletal and muscular GLBs.')
