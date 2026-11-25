#!/usr/bin/env python3
"""Build a compact source-ID index for the anatomy part descriptions."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIRS = [
    ROOT / "assets/source/male-2024",
    ROOT / "assets/source/model-964db2",
]
LANGUAGE_FILE = ROOT / "assets/source/en.json"
OUTPUT = ROOT / "public/models/structure-descriptions.json"


def main() -> None:
    language = json.loads(LANGUAGE_FILE.read_text())
    items_by_cid = {
        item["cid"]: item
        for item in language.get("items", [])
        if isinstance(item.get("cid"), int) and item.get("info")
    }
    descriptions: dict[str, dict] = {}

    for source_dir in SOURCE_DIRS:
        assets = json.loads((source_dir / "assets.json").read_text())
        for structure in assets.get("structures", []):
            item = items_by_cid.get(structure.get("cid"))
            if not item:
                continue
            try:
                sections = json.loads(item["info"])
            except (TypeError, json.JSONDecodeError):
                continue
            if not isinstance(sections, list):
                continue
            cleaned = [
                {"name": section.get("name", "Details"), "text": section["text"].strip()}
                for section in sections
                if isinstance(section, dict)
                and isinstance(section.get("text"), str)
                and section["text"].strip()
            ]
            if cleaned:
                descriptions[structure["id"]] = {
                    "name": item.get("name", ""),
                    "sections": cleaned,
                }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(descriptions, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Wrote {len(descriptions):,} structure descriptions to {OUTPUT}")


if __name__ == "__main__":
    main()
