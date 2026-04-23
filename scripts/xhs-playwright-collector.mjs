#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { chromium } from "playwright";

const XHS_HOST = "www.xiaohongshu.com";
const DEFAULT_USER_DATA_DIR = "sessions/xhs-playwright";
const DEFAULT_CAPTURE_DIR = "data/captures";
const DEFAULT_DELAY_MIN_MS = 9000;
const DEFAULT_DELAY_MAX_MS = 22000;
const DEFAULT_MAX_POSTS = 10;
const DEFAULT_COMMENTS_PER_POST = 80;
const MAX_NETWORK_PAYLOADS = 120;
const MAX_RESPONSE_BYTES = 2_500_000;

const STOP_PATTERNS = [
  /验证码/,
  /安全验证/,
  /访问过于频繁/,
  /操作过于频繁/,
  /环境异常/,
  /滑块/,
  /captcha/i,
  /verify/i
];

const UI_TEXT = new Set([
  "展开",
  "收起",
  "回复",
  "评论",
  "点赞",
  "分享",
  "收藏",
  "登录",
  "关注",
  "更多",
  "查看更多",
  "暂无评论"
]);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (!options.keyword && options.searchUrl) {
    options.keyword = keywordFromSearchUrl(options.searchUrl);
  }

  if (!options.login && !options.keyword && !options.urlsFile) {
    throw new Error("Missing --keyword, --search-url, or --urls-file. Use --help for examples.");
  }

  const session = await openBrowserSession(options);
  try {
    if (options.login) {
      await login(session.context, options);
      return;
    }
    await collect(session.context, options);
  } finally {
    if (!options.keepOpen) {
      await session.close();
    }
  }
}

