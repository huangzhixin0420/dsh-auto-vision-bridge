import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyRuntime, runtimeDiagnostics } from "../lib/runtime.js";
import { CircuitBreaker } from "../lib/breaker.js";
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
      // 嵌套服务注入：deps 里的服务都存在才回调，否则安静跳过
      // （与 cordis 的 ctx.inject 同语义：缺服务时该功能整体不装配）。
      inject(deps, callback) {
        const missing = deps.filter((name) => services[name] === undefined);
        if (missing.length > 0) return () => {};
        const child = makeContext(true);
        children.push(child);
        callback(child);
        return () => {};
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
  const config = testConfig({ pool: [{ provider: "c2a", model: "vision", maxConcurrent: 2 }] });
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
  // llm 通道要求图片先落成持久引用。
  const admitted = [];
  f.services.attachments.saveImages = async (inputs) => inputs.map((input) => {
    const saved = { attachmentId: "sha256:admitted", mediaType: input.mediaType, bytes: input.data.byteLength };
    admitted.push(saved);
    return saved;
  });
  const llmCalls = [];
  f.services.llm.prepareCall = async (callConfig) => {
    llmCalls.push(callConfig);
    return {
      config: callConfig,
      async *stream() { yield { text: "运行时复核结果" }; },
    };
  };
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
  // 工具返回数组，每项与输入一一对应。
  assert.deepEqual(result, [{
    index: 0,
    source: "attachmentId",
    id: ref.attachmentId,
    ok: true,
    text: "运行时复核结果",
  }]);
  assert.equal(reads.length, 1);
  assert.strictEqual(reads[0].actualRef, ref);
  assert.strictEqual(reads[0].signal, controller.signal);
  assert.equal(admitted.length, 1);
  assert.equal(llmCalls.length, 1);
  assert.equal(llmCalls[0].provider, "c2a");
  assert.equal(llmCalls[0].model, "vision");

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

test("配置 schema 暴露并发、池与重试项，且顶层为 volatile", async () => {
  const manifest = await import("../index.js");
  const schema = manifest.Config;
  assert.equal(schema.meta.volatile, true);
  // 只保留模型池配置：不再有独立的端点、凭据与视觉模型字段。
  for (const field of ["enabled", "prompt", "timeoutMs", "maxImageBytes",
    "retries", "retryDelayMs", "maxConcurrent", "pool"]) {
    assert.ok(Object.hasOwn(schema.dict, field), `缺少配置字段 ${field}`);
  }
  for (const field of ["baseURL", "apiKey", "apiKeyEnv", "model"]) {
    assert.equal(Object.hasOwn(schema.dict, field), false, `不应再有配置字段 ${field}`);
  }
  assert.equal(schema.dict.pool.type, "array");
  const entry = schema.dict.pool.inner;
  for (const field of ["provider", "model", "maxConcurrent"]) {
    assert.ok(Object.hasOwn(entry.dict, field), `池条目缺少字段 ${field}`);
  }
  assert.equal(Object.hasOwn(entry.dict, "baseURL"), false);
  assert.equal(Object.hasOwn(entry.dict, "apiKey"), false);
});

test("运行时把熔断器同时接给调度器与视觉客户端，并暴露诊断视图", async () => {
  // 回归保护：runtime 曾经自建 PoolScheduler 却漏传 breaker，
  // 导致熔断在真实运行时完全不生效，而注入 scheduler 的单测看不出来。
  const config = testConfig({
    pool: [{ provider: "c2a", model: "vision", maxConcurrent: 2 }],
    failureThreshold: 1,
    cooldownMs: 60000,
  });
  const f = cordisFixture(config);
  applyRuntime(f.ctx, config, identityDefineTool);

  const view = runtimeDiagnostics(f.ctx);
  assert.ok(view, "应暴露诊断视图");
  assert.deepEqual(view.trippedKeys(), []);
  assert.deepEqual(view.cooldowns(), {});
  assert.equal(typeof view.trippedKeys, "function");
  assert.equal(typeof view.cooldowns, "function");

  for (const dispose of f.rootEffects.reverse()) await dispose?.();
});

test("诊断视图不挂在 ctx 上：Cordis 的 ctx 是 Proxy，赋值会抛 without provide", async () => {
  // 回归保护：曾把诊断视图直接赋给 ctx.diagnostics，导致插件在真实宿主里
  // 加载失败（cannot set property "diagnostics" without provide）。
  const config = testConfig({ pool: [{ provider: "c2a", model: "vision", maxConcurrent: 2 }] });
  const f = cordisFixture(config);
  // 用 Proxy 复刻 Cordis ctx：给未声明的属性赋值会抛错。
  const proxied = new Proxy(f.ctx, {
    set(target, prop, value) {
      if (prop === "diagnostics") throw new Error('cannot set property "diagnostics" without provide');
      return Reflect.set(target, prop, value);
    },
  });
  // 修复后 applyRuntime 不碰 ctx 的属性，必须能正常加载。
  assert.doesNotThrow(() => applyRuntime(proxied, config, identityDefineTool));
  // 视图通过 runtimeDiagnostics 读取，而不是往 ctx 上挂。
  assert.ok(runtimeDiagnostics(proxied), "诊断视图应通过 runtimeDiagnostics 读取");
  // 直接给 ctx 赋未声明的属性仍然是宿主禁止的行为——这正是原 bug 的成因。
  assert.throws(() => { "use strict"; proxied.diagnostics = {}; }, /without provide/);

  for (const dispose of f.rootEffects.reverse()) await dispose?.();
});

test("诊断视图反映熔断状态：冷却中的条目可见且带剩余毫秒", async () => {
  const config = testConfig({
    pool: [{ provider: "c2a", model: "vision", maxConcurrent: 2 }],
    failureThreshold: 1,
    cooldownMs: 60000,
  });
  const f = cordisFixture(config);
  applyRuntime(f.ctx, config, identityDefineTool);

  const view = runtimeDiagnostics(f.ctx);
  assert.equal(view.trippedKeys().length, 0);
  assert.equal(Object.keys(view.cooldowns()).length, 0);

  // 注入一个真实熔断器并让它熔断，验证诊断视图如实反映。
  const breaker = new CircuitBreaker(() => ({ failureThreshold: 1, cooldownMs: 60000 }));
  breaker.recordFailure("c2avision", "recoverable");
  view.__setBreaker(breaker);

  assert.deepEqual(view.trippedKeys(), ["c2avision"]);
  const cooldowns = view.cooldowns();
  assert.ok(cooldowns.c2avision, "应列出冷却中的条目");
  assert.ok(cooldowns.c2avision.remaining > 0, "应给出剩余冷却毫秒数");
  assert.equal(cooldowns.c2avision.failures, 1);

  for (const dispose of f.rootEffects.reverse()) await dispose?.();
});
