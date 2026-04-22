const DEFAULT_WORKER_URL = "https://opinion.liuhe.me";

const elements = {
  workerUrl: document.querySelector("#workerUrl"),
  keyword: document.querySelector("#keyword"),
  maxPosts: document.querySelector("#maxPosts"),
  commentsPerPost: document.querySelector("#commentsPerPost"),
  delayMinSeconds: document.querySelector("#delayMinSeconds"),
  delayMaxSeconds: document.querySelector("#delayMaxSeconds"),
  engine: document.querySelector("#engine"),
  captureBtn: document.querySelector("#captureBtn"),
  autoCaptureBtn: document.querySelector("#autoCaptureBtn"),
  pauseBtn: document.querySelector("#pauseBtn"),
  exportBtn: document.querySelector("#exportBtn"),
  analyzeBtn: document.querySelector("#analyzeBtn"),
  status: document.querySelector("#status"),
  result: document.querySelector("#result")
};

let currentCapture = null;
let statusTimer = null;
let lastAutoStatus = null;

loadSettings();
void refreshAutoStatus();

elements.captureBtn.addEventListener("click", () => void captureCurrentTab());
elements.autoCaptureBtn.addEventListener("click", () => void startAutoCapture());
elements.pauseBtn.addEventListener("click", () => void toggleAutoPause());
elements.exportBtn.addEventListener("click", () => void exportCaptureData());
elements.analyzeBtn.addEventListener("click", () => void analyzeCapture());

for (const key of ["workerUrl", "keyword", "maxPosts", "commentsPerPost", "delayMinSeconds", "delayMaxSeconds", "engine"]) {
  elements[key].addEventListener("change", saveSettings);
}

async function loadSettings() {
  const saved = await chrome.storage.sync.get({
    workerUrl: DEFAULT_WORKER_URL,
    keyword: "",
    maxPosts: 10,
    commentsPerPost: 20,
    delayMinMs: 1200,
    delayMaxMs: 3000,
    engine: "llm"
  });
  elements.workerUrl.value = saved.workerUrl;
  elements.keyword.value = saved.keyword;
  elements.maxPosts.value = saved.maxPosts;
  elements.commentsPerPost.value = saved.commentsPerPost;
  elements.delayMinSeconds.value = formatSeconds(saved.delayMinMs);
  elements.delayMaxSeconds.value = formatSeconds(saved.delayMaxMs);
  elements.engine.value = saved.engine;
}

function saveSettings() {
  const limits = readLimits();
  void chrome.storage.sync.set({
    workerUrl: elements.workerUrl.value.trim() || DEFAULT_WORKER_URL,
    keyword: elements.keyword.value.trim(),
    maxPosts: limits.maxPosts,
    commentsPerPost: limits.commentsPerPost,
    delayMinMs: limits.delayMinMs,
    delayMaxMs: limits.delayMaxMs,
    engine: elements.engine.value
  });
}

async function captureCurrentTab() {
  setStatus("正在读取当前小红书标签页...");
  elements.analyzeBtn.disabled = true;
  elements.result.hidden = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/www\.xiaohongshu\.com\//.test(tab.url || "")) {
    setStatus("请先切换到已登录的小红书搜索页或帖子详情页。");
    return;
  }

  try {
    currentCapture = await chrome.tabs.sendMessage(tab.id, { type: "XHS_CAPTURE_GET" });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    currentCapture = await chrome.tabs.sendMessage(tab.id, { type: "XHS_CAPTURE_GET" });
  }

  if (!currentCapture?.ok) {
    setStatus("采集失败，请刷新小红书页面后重试。");
    return;
  }
  currentCapture = limitCapture(currentCapture, readLimits());

  if (!elements.keyword.value.trim()) {
    elements.keyword.value = currentCapture.keywordGuess || "";
    saveSettings();
  }

  elements.analyzeBtn.disabled = currentCapture.totals.comments === 0;
  elements.exportBtn.disabled = currentCapture.totals.posts === 0;
  setStatus(
    `已采集当前页。\n帖子：${currentCapture.totals.posts}\n评论：${currentCapture.totals.comments}\n网络包：${currentCapture.networkPayloadCount}\n${
      currentCapture.totals.comments === 0 ? "未采集到评论，请打开帖子详情页并滚动评论区后重试。" : "可以发送到 Worker 分析。"
    }`
  );
}

