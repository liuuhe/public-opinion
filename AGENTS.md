# Project Agent Context

This is the active project directory for the public opinion pipeline. Prefer
working from this folder:

```text
C:\Users\xlyytcy\codespace\public_opinion
```

Do not continue feature work in archived backup directories. The previous local
Playwright-only project has been kept as a fallback under
`legacy/playwright-collector/`.

## Current Product Flow

- Browser extension captures Xiaohongshu search results, post details, and
  comments using the user's normal logged-in browser session.
- Collection is intentionally single-threaded with random delay controls because
  concurrent capture triggered platform risk controls too easily.
- The extension can export local capture JSON, or send the current capture to
  the Worker for analysis.
- The React web app imports capture JSON or analysis JSON, renders the report,
  and supports JSON, Markdown, CSV, and print-to-PDF report export.
- Cloudflare Worker handles report generation and sentiment analysis.
- BERT inference is deployed through Cloudflare Containers and currently runs
  ONNX Runtime when the container is awake.

Production URL:

```text
https://opinion.liuhe.me
```

## Important Implementation Notes

- Browser extension source: `browser-extension/`
- Web app source: `src/`
- Worker source: `worker/`
- BERT training/inference/deployment source: `bert/`
- Model packaging script: `scripts/package-bert-model.ps1`
- Cloudflare container deployment workflow:
  `.github/workflows/deploy-cloudflare-containers.yml`

The extension default Worker URL should remain:

```text
https://opinion.liuhe.me
```

## Verified State

Recent checks that were passing:

```powershell
node --check browser-extension/background.js
node --check browser-extension/popup.js
node --check browser-extension/content.js
npm run check
npm run test:worker
npm run build
```

Production health after the ONNX deployment:

- `/api/health`: BERT provider is `cloudflare-container`, LLM is configured.
- `/api/bert/health`: runtime is `onnxruntime`, ONNX model file is `model.onnx`.

## BERT Accuracy Status

Current archived model metrics:

- Train rows: 2701
- Validation rows: 338
- Test rows: 336
- Validation accuracy: 0.7899
- Validation macro F1: 0.7498
- Test accuracy: 0.7738
- Test macro F1: 0.7269

Most remaining errors are negative comments predicted as neutral. The preferred
next step is data correction, not more blind hyperparameter tuning.

Use this loop:

```powershell
cd bert
python evaluate.py `
  --model-dir models/xhs-bert-sentiment `
  --data data/archive-wsl/exports/test.csv `
  --output-dir models/xhs-bert-sentiment/evaluation-test `
  --review-limit 120
```

Fill `manual_label` in the generated review CSV, apply corrections with
`apply_manual_review.py`, retrain, compare held-out `test_macro_f1`, then export
ONNX and redeploy only if metrics improve.

## Backup Directory Relationship

The historical backup directory is not the active project:

```text
C:\Users\xlyytcy\codespace\public_opinion.backup-20260421-185017
```

It contains an older Python-only pipeline with uncommitted `train_bert` helper
changes. That work is superseded by the current `bert/` pipeline in the active
project, which has evaluation, manual review, ONNX export, packaging, and
Cloudflare deployment support.

If a future session starts inside the backup directory, switch to the active
project before making changes:

```powershell
cd C:\Users\xlyytcy\codespace\public_opinion
```
