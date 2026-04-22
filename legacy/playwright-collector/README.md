# Legacy Playwright Collector

This directory keeps the previous local Playwright collector as a fallback path.
The main project flow is now:

1. Browser extension captures Xiaohongshu posts and comments.
2. Cloudflare Worker labels sentiment and builds reports.
3. React web app imports capture JSON and renders reports.

Use this legacy collector only if the browser extension is blocked by browser
permissions or Xiaohongshu page changes.

## Usage

```bash
cd legacy/playwright-collector
python -m venv .venv
.venv\Scripts\activate
pip install -e .
playwright install chromium
python -m app login
python -m app collect --keyword "咖啡" --posts 10 --comments 30 --worker-url https://opinion.liuhe.me --engine llm
```

Outputs are written under `data/captures` and `data/reports` relative to the
current working directory.