async function startAutoCapture() {
  saveSettings();
  setStatus("正在启动自动逐帖采集...");
  elements.autoCaptureBtn.disabled = true;
  elements.captureBtn.disabled = true;
  elements.pauseBtn.disabled = true;
  elements.exportBtn.disabled = true;
  elements.analyzeBtn.disabled = true;
  elements.result.hidden = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/www\.xiaohongshu\.com\//.test(tab.url || "")) {
    setStatus("请先切换到已登录的小红书搜索页。");
    elements.autoCaptureBtn.disabled = false;
    elements.captureBtn.disabled = false;
    elements.pauseBtn.disabled = true;
    elements.exportBtn.disabled = !hasExportableData();
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "XHS_AUTO_CAPTURE_START",
    options: {
      activeTabId: tab.id,
      workerUrl: elements.workerUrl.value.trim() || DEFAULT_WORKER_URL,
      keyword: decodeText(elements.keyword.value.trim()),
      ...readLimits(),
      engine: elements.engine.value
    }
  });
  if (!response?.ok) {
    setStatus(response?.error || "自动采集启动失败。");
    elements.autoCaptureBtn.disabled = false;
    elements.captureBtn.disabled = false;
    elements.pauseBtn.disabled = true;
    elements.exportBtn.disabled = !hasExportableData();
    return;
  }
  renderAutoStatus(response.status);
  startStatusPolling();
}

async function toggleAutoPause() {
  const paused = Boolean(lastAutoStatus?.paused);
  const response = await chrome.runtime.sendMessage({
    type: paused ? "XHS_AUTO_CAPTURE_RESUME" : "XHS_AUTO_CAPTURE_PAUSE"
  });
  if (!response?.ok) {
    setStatus(response?.error || "暂停状态切换失败。");
    return;
  }
  renderAutoStatus(response.status);
}

async function analyzeCapture() {
  if (lastAutoStatus?.running && lastAutoStatus.paused) {
    await analyzePausedAutoCapture();
    return;
  }

  if (!currentCapture) {
    setStatus("请先采集当前页。");
    return;
  }
  const workerUrl = elements.workerUrl.value.trim().replace(/\/+$/, "");
  const keyword = decodeText(elements.keyword.value.trim() || currentCapture.keywordGuess || "小红书");
  const limits = readLimits();
  const capture = limitCapture(currentCapture, limits);

  elements.analyzeBtn.disabled = true;

  try {
    const payload = await postAnalysisWithRetry({
      workerUrl,
      body: {
        keyword,
        engine: elements.engine.value,
        maxPosts: limits.maxPosts,
        commentsPerPost: limits.commentsPerPost,
        concurrency: 1,
        delayMinMs: limits.delayMinMs,
        delayMaxMs: limits.delayMaxMs,
        pageUrl: capture.pageUrl,
        posts: capture.posts
      },
      onProgress: setStatus
    });
    renderResult(payload);
    setStatus("分析完成。");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "分析失败");
  } finally {
    elements.analyzeBtn.disabled = false;
  }
}

async function analyzePausedAutoCapture() {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    setStatus(`正在发送暂停状态下已采集的帖子做分析，已等待 ${elapsed} 秒...`);
  }, 1000);
  setStatus("正在发送暂停状态下已采集的帖子做分析...");
  elements.analyzeBtn.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AUTO_CAPTURE_ANALYZE_PARTIAL" });
    if (!response?.ok) {
      throw new Error(response?.error || "阶段性分析失败。");
    }
    renderAutoStatus(response.status);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "阶段性分析失败。");
  } finally {
    clearInterval(timer);
    elements.analyzeBtn.disabled = false;
  }
}

