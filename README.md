# Public Opinion Local Pipeline

小红书关键词舆情分析本地工作台。当前产品路径是：

```text
MediaCrawler 采集 -> capture JSON -> 本地 BERT 分析 -> WebUI 报告导出
```

## 一键启动

```powershell
npm run local
```

打开：

```text
http://127.0.0.1:8788
```

一键启动会构建本地前端、启动本地 BERT、启动本地 WebUI/API，并自动打开浏览器。

## WebUI 功能

- 在页面中填写关键词、帖子数、每帖评论数。
- 点击“开始采集”，由本地 WebUI 启动 vendored MediaCrawler。
- 采集完成后自动转换为 `data/captures/*.json`。
- 点击“载入结果”，再用本地 BERT 生成报告。
- 报告支持 JSON、Markdown、CSV 和打印 PDF。

当前最佳模型基线：`test_macro_f1 = 0.8295`。后续新模型只有超过该冻结测试集基线才替换默认本地模型。

## 命令行采集

```powershell
npm run mediacrawler:xhs -- --keywords "酒店 避雷" --max_notes_count 10 --max_comments_count_singlenotes 80
```

转换为 capture JSON：

```powershell
npm run mediacrawler:to-capture -- --input-dir "data\mediacrawler\xhs\jsonl" --keyword "酒店 避雷" --output "data\captures\xhs-mediacrawler-酒店-避雷.json"
```

## Dataset Loop

从 capture JSON 生成复核样本：

```powershell
npm run dataset:from-captures -- --input "data/captures/*.json" --output "bert/data/archive-wsl/exports/new_samples.review.csv"
```

复核并填写 `negative/neutral/positive` 标签后合并到训练集：

```powershell
npm run dataset:merge -- --base "bert/data/archive-wsl/exports/train.corrected.v2.csv" --new "bert/data/archive-wsl/exports/new_samples.review.csv" --output "bert/data/archive-wsl/exports/train.corrected.v3.csv"
```

## Notes

- MediaCrawler 使用非商业学习许可，见 `vendor/mediacrawler-xhs/LICENSE`。
- 采集保持低并发，默认 `--max_concurrency_num 1`。
- 如果小红书要求扫码、短信或滑块验证，在 MediaCrawler 打开的真实浏览器里完成后继续。
