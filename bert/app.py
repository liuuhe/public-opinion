import os
from typing import Literal

import torch
from fastapi import FastAPI
from pydantic import BaseModel, Field
from transformers import AutoModelForSequenceClassification, AutoTokenizer

MODEL_DIR = os.getenv("MODEL_DIR", "model")
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL", "hfl/chinese-macbert-base")

LABELS = ["negative", "neutral", "positive"]
ID_TO_LABEL = {index: label for index, label in enumerate(LABELS)}


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
    model_path = MODEL_DIR if os.path.exists(MODEL_DIR) else FALLBACK_MODEL
    tokenizer = AutoTokenizer.from_pretrained(model_path)
    model = AutoModelForSequenceClassification.from_pretrained(
        model_path,
        num_labels=3,
        id2label=ID_TO_LABEL,
        label2id={label: index for index, label in ID_TO_LABEL.items()},
        ignore_mismatched_sizes=True,
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
        labels.append(
            LabelRow(
                sample_id=sample.sample_id,
                label=ID_TO_LABEL.get(prediction, "neutral"),
                confidence=round(float(confidence), 4),
                reason_short="bert",
            )
        )
    return PredictResponse(labels=labels)
