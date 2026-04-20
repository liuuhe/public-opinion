import { launch } from "@cloudflare/playwright";
import type { RemoteLoginStreamEvent } from "../src/shared/types";
import { type Env } from "./env";
import { clearSessionDiagnostic } from "./session";

const LOGIN_LOCK_KEY = "xhs:remote_login:lock";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const LOGIN_POLL_MS = 2500;
const LOGIN_URL =
  "https://www.xiaohongshu.com/search_result?keyword=%E5%92%96%E5%95%A1&source=web_search_result_notes";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

type BrowserLike = any;
type PageLike = any;

interface LoginLock {
  createdAt: string;
  expiresAt: string;
}

export function streamRemoteLogin(env: Env, url: URL): Response {
  const encoder = new TextEncoder();
  const token = url.searchParams.get("token") || "";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: RemoteLoginStreamEvent) => {
        controller.enqueue(encoder.encode(`event: ${event.stage}\ndata: ${JSON.stringify(event)}\n\n`));
      };

      if (!isAuthorized(env, token)) {
        send({
          stage: "login_error",
          message: "管理员口令无效，未启动远程浏览器。",
          progress: 100,
          code: "unauthorized",
          error: "unauthorized"
        });
        controller.close();
        return;
      }

      const lock = await acquireLoginLock(env);
      if (!lock.acquired) {
        send({
          stage: "login_error",
          message: `已有远程登录任务进行中，请稍后再试。锁将在 ${formatTime(lock.expiresAt)} 过期。`,
          progress: 100,
          code: "login_in_progress",
          expiresAt: lock.expiresAt
        });
        controller.close();
        return;
      }

      let browser: BrowserLike | null = null;
      try {
        const expiresAt = new Date(Date.now() + LOGIN_TIMEOUT_MS).toISOString();
        send({
          stage: "login_started",
          message: "正在启动 Cloudflare 远程登录浏览器。",
          progress: 5,
          expiresAt
        });

        browser = await launch(env.BROWSER as Parameters<typeof launch>[0], {
          keep_alive: LOGIN_TIMEOUT_MS
        });
        const page = await prepareLoginPage(browser);
        await streamLoginLoop({ env, browser, page, send, expiresAt });
      } catch (error) {
        send({
          stage: "login_error",
          message: "远程登录流程失败",
          progress: 100,
          code: /429|rate limit/i.test(errorMessage(error)) ? "browser_rate_limited" : "unknown",
          error: errorMessage(error)
        });
      } finally {
        await browser?.close().catch(() => undefined);
        await releaseLoginLock(env);
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive"
    }
  });
}

async function streamLoginLoop(input: {
  env: Env;
  browser: BrowserLike;
  page: PageLike;
  expiresAt: string;
  send: (event: RemoteLoginStreamEvent) => void;
}): Promise<void> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let screenshotCount = 0;

  while (Date.now() < deadline) {
    const authState = await detectAuthState(input.page);
    if (authState.authenticated) {
      const savedAt = new Date().toISOString();
      await saveStorageState(input.env, input.browser, savedAt);
      await clearSessionDiagnostic(input.env);
      input.send({
        stage: "login_authenticated",
        message: "远程登录成功，登录态已保存到 Cloudflare KV。",
        progress: 100,
        savedAt
      });
      return;
    }

    if (screenshotCount === 0 || screenshotCount % 2 === 0) {
      input.send({
        stage: "login_screenshot",
        message: authState.message,
        progress: Math.min(90, 15 + screenshotCount * 7),
        screenshotDataUrl: await capturePageScreenshot(input.page),
        qrImageDataUrl: await captureQrImage(input.page),
        expiresAt: input.expiresAt
      });
    }

    screenshotCount += 1;
    await input.page.waitForTimeout(LOGIN_POLL_MS);
  }

  input.send({
    stage: "login_expired",
    message: "远程登录会话已超时，请重新启动登录流程。",
    progress: 100
  });
}

async function prepareLoginPage(browser: BrowserLike): Promise<PageLike> {
  const context = await browser.newContext({
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    userAgent: USER_AGENT,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();
  page.setDefaultTimeout?.(25000);
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  await clickLoginEntry(page);
  return page;
}

async function clickLoginEntry(page: PageLike): Promise<void> {
  await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll("button, div, span, a"));
    const loginNode = candidates.find((node) => {
      const text = (node.textContent || "").trim();
      return text === "登录" || text.includes("手机号登录") || text.includes("扫码");
    }) as HTMLElement | undefined;
    loginNode?.click();
  }).catch(() => undefined);
  await page.waitForTimeout(800).catch(() => undefined);
}

