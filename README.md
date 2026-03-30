# Public Opinion Pipeline

用于毕业设计的数据流水线，包含：
- 小红书首页推流帖子与评论采集
- 评论清洗与去重
- 基于 OpenAI 兼容接口的三分类情绪标注
- 质量校验与训练集导出

## Quick Start

1. 创建虚拟环境并安装依赖：

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
playwright install chromium
```

2. 配置环境变量：

```bash
cp .env.example .env
```

3. 首次登录小红书并持久化会话：

```bash
python -m app doctor_browser
python -m app login
```

4. 采集首页推流评论：

```bash
python -m app crawl_home_feed --batches 3 --posts-per-batch 10 --comments-per-post 40
```

5. 清洗、标注、校验、导出：

```bash
python -m app clean
python -m app label
python -m app validate
python -m app export_dataset
```

6. 微调 BERT 情绪分类模型：

```bash
python -m app train_bert
```

## Output Layout

- `data/raw/raw_posts.jsonl`
- `data/raw/raw_comments.jsonl`
- `data/clean/clean_comments.jsonl`
- `data/labeled/labeled_comments.jsonl`
- `data/exports/train.csv`
- `data/exports/val.csv`
- `data/exports/test.csv`
- `data/exports/validation_report.json`
- `data/models/bert_finetune/`

## Notes

- 采集基于登录态与时间窗口抽样，结果具有个性化偏差，需要在论文中说明。
- 代码默认只做教学与研究用途，执行前自行确认平台规则与数据使用边界。
- 小红书页面结构会变化，`app/crawler.py` 中保留了多套 DOM / 全局状态提取兜底逻辑，必要时需要按实际页面微调。
- 如果 `login` 报 `ERR_CONNECTION_CLOSED`，先运行 `python -m app doctor_browser`，再根据输出调整 `config.yaml` 中的 `browser.launch_args`、`login_candidates` 或本地网络环境。
