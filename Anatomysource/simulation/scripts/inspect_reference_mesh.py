#!/usr/bin/env python3
"""Validate mesh structure and required EP metadata before conversion/simulation."""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pyvista as pv

REQUIRED_CELL_ARRAYS = ("Material", "Fiber", "Sheet", "Sheetnormal")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mesh", nargs="?", default=str(Path(__file__).resolve().parents[1] / "data/four-chamber-M.vtu"))
    args = parser.parse_args()
    path = Path(args.mesh)
    if not path.is_file():
        raise SystemExit(f"Mesh not found: {path}; run fetch_reference_mesh.py")

    grid = pv.read(path)
    if not isinstance(grid, pv.UnstructuredGrid):
        raise SystemExit(f"Expected an unstructured volume mesh, received {type(grid).__name__}")
    if grid.n_cells == 0 or grid.n_points == 0:
        raise SystemExit("Mesh contains no points or cells")
    missing = [name for name in REQUIRED_CELL_ARRAYS if name not in grid.cell_data]
    if missing:
        raise SystemExit(f"Missing required cell data: {', '.join(missing)}")
    if not np.all(np.isfinite(grid.points)):
        raise SystemExit("Mesh coordinates contain non-finite values")
    for name in ("Fiber", "Sheet", "Sheetnormal"):
        vectors = np.asarray(grid.cell_data[name])
        if vectors.shape != (grid.n_cells, 3) or not np.all(np.isfinite(vectors)):
            raise SystemExit(f"Invalid {name} direction array shape or values: {vectors.shape}")
        lengths = np.linalg.norm(vectors, axis=1)
        # The source mesh contains a small number of near-zero sheet vectors
        # where the sheet direction is undefined. Do not silently normalize
        # those cells; report their share while enforcing the bulk field.
        if np.quantile(lengths, 0.01) < 0.9 or np.quantile(lengths, 0.99) > 1.1:
            raise SystemExit(f"Most {name} directions are not unit vectors")

    print(f"Mesh: {path}")
    print(f"Points: {grid.n_points:,}; cells: {grid.n_cells:,}; bounds: {grid.bounds}")
    print(f"Cell types: {dict(zip(*np.unique(grid.celltypes, return_counts=True)))} (VTK 10 = tetrahedron)")
    materials, counts = np.unique(grid.cell_data["Material"], return_counts=True)
    print("Material IDs/cell counts:", ", ".join(f"{int(i)}:{int(n):,}" for i, n in zip(materials, counts)))
    for name in ("Fiber", "Sheet", "Sheetnormal"):
        lengths = np.linalg.norm(np.asarray(grid.cell_data[name]), axis=1)
        low = int(np.count_nonzero(lengths < 0.9))
        print(f"{name}: valid unit directions in bulk; {low:,} cells have undefined/short vectors")
    print("Units: source file documents dimensions in mm")


if __name__ == "__main__":
    main()