async function exportCaptureData() {
  try {
    const autoCapture = await getAutoCaptureForExport();
    const capture = autoCapture || buildCurrentCaptureExport();
    if (!capture?.posts?.length) {
      setStatus("当前没有可导出的采集数据，请先采集。");
      return;
    }
    const filename = `xhs-opinion-${safeFilename(capture.keyword || "小红书")}-${formatTimestamp(new Date())}-capture.json`;
    downloadJson(capture, filename);
    setStatus(`已导出 ${capture.posts.length} 篇帖子、${capture.totals?.comments || 0} 条评论。`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "导出失败。");
  }
}

async function getAutoCaptureForExport() {
  if (!lastAutoStatus || (lastAutoStatus.capturedPosts || 0) <= 0) {
    return null;
  }
  const response = await chrome.runtime.sendMessage({ type: "XHS_AUTO_CAPTURE_EXPORT" });
  return response?.ok ? response.capture : null;
}

function buildCurrentCaptureExport() {
  if (!currentCapture) {
    return null;
  }
  const limits = readLimits();
  const capture = limitCapture(currentCapture, limits);
  return {
    ok: true,
    source: "browser-extension",
    keyword: decodeText(elements.keyword.value.trim() || capture.keywordGuess || "小红书"),
    engine: elements.engine.value,
    maxPosts: limits.maxPosts,
    commentsPerPost: limits.commentsPerPost,
    concurrency: 1,
    delayMinMs: limits.delayMinMs,
    delayMaxMs: limits.delayMaxMs,
    pageUrl: capture.pageUrl,
    pageTitle: capture.pageTitle,
    capturedAt: new Date().toISOString(),
    networkPayloadCount: capture.networkPayloadCount || 0,
    posts: capture.posts,
    totals: capture.totals
  };
}

async function postAnalysisWithRetry({ workerUrl, body, onProgress }) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      const prefix = attempt === 1 ? "正在唤醒 Worker 并分析" : "正在重试分析";
      onProgress(`${prefix}，已等待 ${elapsed} 秒...`);
    }, 1000);

    try {
      onProgress(attempt === 1 ? "正在唤醒 Worker 并发送分析..." : "首次请求较慢或失败，正在自动重试一次...");
      return await fetchAnalysisJson(workerUrl, body, 60000);
    } catch (error) {
      lastError = error;
      if (attempt >= 2 || !isRetryableError(error)) {
        throw error;
      }
      await delay(1200);
    } finally {
      clearInterval(timer);
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

function renderResult(result) {
  const distribution = result.distribution || {};
  const report = result.report || {};
  const dataQuality = report.dataQuality || {};
  elements.result.hidden = false;
  elements.result.innerHTML = [
    metric("关键词", result.keyword),
    metric("摘要", report.executiveSummary || result.summary),
    metric("帖子", result.totals?.posts ?? 0),
    metric("评论", result.totals?.comments ?? 0),
    metric("正向", distribution.positive?.count ?? 0),
    metric("中性", distribution.neutral?.count ?? 0),
    metric("负向", distribution.negative?.count ?? 0),
    dataQuality.message ? metric("数据质量", dataQuality.message) : "",
    renderListMetric("关键发现", report.keyFindings?.map((item) => `${item.title}：${item.detail}`)),
    renderListMetric("建议动作", report.recommendedActions),
    result.savedReport?.url
      ? metric("完整报告", `<a href="${escapeHtml(result.savedReport.url)}" target="_blank">打开网页报告</a>`, true)
      : ""
  ].join("");
}

function metric(label, value, html = false) {
  const safeValue = html ? String(value) : escapeHtml(String(value));
  return `<div class="metric"><strong>${escapeHtml(label)}</strong><span>${safeValue}</span></div>`;
}

function renderListMetric(label, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "";
  }
  return metric(
    label,
    `<ul>${items.slice(0, 4).map((item) => `<li>${escapeHtml(String(item))}</li>`).join("")}</ul>`,
    true
  );
}

