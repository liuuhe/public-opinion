# -*- coding: utf-8 -*-
# Derived from NanmiCoder/MediaCrawler main.py.
# This vendored entry keeps only the Xiaohongshu crawler needed by this project.

import asyncio
import io
import sys
from typing import Optional

import cmd_arg
import config
from database import db
from base.base_crawler import AbstractCrawler
from media_platform.xhs import XiaoHongShuCrawler
from tools.async_file_writer import AsyncFileWriter
from var import crawler_type_var

if sys.stdout and hasattr(sys.stdout, "buffer"):
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
if sys.stderr and hasattr(sys.stderr, "buffer"):
    if sys.stderr.encoding and sys.stderr.encoding.lower() != "utf-8":
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


crawler: Optional[AbstractCrawler] = None


async def _generate_wordcloud_if_needed() -> None:
    if config.SAVE_DATA_OPTION not in ("json", "jsonl") or not config.ENABLE_GET_WORDCLOUD:
        return
    file_writer = AsyncFileWriter(platform=config.PLATFORM, crawler_type=crawler_type_var.get())
    await file_writer.generate_wordcloud_from_comments()


async def main() -> None:
    global crawler

    args = await cmd_arg.parse_cmd()
    if args.init_db:
        await db.init_db(args.init_db)
        print(f"Database {args.init_db} initialized successfully.")
        return

    if config.PLATFORM != "xhs":
        raise ValueError("This vendored MediaCrawler subset only supports --platform xhs.")

    crawler = XiaoHongShuCrawler()
    await crawler.start()
    await _generate_wordcloud_if_needed()


async def async_cleanup() -> None:
    global crawler
    if crawler:
        if getattr(crawler, "cdp_manager", None):
            try:
                await crawler.cdp_manager.cleanup(force=True)
            except Exception as error:
                if "closed" not in str(error).lower() and "disconnected" not in str(error).lower():
                    print(f"[Main] Error cleaning up CDP browser: {error}")
        elif getattr(crawler, "browser_context", None):
            try:
                await crawler.browser_context.close()
            except Exception as error:
                if "closed" not in str(error).lower() and "disconnected" not in str(error).lower():
                    print(f"[Main] Error closing browser context: {error}")

    if config.SAVE_DATA_OPTION in ("db", "sqlite"):
        await db.close()


if __name__ == "__main__":
    from tools.app_runner import run

    def _force_stop() -> None:
        current = crawler
        if not current:
            return
        cdp_manager = getattr(current, "cdp_manager", None)
        launcher = getattr(cdp_manager, "launcher", None)
        if launcher:
            try:
                launcher.cleanup()
            except Exception:
                pass

    run(main, async_cleanup, cleanup_timeout_seconds=15.0, on_first_interrupt=_force_stop)
