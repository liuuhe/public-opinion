const DEFAULT_STATUS = {
  running: false,
  phase: "idle",
  message: "等待开始自动采集。",
  discoveredPosts: 0,
  targetPosts: 0,
  currentIndex: 0,
  capturedPosts: 0,
  capturedComments: 0,
  warnings: [],
  result: null,
  reportUrl: "",
  error: "",
  paused: false
};

let taskStatus = { ...DEFAULT_STATUS };
let taskCancelled = false;
let taskPaused = false;
let latestTaskOptions = null;
let latestSearchCapture = null;
let latestCapturedPosts = [];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "XHS_AUTO_CAPTURE_START") {
    if (taskStatus.running) {
      sendResponse({ ok: false, status: taskStatus, error: "已有自动采集任务正在运行。" });
      return false;
    }
    taskCancelled = false;
    taskPaused = false;
    latestTaskOptions = message.options || {};
    latestSearchCapture = null;
    latestCapturedPosts = [];
    void runAutoCapture(message.options || {});
    sendResponse({ ok: true, status: taskStatus });
    return false;
  }

  if (message?.type === "XHS_AUTO_CAPTURE_STATUS") {
    sendResponse({ ok: true, status: taskStatus });
    return false;
  }

  if (message?.type === "XHS_AUTO_CAPTURE_CANCEL") {
    taskCancelled = true;
    updateStatus({ running: false, phase: "cancelled", message: "自动采集已取消。" });
    sendResponse({ ok: true, status: taskStatus });
    return false;
  }

  if (message?.type === "XHS_AUTO_CAPTURE_PAUSE") {
    if (!taskStatus.running) {
      sendResponse({ ok: false, status: taskStatus, error: "当前没有正在运行的自动采集任务。" });
      return false;
    }
    taskPaused = true;
    updateStatus({ paused: true, phase: "paused", message: "自动采集已暂停。点击继续后从下一篇帖子开始。" });
    sendResponse({ ok: true, status: taskStatus });
    return false;
  }

  if (message?.type === "XHS_AUTO_CAPTURE_RESUME") {
    if (!taskStatus.running) {
      sendResponse({ ok: false, status: taskStatus, error: "当前没有正在运行的自动采集任务。" });
      return false;
    }
    taskPaused = false;
    updateStatus({ paused: false, phase: "capturing", message: "自动采集已继续。" });
    sendResponse({ ok: true, status: taskStatus });
    return false;
  }

  if (message?.type === "XHS_AUTO_CAPTURE_ANALYZE_PARTIAL") {
    void analyzePausedCapture().then(sendResponse).catch((error) => {
      sendResponse({
        ok: false,
        status: taskStatus,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return true;
  }

  if (message?.type === "XHS_AUTO_CAPTURE_EXPORT") {
    const capture = buildLatestCaptureExport();
    if (!capture.posts.length) {
      sendResponse({ ok: false, status: taskStatus, error: "当前还没有可导出的采集数据。" });
      return false;
    }
    sendResponse({ ok: true, status: taskStatus, capture });
    return false;
  }

  return false;
});

async function runAutoCapture(options) {
  const targetPosts = clampNumber(options.maxPosts, 10, 1, 30);
  const commentsPerPost = clampNumber(options.commentsPerPost, 20, 0, 80);
  const captureDelay = readDelayRange(options);
  updateStatus({
    ...DEFAULT_STATUS,
    running: true,
    phase: "discovering",
    message: "正在从当前搜索页提取帖子链接和 xsec_token。",
    targetPosts,
    concurrency: 1,
    delayMinMs: captureDelay.minMs,
    delayMaxMs: captureDelay.maxMs
  });

  let activeTabId = 0;
  let searchCapture = null;
  let candidates = [];
  let assignedPosts = 0;
  const candidateQueue = [];
  const queuedCandidateKeys = new Set();
  const capturedPosts = [];
  const visitedCandidateKeys = new Set();

  try {
    activeTabId = Number(options.activeTabId);
    if (!activeTabId) {
      throw new Error("没有可用的小红书标签页。");
    }

    const keyword = decodeText(options.keyword || "");
    if (keyword) {
      updateStatus({
        phase: "searching",
        message: `正在打开关键词「${keyword}」的小红书搜索结果页。`
      });
      await openSearchPageForKeyword(activeTabId, keyword);
    }

    searchCapture = await discoverCandidates(activeTabId, Math.min(5, targetPosts));
    latestSearchCapture = searchCapture;
    enqueueCandidates(candidateQueue, queuedCandidateKeys, searchCapture?.posts || [], targetPosts);
    candidates = candidateQueue.slice();

    if (candidates.length === 0) {
      throw new Error(buildDiscoveryError(searchCapture));
    }

    updateStatus({
      phase: "capturing",
      message: `已发现 ${candidates.length} 篇帖子，开始单线程逐帖采集评论。`,
      discoveredPosts: candidates.length
    });

    await capturePostsSequentially();

    if (capturedPosts.length === 0) {
      throw new Error("没有采集到可分析帖子。请确认小红书已登录，并打开搜索结果页重试。");
    }

    updateStatus({
      phase: "analyzing",
      message: `已采集 ${capturedPosts.length} 篇帖子、${taskStatus.capturedComments} 条评论，正在发送 Worker 分析。`
    });
    await waitWhilePaused();

    const result = await analyzeCapturedPosts(options, searchCapture, capturedPosts.slice(0, targetPosts));
    updateStatus({
      running: false,
      phase: "completed",
      message: "自动采集和分析完成。",
      result,
      reportUrl: result.savedReport?.url || ""
    });

    if (result.savedReport?.url) {
      await chrome.tabs.create({ url: result.savedReport.url, active: true });
    }
  } catch (error) {
    updateStatus({
      running: false,
      phase: "failed",
      message: error instanceof Error ? error.message : "自动采集失败",
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    // The active Xiaohongshu search tab is intentionally kept open for the user.
  }

  async function capturePostsSequentially() {
    while (assignedPosts < targetPosts) {
      if (taskCancelled) {
        throw new Error("自动采集已取消。");
      }
      await waitWhilePaused();

      const nextTask = await takeNextCandidate();
      if (!nextTask) {
        return;
      }
      const { candidate, postIndex } = nextTask;

      updateStatus({
        currentIndex: postIndex,
        discoveredPosts: Math.max(taskStatus.discoveredPosts, queuedCandidateKeys.size),
        message: `正在后台打开第 ${postIndex}/${targetPosts} 篇：${candidate.title || candidate.url}`
      });
      await waitWhilePaused();

      const capture = await capturePostInBackgroundTab({
        candidate,
        maxComments: commentsPerPost,
        captureDelay
      });
      const bestPost = pickBestPost(capture?.posts || [], candidate);
      if (!bestPost) {
        taskStatus.warnings.push(`第 ${postIndex} 篇未采集到帖子内容：${candidate.url}`);
        await delay(350);
        continue;
      }

      if (capturedPosts.length < targetPosts) {
        capturedPosts.push({
          ...candidate,
          ...bestPost,
          url: bestPost.url || candidate.url,
          title: bestPost.title || candidate.title || "小红书帖子",
          comments: (bestPost.comments || []).slice(0, commentsPerPost)
        });
        latestCapturedPosts = capturedPosts.slice();
      }

      updateStatus({
        capturedPosts: capturedPosts.length,
        capturedComments: capturedPosts.reduce((sum, post) => sum + (post.comments?.length || 0), 0)
      });
      if ((bestPost.comments || []).length === 0) {
        taskStatus.warnings.push(`第 ${postIndex} 篇没有采集到评论，可能评论区未加载或该帖无评论。`);
      }
      if (assignedPosts < targetPosts) {
        const waitMs = randomDelayMs(captureDelay);
        updateStatus({
          message: `第 ${postIndex}/${targetPosts} 篇采集完成，随机等待 ${(waitMs / 1000).toFixed(1)} 秒后继续。`
        });
        await interruptibleDelay(waitMs);
      }
    }
  }

  async function takeNextCandidate() {
    if (assignedPosts >= targetPosts) {
      return null;
    }

    while (candidateQueue.length === 0 && assignedPosts < targetPosts) {
      searchCapture = await discoverCandidates(activeTabId, Math.min(targetPosts, capturedPosts.length + 3), { light: true });
      latestSearchCapture = searchCapture;
      enqueueCandidates(
        candidateQueue,
        queuedCandidateKeys,
        searchCapture?.posts || [],
        targetPosts - assignedPosts - candidateQueue.length
      );
      candidates = Array.from(queuedCandidateKeys);
      if (candidateQueue.length === 0) {
        taskStatus.warnings.push(`当前搜索页只找到 ${capturedPosts.length} 篇可采集的帖子。`);
        return null;
      }
    }

    while (candidateQueue.length > 0) {
      const candidate = candidateQueue.shift();
      const candidateKey = getCandidateKey(candidate);
      if (!candidateKey || visitedCandidateKeys.has(candidateKey)) {
        continue;
      }
      visitedCandidateKeys.add(candidateKey);
      assignedPosts += 1;
      return { candidate, postIndex: assignedPosts };
    }
    return null;
  }
}

async function discoverCandidates(activeTabId, minPosts, options = {}) {
  return sendCaptureMessage(activeTabId, {
    type: "XHS_CAPTURE_SEARCH_SCROLL_AND_GET",
    enableNetwork: true,
    delayMs: options.light ? 450 : 650,
    minPosts
  });
}

async function analyzePausedCapture() {
  if (!taskStatus.running || !taskPaused) {
    throw new Error("只有自动采集暂停时才能发送阶段性分析。");
  }
  const posts = latestCapturedPosts.slice();
  if (posts.length === 0) {
    throw new Error("当前还没有采集到可分析的帖子。");
  }
  updateStatus({
    message: `自动采集已暂停，正在发送已采集的 ${posts.length} 篇帖子做阶段性分析。`
  });
  const result = await analyzeCapturedPosts(latestTaskOptions || {}, latestSearchCapture, posts);
  updateStatus({
    result,
    reportUrl: result.savedReport?.url || "",
    message: "阶段性分析完成。自动采集仍处于暂停状态，可继续采集。"
  });
  if (result.savedReport?.url) {
    await chrome.tabs.create({ url: result.savedReport.url, active: true });
  }
  return { ok: true, status: taskStatus, result };
}

function buildLatestCaptureExport() {
  const options = latestTaskOptions || {};
  const posts = latestCapturedPosts.slice();
  const keyword = decodeText(options.keyword || latestSearchCapture?.keywordGuess || "小红书");
  const commentsPerPost = clampNumber(options.commentsPerPost, 20, 0, 80);
  return {
    ok: true,
    source: "browser-extension",
    keyword,
    engine: options.engine || "llm",
    maxPosts: clampNumber(options.maxPosts, 10, 1, 30),
    commentsPerPost,
    concurrency: 1,
    delayMinMs: clampNumber(options.delayMinMs, 1200, 0, 15000),
    delayMaxMs: clampNumber(options.delayMaxMs, 3000, 0, 15000),
    pageUrl: latestSearchCapture?.pageUrl || "",
    pageTitle: latestSearchCapture?.pageTitle || "",
    capturedAt: new Date().toISOString(),
    networkPayloadCount: latestSearchCapture?.networkPayloadCount || 0,
    posts,
    totals: {
      posts: posts.length,
      comments: posts.reduce((sum, post) => sum + (post.comments?.length || 0), 0)
    }
  };
}

async function openSearchPageForKeyword(activeTabId, keyword) {
  const tab = await chrome.tabs.get(activeTabId);
  const currentUrl = tab.url || "";
  if (isSearchPageForKeyword(currentUrl, keyword)) {
    return;
  }

  await chrome.tabs.update(activeTabId, {
    url: buildSearchUrl(keyword)
  });
  await waitForSearchTabReady(activeTabId, keyword, 18000);
  await delay(900);
}

function isSearchPageForKeyword(tabUrl, keyword) {
  try {
    const url = new URL(tabUrl);
    if (url.hostname !== "www.xiaohongshu.com" || !url.pathname.startsWith("/search_result")) {
      return false;
    }
    return decodeText(url.searchParams.get("keyword") || "") === keyword;
  } catch {
    return false;
  }
}

function buildSearchUrl(keyword) {
  const url = new URL("https://www.xiaohongshu.com/search_result");
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("source", "web_search_result_notes");
  return url.href;
}

async function waitForSearchTabReady(tabId, keyword, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && isSearchPageForKeyword(tab.url || "", keyword)) {
      return;
    }
    await delay(300);
  }
  throw new Error("关键词搜索页打开超时，请确认小红书页面可以正常访问。");
}

function enqueueCandidates(queue, seen, posts, limit = Infinity) {
  if (limit <= 0) {
    return;
  }
  for (const post of filterCandidatePosts(posts || [])) {
    const key = getCandidateKey(post);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    queue.push(post);
    if (queue.length >= limit) {
      return;
    }
  }
}

async function waitWhilePaused() {
  while (taskPaused) {
    if (taskCancelled) {
      throw new Error("自动采集已取消。");
    }
    await delay(300);
  }
}

async function capturePostInBackgroundTab({ candidate, maxComments, captureDelay }) {
  const url = normalizeCandidateUrl(candidate);
  if (!url) {
    throw new Error(`帖子 URL 无效：${candidate.postId || candidate.url || ""}`);
  }

  let tab = null;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    await waitForTabReady(tab.id, 18000);
    await interruptibleDelay(randomDelayMs(captureDelay));
    const capture = await sendCaptureMessage(tab.id, {
      type: "XHS_CAPTURE_SCROLL_AND_GET",
      enableNetwork: true,
      maxComments,
      scrollRounds: maxComments > 30 ? 5 : 4,
      scrollDelayMs: 520
    });
    const bestPost = pickBestPost(capture?.posts || [], candidate);
    return {
      ...capture,
      posts: bestPost ? [bestPost] : capture?.posts || []
    };
  } finally {
    if (tab?.id) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        // The user or browser may already have closed the tab.
      }
    }
  }
}

