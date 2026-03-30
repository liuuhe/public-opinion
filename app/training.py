from __future__ import annotations

import csv
import inspect
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from app.config import AppConfig
from app.utils import ensure_parent_dir


LABEL_TO_ID = {
    "negative": 0,
    "neutral": 1,
    "positive": 2,
}
ID_TO_LABEL = {value: key for key, value in LABEL_TO_ID.items()}


@dataclass(slots=True)
class ClassificationSample:
    sample_id: str
    text: str
    label: int


class SentimentDataset:
    def __init__(self, encodings: dict[str, Any], labels: Sequence[int]) -> None:
        self.encodings = encodings
        self.labels = list(labels)

    def __len__(self) -> int:
        return len(self.labels)

    def __getitem__(self, index: int) -> dict[str, Any]:
        item = {key: value[index] for key, value in self.encodings.items()}
        item["labels"] = self.labels[index]
        return item


def train_bert_classifier(config: AppConfig) -> dict[str, Any]:
    transformers = _load_transformers()
    AutoModelForSequenceClassification = transformers["AutoModelForSequenceClassification"]
    AutoTokenizer = transformers["AutoTokenizer"]
    EarlyStoppingCallback = transformers["EarlyStoppingCallback"]
    Trainer = transformers["Trainer"]
    TrainingArguments = transformers["TrainingArguments"]
    _disable_hf_auto_conversion()

    train_samples = _load_split_csv(config.training.train_path)
    val_samples = _load_split_csv(config.training.val_path)
    test_samples = _load_split_csv(config.training.test_path)
    if not train_samples or not val_samples or not test_samples:
        raise RuntimeError(
            "Missing train/val/test CSV data. Run `python -m app export_dataset` first."
        )

    output_dir = Path(config.training.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    tokenizer = AutoTokenizer.from_pretrained(config.training.pretrained_model_name)
    train_dataset = _build_dataset(tokenizer, train_samples, config.training.max_length)
    val_dataset = _build_dataset(tokenizer, val_samples, config.training.max_length)
    test_dataset = _build_dataset(tokenizer, test_samples, config.training.max_length)

    model = AutoModelForSequenceClassification.from_pretrained(
        config.training.pretrained_model_name,
        num_labels=len(LABEL_TO_ID),
        label2id=LABEL_TO_ID,
        id2label=ID_TO_LABEL,
        use_safetensors=False,
    )

    training_args = _build_training_arguments(
        TrainingArguments=TrainingArguments,
        config=config,
        output_dir=output_dir,
    )

    callbacks = []
    if config.training.early_stopping_patience > 0:
        callbacks.append(
            EarlyStoppingCallback(
                early_stopping_patience=config.training.early_stopping_patience
            )
        )

    trainer = _build_trainer(
        Trainer=Trainer,
        model=model,
        training_args=training_args,
        train_dataset=train_dataset,
        eval_dataset=val_dataset,
        tokenizer=tokenizer,
        callbacks=callbacks,
    )

    train_output = trainer.train()
    val_metrics = trainer.evaluate(eval_dataset=val_dataset, metric_key_prefix="val")
    test_metrics = trainer.evaluate(eval_dataset=test_dataset, metric_key_prefix="test")

    trainer.save_model(str(output_dir))
    tokenizer.save_pretrained(str(output_dir))

    metrics_payload = {
        "model_name": config.training.pretrained_model_name,
        "train_samples": len(train_samples),
        "val_samples": len(val_samples),
        "test_samples": len(test_samples),
        "train_metrics": _json_safe_metrics(train_output.metrics),
        "val_metrics": _json_safe_metrics(val_metrics),
        "test_metrics": _json_safe_metrics(test_metrics),
    }
    metrics_path = output_dir / "metrics.json"
    ensure_parent_dir(metrics_path)
    metrics_path.write_text(
        json.dumps(metrics_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return metrics_payload


def _build_training_arguments(TrainingArguments: Any, config: AppConfig, output_dir: Path) -> Any:
    kwargs = {
        "output_dir": str(output_dir),
        "overwrite_output_dir": True,
        "do_train": True,
        "do_eval": True,
        "eval_strategy": "epoch",
        "save_strategy": "epoch",
        "load_best_model_at_end": True,
        "metric_for_best_model": "eval_macro_f1",
        "greater_is_better": True,
        "per_device_train_batch_size": config.training.train_batch_size,
        "per_device_eval_batch_size": config.training.eval_batch_size,
        "learning_rate": config.training.learning_rate,
        "weight_decay": config.training.weight_decay,
        "warmup_ratio": config.training.warmup_ratio,
        "num_train_epochs": config.training.num_train_epochs,
        "logging_steps": config.training.logging_steps,
        "seed": config.training.seed,
        "dataloader_num_workers": config.training.dataloader_num_workers,
        "report_to": "none",
        "save_total_limit": 2,
    }

    supported = inspect.signature(TrainingArguments.__init__).parameters
    filtered_kwargs = {key: value for key, value in kwargs.items() if key in supported}
    return TrainingArguments(**filtered_kwargs)


def _build_trainer(
    Trainer: Any,
    model: Any,
    training_args: Any,
    train_dataset: Any,
    eval_dataset: Any,
    tokenizer: Any,
    callbacks: list[Any],
) -> Any:
    kwargs = {
        "model": model,
        "args": training_args,
        "train_dataset": train_dataset,
        "eval_dataset": eval_dataset,
        "tokenizer": tokenizer,
        "processing_class": tokenizer,
        "compute_metrics": _compute_metrics,
        "callbacks": callbacks,
    }
    supported = inspect.signature(Trainer.__init__).parameters
    filtered_kwargs = {key: value for key, value in kwargs.items() if key in supported}
    return Trainer(**filtered_kwargs)


def _disable_hf_auto_conversion() -> None:
    try:
        import transformers.modeling_utils as modeling_utils
        import transformers.safetensors_conversion as safetensors_conversion
    except Exception:
        return

    def _skip_auto_conversion(*args: Any, **kwargs: Any) -> tuple[None, str | None, bool]:
        return None, kwargs.get("revision"), False

    modeling_utils.auto_conversion = _skip_auto_conversion
    safetensors_conversion.auto_conversion = _skip_auto_conversion


def _load_transformers() -> dict[str, Any]:
    try:
        from transformers import (
            AutoModelForSequenceClassification,
            AutoTokenizer,
            EarlyStoppingCallback,
            Trainer,
            TrainingArguments,
        )
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "Training dependencies are missing. Run `pip install -e .` to install torch, "
            "transformers, and accelerate."
        ) from exc

    return {
        "AutoModelForSequenceClassification": AutoModelForSequenceClassification,
        "AutoTokenizer": AutoTokenizer,
        "EarlyStoppingCallback": EarlyStoppingCallback,
        "Trainer": Trainer,
        "TrainingArguments": TrainingArguments,
    }


def _load_split_csv(path: str) -> list[ClassificationSample]:
    file_path = Path(path)
    if not file_path.exists():
        return []

    samples: list[ClassificationSample] = []
    with file_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            label_name = str(row.get("label", "")).strip().lower()
            text = str(row.get("text_norm", "")).strip()
            sample_id = str(row.get("sample_id", "")).strip()
            if not sample_id or not text or label_name not in LABEL_TO_ID:
                continue
            samples.append(
                ClassificationSample(
                    sample_id=sample_id,
                    text=text,
                    label=LABEL_TO_ID[label_name],
                )
            )
    return samples


def _build_dataset(tokenizer: Any, samples: list[ClassificationSample], max_length: int) -> SentimentDataset:
    encodings = tokenizer(
        [sample.text for sample in samples],
        truncation=True,
        padding=True,
        max_length=max_length,
    )
    return SentimentDataset(encodings=encodings, labels=[sample.label for sample in samples])


def _compute_metrics(eval_pred: Any) -> dict[str, float]:
    logits, labels = eval_pred
    if hasattr(logits, "argmax"):
        predictions = logits.argmax(axis=-1)
    else:
        predictions = [max(range(len(row)), key=lambda idx: row[idx]) for row in logits]
    return _classification_metrics(labels, predictions, label_count=len(LABEL_TO_ID))


def _classification_metrics(
    true_labels: Sequence[int],
    predicted_labels: Sequence[int],
    label_count: int,
) -> dict[str, float]:
    total = len(true_labels)
    if total == 0:
        return {
            "accuracy": 0.0,
            "macro_precision": 0.0,
            "macro_recall": 0.0,
            "macro_f1": 0.0,
        }

    correct = sum(1 for truth, pred in zip(true_labels, predicted_labels) if truth == pred)
    precision_sum = 0.0
    recall_sum = 0.0
    f1_sum = 0.0

    for label_id in range(label_count):
        tp = sum(
            1
            for truth, pred in zip(true_labels, predicted_labels)
            if truth == label_id and pred == label_id
        )
        fp = sum(
            1
            for truth, pred in zip(true_labels, predicted_labels)
            if truth != label_id and pred == label_id
        )
        fn = sum(
            1
            for truth, pred in zip(true_labels, predicted_labels)
            if truth == label_id and pred != label_id
        )

        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = (
            (2 * precision * recall) / (precision + recall)
            if (precision + recall) > 0
            else 0.0
        )
        precision_sum += precision
        recall_sum += recall
        f1_sum += f1

    return {
        "accuracy": round(correct / total, 4),
        "macro_precision": round(precision_sum / label_count, 4),
        "macro_recall": round(recall_sum / label_count, 4),
        "macro_f1": round(f1_sum / label_count, 4),
    }


def _json_safe_metrics(metrics: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in metrics.items():
        if hasattr(value, "item"):
            result[key] = value.item()
        else:
            result[key] = value
    return result
