# Xiaohongshu Playwright Collector

This collector is a local fallback when the browser extension capture flow is too fragile. It writes the same capture JSON shape that the web app and `/api/analyze/captured` already accept.

It is intentionally conservative: one visible browser session, one post at a time, persistent login state, randomized delays, checkpoint output after each post, and stop-on-verification behavior. It does not try to bypass verification, CAPTCHAs, or platform rate limits.

## Install

```powershell
npm install
npx playwright install chromium
```

## Login Once

```powershell
npm run collect:xhs -- --login
```

Log in manually in the opened Chromium window, wait until Xiaohongshu is usable, then press Enter in the terminal. The profile is saved under `sessions/xhs-playwright/`.

## Collect By Keyword

```powershell
npm run collect:xhs -- --keyword "咖啡" --max-posts 20 --comments-per-post 80
```

Output defaults to `data/captures/xhs-playwright-<keyword>-<timestamp>.json`.

## Collect From Known Note URLs

```powershell
npm run collect:xhs -- --urls-file data/note-urls.txt --keyword "咖啡"
```

`data/note-urls.txt` should contain one Xiaohongshu note URL per line. Blank lines and `#` comments are ignored.

## Reuse Existing Chrome With CDP

If you prefer using your normal Chrome profile, start Chrome with remote debugging enabled yourself, then run:

```powershell
npm run collect:xhs -- --cdp http://127.0.0.1:9222 --keyword "咖啡"
```

This follows the same high-level pattern as MediaCrawler: reuse a real logged-in browser context and avoid extra reverse engineering. Keep collection small and pause when verification appears.

## Useful Options

```text
--max-posts 10
--comments-per-post 80
--search-scroll-rounds 8
--detail-scroll-rounds 8
--delay-min-ms 9000
--delay-max-ms 22000
--output data/captures/my-capture.json
--keep-open
```