async function detectAuthState(page: PageLike): Promise<{ authenticated: boolean; message: string }> {
  return page.evaluate(() => {
    const bodyText = document.body?.innerText || "";
    const links = Array.from(document.querySelectorAll("a[href]")).map((anchor) =>
      (anchor as HTMLAnchorElement).href
    );
    const hasLoginGate =
      bodyText.includes("登录后查看搜索结果") ||
      bodyText.includes("手机号登录") ||
      bodyText.includes("获取验证码") ||
      bodyText.includes("小红书如何扫码") ||
      bodyText.includes("扫码");
    const hasPostLinks = links.some((href) => href.includes("/explore/") || href.includes("/discovery/item/"));
    return {
      authenticated: !hasLoginGate && hasPostLinks,
      message: hasLoginGate ? "请使用小红书 App 扫描远程页面中的二维码，并在手机端确认登录。" : "等待搜索结果加载。"
    };
  }).catch(() => ({
    authenticated: false,
    message: "正在等待登录页加载。"
  }));
}

async function capturePageScreenshot(page: PageLike): Promise<string | undefined> {
  try {
    const bytes = await page.screenshot({ type: "jpeg", quality: 72, fullPage: false });
    return `data:image/jpeg;base64,${bytesToBase64(bytes)}`;
  } catch {
    return undefined;
  }
}

async function captureQrImage(page: PageLike): Promise<string | undefined> {
  try {
    const clip = await findQrCandidate(page);
    if (!clip) {
      return undefined;
    }
    const bytes = await page.screenshot({ type: "jpeg", quality: 82, clip });
    return `data:image/jpeg;base64,${bytesToBase64(bytes)}`;
  } catch {
    return undefined;
  }
}

async function findQrCandidate(page: PageLike): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page.evaluate(() => {
    const viewportWidth = window.innerWidth || 1280;
    const viewportHeight = window.innerHeight || 900;
    const candidates = Array.from(document.querySelectorAll("img, canvas, svg"))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        const squareScore = Math.max(0, 100 - Math.abs(width - height));
        const sizeScore = width >= 120 && width <= 360 && height >= 120 && height <= 360 ? 100 : 0;
        const centeredScore = rect.left > viewportWidth * 0.25 && rect.right < viewportWidth * 0.9 ? 40 : 0;
        return {
          x: Math.max(0, Math.round(rect.left - 18)),
          y: Math.max(0, Math.round(rect.top - 18)),
          width: Math.min(viewportWidth - Math.max(0, Math.round(rect.left - 18)), width + 36),
          height: Math.min(viewportHeight - Math.max(0, Math.round(rect.top - 18)), height + 36),
          score: squareScore + sizeScore + centeredScore
        };
      })
      .filter((item) => item.width >= 120 && item.height >= 120)
      .sort((left, right) => right.score - left.score);
    return candidates[0] || null;
  }).catch(() => null);
}

async function saveStorageState(env: Env, browser: BrowserLike, savedAt: string): Promise<void> {
  const context = browser.contexts?.()[0];
  if (!context) {
    throw new Error("远程浏览器上下文不存在，无法保存登录态。");
  }
  const storageState = await context.storageState({ indexedDB: true });
  await env.PUBLIC_OPINION_KV.put(storageStateKey(env), JSON.stringify(storageState), {
    metadata: {
      uploadedAt: savedAt,
      source: "remote-login"
    }
  });
}

async function acquireLoginLock(env: Env): Promise<{ acquired: true; expiresAt: string } | { acquired: false; expiresAt: string }> {
  const existing = await readLoginLock(env);
  if (existing && Date.parse(existing.expiresAt) > Date.now()) {
    return { acquired: false, expiresAt: existing.expiresAt };
  }

  const expiresAt = new Date(Date.now() + LOGIN_TIMEOUT_MS + 30_000).toISOString();
  await env.PUBLIC_OPINION_KV.put(
    LOGIN_LOCK_KEY,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      expiresAt
    } satisfies LoginLock),
    { expirationTtl: Math.ceil((LOGIN_TIMEOUT_MS + 30_000) / 1000) }
  );
  return { acquired: true, expiresAt };
}

async function readLoginLock(env: Env): Promise<LoginLock | null> {
  try {
    const value = await env.PUBLIC_OPINION_KV.get(LOGIN_LOCK_KEY);
    return value ? (JSON.parse(value) as LoginLock) : null;
  } catch {
    return null;
  }
}

async function releaseLoginLock(env: Env): Promise<void> {
  await env.PUBLIC_OPINION_KV.delete(LOGIN_LOCK_KEY).catch(() => undefined);
}

function isAuthorized(env: Env, token: string): boolean {
  const expected = env.LOGIN_ADMIN_TOKEN;
  return Boolean(expected) && safeEqual(token, expected || "");
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function bytesToBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function storageStateKey(env: Env): string {
  return env.XHS_STORAGE_STATE_KEY || "xhs:storage_state";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