function parseArgs(argv) {
  const options = {
    keyword: "",
    urlsFile: "",
    searchUrl: "",
    output: "",
    userDataDir: DEFAULT_USER_DATA_DIR,
    cdpEndpoint: "",
    currentPage: false,
    headless: false,
    keepOpen: false,
    login: false,
    engine: "bert",
    maxPosts: DEFAULT_MAX_POSTS,
    commentsPerPost: DEFAULT_COMMENTS_PER_POST,
    searchScrollRounds: 8,
    detailScrollRounds: 8,
    delayMinMs: DEFAULT_DELAY_MIN_MS,
    delayMaxMs: DEFAULT_DELAY_MAX_MS,
    navigationTimeoutMs: 45_000,
    networkPayloadLimit: MAX_NETWORK_PAYLOADS,
    slowMoMs: 0,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const [key, inlineValue] = raw.includes("=") ? raw.split(/=(.*)/s, 2) : [raw, undefined];
    const nextValue = () => inlineValue ?? argv[++index] ?? "";
    switch (key) {
      case "--keyword":
      case "-k":
        options.keyword = decodeText(nextValue());
        break;
      case "--urls-file":
        options.urlsFile = nextValue();
        break;
      case "--search-url":
        options.searchUrl = nextValue();
        break;
      case "--output":
      case "-o":
        options.output = nextValue();
        break;
      case "--user-data-dir":
        options.userDataDir = nextValue();
        break;
      case "--cdp":
      case "--cdp-endpoint":
        options.cdpEndpoint = nextValue();
        break;
      case "--max-posts":
        options.maxPosts = clampNumber(nextValue(), DEFAULT_MAX_POSTS, 1, 100);
        break;
      case "--comments-per-post":
        options.commentsPerPost = clampNumber(nextValue(), DEFAULT_COMMENTS_PER_POST, 0, 80);
        break;
      case "--search-scroll-rounds":
        options.searchScrollRounds = clampNumber(nextValue(), 8, 1, 80);
        break;
      case "--detail-scroll-rounds":
        options.detailScrollRounds = clampNumber(nextValue(), 8, 1, 80);
        break;
      case "--delay-min-ms":
        options.delayMinMs = clampNumber(nextValue(), DEFAULT_DELAY_MIN_MS, 1000, 120_000);
        break;
      case "--delay-max-ms":
        options.delayMaxMs = clampNumber(nextValue(), DEFAULT_DELAY_MAX_MS, 1000, 180_000);
        break;
      case "--engine":
        {
          const value = nextValue();
          options.engine = ["bert", "llm"].includes(value) ? value : "bert";
        }
        break;
      case "--headless":
        options.headless = true;
        break;
      case "--headful":
        options.headless = false;
        break;
      case "--keep-open":
        options.keepOpen = true;
        break;
      case "--current-page":
        options.currentPage = true;
        break;
      case "--login":
        options.login = true;
        break;
      case "--slow-mo-ms":
        options.slowMoMs = clampNumber(nextValue(), 0, 0, 5000);
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${raw}`);
    }
  }

  if (options.delayMaxMs < options.delayMinMs) {
    options.delayMaxMs = options.delayMinMs;
  }
  return options;
}

function printHelp() {
  console.log(`
Xiaohongshu Playwright collector

Examples:
  npm run collect:xhs -- --login
  npm run collect:xhs -- --keyword "咖啡" --max-posts 20 --comments-per-post 80
  npm run collect:xhs -- --urls-file data/note-urls.txt --keyword "咖啡"
  npm run collect:xhs -- --current-page --keyword "咖啡"
  npm run collect:xhs -- --search-url "https://www.xiaohongshu.com/search_result?keyword=..."
  npm run collect:xhs -- --cdp http://127.0.0.1:9222 --keyword "咖啡"

Notes:
  - The default mode is visible Chromium with a persistent profile at sessions/xhs-playwright.
  - Use --login once, complete login manually, then press Enter in the terminal.
  - Use --cdp only when Chrome remote debugging is already enabled by you.
  - The collector stops on obvious verification/rate-limit pages instead of trying to bypass them.
`);
}

async function openBrowserSession(options) {
  if (options.cdpEndpoint) {
    const browser = await chromium.connectOverCDP(options.cdpEndpoint);
    const context = browser.contexts()[0] ?? await browser.newContext(defaultContextOptions());
    context.setDefaultTimeout(options.navigationTimeoutMs);
    return {
      context,
      close: async () => browser.close()
    };
  }

  const userDataDir = path.resolve(options.userDataDir);
  await mkdir(userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...defaultContextOptions(),
    headless: options.headless,
    slowMo: options.slowMoMs
  });
  context.setDefaultTimeout(options.navigationTimeoutMs);
  return {
    context,
    close: async () => context.close()
  };
}

function defaultContextOptions() {
  return {
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    viewport: { width: 1365, height: 900 },
    ignoreHTTPSErrors: true
  };
}

async function login(context, options) {
  const page = await reuseOrCreatePage(context);
  await page.goto("https://www.xiaohongshu.com/explore", {
    waitUntil: "domcontentloaded",
    timeout: options.navigationTimeoutMs
  });
  console.log("Log in manually in the opened browser. Press Enter here after the account home/search page is usable.");
  const rl = readline.createInterface({ input, output });
  try {
    await rl.question("");
  } finally {
    rl.close();
  }
}

async function collect(context, options) {
  const outputPath = path.resolve(options.output || defaultOutputPath(options.keyword || "xhs"));
  await mkdir(path.dirname(outputPath), { recursive: true });

  let sourcePageUrl = options.searchUrl || (options.keyword ? buildSearchUrl(options.keyword) : "");
  const candidates = await loadInitialCandidates(options);
  const warnings = [];
  let searchTitle = "";

  const searchPage = await reuseOrCreatePage(context);
  if (options.keyword) {
    const recorder = attachResponseRecorder(searchPage, options.networkPayloadLimit);
    sourcePageUrl = await openSearchPageForKeyword(searchPage, options, sourcePageUrl);
    searchTitle = await safeTitle(searchPage);
    await assertPageAllowed(searchPage);

    for (let round = 0; round < options.searchScrollRounds && candidates.length < options.maxPosts; round += 1) {
      await expandVisibleText(searchPage);
      const domPosts = await extractDomPosts(searchPage);
      const networkPosts = normalizeNetworkPayloads(recorder.payloads.map((item) => item.payload));
      mergeCandidates(candidates, [...domPosts, ...networkPosts], options.maxPosts * 5);
      console.log(`[search] round=${round + 1} candidates=${candidates.length}`);
      if (candidates.length >= options.maxPosts) {
        break;
      }
      await scrollPage(searchPage);
      await delay(randomDelayMs(options));
      await assertPageAllowed(searchPage);
    }
  }

  if (candidates.length === 0) {
    throw new Error("No post candidates were found. Try a logged-in profile, a smaller keyword, or --urls-file.");
  }

  const capturedPosts = [];
  const detailPage = await context.newPage();
  const detailRecorder = attachResponseRecorder(detailPage, options.networkPayloadLimit);

  for (const candidate of candidates.slice(0, options.maxPosts)) {
    detailRecorder.clear();
    const url = normalizeCandidateUrl(candidate);
    if (!url) {
      continue;
    }

    try {
      console.log(`[detail] ${capturedPosts.length + 1}/${options.maxPosts} ${url}`);
      await detailPage.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: options.navigationTimeoutMs
      });
      await delay(randomDelayMs(options));
      await assertPageAllowed(detailPage);
      await scrollComments(detailPage, options);
      const domPosts = await extractDomPosts(detailPage);
      const networkPosts = normalizeNetworkPayloads(detailRecorder.payloads.map((item) => item.payload));
      const mergedPosts = mergePosts([...networkPosts, ...domPosts]);
      const bestPost = pickBestPost(mergedPosts, candidate);
      if (!bestPost) {
        warnings.push(`No detail payload extracted for ${url}`);
        continue;
      }
      const normalizedPost = normalizeCapturedPost(bestPost, candidate, options.commentsPerPost);
      capturedPosts.push(normalizedPost);
      await writeCapture(outputPath, {
        options,
        sourcePageUrl,
        searchTitle,
        posts: capturedPosts,
        warnings
      });
      console.log(`[detail] captured comments=${normalizedPost.comments.length} totalPosts=${capturedPosts.length}`);
      await delay(randomDelayMs(options));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${url}: ${message}`);
      await writeCapture(outputPath, {
        options,
        sourcePageUrl,
        searchTitle,
        posts: capturedPosts,
        warnings
      });
      if (isStopError(error)) {
        console.warn(`[stop] ${message}`);
        break;
      }
      console.warn(`[warn] ${message}`);
    }
  }

  await detailPage.close();
  await writeCapture(outputPath, {
    options,
    sourcePageUrl,
    searchTitle,
    posts: capturedPosts,
    warnings
  });
  console.log(`[done] posts=${capturedPosts.length} comments=${countComments(capturedPosts)} output=${outputPath}`);
}

