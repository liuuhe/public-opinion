import argparse
import csv
import json
import random
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from sklearn.metrics import accuracy_score, f1_score
from torch.utils.data import Dataset
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    Trainer,
    TrainingArguments,
)

LABEL_TO_ID = {"negative": 0, "neutral": 1, "positive": 2}
ID_TO_LABEL = {value: key for key, value in LABEL_TO_ID.items()}


@dataclass
class Row:
    text: str
    label: str


class SentimentDataset(Dataset):
    def __init__(self, rows: list[Row], tokenizer, max_length: int) -> None:
        self.rows = rows
        self.tokenizer = tokenizer
        self.max_length = max_length

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> dict[str, torch.Tensor]:
        row = self.rows[index]
        encoded = self.tokenizer(
            row.text,
            truncation=True,
            padding="max_length",
            max_length=self.max_length,
            return_tensors="pt",
        )
        item = {key: value.squeeze(0) for key, value in encoded.items()}
        item["labels"] = torch.tensor(LABEL_TO_ID[row.label], dtype=torch.long)
        return item


def main() -> None:
    parser = argparse.ArgumentParser(description="Fine-tune Chinese BERT for Xiaohongshu sentiment labels.")
    parser.add_argument("--data", default="data/seed.jsonl", help="JSONL or CSV file with text,label columns.")
    parser.add_argument("--model", default="hfl/chinese-macbert-base", help="Base Hugging Face model.")
    parser.add_argument("--output", default="models/xhs-bert-sentiment", help="Output model directory.")
    parser.add_argument("--epochs", type=float, default=3)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--learning-rate", type=float, default=2e-5)
    parser.add_argument("--max-length", type=int, default=160)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    rows = load_rows(Path(args.data))
    if len(rows) < 9:
        raise SystemExit("Need at least 9 labeled rows so each label can appear in train/eval data.")

    random.seed(args.seed)
    random.shuffle(rows)
    split_index = max(1, int(len(rows) * 0.85))
    train_rows = rows[:split_index]
    eval_rows = rows[split_index:] or rows[-3:]

    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForSequenceClassification.from_pretrained(
        args.model,
        num_labels=3,
        id2label=ID_TO_LABEL,
        label2id=LABEL_TO_ID,
    )

    training_args = TrainingArguments(
        output_dir=args.output,
        eval_strategy="epoch",
        save_strategy="epoch",
        learning_rate=args.learning_rate,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        num_train_epochs=args.epochs,
        weight_decay=0.01,
        logging_steps=10,
        load_best_model_at_end=True,
        metric_for_best_model="macro_f1",
        report_to=[],
        seed=args.seed,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=SentimentDataset(train_rows, tokenizer, args.max_length),
        eval_dataset=SentimentDataset(eval_rows, tokenizer, args.max_length),
        compute_metrics=compute_metrics,
    )
    trainer.train()
    trainer.save_model(args.output)
    tokenizer.save_pretrained(args.output)
    write_label_map(Path(args.output))


def load_rows(path: Path) -> list[Row]:
    if path.suffix.lower() == ".csv":
        with path.open("r", encoding="utf-8-sig", newline="") as file:
            return normalize_rows(csv.DictReader(file))

    rows = []
    with path.open("r", encoding="utf-8") as file:
        for line in file:
            if not line.strip():
                continue
            rows.append(json.loads(line))
    return normalize_rows(rows)


def normalize_rows(items) -> list[Row]:
    rows = []
    for item in items:
        text = str(item.get("text", "")).strip()
        label = str(item.get("label", "")).strip()
        if text and label in LABEL_TO_ID:
            rows.append(Row(text=text[:300], label=label))
    return rows


def compute_metrics(eval_prediction) -> dict[str, float]:
    logits, labels = eval_prediction
    predictions = np.argmax(logits, axis=-1)
    return {
        "accuracy": accuracy_score(labels, predictions),
        "macro_f1": f1_score(labels, predictions, average="macro"),
    }


def write_label_map(output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    with (output_dir / "label_map.json").open("w", encoding="utf-8") as file:
        json.dump({"label2id": LABEL_TO_ID, "id2label": ID_TO_LABEL}, file, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
