from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from app.cleaning import build_clean_dataset
from app.config import AppConfig
from app.crawler import _build_comment_candidate, _is_plausible_comment_candidate, _normalize_post_url
from app.exporter import export_dataset_splits
from app.storage import append_jsonl, read_jsonl
from app.validation import validate_labeled_dataset


class PipelineTests(unittest.TestCase):
    def test_normalize_post_url_keeps_query_string(self) -> None:
        url = (
            "https://www.xiaohongshu.com/explore/69afa831000000002603377b"
            "?xsec_token=abc123&xsec_source=pc_feed"
        )
        normalized = _normalize_post_url(url)
        self.assertEqual(
            normalized,
            "https://www.xiaohongshu.com/explore/69afa831000000002603377b"
            "?xsec_token=abc123&xsec_source=pc_feed",
        )

    def test_comment_candidate_requires_comment_context(self) -> None:
        candidate = _build_comment_candidate(
            {
                "content": "宿舍翻修太吵了",
                "commentId": "c1",
                "userId": "u1",
            },
            ["https://edith.xiaohongshu.com/api/sns/web/v2/comment/page"],
        )
        self.assertIsNotNone(candidate)
        self.assertTrue(_is_plausible_comment_candidate(candidate or {}))

        garbage = {
            "text": "还没有简介",
            "user_id": "u2",
            "_path_hint": "global0.profile.desc",
        }
        self.assertFalse(_is_plausible_comment_candidate(garbage))

    def test_comment_candidate_infers_reply_level_and_generic_id(self) -> None:
        candidate = _build_comment_candidate(
            {
                "content": "同意",
                "id": "reply-1",
                "user": {"id": "u2"},
            },
            ["https://edith.xiaohongshu.com/api/sns/web/v2/comment/page", "data", "comments", "0", "sub_comments", "0"],
            parent_comment_id="root-1",
        )
        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate["comment_id"], "reply-1")
        self.assertEqual(candidate["parent_comment_id"], "root-1")
        self.assertEqual(candidate["comment_level"], 2)

    def test_clean_dataset_filters_noise_and_duplicates(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            raw_path = Path(tmpdir) / "raw_comments.jsonl"
            clean_path = Path(tmpdir) / "clean_comments.jsonl"
            config = AppConfig()
            config.clean.input_path = str(raw_path)
            config.clean.output_path = str(clean_path)
            append_jsonl(
                raw_path,
                [
                    {
                        "post_id": "p1",
                        "comment_id": "c1",
                        "parent_comment_id": None,
                        "feed_batch_id": "b1",
                        "capture_time": "2026-03-14T00:00:00+00:00",
                        "comment_text_raw": "支持学校尽快解决",
                        "user_hash": "u1",
                        "comment_level": 1,
                        "dedupe_key": "d1",
                    },
                    {
                        "post_id": "p1",
                        "comment_id": "c2",
                        "parent_comment_id": None,
                        "feed_batch_id": "b1",
                        "capture_time": "2026-03-14T00:00:00+00:00",
                        "comment_text_raw": "展开",
                        "user_hash": "u2",
                        "comment_level": 1,
                        "dedupe_key": "d2",
                    },
                    {
                        "post_id": "p1",
                        "comment_id": "c3",
                        "parent_comment_id": None,
                        "feed_batch_id": "b1",
                        "capture_time": "2026-03-14T00:00:00+00:00",
                        "comment_text_raw": "支持学校尽快解决",
                        "user_hash": "u1",
                        "comment_level": 1,
                        "dedupe_key": "d1",
                    },
                ],
            )

            result = build_clean_dataset(config)
            cleaned = read_jsonl(clean_path)

            self.assertEqual(result["clean_count"], 1)
            self.assertEqual(result["dropped_noise"], 1)
            self.assertEqual(result["dropped_duplicate"], 1)
            self.assertEqual(cleaned[0]["text_norm"], "支持学校尽快解决")

    def test_validation_and_export(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            labeled_path = Path(tmpdir) / "labeled.jsonl"
            report_path = Path(tmpdir) / "validation_report.json"
            review_path = Path(tmpdir) / "manual_review.csv"
            export_dir = Path(tmpdir) / "exports"

            config = AppConfig()
            config.validation.input_path = str(labeled_path)
            config.validation.report_path = str(report_path)
            config.validation.manual_review_path = str(review_path)
            config.validation.manual_review_sample_size = 2
            config.export.input_path = str(labeled_path)
            config.export.output_dir = str(export_dir)

            append_jsonl(
                labeled_path,
                [
                    {
                        "sample_id": f"sp{i}",
                        "text_norm": f"很好{i}",
                        "label": "positive",
                        "confidence": 0.91,
                        "post_id": "p1",
                        "review_pass": 1,
                    }
                    for i in range(10)
                ]
                + [
                    {
                        "sample_id": f"sn{i}",
                        "text_norm": f"一般{i}",
                        "label": "neutral",
                        "confidence": 0.62,
                        "post_id": "p1",
                        "review_pass": 2,
                    }
                    for i in range(10)
                ]
                + [
                    {
                        "sample_id": f"sg{i}",
                        "text_norm": f"太差了{i}",
                        "label": "negative",
                        "confidence": 0.89,
                        "post_id": "p2",
                        "review_pass": 1,
                    }
                    for i in range(10)
                ],
            )

            report = validate_labeled_dataset(config)
            split_counts = export_dataset_splits(config)

            self.assertEqual(report["total_samples"], 30)
            self.assertEqual(report["label_distribution"]["positive"], 10)
            self.assertTrue(report_path.exists())
            self.assertTrue(review_path.exists())
            self.assertEqual(sum(split_counts.values()), 30)
            self.assertEqual(split_counts, {"train": 24, "val": 3, "test": 3})

            train_csv = (export_dir / "train.csv").read_text(encoding="utf-8")
            self.assertIn("sample_id,text_norm,label", train_csv)

            saved_report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(saved_report["posts_covered"], 2)


if __name__ == "__main__":
    unittest.main()
