#!/usr/bin/env python3
"""Convert Complete Anatomy IBL! cubemap data to a Radiance equirectangular HDR."""

from __future__ import annotations

import argparse
import math
import struct
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--width", type=int, default=1024)
    args = parser.parse_args()

    raw = args.input.read_bytes()
    if raw[:4] != b"IBL!":
        raise ValueError("unsupported IBL resource signature")
    # Each 20-byte descriptor is format, width, height, layers, byte length.
    descriptors = [struct.unpack_from("<5I", raw, 12 + i * 20) for i in range(3)]
    _, cube_size, cube_height, faces, cube_bytes = descriptors[1]
    if cube_size != cube_height or faces != 6 or cube_size < 2:
        raise ValueError(f"unexpected specular cubemap descriptor: {descriptors[1]}")

    data_offset = 128 + descriptors[0][4]
    face_stride = cube_size * cube_size * 8  # RGBA16F base mip
    if data_offset + face_stride * 6 > len(raw):
        raise ValueError("IBL cubemap exceeds resource bounds")
    faces_data: list[list[tuple[float, float, float]]] = []
    for face in range(6):
        pixels = []
        start = data_offset + face * face_stride
        for pixel in range(cube_size * cube_size):
            rgba = struct.unpack_from("<4e", raw, start + pixel * 8)
            pixels.append((max(0.0, rgba[0]), max(0.0, rgba[1]), max(0.0, rgba[2])))
        faces_data.append(pixels)

    def sample(direction: tuple[float, float, float]) -> tuple[float, float, float]:
        x, y, z = direction
        ax, ay, az = abs(x), abs(y), abs(z)
        if ax >= ay and ax >= az:
            if x >= 0:
                face, sc, tc = 0, -z / ax, -y / ax
            else:
                face, sc, tc = 1, z / ax, -y / ax
        elif ay >= ax and ay >= az:
            if y >= 0:
                face, sc, tc = 2, x / ay, z / ay
            else:
                face, sc, tc = 3, x / ay, -z / ay
        elif z >= 0:
            face, sc, tc = 4, x / az, -y / az
        else:
            face, sc, tc = 5, -x / az, -y / az
        fx = (sc * 0.5 + 0.5) * (cube_size - 1)
        fy = (tc * 0.5 + 0.5) * (cube_size - 1)
        x0, y0 = int(fx), int(fy)
        x1, y1 = min(x0 + 1, cube_size - 1), min(y0 + 1, cube_size - 1)
        tx, ty = fx - x0, fy - y0
        indexes = (y0 * cube_size + x0, y0 * cube_size + x1, y1 * cube_size + x0, y1 * cube_size + x1)
        return tuple(
            (1 - ty) * ((1 - tx) * faces_data[face][indexes[0]][c] + tx * faces_data[face][indexes[1]][c])
            + ty * ((1 - tx) * faces_data[face][indexes[2]][c] + tx * faces_data[face][indexes[3]][c])
            for c in range(3)
        )

    width, height = args.width, args.width // 2
    rgbe_rows: list[bytes] = []
    for row in range(height):
        latitude = math.pi * (0.5 - (row + 0.5) / height)
        cos_lat, sin_lat = math.cos(latitude), math.sin(latitude)
        colors = []
        for col in range(width):
            longitude = 2 * math.pi * ((col + 0.5) / width - 0.5)
            direction = (cos_lat * math.sin(longitude), sin_lat, cos_lat * math.cos(longitude))
            rgb = sample(direction)
            maximum = max(rgb)
            if maximum < 1e-32:
                colors.append((0, 0, 0, 0))
            else:
                mantissa, exponent = math.frexp(maximum)
                scale = mantissa * 256.0 / maximum
                colors.append(tuple(max(0, min(255, int(channel * scale))) for channel in rgb) + (max(0, min(255, exponent + 128)),))
        # Radiance scanline RLE, emitted as literal runs for each channel.
        scanline = bytearray((2, 2, width >> 8, width & 255))
        for channel in range(4):
            values = [px[channel] for px in colors]
            for offset in range(0, width, 128):
                run = values[offset : offset + 128]
                scanline.append(len(run))
                scanline.extend(run)
        rgbe_rows.append(bytes(scanline))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("wb") as output:
        output.write(f"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y {height} +X {width}\n".encode("ascii"))
        for row in rgbe_rows:
            output.write(row)
    print(f"Wrote {args.output} from {cube_size}px RGBA16F cubemap (declared payload {cube_bytes} bytes)")


if __name__ == "__main__":
    main()
