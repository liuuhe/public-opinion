# Project Status

Last consolidated: 2026-04-22.

## Active Folder

Use only this folder for ongoing work:

```text
C:\Users\xlyytcy\codespace\public_opinion
```

The sibling backup directory is archival. It can be kept for reference, but it
should not receive new feature work.

## Completed Work

- Browser extension collection now prioritizes Xiaohongshu search result links
  that include `xsec_token`.
- Automatic post collection no longer performs an initial scroll before opening
  posts.
- Extension parameters for keyword, post count, comments per post, and random
  delay are wired into capture behavior.
- Concurrent capture was removed because it increased risk-control triggers.
  Capture is now sequential and supports pause/cancel.
- Paused captures can still be sent for analysis.
- Extension export and web import support capture JSON.
- Web report export supports JSON, Markdown, CSV samples, and print-to-PDF.
- Worker is adapted for current plugin payloads and report summaries.
- Custom domain is in use: `https://opinion.liuhe.me`.
- BERT model deployment is automated through GitHub Actions and Cloudflare
  Containers.
- BERT inference prefers ONNX Runtime when `model.onnx` is present.

## Current Deployment

Production:

```text
https://opinion.liuhe.me
```

Expected health state:

- Worker health: BERT provider `cloudflare-container`.
- BERT health: runtime `onnxruntime`, model file `model.onnx`.

The Cloudflare container can take time to wake up on the first request. The UI
should continue showing request progress during that first analysis.

## Current BERT Model

The deployed ONNX model has the same accuracy as the existing PyTorch model; it
was exported for deployment/runtime efficiency, not because it improved model
quality.

Current held-out metrics:

| Split | Accuracy | Macro F1 |
| --- | ---: | ---: |
| Validation | 0.7899 | 0.7498 |
| Test | 0.7738 | 0.7269 |

Confusion review showed that negative comments are often predicted as neutral.
Short sarcasm, slang, and weak labels are the main known weaknesses.

## Recommended Next Step

Improve accuracy through label review:

1. Generate misclassification review CSVs with `bert/evaluate.py`.
2. Fill the `manual_label` column for high-confidence mistakes.
3. Apply corrections with `bert/apply_manual_review.py`.
4. Retrain with `bert/train.py`.
5. Compare held-out `test_macro_f1`.
6. Export ONNX with `bert/export_onnx.py`.
7. Package, upload to GitHub Release `bert-model`, and run the Cloudflare
   Containers GitHub Actions workflow.

Do not deploy a new model unless held-out test metrics improve.

## Backup Merge Decision

The backup directory contains older uncommitted changes that add a `train_bert`
command to the previous Python pipeline. Those changes are not being copied into
the main app because the active project already has a more complete BERT flow:

- `bert/train.py`
- `bert/evaluate.py`
- `bert/apply_manual_review.py`
- `bert/export_onnx.py`
- Cloudflare container deployment
- GitHub Actions deployment

The useful context from the backup has been consolidated here and in
`AGENTS.md`.
