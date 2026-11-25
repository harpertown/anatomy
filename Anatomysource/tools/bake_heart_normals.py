#!/usr/bin/env python3
"""Bake decoded tangent-space heart normals into matching sRGB albedo atlases."""

from __future__ import annotations

import argparse
import json
import math
import struct
import zlib
from pathlib import Path

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else b if pb <= pc else c


def read_png(path: Path) -> tuple[int, int, bytearray]:
    data = path.read_bytes()
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError(f"not a PNG: {path}")
    offset = len(PNG_SIGNATURE)
    compressed = bytearray()
    width = height = bit_depth = color_type = interlace = None
    while offset < len(data):
        size = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4 : offset + 8]
        chunk = data[offset + 8 : offset + 8 + size]
        offset += size + 12
        if kind == b"IHDR":
            width, height, bit_depth, color_type, _, _, interlace = struct.unpack(">IIBBBBB", chunk)
        elif kind == b"IDAT":
            compressed.extend(chunk)
        elif kind == b"IEND":
            break
    if bit_depth != 8 or color_type not in (2, 6) or interlace != 0:
        raise ValueError(f"expected non-interlaced 8-bit RGB/RGBA PNG: {path}")
    channels = 4 if color_type == 6 else 3
    stride = width * channels
    raw = zlib.decompress(compressed)
    pixels = bytearray(height * stride)
    src = 0
    for y in range(height):
        filter_type = raw[src]
        src += 1
        row = bytearray(raw[src : src + stride])
        src += stride
        prev_start = (y - 1) * stride
        for i in range(stride):
            left = row[i - channels] if i >= channels else 0
            up = pixels[prev_start + i] if y else 0
            upper_left = pixels[prev_start + i - channels] if y and i >= channels else 0
            if filter_type == 1:
                row[i] = (row[i] + left) & 255
            elif filter_type == 2:
                row[i] = (row[i] + up) & 255
            elif filter_type == 3:
                row[i] = (row[i] + ((left + up) // 2)) & 255
            elif filter_type == 4:
                row[i] = (row[i] + _paeth(left, up, upper_left)) & 255
            elif filter_type != 0:
                raise ValueError(f"unsupported PNG filter {filter_type}: {path}")
        pixels[y * stride : (y + 1) * stride] = row
    if channels == 3:
        rgba = bytearray(width * height * 4)
        for i in range(width * height):
            rgba[i * 4 : i * 4 + 3] = pixels[i * 3 : i * 3 + 3]
            rgba[i * 4 + 3] = 255
        pixels = rgba
    return width, height, pixels


def write_png(path: Path, width: int, height: int, rgba: bytes) -> None:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    rows = bytearray()
    stride = width * 4
    for y in range(height):
        rows.append(0)
        rows.extend(rgba[y * stride : (y + 1) * stride])
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    path.write_bytes(
        PNG_SIGNATURE
        + chunk(b"IHDR", header)
        + chunk(b"sRGB", b"\x00")
        + chunk(b"IDAT", zlib.compress(rows, 6))
        + chunk(b"IEND", b"")
    )


def linear(value: int) -> float:
    c = value / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def srgb(value: float) -> int:
    c = 12.92 * value if value <= 0.0031308 else 1.055 * value ** (1 / 2.4) - 0.055
    return max(0, min(255, round(c * 255)))


def bake(albedo: bytearray, normal: bytearray) -> bytearray:
    baked = bytearray(albedo)
    light = (0.28, 0.38, 0.88)
    length = math.sqrt(sum(v * v for v in light))
    light = tuple(v / length for v in light)
    half = (light[0], light[1], light[2] + 1.0)
    length = math.sqrt(sum(v * v for v in half))
    half = tuple(v / length for v in half)
    for i in range(0, len(baked), 4):
        nx = normal[i] / 127.5 - 1.0
        ny = normal[i + 1] / 127.5 - 1.0
        nz = normal[i + 2] / 127.5 - 1.0
        length = math.sqrt(nx * nx + ny * ny + nz * nz)
        if length > 1e-8:
            nx, ny, nz = nx / length, ny / length, nz / length
        diffuse = max(0.0, nx * light[0] + ny * light[1] + nz * light[2])
        facing = max(0.0, nx * half[0] + ny * half[1] + nz * half[2])
        shade = 0.78 + 0.22 * diffuse + 0.045 * facing**32
        for channel in range(3):
            baked[i + channel] = srgb(min(1.0, linear(albedo[i + channel]) * shade))
    return baked


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--texture-dir", type=Path, required=True)
    parser.add_argument("--material-map", type=Path, help="defaults to <texture-dir>/heart-materials.json")
    args = parser.parse_args()
    texture_dir = args.texture_dir
    map_path = args.material_map or texture_dir / "heart-materials.json"
    mapping = json.loads(map_path.read_text())
    baked_by_pair: dict[tuple[str, str], str] = {}
    for material_id, fields in mapping.items():
        albedo_name = fields.get("formeOriginalAlbedoTexture")
        normal_name = fields.get("formeOriginalNormalTexture")
        if not albedo_name or not normal_name:
            continue
        pair = (albedo_name, normal_name)
        filename = baked_by_pair.get(pair)
        if filename is None:
            albedo_path, normal_path = texture_dir / albedo_name, texture_dir / normal_name
            aw, ah, albedo = read_png(albedo_path)
            nw, nh, normal = read_png(normal_path)
            if (aw, ah) != (nw, nh):
                raise ValueError(f"atlas sizes differ: {albedo_path.name} vs {normal_path.name}")
            stem = albedo_path.stem.removesuffix("-albedo")
            filename = f"{stem}-normal-baked.png"
            write_png(texture_dir / filename, aw, ah, bake(albedo, normal))
            baked_by_pair[pair] = filename
            print(f"{filename}: baked tangent normals into {aw}x{ah} sRGB albedo")
        fields["formeBakedAlbedoTexture"] = filename
    map_path.write_text(json.dumps(mapping, indent=2) + "\n")
    print(f"Updated {map_path} with {len(baked_by_pair)} baked heart atlases")


if __name__ == "__main__":
    main()
