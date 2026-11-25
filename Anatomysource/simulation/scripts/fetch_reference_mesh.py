#!/usr/bin/env python3
"""Fetch the documented four-chamber reference mesh and verify Zenodo MD5s."""
from __future__ import annotations

import hashlib
from pathlib import Path
from urllib.request import urlretrieve

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
FILES = {
    "four-chamber-M.vtu": ("d2c9a077ef355b985d6dcb3740eb493a", "https://zenodo.org/records/10526554/files/M.vtu?download=1"),
    "LabelIDs.txt": ("9cf108dcd68fc97e76f51eaf86212a9a", "https://zenodo.org/records/10526554/files/LabelIDs.txt?download=1"),
    "Surfaces.zip": ("c9fa25053693429ffe9f6d315f300a08", "https://zenodo.org/records/10526554/files/Surfaces.zip?download=1"),
}


def md5(path: Path) -> str:
    digest = hashlib.md5()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    for name, (expected, url) in FILES.items():
        path = DATA / name
        if not path.exists() or md5(path) != expected:
            print(f"Downloading {name}")
            temporary = path.with_suffix(path.suffix + ".part")
            urlretrieve(url, temporary)
            actual = md5(temporary)
            if actual != expected:
                temporary.unlink(missing_ok=True)
                raise SystemExit(f"MD5 mismatch for {name}: expected {expected}, received {actual}")
            temporary.replace(path)
        print(f"{name}: verified ({path.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
