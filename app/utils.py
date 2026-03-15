from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


_CONTROL_RE = re.compile(r"[\u0000-\u001f\u007f-\u009f]")
_WHITESPACE_RE = re.compile(r"\s+")
_MEANINGFUL_CHAR_RE = re.compile(r"[0-9A-Za-z\u4e00-\u9fff]")


def utc_now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def ensure_parent_dir(path: str | Path) -> None:
    Path(path).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)


def normalize_whitespace(value: str) -> str:
    return _WHITESPACE_RE.sub(" ", value).strip()


def strip_control_chars(value: str) -> str:
    return _CONTROL_RE.sub("", value)


def normalize_text(value: str) -> str:
    return normalize_whitespace(strip_control_chars(value))


def has_meaningful_text(value: str) -> bool:
    return bool(_MEANINGFUL_CHAR_RE.search(value))


def hash_identifier(value: str, salt: str = "") -> str:
    return hashlib.sha256(f"{salt}:{value}".encode("utf-8")).hexdigest()[:16]


def stable_json_dumps(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def load_dotenv(path: str | Path = ".env") -> None:
    env_path = Path(path)
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        os.environ.setdefault(key, value)
