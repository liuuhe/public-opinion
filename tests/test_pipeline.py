from __future__ import annotations

import os
import json
import tempfile
import time
import unittest
from pathlib import Path

from app.cleaning import build_clean_dataset
from app.config import AppConfig, load_runtime_settings
from app.crawler import _build_comment_candidate, _is_plausible_comment_candidate, _normalize_post_url
from app.exporter import export_dataset_splits
from app.labeling import _build_progress_line, _format_duration, label_samples
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

    def test_runtime_settings_loads_root_env_from_subdirectory(self) -> None:
        root_env = Path("/home/julian/projects/public_opinion/.env")
        original_env_text = root_env.read_text(encoding="utf-8") if root_env.exists() else None
        original_cwd = Path.cwd()
        original_values = {key: os.environ.get(key) for key in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL")}

        try:
            root_env.write_text(
                "\n".join(
                    [
                        "OPENAI_API_KEY=test-root-key",
                        "OPENAI_BASE_URL=https://example.com/v1",
                        "OPENAI_MODEL=test-model",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            for key in original_values:
                os.environ.pop(key, None)
            os.chdir("/home/julian/projects/public_opinion/app")

            settings = load_runtime_settings()

            self.assertEqual(settings.api_key, "test-root-key")
            self.assertEqual(settings.base_url, "https://example.com/v1")
            self.assertEqual(settings.model, "test-model")
        finally:
            os.chdir(original_cwd)
            for key, value in original_values.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
            if original_env_text is None:
                root_env.unlink(missing_ok=True)
            else:
                root_env.write_text(original_env_text, encoding="utf-8")

    def test_label_progress_helpers(self) -> None:
        self.assertEqual(_format_duration(5), "5s")
        self.assertEqual(_format_duration(65), "1m05s")
        self.assertEqual(_format_duration(3665), "1h01m05s")

        line = _build_progress_line(
            completed=5,
            total=10,
            reviewed=2,
            start_time=time.monotonic() - 10,
        )
        self.assertIn("Progress: 5/10 (50.0%)", line)
        self.assertIn("reviewed=2", line)
        self.assertIn("speed=", line)
        self.assertIn("eta=", line)

    def test_label_samples_appends_each_result(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            clean_path = Path(tmpdir) / "clean.jsonl"
            labeled_path = Path(tmpdir) / "labeled.jsonl"

            config = AppConfig()
            config.labeling.input_path = str(clean_path)
            config.labeling.output_path = str(labeled_path)
            config.labeling.low_confidence_threshold = 0.2

            append_jsonl(
                clean_path,
                [
                    {
                        "sample_id": "s1",
                        "text_norm": "挺好的",
                        "source": "xiaohongshu_home_feed",
                        "post_id": "p1",
                        "comment_id": "c1",
                        "parent_comment_id": None,
                        "feed_batch_id": "b1",
                        "capture_time": "2026-03-15T00:00:00+00:00",
                        "user_hash": "u1",
                        "comment_level": 1,
                    },
                    {
                        "sample_id": "s2",
                        "text_norm": "一般",
                        "source": "xiaohongshu_home_feed",
                        "post_id": "p1",
                        "comment_id": "c2",
                        "parent_comment_id": None,
                        "feed_batch_id": "b1",
                        "capture_time": "2026-03-15T00:00:00+00:00",
                        "user_hash": "u2",
                        "comment_level": 1,
                    },
                ],
            )

            runtime = load_runtime_settings()
            runtime.api_key = "test-key"
            runtime.base_url = "https://example.com/v1"
            runtime.model = "test-model"

            from app import labeling as labeling_module

            original_label_once = labeling_module._label_once

            try:
                call_count = 0

                def fake_label_once(text: str, runtime, config, second_pass: bool = False):
                    nonlocal call_count
                    call_count += 1
                    if second_pass:
                        return {"label": "neutral", "confidence": 0.9, "reason_short": "review"}
                    if call_count == 1:
                        return {"label": "positive", "confidence": 0.95, "reason_short": "ok"}
                    raise RuntimeError("stop after first sample")

                labeling_module._label_once = fake_label_once

                with self.assertRaisesRegex(RuntimeError, "stop after first sample"):
                    label_samples(config, runtime)

                labeled_rows = read_jsonl(labeled_path)
                self.assertEqual(len(labeled_rows), 1)
                self.assertEqual(labeled_rows[0]["sample_id"], "s1")
            finally:
                labeling_module._label_once = original_label_once

    def test_label_samples_supports_concurrency(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            clean_path = Path(tmpdir) / "clean.jsonl"
            labeled_path = Path(tmpdir) / "labeled.jsonl"

            config = AppConfig()
            config.labeling.input_path = str(clean_path)
            config.labeling.output_path = str(labeled_path)
            config.labeling.max_concurrency = 3
            config.labeling.low_confidence_threshold = 0.0

            append_jsonl(
                clean_path,
                [
                    {
                        "sample_id": f"s{i}",
                        "text_norm": f"text-{i}",
                        "source": "xiaohongshu_home_feed",
                        "post_id": "p1",
                        "comment_id": f"c{i}",
                        "parent_comment_id": None,
                        "feed_batch_id": "b1",
                        "capture_time": "2026-03-15T00:00:00+00:00",
                        "user_hash": f"u{i}",
                        "comment_level": 1,
                    }
                    for i in range(6)
                ],
            )

            runtime = load_runtime_settings()
            runtime.api_key = "test-key"
            runtime.base_url = "https://example.com/v1"
            runtime.model = "test-model"

            from app import labeling as labeling_module

            original_label_once = labeling_module._label_once

            try:
                def fake_label_once(text: str, runtime, config, second_pass: bool = False):
                    time.sleep(0.01)
                    return {"label": "neutral", "confidence": 0.9, "reason_short": text}

                labeling_module._label_once = fake_label_once
                result = label_samples(config, runtime)

                labeled_rows = read_jsonl(labeled_path)
                self.assertEqual(result["created"], 6)
                self.assertEqual(len(labeled_rows), 6)
            finally:
                labeling_module._label_once = original_label_once

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
