# Public Opinion Pipeline

小红书关键词舆情分析项目。当前主流程：

- 浏览器插件：复用真实登录态，搜索关键词、逐帖打开详情页、采集评论并导出 JSON。
- Cloudflare Worker：接收插件采集 JSON，执行 LLM/BERT 情绪标注并返回报告。
- React Web：作为插件工作台，导入 JSON、查看摘要、图表、样本和导出报告。

线上入口：

```text
https://opinion.liuhe.me
```

## Browser Extension

1. 打开 Chrome/Edge 扩展管理页，启用开发者模式。
2. 选择“加载已解压的扩展程序”，目录选择 `browser-extension`。
3. 在正常浏览器里登录小红书，打开任意小红书页面。
4. 点击扩展，填写关键词、帖子数、每帖评论数、并发数。
5. 点击“自动逐帖”，插件会优先使用带 `xsec_token` 的搜索结果链接采集。
6. 采集完成后可直接“发送分析”，也可以“导出数据”后在网页工作台导入。

默认 Worker 地址：

```text
https://opinion.liuhe.me
```

## Cloudflare Worker

配置 LLM secret：

```bash
wrangler secret put OPENAI_API_KEY
```

本地开发与部署：

```bash
npm install
npm run dev
npm run build
npm run deploy
```

网页支持两种输入：

- 插件导出的 `xhs-opinion-*-capture.json`：调用 `/api/analyze/captured` 生成新报告。
- Worker 返回的 analysis JSON：直接渲染已生成报告，适合答辩复现。

## BERT Mode

Worker 不在 Cloudflare 内运行 PyTorch。选择 BERT 时，Worker 会调用外部 HTTP 推理服务：

```bash
wrangler secret put BERT_INFERENCE_URL
# value: https://<your-huggingface-space>.hf.space/predict
npm run deploy
```

BERT 训练和 Hugging Face Space 推理服务在 `bert/`：

```bash
cd bert
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python train.py --data data/seed.jsonl --output models/xhs-bert-sentiment --epochs 8
set MODEL_DIR=models/xhs-bert-sentiment
uvicorn app:app --host 0.0.0.0 --port 7860
```

推理接口兼容 Worker：

```json
{
  "samples": [
    { "sample_id": "s1", "text": "服务很耐心，下次还会去。" }
  ]
}
```

响应：

```json
{
  "labels": [
    { "sample_id": "s1", "label": "positive", "confidence": 0.91, "reason_short": "bert" }
  ]
}
```

## API

`POST /api/analyze/captured`

```json
{
  "keyword": "咖啡",
  "engine": "llm",
  "maxPosts": 10,
  "commentsPerPost": 30,
  "pageUrl": "https://www.xiaohongshu.com/search_result?...",
  "posts": [
    {
      "postId": "note id",
      "url": "https://www.xiaohongshu.com/explore/...",
      "title": "帖子标题",
      "description": "正文摘要",
      "authorHash": "匿名作者标识",
      "tags": ["#咖啡"],
      "comments": [
        {
          "sampleId": "sample id",
          "commentId": "comment id",
          "postId": "note id",
          "postUrl": "https://www.xiaohongshu.com/explore/...",
          "text": "评论文本",
          "userHash": "匿名用户标识",
          "commentLevel": 1,
          "captureSource": "network"
        }
      ]
    }
  ]
}
```

`POST /api/analyze` 仅在 `LOCAL_FIXTURE_ENABLED=true` 时返回 fixture 演示报告。

## Legacy

旧的本地 Playwright 采集器已归档到 `legacy/playwright-collector/`。如果插件因浏览器权限或小红书页面变化不可用，可以按该目录 README 作为兜底方案。

## Notes

- 采集基于个人登录态和小红书个性化推荐，论文和答辩中需要说明样本偏差。
- 若小红书要求扫码、短信或滑块验证，直接在日常浏览器中完成，再重新运行插件采集。
- BERT 初版 seed 数据较小，建议继续追加插件导出的评论并人工标注后再训练。
