import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyRuntime } from "../lib/runtime.js";
import { identityDefineTool, testConfig, visionResponse } from "./helpers.js";

function cordisFixture(config) {
  const activeTools = new Map();
  const rootListeners = new Map();
  const rootEffects = [];
  const children = [];
  const llm = { async resolveModelInfo() { return { inputModalities: ["text"] }; } };
  const rawResolve = llm.resolveModelInfo;
  const services = {
    llm,
    attachments: { async readImage() { throw new Error("测试不读图"); } },
    sessionProjections: { stateOf() { return null; } },
  };

  function makeContext(isChild = false) {
    const listeners = new Map();
    const effects = [];
    const tools = {
      register(tool) {
        activeTools.set(tool.name, tool);
        if (isChild) effects.push(() => activeTools.delete(tool.name));
        return tool;
      },
    };
    const ctx = {
      tools,
      logger: { warn() {}, info() {}, debug() {} },
      get(name) { return services[name]; },
      on(event, listener) {
        const target = isChild ? listeners : rootListeners;
        target.set(event, listener);
        const dispose = () => target.delete(event);
        if (isChild) effects.push(dispose);
        return dispose;
      },
      effect(setup) {
        const dispose = setup();
        (isChild ? effects : rootEffects).push(dispose);
        return dispose;
      },
      plugin(definition) {
        const child = makeContext(true);
        children.push(child);
        definition.apply(child);
        return {
          async dispose() {
            for (const dispose of child.effects.splice(0).reverse()) await dispose?.();
            child.listeners.clear();
          },
        };
      },
    };
    if (isChild) {
      ctx.listeners = listeners;
      ctx.effects = effects;
    }
    return ctx;
  }

  const ctx = makeContext();
  return {
    ctx,
    config,
    activeTools,
    rootListeners,
    rootEffects,
    llm,
    rawResolve,
    services,
    preStepCount: () => children.filter((child) => child.listeners.has("agent/pre-step")).length,
  };
}

test("运行时只注册 inspect_image；禁用后工具、pre-step 与准入全部恢复", async () => {
  const config = testConfig();
  const f = cordisFixture(config);
  let child;
  const originalPlugin = f.ctx.plugin;
  f.ctx.plugin = (definition) => {
    child = originalPlugin(definition);
    return child;
  };
  applyRuntime(f.ctx, config, identityDefineTool);
  assert.deepEqual([...f.activeTools.keys()], ["inspect_image"]);
  assert.notStrictEqual(f.llm.resolveModelInfo, f.rawResolve);
  assert.equal(f.preStepCount(), 1);

  config.enabled = false;
  await f.rootListeners.get("settings/document-updated")("auto-vision-bridge");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.activeTools.size, 0);
  assert.strictEqual(f.llm.resolveModelInfo, f.rawResolve);
  assert.equal(f.preStepCount(), 0);

  config.enabled = true;
  await f.rootListeners.get("settings/document-updated")("auto-vision-bridge");
  assert.deepEqual([...f.activeTools.keys()], ["inspect_image"]);
  assert.notStrictEqual(f.llm.resolveModelInfo, f.rawResolve);
  for (const dispose of f.rootEffects.reverse()) await dispose?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.activeTools.size, 0);
  assert.strictEqual(f.llm.resolveModelInfo, f.rawResolve);
});

test("运行时将宿主 attachments 服务接入 attachmentId 复核，并保持单工具注册", async (t) => {
  const config = testConfig();
  const f = cordisFixture(config);
  const data = Buffer.from("runtime-attachment-bytes");
  const ref = {
    attachmentId: "sha256:runtime",
    mediaType: "image/png",
    bytes: data.byteLength,
    width: 2,
    height: 3,
    name: "runtime.png",
  };
  const reads = [];
  f.services.attachments.readImage = async (actualRef, signal) => {
    reads.push({ actualRef, signal });
    return { ref: actualRef, data };
  };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return visionResponse("运行时复核结果");
  });
  applyRuntime(f.ctx, config, identityDefineTool);
  assert.deepEqual([...f.activeTools.keys()], ["inspect_image"]);

  const controller = new AbortController();
  const session = {
    header: { cwd: "/unused" },
    events: [{ type: "user/message", data: { content: [{ type: "image", attachment: ref }] } }],
  };
  const result = await f.activeTools.get("inspect_image").execute({
    attachmentId: ref.attachmentId,
    question: "只核对标题",
  }, { agent: { session }, signal: controller.signal });
  assert.equal(result, "运行时复核结果");
  assert.equal(reads.length, 1);
  assert.strictEqual(reads[0].actualRef, ref);
  assert.strictEqual(reads[0].signal, controller.signal);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].messages[0].content[0].text, "只核对标题");
  assert.match(requests[0].messages[0].content[1].image_url.url, /^data:image\/png;base64,/);

  for (const dispose of f.rootEffects.reverse()) await dispose?.();
});

test("标准清单声明 bundle patch 与 web client，源码不碰真实 dispatch 能力", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "dsh-auto-vision-bridge");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(manifest.dsh.client.platform, "web");
  const runtime = await readFile(new URL("../lib/runtime.js", import.meta.url), "utf8");
  assert.equal((runtime.match(/tools\.register\(/g) ?? []).length, 1);
  assert.doesNotMatch(runtime, /vision_[a-z]/);
  assert.doesNotMatch(runtime, /registration\s*\(|prepareCall|adapter\s*=/);
});
