from __future__ import annotations

import argparse
import json

from app.cleaning import build_clean_dataset
from app.config import load_config, load_runtime_settings
from app.crawler import crawl_home_feed, doctor_browser, login
from app.exporter import export_dataset_splits
from app.labeling import label_samples
from app.training import train_bert_classifier
from app.validation import validate_labeled_dataset


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Public opinion data pipeline CLI")
    parser.add_argument("--config", default="config.yaml", help="Path to config file")

    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("login", help="Manual Xiaohongshu login and save browser session")
    subparsers.add_parser("doctor_browser", help="Diagnose browser access to Xiaohongshu URLs")

    crawl_parser = subparsers.add_parser("crawl_home_feed", help="Crawl home feed posts and comments")
    crawl_parser.add_argument("--batches", type=int, default=None)
    crawl_parser.add_argument("--posts-per-batch", type=int, default=None)
    crawl_parser.add_argument("--comments-per-post", type=int, default=None)

    subparsers.add_parser("clean", help="Clean and deduplicate raw comments")
    subparsers.add_parser("label", help="Label cleaned comments with an OpenAI-compatible API")
    subparsers.add_parser("validate", help="Generate validation reports and manual review samples")
    subparsers.add_parser("export_dataset", help="Export train/val/test CSV splits")
    subparsers.add_parser("train_bert", help="Fine-tune a BERT sentiment classifier")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    config = load_config(args.config)

    if args.command == "login":
        login(config)
        return 0

    if args.command == "doctor_browser":
        result = doctor_browser(config)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if args.command == "crawl_home_feed":
        result = crawl_home_feed(
            config,
            batches=args.batches,
            posts_per_batch=args.posts_per_batch,
            comments_per_post=args.comments_per_post,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if args.command == "clean":
        result = build_clean_dataset(config)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if args.command == "label":
        runtime = load_runtime_settings()
        result = label_samples(config, runtime)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if args.command == "validate":
        result = validate_labeled_dataset(config)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if args.command == "export_dataset":
        result = export_dataset_splits(config)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if args.command == "train_bert":
        result = train_bert_classifier(config)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    parser.error(f"Unsupported command: {args.command}")
    return 1
