import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = path.join(ROOT, "artifacts");
const RESULT_PATH = path.join(ARTIFACTS, "gui-e2e-result.json");
const ALPHA = "AVBALPHA74261";
const BRAVO = "AVBBETA90817";
const BRIDGE_START = "\u200b[auto-vision-bridge:start]";
const BRIDGE_END = "\u200b[auto-vision-bridge:end]";
const MIXED_PROMPT = "不要使用任何工具。请按图片顺序，只回复两个图片转写块中的两个唯一码，每个唯一码独占一行，不要添加其他文字。";
const TOOL_QUESTION = "图片中的唯一码是什么？";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await mkdir(ARTIFACTS, { recursive: true });

const result = {
  timestamp: new Date().toISOString(),
  passed: false,
  sessionId: null,
  title: null,
  model: null,
  imageCount: 2,
  checks: {
    modelSelected: false,
    inspectImageInToolSnapshot: false,
    noLegacyVisionTools: false,
    plainTextTurnCompleted: false,
    plainTextReply: false,
    plainTextUserHasNoImageOrBridge: false,
    mixedTurnCompleted: false,
    mixedUserHasTwoImages: false,
    mixedBridgeBlockAfterEachImage: false,
    mixedOriginalTextPreserved: false,
    mixedTranscriptionsContainCanaries: false,
    mixedAssistantContainsBothCanaries: false,
    mixedUsedNoTools: false,
    inspectToolCallObserved: false,
    inspectToolArgumentsCorrect: false,
    inspectToolResultObserved: false,
    inspectToolResultContainsCanary: false,
    inspectTurnCompleted: false,
    guiSessionOpened: false,
    guiTwoImagesComplete: false,
    guiTranscriptionHidden: false,
    guiPreviewOpened: false,
    guiPreviewClosed: false,
    guiScreenshotSaved: false,
    guiAfterRefreshTwoImagesComplete: false,
    guiAfterRefreshTranscriptionHidden: false,
  },
  durationsMs: {
    plainText: null,
    mixedImages: null,
    inspectTool: null,
    total: null,
  },
  tool: {
    name: null,
    resultText: null,
  },
  artifacts: {
    alpha: "artifacts/avb-alpha.png",
    bravo: "artifacts/avb-bravo.png",
    inspectTarget: "artifacts/inspect-target.png",
    screenshot: "artifacts/gui-acceptance.png",
  },
  archived: false,
  failure: null,
};

function safeError(error) {
  return String(error?.message ?? error ?? "未知错误")
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, "[已移除图片数据]")
    .slice(0, 1200);
}

