from __future__ import annotations

from app.config import AppConfig
from app.models import CleanSample
from app.storage import read_jsonl, write_jsonl
from app.utils import hash_identifier, has_meaningful_text, normalize_text, stable_json_dumps


def build_clean_dataset(config: AppConfig) -> dict[str, int]:
    raw_rows = read_jsonl(config.clean.input_path)
    seen_dedupe_keys: set[str] = set()
    clean_samples: list[dict] = []

    dropped_empty = 0
    dropped_short = 0
    dropped_noise = 0
    dropped_duplicate = 0

    for row in raw_rows:
        raw_text = str(row.get("comment_text_raw", ""))
        normalized = normalize_text(raw_text)
        if not normalized:
            dropped_empty += 1
            continue
        if normalized in config.clean.drop_pattern_texts:
            dropped_noise += 1
            continue
        if len(normalized) < config.clean.min_text_length:
            dropped_short += 1
            continue
        if not has_meaningful_text(normalized):
            dropped_noise += 1
            continue

        dedupe_material = row.get("dedupe_key") or stable_json_dumps(
            {
                "post_id": row.get("post_id"),
                "parent_comment_id": row.get("parent_comment_id"),
                "user_hash": row.get("user_hash"),
                "text_norm": normalized,
            }
        )
        if dedupe_material in seen_dedupe_keys:
            dropped_duplicate += 1
            continue
        seen_dedupe_keys.add(dedupe_material)

        sample = CleanSample(
            sample_id=hash_identifier(
                f"{row.get('post_id', '')}:{row.get('comment_id', '')}:{normalized}",
                salt="clean-sample",
            ),
            source="xiaohongshu_home_feed",
            post_id=str(row.get("post_id", "")),
            comment_id=str(row.get("comment_id", "")),
            parent_comment_id=row.get("parent_comment_id"),
            feed_batch_id=str(row.get("feed_batch_id", "")),
            capture_time=str(row.get("capture_time", "")),
            text_raw=raw_text,
            text_norm=normalized,
            user_hash=str(row.get("user_hash", "")),
            comment_level=int(row.get("comment_level", 1)),
        )
        clean_samples.append(sample.to_dict())

    write_jsonl(config.clean.output_path, clean_samples)
    return {
        "raw_count": len(raw_rows),
        "clean_count": len(clean_samples),
        "dropped_empty": dropped_empty,
        "dropped_short": dropped_short,
        "dropped_noise": dropped_noise,
        "dropped_duplicate": dropped_duplicate,
    }
