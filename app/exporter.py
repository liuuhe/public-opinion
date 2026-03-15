from __future__ import annotations

import random
from collections import defaultdict
from pathlib import Path

from app.config import AppConfig
from app.storage import read_jsonl, write_csv


def export_dataset_splits(config: AppConfig) -> dict[str, int]:
    rows = read_jsonl(config.export.input_path)
    if not rows:
        output_dir = Path(config.export.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        for split in ("train", "val", "test"):
            write_csv(
                output_dir / f"{split}.csv",
                [],
                fieldnames=["sample_id", "text_norm", "label"],
            )
        return {"train": 0, "val": 0, "test": 0}

    buckets: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        buckets[row.get("label", "neutral")].append(row)

    randomizer = random.Random(config.export.random_seed)
    splits = {"train": [], "val": [], "test": []}

    for label_rows in buckets.values():
        randomizer.shuffle(label_rows)
        total = len(label_rows)
        train_count, val_count, test_count = _compute_split_counts(
            total,
            config.export.train_ratio,
            config.export.val_ratio,
            config.export.test_ratio,
        )
        train_cut = train_count
        val_cut = train_count + val_count
        splits["train"].extend(label_rows[:train_cut])
        splits["val"].extend(label_rows[train_cut:val_cut])
        splits["test"].extend(label_rows[val_cut : val_cut + test_count])

    output_dir = Path(config.export.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    for split_name, split_rows in splits.items():
        export_rows = [
            {
                "sample_id": row.get("sample_id", ""),
                "text_norm": row.get("text_norm", ""),
                "label": row.get("label", ""),
            }
            for row in split_rows
        ]
        write_csv(
            output_dir / f"{split_name}.csv",
            export_rows,
            fieldnames=["sample_id", "text_norm", "label"],
        )

    return {name: len(items) for name, items in splits.items()}


def _compute_split_counts(
    total: int,
    train_ratio: float,
    val_ratio: float,
    test_ratio: float,
) -> tuple[int, int, int]:
    if total <= 0:
        return 0, 0, 0
    ratios = [train_ratio, val_ratio, test_ratio]
    counts = [int(total * ratio) for ratio in ratios]
    remainder = total - sum(counts)
    order = sorted(range(3), key=lambda idx: ratios[idx], reverse=True)
    for idx in order:
        if remainder <= 0:
            break
        counts[idx] += 1
        remainder -= 1
    return counts[0], counts[1], counts[2]