async function saveResult() {
  await writeFile(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function textOf(content) {
  return (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function isBridgeBlock(block) {
  if (block?.type !== "text" || typeof block.text !== "string") return false;
  const start = block.text.indexOf(BRIDGE_START);
  const end = block.text.lastIndexOf(BRIDGE_END);
  return start === 0 && end > start && block.text.slice(end + BRIDGE_END.length).trim() === "";
}

let browser;
const startedAt = Date.now();

try {
  browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:9222",
    defaultViewport: null,
    protocolTimeout: 60_000,
  });
  const pages = await browser.pages();
  const page = pages.find((candidate) => {
    try {
      const url = new URL(candidate.url());
      return url.origin === "http://127.0.0.1:3080";
    } catch {
      return false;
    }
  });
  if (!page) throw new Error("CDP 中未找到已授权的 http://127.0.0.1:3080/ 页面");
  // 后台标签页的 ElementHandle 滚动/点击可能等待 rAF 直到协议超时。
  await page.bringToFront();

  async function rpc(method, payload) {
    const rpcId = randomUUID();
    return page.evaluate(async ({ method, payload, rpcId }) => {
      const response = await fetch(`/api/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId, method, payload: { args: method === "session/modelCatalog" ? {} : { request: payload } } }),
      });
      const envelope = await response.json();
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}: ${method}`);
      if (envelope?.rpcId !== rpcId) throw new Error(`RPC envelope rpcId 不匹配: ${method}`);
      if (envelope?.result?.ok !== true) {
        const remote = envelope?.result?.error;
        throw new Error(`RPC ${method} 失败: ${remote?.message ?? remote?.code ?? "未知错误"}`);
      }
      return envelope.result.value;
    }, { method, payload, rpcId });
  }

  async function history() {
    const projection = await rpc("session/projections", { sessionId: result.sessionId });
    if (!projection || projection.kind !== "sequenced" || !Number.isSafeInteger(projection.asOfSeq)) {
      throw new Error("session/projections 未返回可用 asOfSeq");
    }
    const pageValue = await rpc("session/page", {
      address: { kind: "session", sessionId: result.sessionId },
      throughSeq: projection.asOfSeq,
      maxMessages: 200,
    });
    return {
      asOfSeq: projection.asOfSeq,
      events: (pageValue?.records ?? []).filter((record) => record?.type === "event").map((record) => record.event),
    };
  }

  async function runPrompt(content) {
    const baseline = await history();
    const requestId = randomUUID();
    const started = Date.now();
    await rpc("session/prompt", {
      requestId,
      sessionId: result.sessionId,
      mode: "queue",
      content,
      clientTimeZone: "Asia/Shanghai",
    });
    const deadline = Date.now() + 240_000;
    let latest;
    while (Date.now() < deadline) {
      await sleep(750);
      latest = await history();
      const turnEvents = latest.events.filter((event) => event.seq > baseline.asOfSeq);
      const startedTurn = turnEvents.find((event) => event.type === "turn/start")?.data?.turn;
      const ended = startedTurn !== undefined && turnEvents.some((event) =>
        event.type === "turn/end" && event.data?.turn === startedTurn);
      if (ended) {
        return {
          requestId,
          elapsedMs: Date.now() - started,
          events: latest.events,
          turnEvents,
        };
      }
    }
    throw new Error("等待 turn/end 超时（240 秒）");
  }

  function userForRequest(events, requestId) {
    return events.filter((event) =>
      event.type === "user/message" && event.data?.source?.rpcId === requestId).at(-1)?.data;
  }

  function assistantText(events) {
    return events.filter((event) => event.type === "assistant/message")
      .map((event) => textOf(event.data?.message?.content))
      .filter(Boolean)
      .join("\n");
  }

  const sessionId = randomUUID();
  const title = `AVB-ACCEPT-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${sessionId.slice(0, 8)}`;
  const created = await rpc("session/create", { sessionId, cwd: process.cwd() });
  result.sessionId = created?.sessionId ?? sessionId;
  result.title = title;
  await rpc("session/rename", { sessionId: result.sessionId, title });

  const catalog = await rpc("session/modelCatalog", {});
  const c2a = (catalog?.groups ?? []).find((group) => group.id === "c2a");
  if (!c2a) throw new Error("modelCatalog 中没有 c2a 路由");
  const selected = (c2a.models ?? []).find((model) =>
    String(model.name).toLowerCase() === "intelligence" || String(model.id).toLowerCase() === "intelligence")
    ?? (c2a.models ?? []).find((model) => {
      const label = `${model.name ?? ""} ${model.id ?? ""} ${model.description ?? ""}`;
      return /(?:text|文本)/i.test(label) && !/(?:vision|视觉)/i.test(label);
    });
  if (!selected) throw new Error("c2a 中没有 Intelligence，也没有明确标注的文本模型");
  result.model = { provider: "c2a", model: selected.id };
  await rpc("session/selectModel", { sessionId: result.sessionId, provider: "c2a", model: selected.id });
  result.checks.modelSelected = true;

  const plain = await runPrompt([{ type: "text", text: "只回复 TEXT_ROUTE_OK，不要添加其他文字。" }]);
  result.durationsMs.plainText = plain.elapsedMs;
  const plainEnd = plain.turnEvents.find((event) => event.type === "turn/end");
  result.checks.plainTextTurnCompleted = plainEnd?.data?.reason?.kind === "completed";
  result.checks.plainTextReply = assistantText(plain.turnEvents).trim() === "TEXT_ROUTE_OK";
  const plainUser = userForRequest(plain.events, plain.requestId);
  const plainContent = plainUser?.content ?? [];
  result.checks.plainTextUserHasNoImageOrBridge = plainContent.length > 0
    && plainContent.every((block) => block?.type === "text"
      && !block.text.includes(BRIDGE_START)
      && !block.text.includes(BRIDGE_END)
      && !block.text.includes("auto-vision-bridge"));

  const headers = plain.events.filter((event) => event.type === "request/header");
  const toolSnapshots = headers.map((event) => event.data?.header?.tools).filter(Array.isArray);
  const toolNames = toolSnapshots.flat().map((tool) => tool?.name).filter((name) => typeof name === "string");
  result.checks.inspectImageInToolSnapshot = toolSnapshots.some((tools) =>
    tools.filter((tool) => tool?.name === "inspect_image").length === 1);
  result.checks.noLegacyVisionTools = toolNames.length > 0 && !toolNames.some((name) => /^vision_/i.test(name));
  if (!result.checks.inspectImageInToolSnapshot) {
    throw new Error("当前会话 request/header 工具快照未包含唯一的 inspect_image，主动工具验收不能跳过");
  }
  if (!result.checks.noLegacyVisionTools) {
    throw new Error("当前会话工具快照仍包含旧 vision_* 工具或没有工具快照");
  }

  const images = await page.evaluate(({ ALPHA, BRAVO }) => {
    function make(code, background, accent) {
      const canvas = document.createElement("canvas");
      canvas.width = 900;
      canvas.height = 260;
      const context = canvas.getContext("2d");
      context.fillStyle = background;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = accent;
      context.fillRect(0, 0, canvas.width, 18);
      context.fillStyle = "#ffffff";
      context.font = "700 34px sans-serif";
      context.textAlign = "center";
      context.fillText("AUTO VISION ACCEPTANCE", 450, 72);
      context.fillStyle = accent;
      context.font = "700 68px monospace";
      context.fillText(code, 450, 174);
      context.fillStyle = "#cbd5e1";
      context.font = "24px sans-serif";
      context.fillText("TRANSCRIBE THE UNIQUE CODE", 450, 226);
      return canvas.toDataURL("image/png").split(",")[1];
    }
    return [
      { name: "avb-alpha.png", data: make(ALPHA, "#0f172a", "#fbbf24") },
      { name: "avb-bravo.png", data: make(BRAVO, "#172554", "#67e8f9") },
    ];
  }, { ALPHA, BRAVO });
  for (const image of images) {
    const filename = image.name === "avb-alpha.png" ? "avb-alpha.png" : "avb-bravo.png";
    await writeFile(path.join(ARTIFACTS, filename), Buffer.from(image.data, "base64"));
  }
  await writeFile(path.join(ARTIFACTS, "inspect-target.png"), Buffer.from(images[0].data, "base64"));

  const mixed = await runPrompt([
    { type: "text", text: MIXED_PROMPT },
    ...images.map((image) => ({ type: "image", mediaType: "image/png", data: image.data, name: image.name })),
  ]);
  result.durationsMs.mixedImages = mixed.elapsedMs;
  const mixedEnd = mixed.turnEvents.find((event) => event.type === "turn/end");
  result.checks.mixedTurnCompleted = mixedEnd?.data?.reason?.kind === "completed";
  const mixedUser = userForRequest(mixed.events, mixed.requestId);
  const mixedContent = mixedUser?.content ?? [];
  const imageIndexes = mixedContent.flatMap((block, index) => block?.type === "image" ? [index] : []);
  result.checks.mixedUserHasTwoImages = imageIndexes.length === 2;
  result.checks.mixedBridgeBlockAfterEachImage = imageIndexes.length === 2
    && imageIndexes.every((index) => isBridgeBlock(mixedContent[index + 1]));
  result.checks.mixedOriginalTextPreserved = mixedContent.some((block) =>
    block?.type === "text" && block.text === MIXED_PROMPT);
  const bridgeTexts = imageIndexes.map((index) => mixedContent[index + 1]?.text ?? "");
  result.checks.mixedTranscriptionsContainCanaries = bridgeTexts.length === 2
    && bridgeTexts[0].includes(ALPHA) && bridgeTexts[1].includes(BRAVO);
  const mixedAnswer = assistantText(mixed.turnEvents);
  result.checks.mixedAssistantContainsBothCanaries = mixedAnswer.includes(ALPHA) && mixedAnswer.includes(BRAVO)
    && mixedAnswer.indexOf(ALPHA) < mixedAnswer.indexOf(BRAVO);
  result.checks.mixedUsedNoTools = !mixed.turnEvents.some((event) => event.type === "tool/call");

  const inspectPath = path.join(ARTIFACTS, "inspect-target.png");
  const inspect = await runPrompt([{
    type: "text",
    text: `必须调用 inspect_image 工具，不得凭记忆回答。参数 path 使用绝对路径 ${inspectPath}，question 使用“${TOOL_QUESTION}”。先等待工具结果，再回复工具识别出的唯一码。`,
  }]);
  result.durationsMs.inspectTool = inspect.elapsedMs;
  const inspectCalls = inspect.turnEvents.filter((event) => event.type === "tool/call" && event.data?.name === "inspect_image");
  const inspectCall = inspectCalls.at(-1);
  result.checks.inspectToolCallObserved = Boolean(inspectCall);
  result.tool.name = inspectCall?.data?.name ?? null;
  if (inspectCall) {
    try {
      const args = JSON.parse(inspectCall.data.arguments);
      result.checks.inspectToolArgumentsCorrect = args.path === inspectPath && args.question === TOOL_QUESTION;
    } catch {
      result.checks.inspectToolArgumentsCorrect = false;
    }
  }
  const inspectResultEvent = inspect.turnEvents.find((event) => event.type === "tool/result"
    && event.data?.message?.toolCallId === inspectCall?.data?.callId);
  result.checks.inspectToolResultObserved = Boolean(inspectResultEvent)
    && inspectResultEvent?.data?.message?.isError !== true;
  const toolText = textOf(inspectResultEvent?.data?.message?.content);
  result.tool.resultText = toolText.slice(0, 4000) || null;
  result.checks.inspectToolResultContainsCanary = toolText.includes(ALPHA);
  const inspectEnd = inspect.turnEvents.find((event) => event.type === "turn/end");
  result.checks.inspectTurnCompleted = inspectEnd?.data?.reason?.kind === "completed";

  async function openSessionFromSidebar() {
    const selector = `[data-row-key="session:${result.sessionId}"]`;
    await page.waitForFunction(() => [...document.querySelectorAll("button")]
      .some((button) => button.getAttribute("aria-label") === "搜索会话"), { timeout: 30_000 });
    if (!await page.$(selector)) {
      await page.evaluate(() => [...document.querySelectorAll("button")]
        .find((button) => button.getAttribute("aria-label") === "搜索会话")?.click());
      await page.waitForFunction(() => document.querySelector('input[placeholder="搜索会话名称"]'),
        { timeout: 30_000 });
      await page.evaluate((title) => {
        const input = document.querySelector('input[placeholder="搜索会话名称"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, title);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, result.title);
      await page.waitForFunction((title) => [...document.querySelectorAll('[role="treeitem"]')]
        .some((row) => row.textContent?.includes(title)), { timeout: 30_000 }, result.title);
    }
    const clicked = await page.evaluate(({ selector, title }) => {
      const row = document.querySelector(selector) ?? [...document.querySelectorAll('[role="treeitem"]')]
        .find((candidate) => candidate.textContent?.includes(title));
      if (!row) return false;
      row.scrollIntoView({ block: "center" });
      row.click();
      return true;
    }, { selector, title: result.title });
    if (!clicked) throw new Error("临时会话侧栏行或搜索 treeitem 不存在");
    await page.waitForFunction((prompt) => {
      return [...document.querySelectorAll('[data-chat-flow-kind="user"]')]
        .some((row) => row.textContent?.includes(prompt));
    }, { timeout: 30_000 }, MIXED_PROMPT);
  }

  async function mixedUserRowState() {
    return page.evaluate(({ prompt, ALPHA, BRAVO }) => {
      const row = [...document.querySelectorAll('[data-chat-flow-kind="user"]')]
        .find((candidate) => candidate.textContent?.includes(prompt));
      if (!row) return { found: false };
      const images = [...row.querySelectorAll("[data-message-attachments] img")];
      return {
        found: true,
        imageCount: images.length,
        imagesReady: images.length === 2 && images.every((image) =>
          image.complete && image.naturalWidth > 0 && image.currentSrc.startsWith("blob:")),
        transcriptionHidden: !row.textContent?.includes("auto-vision-bridge")
          && !row.textContent?.includes(ALPHA) && !row.textContent?.includes(BRAVO),
      };
    }, { prompt: MIXED_PROMPT, ALPHA, BRAVO });
  }

  async function waitForMixedImages() {
    await page.waitForFunction(({ prompt, ALPHA, BRAVO }) => {
      const row = [...document.querySelectorAll('[data-chat-flow-kind="user"]')]
        .find((candidate) => candidate.textContent?.includes(prompt));
      if (!row) return false;
      const images = [...row.querySelectorAll("[data-message-attachments] img")];
      return images.length === 2 && images.every((image) =>
        image.complete && image.naturalWidth > 0 && image.currentSrc.startsWith("blob:"))
        && !row.textContent?.includes("auto-vision-bridge")
        && !row.textContent?.includes(ALPHA) && !row.textContent?.includes(BRAVO);
    }, { timeout: 45_000 }, { prompt: MIXED_PROMPT, ALPHA, BRAVO });
  }

  await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
  await openSessionFromSidebar();
  result.checks.guiSessionOpened = true;
  await waitForMixedImages();
  const firstGuiState = await mixedUserRowState();
  result.checks.guiTwoImagesComplete = firstGuiState.imagesReady === true;
  result.checks.guiTranscriptionHidden = firstGuiState.transcriptionHidden === true;

  const imageClicked = await page.evaluate((prompt) => {
    const row = [...document.querySelectorAll('[data-chat-flow-kind="user"]')]
      .find((candidate) => candidate.textContent?.includes(prompt));
    const image = row?.querySelector("[data-message-attachments] img");
    image?.click();
    return Boolean(image);
  }, MIXED_PROMPT);
  if (!imageClicked) throw new Error("GUI 中未找到第一张用户原图");
  await page.waitForSelector('[role="dialog"] img', { visible: true, timeout: 15_000 });
  await page.waitForFunction(() => {
    const image = document.querySelector('[role="dialog"] img');
    return image?.complete && image.naturalWidth > 0;
  }, { timeout: 15_000 });
  result.checks.guiPreviewOpened = true;
  const closeClicked = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return false;
    const buttons = [...dialog.querySelectorAll("button")];
    const close = buttons.find((button) => /关闭|close/i.test(`${button.getAttribute("aria-label") ?? ""} ${button.textContent ?? ""}`))
      ?? buttons[0];
    if (!close) return false;
    close.click();
    return true;
  });
  if (!closeClicked) await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[role="dialog"] img'), { timeout: 15_000 });
  result.checks.guiPreviewClosed = true;

  const clip = await page.evaluate((prompt) => {
    const row = [...document.querySelectorAll('[data-chat-flow-kind="user"]')]
      .find((candidate) => candidate.textContent?.includes(prompt));
    if (!row) return null;
    row.scrollIntoView({ block: "center" });
    const rect = row.getBoundingClientRect();
    const x = Math.max(0, rect.x);
    const y = Math.max(0, rect.y);
    return {
      x, y,
      width: Math.min(rect.width, innerWidth - x),
      height: Math.min(rect.height, innerHeight - y),
    };
  }, MIXED_PROMPT);
  if (!clip) throw new Error("GUI 截图前未找到混合图片用户消息行");
  await sleep(250);
  await page.screenshot({ path: path.join(ARTIFACTS, "gui-acceptance.png"), clip });
  result.checks.guiScreenshotSaved = true;

  await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
  await openSessionFromSidebar();
  await waitForMixedImages();
  const secondGuiState = await mixedUserRowState();
  result.checks.guiAfterRefreshTwoImagesComplete = secondGuiState.imagesReady === true;
  result.checks.guiAfterRefreshTranscriptionHidden = secondGuiState.transcriptionHidden === true;

  result.passed = Object.values(result.checks).every((value) => value === true);
  result.durationsMs.total = Date.now() - startedAt;
  await saveResult();
  if (result.passed) {
    await rpc("workspace/archiveSession", { sessionId: result.sessionId, stopActivity: true });
    result.archived = true;
    await saveResult();
  } else {
    result.failure = "验收存在未通过布尔项，临时会话已保留供排查";
    await saveResult();
  }
} catch (error) {
  result.failure = safeError(error);
  result.passed = false;
  result.durationsMs.total = Date.now() - startedAt;
  await saveResult();
  process.exitCode = 1;
} finally {
  if (browser) await browser.disconnect();
}

console.log(JSON.stringify({
  passed: result.passed,
  sessionId: result.sessionId,
  model: result.model,
  checks: result.checks,
  durationsMs: result.durationsMs,
  tool: result.tool,
  archived: result.archived,
  failure: result.failure,
  resultPath: RESULT_PATH,
}, null, 2));
