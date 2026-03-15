from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.utils import load_dotenv

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None


@dataclass(slots=True)
class BrowserConfig:
    home_url: str = "https://www.xiaohongshu.com/explore"
    login_url: str = "https://www.xiaohongshu.com/"
    login_candidates: list[str] = field(
        default_factory=lambda: [
            "https://www.xiaohongshu.com/",
            "https://www.xiaohongshu.com/explore",
            "https://www.xiaohongshu.com/search_result",
        ]
    )
    headless: bool = False
    slow_mo_ms: int = 200
    default_timeout_ms: int = 20000
    storage_state_path: str = "sessions/xiaohongshu_storage_state.json"
    ignore_https_errors: bool = True
    locale: str = "zh-CN"
    timezone_id: str = "Asia/Shanghai"
    user_agent: str = (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )
    launch_args: list[str] = field(
        default_factory=lambda: [
            "--disable-blink-features=AutomationControlled",
            "--disable-quic",
            "--disable-dev-shm-usage",
        ]
    )


@dataclass(slots=True)
class CrawlConfig:
    raw_posts_path: str = "data/raw/raw_posts.jsonl"
    raw_comments_path: str = "data/raw/raw_comments.jsonl"
    batches: int = 3
    posts_per_batch: int = 10
    comments_per_post: int = 40
    max_scroll_rounds: int = 20
    feed_scroll_px: int = 1600
    post_open_wait_ms: int = 2000
    comment_expand_clicks: int = 6
    comment_scroll_rounds: int = 8
    comment_scroll_px: int = 900
    dedupe_fallback_salt: str = "public-opinion-v1"


@dataclass(slots=True)
class CleanConfig:
    input_path: str = "data/raw/raw_comments.jsonl"
    output_path: str = "data/clean/clean_comments.jsonl"
    min_text_length: int = 2
    drop_pattern_texts: list[str] = field(
        default_factory=lambda: ["作者赞过", "置顶", "展开", "查看更多回复"]
    )


@dataclass(slots=True)
class LabelingConfig:
    input_path: str = "data/clean/clean_comments.jsonl"
    output_path: str = "data/labeled/labeled_comments.jsonl"
    batch_size: int = 1
    max_retries: int = 3
    retry_backoff_seconds: float = 2.0
    low_confidence_threshold: float = 0.7
    review_on_short_text_chars: int = 6
    prompt_version: str = "v1-explicit-sentiment"


@dataclass(slots=True)
class ValidationConfig:
    input_path: str = "data/labeled/labeled_comments.jsonl"
    report_path: str = "data/exports/validation_report.json"
    manual_review_path: str = "data/exports/manual_review_sample.csv"
    manual_review_sample_size: int = 200
    random_seed: int = 42


@dataclass(slots=True)
class ExportConfig:
    input_path: str = "data/labeled/labeled_comments.jsonl"
    output_dir: str = "data/exports"
    train_ratio: float = 0.8
    val_ratio: float = 0.1
    test_ratio: float = 0.1
    random_seed: int = 42


@dataclass(slots=True)
class RuntimeSettings:
    api_key: str = ""
    base_url: str = "https://api.openai.com/v1"
    model: str = "gpt-4o-mini"


@dataclass(slots=True)
class AppConfig:
    browser: BrowserConfig = field(default_factory=BrowserConfig)
    crawl: CrawlConfig = field(default_factory=CrawlConfig)
    clean: CleanConfig = field(default_factory=CleanConfig)
    labeling: LabelingConfig = field(default_factory=LabelingConfig)
    validation: ValidationConfig = field(default_factory=ValidationConfig)
    export: ExportConfig = field(default_factory=ExportConfig)


def _update_dataclass(instance: Any, values: dict[str, Any] | None) -> None:
    if not values:
        return
    for key, value in values.items():
        if hasattr(instance, key):
            setattr(instance, key, value)


def load_config(path: str = "config.yaml") -> AppConfig:
    config = AppConfig()
    file_path = Path(path)
    if file_path.exists():
        payload = _load_config_payload(file_path)
        _update_dataclass(config.browser, payload.get("browser"))
        _update_dataclass(config.crawl, payload.get("crawl"))
        _update_dataclass(config.clean, payload.get("clean"))
        _update_dataclass(config.labeling, payload.get("labeling"))
        _update_dataclass(config.validation, payload.get("validation"))
        _update_dataclass(config.export, payload.get("export"))
    return config


def load_runtime_settings() -> RuntimeSettings:
    load_dotenv()
    return RuntimeSettings(
        api_key=os.getenv("OPENAI_API_KEY", ""),
        base_url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/"),
        model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
    )


def _load_config_payload(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if yaml is not None:
        return yaml.safe_load(text) or {}
    return _parse_simple_yaml(text)


def _parse_simple_yaml(text: str) -> dict[str, Any]:
    root: dict[str, Any] = {}
    stack: list[tuple[int, Any]] = [(-1, root)]
    lines = text.splitlines()

    for index, raw_line in enumerate(lines):
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        stripped = raw_line.strip()

        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()

        current = stack[-1][1]
        if stripped.startswith("- "):
            if not isinstance(current, list):
                raise RuntimeError(f"Invalid list entry in config line: {raw_line}")
            current.append(_parse_scalar(stripped[2:].strip()))
            continue

        if ":" not in stripped:
            raise RuntimeError(f"Invalid config line: {raw_line}")
        key, value = stripped.split(":", 1)
        key = key.strip()
        value = value.strip()

        if value == "":
            next_container: Any
            next_significant = _peek_next_significant_line(lines, index)
            if next_significant is not None and next_significant.strip().startswith("- "):
                next_container = []
            else:
                next_container = {}
            current[key] = next_container
            stack.append((indent, next_container))
            continue

        current[key] = _parse_scalar(value)

    return root


def _peek_next_significant_line(lines: list[str], current_index: int) -> str | None:
    for line in lines[current_index + 1 :]:
        if line.strip() and not line.lstrip().startswith("#"):
            return line
    return None


def _parse_scalar(value: str) -> Any:
    trimmed = value.strip().strip('"').strip("'")
    lowered = trimmed.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if lowered in {"null", "none"}:
        return None
    try:
        if "." in trimmed:
            return float(trimmed)
        return int(trimmed)
    except ValueError:
        return trimmed