async function loadInitialCandidates(options) {
  if (!options.urlsFile) {
    return [];
  }
  const filePath = path.resolve(options.urlsFile);
  const text = await readFile(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((url, index) => {
      const postId = getPostIdFromUrl(url) || `url-${index + 1}`;
      return {
        postId,
        url: normalizePostUrl(url, postId),
        title: "",
        description: "",
        authorHash: "playwright-url-file",
        tags: [],
        comments: []
      };
    });
}

async function writeCapture(outputPath, input) {
  const keyword = input.options.keyword || "小红书";
  const posts = dedupePosts(input.posts).map((post) => ({
    ...post,
    comments: dedupeComments(post.comments || []).slice(0, input.options.commentsPerPost)
  }));
  const capture = {
    keyword,
    engine: input.options.engine,
    maxPosts: input.options.maxPosts,
    commentsPerPost: input.options.commentsPerPost,
    pageUrl: input.sourcePageUrl,
    pageTitle: input.searchTitle,
    capturedAt: new Date().toISOString(),
    captureSource: "playwright",
    collector: {
      name: "xhs-playwright-collector",
      singleThreaded: true,
      delayMinMs: input.options.delayMinMs,
      delayMaxMs: input.options.delayMaxMs
    },
    warnings: input.warnings,
    posts,
    totals: {
      posts: posts.length,
      comments: countComments(posts)
    }
  };
  await writeFile(outputPath, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
}

function attachResponseRecorder(page, limit) {
  const payloads = [];
  page.on("response", async (response) => {
    try {
      const url = response.url();
      if (!url.includes(XHS_HOST)) {
        return;
      }
      const contentType = response.headers()["content-type"] || "";
      if (!contentType.includes("json")) {
        return;
      }
      const text = await response.text();
      if (!text || text.length > MAX_RESPONSE_BYTES) {
        return;
      }
      payloads.push({
        url,
        payload: JSON.parse(text),
        capturedAt: new Date().toISOString()
      });
      while (payloads.length > limit) {
        payloads.shift();
      }
    } catch {
      // Some responses are streaming, cached, or already unavailable. They are not needed.
    }
  });
  return {
    payloads,
    clear() {
      payloads.splice(0, payloads.length);
    }
  };
}

async function openSearchPageForKeyword(page, options, sourcePageUrl) {
  const currentUrl = page.url();
  if (options.currentPage) {
    if (!isXhsSearchPage(currentUrl)) {
      throw new Error(`--current-page requires an opened Xiaohongshu search page. Current URL: ${currentUrl}`);
    }
    console.log(`[search] using current page ${currentUrl}`);
    await waitForSearchResultsReady(page, options.keyword, 8000);
    return currentUrl;
  }

  if (isSearchPageForKeyword(currentUrl, options.keyword)) {
    console.log(`[search] already on keyword page ${currentUrl}`);
    await waitForSearchResultsReady(page, options.keyword, 8000);
    return currentUrl;
  }

  console.log(`[search] ${sourcePageUrl}`);
  await page.goto(sourcePageUrl, {
    waitUntil: "domcontentloaded",
    timeout: options.navigationTimeoutMs
  });
  await waitForSearchResultsReady(page, options.keyword, options.navigationTimeoutMs);
  return page.url();
}

async function waitForSearchResultsReady(page, keyword, timeoutMs) {
  const start = Date.now();
  let lastUrl = page.url();
  while (Date.now() - start < timeoutMs) {
    lastUrl = page.url();
    if (isSearchPageForKeyword(lastUrl, keyword) || (isXhsSearchPage(lastUrl) && await pageHasSearchContent(page))) {
      await delay(900);
      return;
    }
    await delay(300);
  }
  throw new Error(`Keyword search page did not become ready. Current URL: ${lastUrl}`);
}

async function pageHasSearchContent(page) {
  try {
    return await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const links = Array.from(document.querySelectorAll("a[href]"));
      return text.includes("搜索") || links.some((anchor) => /\/(?:explore|discovery\/item|search_result)\//.test(anchor.getAttribute("href") || ""));
    });
  } catch {
    return false;
  }
}

async function extractDomPosts(page) {
  return page.evaluate(() => {
    const currentUrl = location.href;
    const currentPostId = getPostIdFromUrl(currentUrl);
    const posts = [];
    if (currentPostId) {
      posts.push({
        postId: currentPostId,
        url: currentUrl,
        title: cleanText(document.querySelector("h1")?.textContent || document.title.replace(/ - 小红书.*/, "")),
        description: cleanText(document.querySelector("[class*='desc'], [class*='content']")?.textContent || ""),
        authorHash: "playwright-dom-author",
        tags: extractTags(),
        comments: extractDomComments(currentPostId, currentUrl)
      });
    }

    const anchors = Array.from(document.querySelectorAll("a[href]"));
    for (const anchor of anchors) {
      const href = new URL(anchor.getAttribute("href"), location.href).href;
      const postId = getCandidatePostIdFromUrl(href);
      if (!postId) {
        continue;
      }
      posts.push({
        postId,
        url: normalizeExtractedPostUrl(href, postId),
        title: cleanText(anchor.getAttribute("aria-label") || anchor.textContent || "").slice(0, 120),
        description: "",
        authorHash: "playwright-dom-author",
        tags: [],
        comments: []
      });
    }
    return mergePosts(posts);

    function extractDomComments(postId, postUrl) {
      const nodes = getCommentTextNodes();
      const seen = new Set();
      return nodes
        .map((node, index) => ({
          sampleId: `playwright-dom-${postId}-${index}`,
          commentId: `playwright-dom-${postId}-${index}`,
          postId,
          postUrl,
          text: cleanText(node.textContent || ""),
          userHash: "playwright-dom-user",
          commentLevel: 1,
          captureSource: "dom"
        }))
        .filter((comment) => {
          if (!isMeaningfulComment(comment.text) || seen.has(comment.text)) {
            return false;
          }
          seen.add(comment.text);
          return true;
        })
        .slice(0, 120);
    }

    function getCommentTextNodes() {
      const preferred = Array.from(
        document.querySelectorAll(
          "[class*='comment'] [class*='content']:not([class*='author']):not([class*='info']), [class*='comment'] [class*='text'], .comment-item .content"
        )
      );
      if (preferred.length > 0) {
        return preferred;
      }
      return Array.from(document.querySelectorAll("[class*='comment'] span, [class*='comment'] p, .comment-item, .comment-inner-container"));
    }

    function getCandidatePostIdFromUrl(url) {
      return String(url || "").match(/\/(?:explore|discovery\/item|search_result)\/([0-9a-fA-F]{12,32})/)?.[1] || "";
    }

    function getPostIdFromUrl(url) {
      return String(url || "").match(/\/(?:explore|discovery\/item)\/([^/?#]+)/)?.[1] || "";
    }

    function normalizeExtractedPostUrl(rawUrl, postId) {
      try {
        const url = new URL(rawUrl.startsWith("http") ? rawUrl : `https://www.xiaohongshu.com${rawUrl}`);
        if (url.hostname !== "www.xiaohongshu.com") {
          return `https://www.xiaohongshu.com/explore/${postId}`;
        }
        if (url.pathname.startsWith("/search_result/") && url.searchParams.has("xsec_token")) {
          const nextUrl = new URL(`https://www.xiaohongshu.com/explore/${postId}`);
          nextUrl.search = url.search;
          return nextUrl.href;
        }
        return url.href;
      } catch {
        return `https://www.xiaohongshu.com/explore/${postId}`;
      }
    }

    function extractTags() {
      return Array.from(document.querySelectorAll("a, span"))
        .map((node) => cleanText(node.textContent || ""))
        .filter((text) => /^#.{1,30}/.test(text))
        .slice(0, 12);
    }

    function mergePosts(inputPosts) {
      const merged = new Map();
      for (const post of inputPosts) {
        if (!post.postId) {
          continue;
        }
        const existing = merged.get(post.postId);
        if (!existing) {
          merged.set(post.postId, { ...post, comments: dedupeComments(post.comments || []) });
          continue;
        }
        if (post.title && (!existing.title || existing.title === "小红书帖子")) {
          existing.title = post.title;
        }
        existing.description ||= post.description;
        if (shouldPreferPostUrl(post.url, existing.url)) {
          existing.url = post.url;
        }
        existing.comments = dedupeComments([...(existing.comments || []), ...(post.comments || [])]);
      }
      return Array.from(merged.values());
    }

    function shouldPreferPostUrl(nextUrl, currentUrl) {
      return Boolean(nextUrl && (!currentUrl || (!currentUrl.includes("xsec_token=") && nextUrl.includes("xsec_token="))));
    }

    function dedupeComments(comments) {
      const seen = new Set();
      return comments.filter((comment) => {
        const text = cleanText(comment.text);
        if (!text || seen.has(text)) {
          return false;
        }
        seen.add(text);
        comment.text = text;
        return true;
      });
    }

    function isMeaningfulComment(text) {
      const value = cleanText(text);
      if (value.length < 2 || value.length > 300) {
        return false;
      }
      return !/^(展开|收起|回复|评论|点赞|分享|收藏|登录|关注|更多|查看更多|暂无评论)$/.test(value);
    }

    function cleanText(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }
  });
}

async function scrollComments(page, options) {
  let previousCount = 0;
  for (let round = 0; round < options.detailScrollRounds; round += 1) {
    await expandVisibleText(page);
    await page.evaluate(() => {
      const scrollable = Array.from(document.querySelectorAll("div, section, main"))
        .filter((element) => element.scrollHeight > element.clientHeight + 120)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const text = element.textContent || "";
          const score = (text.includes("评论") ? 1000 : 0) + Math.min(element.scrollHeight - element.clientHeight, 2000) + Math.max(rect.height, 0);
          return { element, score };
        })
        .sort((left, right) => right.score - left.score)[0]?.element;
      scrollable?.scrollBy({ top: Math.max(700, scrollable.clientHeight || 700), behavior: "smooth" });
      window.scrollBy({ top: 550, behavior: "smooth" });
    });
    await delay(randomDelayMs(options));
    await assertPageAllowed(page);

    const posts = await extractDomPosts(page);
    const commentCount = countComments(posts);
    if (commentCount >= options.commentsPerPost || (round > 2 && commentCount === previousCount)) {
      break;
    }
    previousCount = commentCount;
  }
}

async function expandVisibleText(page) {
  await page.evaluate(() => {
    const pattern = /(展开|更多|查看.*评论|条回复|show more|more replies)/i;
    const nodes = Array.from(document.querySelectorAll("button, span, div, a"))
      .filter((node) => {
        const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
        if (!pattern.test(text) || text.length > 30) {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .slice(0, 6);
    for (const node of nodes) {
      try {
        node.click();
      } catch {
        // Ignore stale nodes.
      }
    }
  });
}

async function scrollPage(page) {
  await page.evaluate(() => {
    window.scrollBy({ top: Math.max(window.innerHeight * 0.85, 650), behavior: "smooth" });
  });
}

async function assertPageAllowed(page) {
  const result = await page.evaluate(() => {
    const title = document.title || "";
    const text = (document.body?.innerText || "").slice(0, 2500);
    return { title, text, url: location.href };
  });
  const haystack = `${result.title}\n${result.text}\n${result.url}`;
  if (STOP_PATTERNS.some((pattern) => pattern.test(haystack))) {
    const error = new Error("Xiaohongshu showed a verification or rate-limit page. Collection stopped.");
    error.stopCollection = true;
    throw error;
  }
}

function normalizeNetworkPayloads(payloads) {
  const posts = new Map();
  for (const payload of payloads) {
    walk(payload, (node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        return;
      }
      const post = parseNetworkPost(node);
      if (post) {
        const existing = posts.get(post.postId);
        posts.set(post.postId, existing ? mergePost(existing, post) : post);
      }
      const comment = parseNetworkComment(node);
      if (comment) {
        const targetPostId = comment.postId || "";
        if (!targetPostId) {
          return;
        }
        const target = posts.get(targetPostId) || {
          postId: targetPostId,
          url: comment.postUrl || makePostUrl(targetPostId),
          title: "小红书帖子",
          description: "",
          authorHash: "playwright-network-author",
          tags: [],
          comments: []
        };
        target.comments.push(comment);
        posts.set(targetPostId, target);
      }
    });
  }
  return Array.from(posts.values()).map((post) => ({
    ...post,
    comments: dedupeComments(post.comments || [])
  }));
}

function parseNetworkPost(node) {
  const noteCard = node.note_card || node.noteCard || node.note || node;
  const postId = cleanText(node.note_id || node.noteId || noteCard.note_id || noteCard.noteId || noteCard.id || node.id);
  const title = cleanText(noteCard.display_title || noteCard.title || noteCard.name || "");
  const description = cleanText(noteCard.desc || noteCard.description || noteCard.content || noteCard.desc_text || "");
  const xsecToken = cleanText(node.xsec_token || node.xsecToken || noteCard.xsec_token || noteCard.xsecToken || "");
  const xsecSource = cleanText(node.xsec_source || node.xsecSource || noteCard.xsec_source || noteCard.xsecSource || "pc_search");
  const looksLikePost = postId && (title || description) && (
    Object.hasOwn(node, "note_card") ||
    Object.hasOwn(node, "noteCard") ||
    Object.hasOwn(noteCard, "display_title") ||
    Object.hasOwn(noteCard, "interact_info") ||
    String(node.type || "").includes("note")
  );
  if (!looksLikePost) {
    return null;
  }
  return {
    postId,
    url: makePostUrl(postId, { xsecToken, xsecSource }),
    title: title || description.slice(0, 40) || "小红书帖子",
    description,
    authorHash: cleanText(noteCard.user?.user_id || noteCard.user_info?.user_id || "playwright-network-author"),
    tags: [],
    comments: []
  };
}

function parseNetworkComment(node) {
  const text = cleanText(node.content || node.text || node.comment_content || node.content_text || "");
  const commentId = cleanText(node.comment_id || node.commentId || node.id || "");
  const postId = cleanText(node.note_id || node.noteId || node.note?.id || "");
  const looksLikeComment = text && (
    Boolean(commentId) ||
    Object.hasOwn(node, "sub_comments") ||
    Object.hasOwn(node, "subComments") ||
    Object.hasOwn(node, "comment_id") ||
    Object.hasOwn(node, "commentId") ||
    String(node.type || "").includes("comment")
  );
  if (!looksLikeComment || !isMeaningfulComment(text)) {
    return null;
  }
  return {
    sampleId: `playwright-network-${commentId || hashText(text)}`,
    commentId: commentId || hashText(text),
    postId,
    postUrl: postId ? makePostUrl(postId) : "",
    text,
    userHash: cleanText(node.user_info?.user_id || node.user?.id || "playwright-network-user"),
    commentLevel: Number(node.level || node.comment_level || 1) || 1,
    captureSource: "network"
  };
}

function walk(value, visitor, depth = 0) {
  if (depth > 9 || value == null) {
    return;
  }
  visitor(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, visitor, depth + 1);
    }
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      walk(item, visitor, depth + 1);
    }
  }
}

function mergeCandidates(candidates, posts, limit) {
  for (const post of posts) {
    const postId = post.postId || getPostIdFromUrl(post.url);
    if (!postId) {
      continue;
    }
    const normalizedPost = {
      ...post,
      postId,
      url: normalizeCandidateUrl(post)
    };
    const existingIndex = candidates.findIndex((candidate) => (candidate.postId || getPostIdFromUrl(candidate.url)) === postId);
    if (existingIndex >= 0) {
      candidates[existingIndex] = mergePost(candidates[existingIndex], normalizedPost);
      continue;
    }
    candidates.push(normalizedPost);
    if (candidates.length >= limit) {
      break;
    }
  }
}

function mergePosts(posts) {
  const merged = new Map();
  for (const post of posts) {
    if (!post?.postId) {
      continue;
    }
    const existing = merged.get(post.postId);
    if (!existing) {
      merged.set(post.postId, { ...post, comments: dedupeComments(post.comments || []) });
      continue;
    }
    merged.set(post.postId, mergePost(existing, post));
  }
  return Array.from(merged.values());
}

function mergePost(left, right) {
  return {
    ...left,
    title: right.title && (!left.title || left.title === "小红书帖子") ? right.title : left.title,
    description: left.description || right.description,
    url: shouldPreferPostUrl(right.url, left.url) ? right.url : left.url,
    authorHash: left.authorHash || right.authorHash,
    tags: Array.from(new Set([...(left.tags || []), ...(right.tags || [])])).slice(0, 12),
    comments: dedupeComments([...(left.comments || []), ...(right.comments || [])])
  };
}

function pickBestPost(posts, candidate) {
  const postId = String(candidate.postId || getPostIdFromUrl(candidate.url || ""));
  const exact = posts.find((post) => post.postId === postId);
  if (exact) {
    return exact;
  }
  return posts
    .filter((post) => (post.comments || []).length > 0)
    .sort((left, right) => (right.comments?.length || 0) - (left.comments?.length || 0))[0] || posts[0] || null;
}

function normalizeCapturedPost(post, candidate, commentsPerPost) {
  const postId = post.postId || candidate.postId || getPostIdFromUrl(post.url || candidate.url || "");
  const url = normalizeCandidateUrl({ ...candidate, ...post, postId });
  return {
    postId,
    url,
    title: cleanText(post.title || candidate.title || "小红书帖子").slice(0, 160),
    description: cleanText(post.description || candidate.description || "").slice(0, 500),
    authorHash: cleanText(post.authorHash || candidate.authorHash || "playwright-author").slice(0, 80),
    tags: Array.isArray(post.tags) ? post.tags.map((tag) => cleanText(tag)).filter(Boolean).slice(0, 12) : [],
    comments: dedupeComments(post.comments || []).slice(0, commentsPerPost).map((comment, index) => ({
      sampleId: cleanText(comment.sampleId) || `playwright-${postId}-${index}`,
      commentId: cleanText(comment.commentId) || hashText(`${postId}:${comment.text}:${index}`),
      postId,
      postUrl: url,
      text: cleanText(comment.text).slice(0, 300),
      userHash: cleanText(comment.userHash || "playwright-user").slice(0, 80),
      commentLevel: clampNumber(comment.commentLevel, 1, 1, 5),
      captureSource: comment.captureSource === "network" ? "network" : "dom"
    }))
  };
}

function dedupePosts(posts) {
  return mergePosts(posts);
}

function dedupeComments(comments) {
  const seen = new Set();
  const result = [];
  for (const comment of comments) {
    const text = cleanText(comment?.text);
    if (!isMeaningfulComment(text) || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push({ ...comment, text });
  }
  return result;
}

function isMeaningfulComment(text) {
  const value = cleanText(text);
  return value.length >= 2 && value.length <= 300 && !UI_TEXT.has(value);
}

function normalizeCandidateUrl(candidate) {
  const rawUrl = String(candidate?.url || "");
  const postId = String(candidate?.postId || getPostIdFromUrl(rawUrl) || "").trim();
  if (!postId && !rawUrl) {
    return "";
  }
  return normalizePostUrl(rawUrl || makePostUrl(postId), postId);
}

function normalizePostUrl(rawUrl, postId) {
  const fallback = makePostUrl(postId);
  try {
    const url = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${XHS_HOST}${rawUrl}`);
    if (url.hostname !== XHS_HOST) {
      return fallback;
    }
    if (url.pathname.startsWith("/search_result/") && url.searchParams.has("xsec_token")) {
      const nextUrl = new URL(`https://${XHS_HOST}/explore/${postId}`);
      nextUrl.search = url.search;
      return nextUrl.href;
    }
    return url.href;
  } catch {
    return fallback;
  }
}

function makePostUrl(postId, params = {}) {
  const url = new URL(`https://${XHS_HOST}/explore/${postId}`);
  if (params.xsecToken) {
    url.searchParams.set("xsec_token", params.xsecToken);
  }
  if (params.xsecSource) {
    url.searchParams.set("xsec_source", params.xsecSource);
  }
  return url.href;
}

function getPostIdFromUrl(url) {
  return String(url || "").match(/\/(?:explore|discovery\/item|search_result)\/([^/?#]+)/)?.[1] || "";
}

function shouldPreferPostUrl(nextUrl, currentUrl) {
  return Boolean(nextUrl && (!currentUrl || (!currentUrl.includes("xsec_token=") && nextUrl.includes("xsec_token="))));
}

function buildSearchUrl(keyword) {
  return `https://${XHS_HOST}/search_result?keyword=${encodeURIComponent(keyword)}&source=web_search_result_notes`;
}

function isSearchPageForKeyword(pageUrl, keyword) {
  try {
    const url = new URL(pageUrl);
    if (!isXhsSearchPage(url.href)) {
      return false;
    }
    const pageKeyword = decodeText(url.searchParams.get("keyword") || "").replace(/\+/g, " ");
    return !keyword || pageKeyword === keyword;
  } catch {
    return false;
  }
}

function isXhsSearchPage(pageUrl) {
  try {
    const url = new URL(pageUrl);
    return url.hostname === XHS_HOST && url.pathname.startsWith("/search_result");
  } catch {
    return false;
  }
}

function keywordFromSearchUrl(pageUrl) {
  try {
    return decodeText(new URL(pageUrl).searchParams.get("keyword") || "").replace(/\+/g, " ");
  } catch {
    return "";
  }
}

function defaultOutputPath(keyword) {
  const safeKeyword = String(keyword || "xhs").replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40) || "xhs";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(DEFAULT_CAPTURE_DIR, `xhs-playwright-${safeKeyword}-${stamp}.json`);
}

async function reuseOrCreatePage(context) {
  const existing = context.pages().find((page) => !page.isClosed());
  if (existing) {
    return existing;
  }
  return context.newPage();
}

async function safeTitle(page) {
  try {
    return await page.title();
  } catch {
    return "";
  }
}

function randomDelayMs(options) {
  const min = options.delayMinMs;
  const max = options.delayMaxMs;
  return Math.round(min + Math.random() * (max - min));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(number)));
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decodeText(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function hashText(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function countComments(posts) {
  return posts.reduce((sum, post) => sum + (Array.isArray(post.comments) ? post.comments.length : 0), 0);
}

function isStopError(error) {
  return Boolean(error && typeof error === "object" && error.stopCollection);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
