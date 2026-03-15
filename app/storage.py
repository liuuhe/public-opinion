from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Iterable

from app.utils import ensure_parent_dir


def append_jsonl(path: str | Path, rows: Iterable[dict]) -> int:
    items = list(rows)
    if not items:
        return 0

    ensure_parent_dir(path)
    with Path(path).open("a", encoding="utf-8") as handle:
        for row in items:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    return len(items)


def write_jsonl(path: str | Path, rows: Iterable[dict]) -> int:
    items = list(rows)
    ensure_parent_dir(path)
    with Path(path).open("w", encoding="utf-8") as handle:
        for row in items:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    return len(items)


def read_jsonl(path: str | Path) -> list[dict]:
    file_path = Path(path)
    if not file_path.exists():
        return []

    records: list[dict] = []
    with file_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            records.append(json.loads(line))
    return records


def write_json(path: str | Path, payload: dict) -> None:
    ensure_parent_dir(path)
    with Path(path).open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


def write_csv(path: str | Path, rows: Iterable[dict], fieldnames: list[str]) -> None:
    ensure_parent_dir(path)
    with Path(path).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