async function waitForTabReady(tabId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && /^https:\/\/www\.xiaohongshu\.com\//.test(tab.url || "")) {
      return;
    }
    await delay(300);
  }
}

function normalizeCandidateUrl(candidate) {
  const url = String(candidate.url || "");
  if (/^https:\/\/www\.xiaohongshu\.com\/(?:explore|discovery\/item)\//.test(url)) {
    return url;
  }
  const searchMatch = url.match(/^https:\/\/www\.xiaohongshu\.com\/search_result\/([^/?#]+)(\?[^#]*)?/);
  if (searchMatch && url.includes("xsec_token=")) {
    return `https://www.xiaohongshu.com/explore/${searchMatch[1]}${searchMatch[2] || ""}`;
  }
  const postId = String(candidate.postId || "").trim();
  if (!postId) {
    return "";
  }
  const nextUrl = new URL(`https://www.xiaohongshu.com/explore/${postId}`);
  if (candidate.xsecToken) {
    nextUrl.searchParams.set("xsec_token", candidate.xsecToken);
  }
  nextUrl.searchParams.set("xsec_source", candidate.xsecSource || "pc_search");
  return nextUrl.href;
}

function buildDiscoveryError(searchCapture) {
  const url = searchCapture?.pageUrl || "";
  const title = searchCapture?.pageTitle || "";
  const networkCount = searchCapture?.networkPayloadCount ?? 0;
  return [
    "当前搜索页没有提取到帖子链接。",
    "请确认页面是小红书搜索结果页、账号已登录，并轻微滚动后重试。",
    url ? `当前 URL：${url}` : "",
    title ? `页面标题：${title}` : "",
    `网络包：${networkCount}`
  ].filter(Boolean).join("\n");
}

async function analyzeCapturedPosts(options, searchCapture, posts) {
  const workerUrl = String(options.workerUrl || "").replace(/\/+$/, "");
  if (!workerUrl) {
    throw new Error("请先配置 Worker 地址。");
  }

  return postAnalysisWithRetry(workerUrl, {
    keyword: decodeText(options.keyword || searchCapture?.keywordGuess || "小红书"),
    engine: options.engine || "llm",
    maxPosts: clampNumber(options.maxPosts, 10, 1, 30),
    commentsPerPost: clampNumber(options.commentsPerPost, 20, 0, 80),
    pageUrl: searchCapture?.pageUrl || "",
    sourcePageUrl: searchCapture?.pageUrl || "",
    persistReport: true,
    posts
  });
}

async function postAnalysisWithRetry(workerUrl, body) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      if (attempt > 1) {
        updateStatus({ message: "首次分析请求较慢或失败，正在自动重试一次。" });
      }
      return await fetchAnalysisJson(workerUrl, body, 60000);
    } catch (error) {
      lastError = error;
      if (attempt >= 2 || !isRetryableError(error)) {
        throw error;
      }
      await delay(1200);
    }
  }
  throw lastError || new Error("分析失败。");
}

