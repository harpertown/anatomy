#!/usr/bin/env python3
"""Convert the reference VTU to XDMF plus a sidecar of cell-wise tissue fields."""
from __future__ import annotations

from pathlib import Path

import meshio
import numpy as np
import pyvista as pv

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data/four-chamber-M.vtu"
OUTPUT = ROOT / "results/four-chamber-M.xdmf"
FIELDS = ("Material", "Fiber", "Sheet", "Sheetnormal")


def main() -> None:
    if not SOURCE.is_file():
        raise SystemExit(f"Missing {SOURCE}; run fetch_reference_mesh.py first")

    grid = pv.read(SOURCE)
    if set(np.unique(grid.celltypes)) != {10}:
        raise SystemExit("Expected an all-tetrahedron volume mesh")
    cells = np.asarray(grid.cells).reshape(-1, 5)[:, 1:].astype(np.int64, copy=False)
    cell_data = {name: [np.asarray(grid.cell_data[name])] for name in FIELDS}
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    meshio.write(OUTPUT, meshio.Mesh(points=np.asarray(grid.points), cells=[("tetra", cells)], cell_data=cell_data))

    # Preserve original cell ordering explicitly. DOLFINx may reorder cells at
    # import; downstream field assignment must map by cell geometry, not assume
    # its local cell index matches this array index.
    centers = np.asarray(grid.cell_centers().points)
    np.savez_compressed(
        OUTPUT.with_suffix(".fields.npz"),
        cell_centers_mm=centers,
        **{name: np.asarray(grid.cell_data[name]) for name in FIELDS},
    )
    print(f"Wrote {OUTPUT}")
    print(f"Wrote {OUTPUT.with_suffix('.fields.npz')} with cell-wise {', '.join(FIELDS)}")
    print("Cell fields retain source ordering; map them to imported DOLFINx cells by centroid.")


if __name__ == "__main__":
    main()
