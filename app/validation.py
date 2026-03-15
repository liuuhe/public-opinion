from __future__ import annotations

import random
from collections import Counter

from app.config import AppConfig
from app.storage import read_jsonl, write_csv, write_json


def validate_labeled_dataset(config: AppConfig) -> dict:
    rows = read_jsonl(config.validation.input_path)
    if not rows:
        report = {"total_samples": 0, "label_distribution": {}, "average_confidence": 0.0}
        write_json(config.validation.report_path, report)
        return report

    label_counter = Counter(row.get("label", "unknown") for row in rows)
    average_confidence = sum(float(row.get("confidence", 0.0)) for row in rows) / len(rows)
    low_confidence_count = sum(
        1
        for row in rows
        if float(row.get("confidence", 0.0)) < config.labeling.low_confidence_threshold
    )
    review_pass_counter = Counter(int(row.get("review_pass", 1)) for row in rows)
    post_counter = Counter(row.get("post_id", "") for row in rows)
    manual_review_rows = _sample_manual_review(rows, config)

    write_csv(
        config.validation.manual_review_path,
        manual_review_rows,
        fieldnames=[
            "sample_id",
            "text_norm",
            "label",
            "confidence",
            "manual_label",
            "notes",
        ],
    )

    report = {
        "total_samples": len(rows),
        "label_distribution": dict(label_counter),
        "average_confidence": round(average_confidence, 4),
        "low_confidence_count": low_confidence_count,
        "review_pass_distribution": dict(review_pass_counter),
        "posts_covered": len(post_counter),
        "max_samples_per_post": max(post_counter.values()) if post_counter else 0,
        "min_samples_per_post": min(post_counter.values()) if post_counter else 0,
        "manual_review_sample_size": len(manual_review_rows),
    }
    write_json(config.validation.report_path, report)
    return report


def _sample_manual_review(rows: list[dict], config: AppConfig) -> list[dict]:
    randomizer = random.Random(config.validation.random_seed)
    sample_size = min(config.validation.manual_review_sample_size, len(rows))
    sampled = randomizer.sample(rows, sample_size)
    return [
        {
            "sample_id": row.get("sample_id", ""),
            "text_norm": row.get("text_norm", ""),
            "label": row.get("label", ""),
            "confidence": row.get("confidence", 0.0),
            "manual_label": "",
            "notes": "",
        }
        for row in sampled
    ]