async function fetchAnalysisJson(workerUrl, body, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${workerUrl}/api/analyze/captured`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(body)
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error([payload.error, payload.details].filter(Boolean).join("："));
      error.status = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("Worker 响应超时。");
      timeoutError.retryable = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryableError(error) {
  if (error?.retryable) {
    return true;
  }
  if (error?.status && [502, 503, 504].includes(error.status)) {
    return true;
  }
  return /Failed to fetch|NetworkError|timeout|超时|Worker 响应超时/i.test(String(error?.message || error));
}

async function sendCaptureMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await delay(500);
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function pickBestPost(posts, candidate) {
  const candidateId = String(candidate.postId || "").trim();
  const exact = posts.find((post) => post.postId === candidateId);
  if (exact) {
    return exact;
  }
  const withComments = posts
    .filter((post) => (post.comments || []).length > 0)
    .sort((left, right) => (right.comments?.length || 0) - (left.comments?.length || 0));
  return withComments[0] || posts[0] || null;
}

function filterCandidatePosts(posts) {
  return dedupePosts(posts)
    .filter((post) => /^https:\/\/www\.xiaohongshu\.com\//.test(post.url || ""))
    .filter((post) => post.postId || post.url)
    .filter((post) => !/当前页|登录|通知|发布/.test(String(post.title || "")));
}

function dedupePosts(posts) {
  const seen = new Set();
  const results = [];
  for (const post of posts) {
    const key = getCandidateKey(post);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(post);
  }
  return results;
}

function getCandidateKey(post) {
  return String(post?.postId || post?.url || "").trim();
}

function updateStatus(patch) {
  taskStatus = {
    ...taskStatus,
    ...patch,
    updatedAt: new Date().toISOString()
  };
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function readDelayRange(options) {
  const minMs = clampNumber(options.delayMinMs, 1200, 0, 15000);
  const maxMs = clampNumber(options.delayMaxMs, 3000, 0, 15000);
  return {
    minMs: Math.min(minMs, maxMs),
    maxMs: Math.max(minMs, maxMs)
  };
}

function randomDelayMs(range) {
  const minMs = range?.minMs ?? 1200;
  const maxMs = range?.maxMs ?? 3000;
  if (maxMs <= minMs) {
    return minMs;
  }
  return Math.round(minMs + Math.random() * (maxMs - minMs));
}

async function interruptibleDelay(ms) {
  const endAt = Date.now() + Math.max(0, ms);
  while (Date.now() < endAt) {
    if (taskCancelled) {
      throw new Error("自动采集已取消。");
    }
    await waitWhilePaused();
    await delay(Math.min(300, endAt - Date.now()));
  }
}

function decodeText(value) {
  let decoded = String(value || "");
  for (let index = 0; index < 2; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        break;
      }
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded.trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
