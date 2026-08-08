import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const instanceToken = "7a6f8d37-78ce-46c9-87a8-08e10db88da2";
const instanceSecret = "2e587946-96d6-47b5-930a-1ba70214fa88";
const sourceRef = process.env.TASKBOARD_INJECTION_SOURCE_REF;
const source = sourceRef
  ? (await execFileAsync(
      "git",
      ["show", `${sourceRef}:inject/codex-taskboard.user.js`],
      { cwd: projectRoot, maxBuffer: 2 * 1024 * 1024 },
    )).stdout
  : await readFile(new URL("../inject/codex-taskboard.user.js", import.meta.url), "utf8");
const embeddedHostSource = await readFile(
  new URL("../web/src/embeddedHost.mjs", import.meta.url),
  "utf8",
);

async function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (_) {}
  }
  return null;
}

function fixtureHtml(origin) {
  const encodedSource = Buffer.from(source).toString("base64");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html, body { width: 1200px; height: 800px; margin: 0; }
      aside { position: absolute; width: 200px; height: 800px; }
      main { position: absolute; left: 200px; width: 1000px; height: 700px; }
      main > header { position: absolute; z-index: 2; width: 1000px; height: 48px; }
      #surface { width: 1000px; height: 700px; }
      [data-app-shell-main-content-layout] { position: absolute; width: 1000px; height: 700px; }
      #conversation { position: absolute; top: 48px; width: 1000px; height: 652px; }
      [data-browser-sidebar-webview] { position: absolute; right: 0; width: 320px; height: 700px; visibility: visible; }
    </style>
  </head>
  <body>
    <aside>
      <nav role="navigation">
        <div data-app-action-sidebar-scroll>
          <div>
            <button><span>首页</span></button>
            <button><span>站点</span></button>
            <button><svg></svg><span class="text-fade-truncate">插件</span></button>
          </div>
          <section data-app-action-sidebar-section>
            <div data-app-action-sidebar-section-heading="项目">项目</div>
          </section>
        </div>
      </nav>
    </aside>
    <main>
      <header>Codex header</header>
      <div id="surface">
        <div data-app-shell-main-content-layout>
          <div id="conversation">Conversation</div>
        </div>
      </div>
      <div data-browser-sidebar-webview>
        <webview
          data-browser-sidebar-conversation-id="conversation-1"
          data-browser-sidebar-browser-tab-id="browser-tab-1"
        ></webview>
      </div>
    </main>
    <output id="result"></output>
    <script>
      window.__CODEX_TASKBOARD_URL__ = ${JSON.stringify(`${origin}/taskboard?host=codex`)};
      window.__CODEX_TASKBOARD_INSTANCE_TOKEN__ = ${JSON.stringify(instanceToken)};
      window.__CODEX_TASKBOARD_INSTANCE_SECRET__ = ${JSON.stringify(instanceSecret)};
      window.__CODEX_TASKBOARD_HOST_CAPABILITY__ = "fullheight-host-capability";
      window.__CODEX_TASKBOARD_SOURCE_HASH__ = "fullheight-regression";
      window.__browserPanelClosed = false;
      window.__injectionError = null;
      window.__frameMessages = [];
      window.__frameLoadCount = 0;
      window.__frameRecreated = false;
      window.__storageFlushAckBeforeReload = false;
      window.__frameWasInertDuringFlush = false;
      window.__externalOpenUrl = null;
      window.__frameVisibleBeforeNavigation = false;
      window.__statusHiddenBeforeNavigation = false;
      window.__hostileNavigationLoaded = false;
      window.__forgedThreadOpened = false;
      window.addEventListener("error", (event) => {
        window.__injectionError = event.error?.stack || event.message;
      });
      window.addEventListener("unhandledrejection", (event) => {
        window.__injectionError = event.reason?.stack || String(event.reason);
      });
      window.addEventListener("message", (event) => {
        if (typeof event.data?.type === "string" && event.data.type.startsWith("taskboard:")) {
          window.__frameMessages.push({ type: event.data.type, origin: event.origin });
        }
        if (event.data?.type === "taskboard:storage-flushed") {
          window.__storageFlushAckBeforeReload = true;
          window.__frameWasInertDuringFlush = document.getElementById("codex-taskboard-frame")?.inert === true;
        }
        if (
          event.source === window
          && event.data?.type === "__codexTaskboardHostRequestV1"
          && event.data.capability === "fullheight-host-capability"
        ) {
          const request = event.data.payload;
          if (request.action === "load-frame") {
            const frame = document.querySelector('iframe[name="' + request.frameName + '"]');
            const frameLoadIndex = window.__frameLoadCount++;
            if (frameLoadIndex === 0) window.__firstTaskboardFrame = frame;
            else window.__frameRecreated = frame !== window.__firstTaskboardFrame
              && window.__firstTaskboardFrame?.isConnected === false;
            const moduleUrl = ${JSON.stringify(`${origin}/embeddedHost.mjs`)};
            frame.srcdoc = '<a id="external-link" href="https://example.com/review" target="_blank">Review</a>'
              + '<script type="module">import * as host from ' + JSON.stringify(moduleUrl) + ';'
              + 'const activateHostileNavigation=' + JSON.stringify(frameLoadIndex > 0) + ';'
              + 'globalThis.__CODEX_TASKBOARD_FRAME_CAPABILITY__='
              + JSON.stringify(request.frameCapability)
              + ';host.installEmbeddedExternalLinkHandler();'
              + 'let activated=false,acknowledgedChallenge="";window.addEventListener("message",function(event){'
              + 'if(event.data?.type==="taskboard:flush-storage"){'
              + 'host.postEmbeddedHostMessage({type:"taskboard:storage-flushed",payload:{requestId:event.data.payload?.requestId}});return;}'
              + 'if(event.data?.type!=="taskboard:frame-challenge")return;'
              + 'const challenge=event.data.payload?.challenge;if(!challenge||challenge===acknowledgedChallenge)return;'
              + 'acknowledgedChallenge=challenge;host.setEmbeddedFrameChallenge(challenge);'
              + 'host.postEmbeddedHostMessage({type:"taskboard:ready"});'
              + 'if(activated)return;activated=true;'
              + 'parent.postMessage({type:"taskboard:ready"},"*");'
              + 'if(!activateHostileNavigation)return;'
              + 'parent.postMessage({type:"taskboard:open-thread",payload:{threadId:"forged"}},"*");'
              + 'document.getElementById("external-link").click();'
              + '});host.postEmbeddedHostMessage({type:"taskboard:frame-awaiting-challenge"});<\\/script>';
          }
          if (request.action === "open-external") {
            window.__externalOpenUrl = request.url;
            const frame = document.getElementById("codex-taskboard-frame");
            window.__frameVisibleBeforeNavigation = frame?.hidden === false;
            window.__statusHiddenBeforeNavigation = document.getElementById("codex-taskboard-status")?.hidden === true;
            frame?.addEventListener("load", () => {
              window.__hostileNavigationLoaded = true;
            }, { once: true });
            frame.removeAttribute("srcdoc");
            frame.src = ${JSON.stringify(`${origin}/attacker`)};
          }
          window.postMessage({
            type: "__codexTaskboardHostResponseV1",
            capability: "fullheight-host-capability",
            response: { id: request.id, ok: true, loaded: true },
          }, window.location.origin);
        }
        if (event.source === window && event.data?.type === "navigate-to-route") {
          window.__forgedThreadOpened = true;
        }
        if (event.data?.type !== "toggle-browser-panel" || event.data.open !== false) return;
        const panel = document.querySelector("[data-browser-sidebar-webview]");
        panel.style.visibility = "hidden";
        panel.hidden = true;
        const conversation = document.getElementById("conversation");
        conversation.style.top = "0";
        conversation.style.height = "700px";
        window.__browserPanelClosed = true;
      });
    </script>
    <script>eval(atob(${JSON.stringify(encodedSource)}));</script>
    <script>
      let heartbeatTimer = null;
      window.__startCodexTaskboardRegression = async () => {
        const publishHeartbeat = () => window.postMessage({
            type: "__codexTaskboardHostHeartbeatV1",
            capability: "fullheight-host-capability",
            at: Date.now(),
            startupToken: "fullheight-startup",
          }, window.location.origin);
        publishHeartbeat();
        heartbeatTimer = setInterval(publishHeartbeat, 500);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const entry = document.getElementById("codex-taskboard-entry");
        const panel = document.querySelector("[data-browser-sidebar-webview]");
        window.__panelVisibleBefore = getComputedStyle(panel).visibility !== "hidden";
        entry?.click();
        window.__entryClicked = true;
      };

      window.__collectCodexTaskboardRegressionResult = () => {
        const page = document.getElementById("codex-taskboard-page");
        const frame = document.getElementById("codex-taskboard-frame");
        const surface = document.getElementById("surface");
        const conversation = document.getElementById("conversation");
        const result = {
          panelVisibleBefore: window.__panelVisibleBefore,
          browserPanelClosed: window.__browserPanelClosed,
          conversationTop: conversation.getBoundingClientRect().top,
          pageMounted: page?.parentElement === surface,
          pageVisible: Boolean(page && !page.hidden && getComputedStyle(page).display !== "none"),
          frameMounted: frame?.parentElement === page,
          frameVisible: Boolean(frame && !frame.hidden && getComputedStyle(frame).display !== "none"),
          frameIsolated: frame?.contentDocument === null,
          statusHidden: document.getElementById("codex-taskboard-status")?.hidden === true,
          frameMessages: window.__frameMessages,
          frameLoadCount: window.__frameLoadCount,
          frameRecreated: window.__frameRecreated,
          storageFlushAckBeforeReload: window.__storageFlushAckBeforeReload,
          frameWasInertDuringFlush: window.__frameWasInertDuringFlush,
          externalOpenUrl: window.__externalOpenUrl,
          frameVisibleBeforeNavigation: window.__frameVisibleBeforeNavigation,
          statusHiddenBeforeNavigation: window.__statusHiddenBeforeNavigation,
          hostileNavigationRevoked: Boolean(frame?.hidden && !document.getElementById("codex-taskboard-status")?.hidden),
          forgedThreadOpened: window.__forgedThreadOpened,
          injectionError: window.__injectionError,
        };
        document.getElementById("result").textContent = btoa(JSON.stringify(result));
        clearInterval(heartbeatTimer);
        return result;
      };
    </script>
  </body>
</html>`;
}

test("Taskboard fills the workspace, opens HTTPS links and revokes hostile iframe navigation", async (t) => {
  const chrome = await chromeExecutable();
  if (!chrome) {
    t.skip("Chrome or Chromium is not installed");
    return;
  }

  const server = http.createServer((request, response) => {
    response.setHeader("connection", "close");
    if (request.url === "/embeddedHost.mjs") {
      response.setHeader("access-control-allow-origin", "null");
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.end(embeddedHostSource);
      return;
    }
    if (request.url === "/attacker") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<!doctype html><title>attacker</title>");
      return;
    }
    if (request.url?.startsWith("/taskboard")) {
      response.setHeader("access-control-allow-origin", "null");
      response.setHeader("access-control-expose-headers", "x-codex-taskboard-proof");
      response.setHeader("access-control-allow-private-network", "true");
      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
        return;
      }
      const challenge = new URL(request.url, "http://127.0.0.1")
        .searchParams.get("__codex_taskboard_challenge");
      response.setHeader(
        "x-codex-taskboard-proof",
        createHmac("sha256", instanceSecret).update(challenge).digest("hex"),
      );
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><head></head><body><script>parent.postMessage({ type: "taskboard:ready" }, "*")</script></body></html>`);
      return;
    }
    const origin = `http://127.0.0.1:${server.address().port}`;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(fixtureHtml(origin));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));

  const url = `http://127.0.0.1:${server.address().port}/fixture`;
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ["--no-sandbox"],
  });
  t.after(() => browser.close());

  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  const stageTrace = [];
  const startedAt = Date.now();
  const record = (stage, detail = {}) => {
    stageTrace.push({ stage, elapsedMs: Date.now() - startedAt, ...detail });
  };
  page.on("console", (message) => record("console", {
    type: message.type(),
    text: message.text(),
  }));
  page.on("pageerror", (error) => record("pageerror", { message: error.message }));
  page.on("requestfailed", (request) => record("requestfailed", {
    url: request.url(),
    failure: request.failure()?.errorText,
  }));

  const waitForStage = async (stage, predicate) => {
    try {
      await page.waitForFunction(predicate, undefined, { timeout: 10_000, polling: 50 });
      record(stage);
    } catch (error) {
      record(`${stage}:timeout`);
      throw error;
    }
  };
  const traceFile = process.env.TASKBOARD_INJECTION_TRACE_FILE;
  let tracing = false;
  let traceSaved = false;
  let result;
  try {
    await context.tracing.start({ snapshots: true, sources: true });
    tracing = true;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
    record("domcontentloaded");
    await waitForStage("entry-mounted", () => Boolean(
      document.getElementById("codex-taskboard-entry")
      && window.__startCodexTaskboardRegression,
    ));
    await page.evaluate(() => window.__startCodexTaskboardRegression());
    await waitForStage("entry-clicked", () => window.__entryClicked === true);
    await waitForStage("frame-awaiting-challenge", () => window.__frameMessages.some(
      (message) => message.type === "taskboard:frame-awaiting-challenge",
    ));
    await waitForStage("frame-ready", () => window.__frameMessages.some(
      (message) => message.type === "taskboard:ready",
    ));
    await page.evaluate(() => window.__codexTaskboardInjection__?.reloadFrame());
    record("frame-reload-requested");
    await waitForStage("storage-flushed", () => window.__storageFlushAckBeforeReload === true);
    await waitForStage("frame-recreated", () => (
      window.__frameLoadCount === 2 && window.__frameRecreated === true
    ));
    await waitForStage("external-open-requested", () => (
      window.__externalOpenUrl === "https://example.com/review"
    ));
    await waitForStage("hostile-navigation-revoked", () => {
      const frame = document.getElementById("codex-taskboard-frame");
      const status = document.getElementById("codex-taskboard-status");
      return window.__hostileNavigationLoaded === true
        && frame?.hidden === true
        && status?.hidden === false;
    });
    result = await page.evaluate(() => window.__collectCodexTaskboardRegressionResult());
    record("result-collected");
  } catch (error) {
    const state = await page.evaluate(() => ({
      entryClicked: window.__entryClicked,
      frameMessages: window.__frameMessages,
      externalOpenUrl: window.__externalOpenUrl,
      hostileNavigationLoaded: window.__hostileNavigationLoaded,
      injectionError: window.__injectionError,
      frameHidden: document.getElementById("codex-taskboard-frame")?.hidden,
      statusHidden: document.getElementById("codex-taskboard-status")?.hidden,
    })).catch((snapshotError) => ({ snapshotError: snapshotError.message }));
    if (traceFile) {
      await mkdir(path.dirname(traceFile), { recursive: true });
      await context.tracing.stop({ path: traceFile });
      tracing = false;
      traceSaved = true;
    }
    error.message += `\nProtocol trace: ${JSON.stringify(stageTrace)}\nPage state: ${JSON.stringify(state)}`;
    if (traceSaved) error.message += `\nPlaywright trace: ${traceFile}`;
    throw error;
  } finally {
    if (tracing) await context.tracing.stop();
  }

  assert.deepEqual(result, {
    panelVisibleBefore: true,
    browserPanelClosed: true,
    conversationTop: 0,
    pageMounted: true,
    pageVisible: true,
    frameMounted: true,
    frameVisible: false,
    frameIsolated: true,
    statusHidden: false,
    frameMessages: [
      { type: "taskboard:frame-awaiting-challenge", origin: "null" },
      { type: "taskboard:ready", origin: "null" },
      { type: "taskboard:ready", origin: "null" },
      { type: "taskboard:storage-flushed", origin: "null" },
      { type: "taskboard:frame-awaiting-challenge", origin: "null" },
      { type: "taskboard:ready", origin: "null" },
      { type: "taskboard:ready", origin: "null" },
      { type: "taskboard:open-thread", origin: "null" },
      { type: "taskboard:open-external", origin: "null" },
    ],
    frameLoadCount: 2,
    frameRecreated: true,
    storageFlushAckBeforeReload: true,
    frameWasInertDuringFlush: true,
    externalOpenUrl: "https://example.com/review",
    frameVisibleBeforeNavigation: true,
    statusHiddenBeforeNavigation: true,
    hostileNavigationRevoked: true,
    forgedThreadOpened: false,
    injectionError: null,
  });
});
