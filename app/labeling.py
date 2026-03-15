from __future__ import annotations

import concurrent.futures
import json
import time
from typing import Any
from urllib import error, request

from app.config import AppConfig, RuntimeSettings
from app.models import LabeledSample
from app.storage import append_jsonl, read_jsonl
from app.utils import utc_now_iso


SYSTEM_PROMPT = """你是网络舆情情绪标注器。任务是把评论标为 positive、neutral、negative 三类之一。

规则：
1. 只依据评论文本本身的显式情绪，不要依赖额外事件背景。
2. 表达支持、满意、赞同、开心、鼓励，标为 positive。
3. 客观陈述、信息补充、无明显情绪、无法确定，标为 neutral。
4. 表达不满、愤怒、批评、质疑、厌恶、明显讽刺，标为 negative。
5. 无法确定时优先选择 neutral。
6. 必须返回严格 JSON，字段为 label、confidence、reason_short。
7. confidence 取 0 到 1 之间的小数。"""


def label_samples(config: AppConfig, runtime: RuntimeSettings) -> dict[str, int]:
    if not runtime.api_key:
        raise RuntimeError("Missing OPENAI_API_KEY in environment.")

    rows = read_jsonl(config.labeling.input_path)
    labeled_by_sample_id = {
        row.get("sample_id"): row for row in read_jsonl(config.labeling.output_path)
    }

    created = 0
    skipped = 0
    reviewed = 0
    start_time = time.monotonic()
    progress = _ProgressPrinter()
    pending_rows: list[dict[str, Any]] = []

    for row in rows:
        sample_id = row.get("sample_id")
        if sample_id in labeled_by_sample_id:
            skipped += 1
            continue
        pending_rows.append(row)
    pending = len(pending_rows)

    print(
        f"Labeling started: total={len(rows)}, pending={pending}, already_labeled={skipped}, "
        f"concurrency={max(1, config.labeling.max_concurrency)}",
        flush=True,
    )
    if pending == 0:
        return {
            "input_count": len(rows),
            "created": created,
            "skipped_existing": skipped,
            "second_reviewed": reviewed,
        }

    max_workers = min(max(1, config.labeling.max_concurrency), pending)
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_row = {
            executor.submit(_label_row, row=row, runtime=runtime, config=config): row
            for row in pending_rows
        }
        try:
            for future in concurrent.futures.as_completed(future_to_row):
                sample_dict, row_reviewed = future.result()
                append_jsonl(config.labeling.output_path, [sample_dict])
                labeled_by_sample_id[sample_dict["sample_id"]] = sample_dict
                created += 1
                reviewed += row_reviewed
                progress.render(
                    completed=created,
                    total=pending,
                    reviewed=reviewed,
                    start_time=start_time,
                )
        except Exception:
            progress.finish(
                completed=created,
                total=pending,
                reviewed=reviewed,
                start_time=start_time,
            )
            executor.shutdown(wait=False, cancel_futures=True)
            raise

    progress.finish(
        completed=created,
        total=pending,
        reviewed=reviewed,
        start_time=start_time,
    )
    return {
        "input_count": len(rows),
        "created": created,
        "skipped_existing": skipped,
        "second_reviewed": reviewed,
    }


def _label_row(
    row: dict[str, Any],
    runtime: RuntimeSettings,
    config: AppConfig,
) -> tuple[dict[str, Any], int]:
    result = _label_once(
        text=row["text_norm"],
        runtime=runtime,
        config=config,
    )
    review_pass = 1
    reviewed = 0
    if _needs_second_review(row["text_norm"], result["confidence"], config):
        result = _label_once(
            text=row["text_norm"],
            runtime=runtime,
            config=config,
            second_pass=True,
        )
        review_pass = 2
        reviewed = 1

    sample = LabeledSample(
        sample_id=row["sample_id"],
        text_norm=row["text_norm"],
        label=result["label"],
        confidence=float(result["confidence"]),
        reason_short=result["reason_short"],
        model_name=runtime.model,
        prompt_version=config.labeling.prompt_version,
        labeled_at=utc_now_iso(),
        source=row["source"],
        post_id=row["post_id"],
        comment_id=row["comment_id"],
        parent_comment_id=row.get("parent_comment_id"),
        feed_batch_id=row["feed_batch_id"],
        capture_time=row["capture_time"],
        user_hash=row["user_hash"],
        comment_level=int(row["comment_level"]),
        review_pass=review_pass,
    )
    return sample.to_dict(), reviewed