function hasExportableData() {
  return Boolean((currentCapture?.totals?.posts || 0) > 0 || (lastAutoStatus?.capturedPosts || 0) > 0);
}

function setStatus(message) {
  elements.status.textContent = message;
}

function readLimits() {
  const delayMinMs = secondsToMs(elements.delayMinSeconds.value, 1200);
  const delayMaxMs = secondsToMs(elements.delayMaxSeconds.value, 3000);
  return {
    maxPosts: clampNumber(elements.maxPosts.value, 10, 1, 30),
    commentsPerPost: clampNumber(elements.commentsPerPost.value, 20, 0, 80),
    concurrency: 1,
    delayMinMs: Math.min(delayMinMs, delayMaxMs),
    delayMaxMs: Math.max(delayMinMs, delayMaxMs)
  };
}

function limitCapture(capture, limits) {
  const posts = (capture.posts || []).slice(0, limits.maxPosts).map((post) => ({
    ...post,
    comments: (post.comments || []).slice(0, limits.commentsPerPost)
  }));
  return {
    ...capture,
    posts,
    totals: {
      posts: posts.length,
      comments: posts.reduce((sum, post) => sum + (post.comments?.length || 0), 0)
    }
  };
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function secondsToMs(value, fallbackMs) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallbackMs;
  }
  return Math.min(15000, Math.max(0, Math.round(parsed * 1000)));
}

function formatSeconds(value) {
  const seconds = Math.max(0, Number(value || 0) / 1000);
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function safeFilename(value) {
  return String(value || "keyword").replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40) || "keyword";
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
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

function startStatusPolling() {
  if (statusTimer) {
    clearInterval(statusTimer);
  }
  statusTimer = setInterval(() => void refreshAutoStatus(), 1000);
}

async function refreshAutoStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AUTO_CAPTURE_STATUS" });
    if (response?.ok) {
      renderAutoStatus(response.status);
    }
  } catch {
    // Background service worker may still be waking up.
  }
}

function renderAutoStatus(status) {
  lastAutoStatus = status || null;
  if (!status || status.phase === "idle") {
    elements.autoCaptureBtn.disabled = false;
    elements.captureBtn.disabled = false;
    elements.pauseBtn.disabled = true;
    elements.exportBtn.disabled = !hasExportableData();
    elements.pauseBtn.textContent = "暂停";
    return;
  }

  const lines = [
    status.message,
    status.discoveredPosts ? `发现帖子：${status.discoveredPosts}` : "",
    status.currentIndex ? `当前进度：${status.currentIndex}/${status.discoveredPosts || status.targetPosts}` : "",
    `已采集：${status.capturedPosts || 0} 篇 / ${status.capturedComments || 0} 条评论`,
    status.warnings?.length ? `提示：${status.warnings.at(-1)}` : "",
    status.error ? `错误：${status.error}` : ""
  ].filter(Boolean);
  setStatus(lines.join("\n"));

  if (status.result) {
    renderResult(status.result);
  }

  const running = Boolean(status.running);
  elements.autoCaptureBtn.disabled = running;
  elements.captureBtn.disabled = running;
  elements.pauseBtn.disabled = !running;
  elements.exportBtn.disabled = !hasExportableData();
  elements.pauseBtn.textContent = status.paused ? "继续" : "暂停";
  elements.analyzeBtn.disabled = running
    ? !(status.paused && (status.capturedPosts || 0) > 0)
    : !currentCapture || currentCapture.totals.comments === 0;

  if (!running && statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
    elements.pauseBtn.disabled = true;
    elements.exportBtn.disabled = !hasExportableData();
    elements.pauseBtn.textContent = "暂停";
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
