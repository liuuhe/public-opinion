import os
from typing import Literal

import torch
from fastapi import FastAPI
from pydantic import BaseModel, Field
from transformers import AutoModelForSequenceClassification, AutoTokenizer

MODEL_DIR = os.getenv("MODEL_DIR", "model")
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL", "google-bert/bert-base-chinese")

LABELS = ["negative", "neutral", "positive"]
ID_TO_LABEL = {index: label for index, label in enumerate(LABELS)}
LOW_CONFIDENCE_THRESHOLD = 0.5
POSITIVE_TERMS = (
    "不错",
    "喜欢",
    "满意",
    "推荐",
    "耐心",
    "舒服",
    "划算",
    "稳定",
    "惊喜",
    "及时",
    "清楚",
    "好",
)
NEGATIVE_TERMS = (
    "差",
    "离谱",
    "失望",
    "不值",
    "普通",
    "太吵",
    "很吵",
    "麻烦",
    "噪音",
    "踩雷",
    "没有回复",
    "不耐烦",
    "问题",
)
NEUTRAL_TERMS = ("一般", "还行", "可以接受", "观望", "中规中矩", "略高", "先看看")


class Sample(BaseModel):
    sample_id: str = Field(alias="sample_id")
    text: str


class PredictRequest(BaseModel):
    samples: list[Sample]


class LabelRow(BaseModel):
    sample_id: str
    label: Literal["positive", "neutral", "negative"]
    confidence: float
    reason_short: str


class PredictResponse(BaseModel):
    labels: list[LabelRow]


app = FastAPI(title="XHS BERT Sentiment Service")
tokenizer = None
model = None
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")


@app.on_event("startup")
def load_model() -> None:
    global tokenizer, model
    has_local_model = os.path.exists(MODEL_DIR)
    model_path = MODEL_DIR if has_local_model else FALLBACK_MODEL
    tokenizer = AutoTokenizer.from_pretrained(model_path)
    if has_local_model:
        model = AutoModelForSequenceClassification.from_pretrained(model_path)
    else:
        model = AutoModelForSequenceClassification.from_pretrained(
            model_path,
            num_labels=3,
            id2label=ID_TO_LABEL,
            label2id={label: index for index, label in ID_TO_LABEL.items()},
        )
    model.to(device)
    model.eval()


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "ok": True,
        "modelDir": MODEL_DIR,
        "fallbackModel": FALLBACK_MODEL,
        "device": str(device),
    }


@app.post("/predict", response_model=PredictResponse)
def predict(request: PredictRequest) -> PredictResponse:
    if not request.samples:
        return PredictResponse(labels=[])

    texts = [sample.text[:300] for sample in request.samples]
    encoded = tokenizer(
        texts,
        padding=True,
        truncation=True,
        max_length=160,
        return_tensors="pt",
    ).to(device)

    with torch.no_grad():
        logits = model(**encoded).logits
        probabilities = torch.softmax(logits, dim=-1)
        confidences, predictions = torch.max(probabilities, dim=-1)

    labels = []
    for sample, prediction, confidence in zip(request.samples, predictions.tolist(), confidences.tolist()):
        label = ID_TO_LABEL.get(prediction, "neutral")
        reason = "bert"
        if confidence < LOW_CONFIDENCE_THRESHOLD:
            rule_label = rule_label_for(sample.text)
            if rule_label:
                label = rule_label
                confidence = max(confidence, 0.62)
                reason = "bert+rules"

        labels.append(
            LabelRow(
                sample_id=sample.sample_id,
                label=label,
                confidence=round(float(confidence), 4),
                reason_short=reason,
            )
        )
    return PredictResponse(labels=labels)


def rule_label_for(text: str) -> Literal["positive", "neutral", "negative"] | None:
    positive_hits = sum(1 for term in POSITIVE_TERMS if term in text)
    negative_hits = sum(1 for term in NEGATIVE_TERMS if term in text)
    neutral_hits = sum(1 for term in NEUTRAL_TERMS if term in text)

    if positive_hits and negative_hits:
        return "neutral"
    if negative_hits > positive_hits:
        return "negative"
    if positive_hits > negative_hits:
        return "positive"
    if neutral_hits:
        return "neutral"
    return None
