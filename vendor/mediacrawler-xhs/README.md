# Vendored MediaCrawler Xiaohongshu Subset

This directory is a local, reduced copy of the Xiaohongshu-related parts of
[NanmiCoder/MediaCrawler](https://github.com/NanmiCoder/MediaCrawler).

It is included so this project can run the collection step locally without
depending on a sibling checkout. Only the Xiaohongshu crawler path is intended
to work here; other platform crawler modules were intentionally not copied.

## License

The original MediaCrawler project is licensed under `NON-COMMERCIAL LEARNING
LICENSE 1.1`. See `LICENSE` in this directory. Keep this notice if the vendored
code is updated or moved.

## Run

From the repository root:

```powershell
npm run mediacrawler:xhs -- --keywords "酒店 避雷" --max_comments_count_singlenotes 80 --save_data_path "..\..\data\mediacrawler"
```

Then convert MediaCrawler output to capture JSON:

```powershell
npm run mediacrawler:to-capture -- --input-dir "data\mediacrawler\xhs\jsonl" --keyword "酒店 避雷"
```