def _needs_second_review(text: str, confidence: float, config: AppConfig) -> bool:
    return (
        confidence < config.labeling.low_confidence_threshold
        or len(text) <= config.labeling.review_on_short_text_chars
        or any(marker in text for marker in ("呵呵", "笑死", "？", "??", "。。。", "不是"))
    )


def _label_once(
    text: str,
    runtime: RuntimeSettings,
    config: AppConfig,
    second_pass: bool = False,
) -> dict[str, Any]:
    suffix = "这是复核轮次，请更保守，无法确定时输出 neutral。" if second_pass else ""
    user_prompt = (
        "请判断下面这条评论的情绪类别，并返回 JSON。\n"
        f"评论文本：{text}\n"
        f"{suffix}"
    )
    payload = {
        "model": runtime.model,
        "temperature": 0.0,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
    }

    for attempt in range(1, config.labeling.max_retries + 1):
        try:
            response = _post_chat_completion(runtime=runtime, payload=payload)
            parsed = _parse_response_payload(response)
            return _normalize_label_result(parsed)
        except Exception:
            if attempt == config.labeling.max_retries:
                raise
            time.sleep(config.labeling.retry_backoff_seconds * attempt)
    raise RuntimeError("Unreachable labeling retry state.")


def _post_chat_completion(runtime: RuntimeSettings, payload: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(
        url=f"{runtime.base_url}/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {runtime.api_key}",
        },
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"LLM request failed: {exc.code} {detail}") from exc


def _parse_response_payload(response: dict[str, Any]) -> dict[str, Any]:
    choices = response.get("choices") or []
    if not choices:
        raise RuntimeError(f"Missing choices in model response: {response}")
    message = choices[0].get("message") or {}
    content = message.get("content", "")
    if isinstance(content, list):
        content = "\n".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )

    content = content.strip()
    start = content.find("{")
    end = content.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise RuntimeError(f"Model output is not JSON: {content}")
    return json.loads(content[start : end + 1])


def _normalize_label_result(result: dict[str, Any]) -> dict[str, Any]:
    label = str(result.get("label", "neutral")).strip().lower()
    if label not in {"positive", "neutral", "negative"}:
        label = "neutral"
    confidence = result.get("confidence", 0.5)
    try:
        confidence = max(0.0, min(1.0, float(confidence)))
    except (TypeError, ValueError):
        confidence = 0.5
    reason = str(result.get("reason_short", "")).strip()[:80]
    if not reason:
        reason = "auto-labeled"
    return {"label": label, "confidence": confidence, "reason_short": reason}


class _ProgressPrinter:
    def __init__(self) -> None:
        self.last_length = 0

    def render(self, completed: int, total: int, reviewed: int, start_time: float) -> None:
        line = _build_progress_line(
            completed=completed,
            total=total,
            reviewed=reviewed,
            start_time=start_time,
        )
        padded = line.ljust(self.last_length)
        print(f"\r{padded}", end="", flush=True)
        self.last_length = len(line)

    def finish(self, completed: int, total: int, reviewed: int, start_time: float) -> None:
        if total == 0:
            return
        self.render(completed=completed, total=total, reviewed=reviewed, start_time=start_time)
        print("", flush=True)


def _build_progress_line(
    completed: int,
    total: int,
    reviewed: int,
    start_time: float,
) -> str:
    elapsed = max(time.monotonic() - start_time, 1e-9)
    percent = (completed / total) * 100 if total else 100.0
    rate = completed / elapsed if completed else 0.0
    remaining = max(total - completed, 0)
    eta_seconds = int(remaining / rate) if rate > 0 else 0
    return (
        f"Progress: {completed}/{total} ({percent:.1f}%)"
        f" | reviewed={reviewed}"
        f" | speed={rate:.2f} samples/s"
        f" | elapsed={_format_duration(int(elapsed))}"
        f" | eta={_format_duration(eta_seconds)}"
    )


def _format_duration(total_seconds: int) -> str:
    if total_seconds < 60:
        return f"{total_seconds}s"
    minutes, seconds = divmod(total_seconds, 60)
    if minutes < 60:
        return f"{minutes}m{seconds:02d}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h{minutes:02d}m{seconds:02d}s"
