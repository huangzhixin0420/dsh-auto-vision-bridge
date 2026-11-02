import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { BRIDGE_END, BRIDGE_START, stripBridgedText, transcriptionBlock } from "../lib/markers.js";
import { attachment } from "./helpers.js";

function clientRequire(models, id) {
  if (id === "react/jsx-runtime") {
    const element = (type, props, key) => ({ type, props, key });
    return { jsx: element, jsxs: element };
  }
  if (id === "@deepseek-ai/dsh-client-ui-primitives") {
    class SettingsFormModel {
      constructor(scope, fields, secrets) {
        this.scope = scope;
        this.fields = fields;
        this.secrets = secrets;
        models.push(this);
      }
      shell() {
        return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false };
      }
      field(name) { return { text: String(this.scope.getSnapshot().value?.[name] ?? "") }; }
      bind(project) { return { getSnapshot: project, subscribe() { return () => {}; } }; }
      actions() {
        return {
          edit: (name, text) => { this.scope.getSnapshot().value[name] = text; },
          resetField() {}, save() {}, discard() {},
        };
      }
      dispose() { this.disposed = true; }
    }
    return {
      SettingsFormModel,
      settingsTextField: (field) => ({ field }),
      settingsNumberField: (field) => ({ field, numeric: true }),
      SettingsForm() {}, SettingsValueField() {}, SettingsSecretField() {}, Switch() {},
    };
  }
  throw new Error(`未预期的客户端依赖：${id}`);
}

function settingsContext(overrides = {}) {
  const registrations = [];
  const writes = [];
  const scope = {
    value: { enabled: true },
    getSnapshot() { return { value: this.value, writable: true }; },
    async set(name, value) { writes.push([name, value]); this.value[name] = value; return true; },
  };
  const mirror = {
    getSnapshot: () => ({
      view: {
        namespaces: [{ ns: "auto-vision-bridge", secrets: [{ path: ["apiKey"], set: true }] }],
      },
    }),
  };
  const ctx = {
    disposers: [],
    effect(fn) { const dispose = fn(); this.disposers.push(dispose); return dispose; },
    configForms: {
      get(name) { assert.equal(name, "auto-vision-bridge"); return scope; },
      describe() { return mirror; },
      whileServed(names, register) {
        assert.deepEqual([...names], ["auto-vision-bridge"]);
        return register(new Set(names));
      },
    },
    slots: {
      inject(_name, register) { return register(); },
      register(options, component) {
        registrations.push({ ...options, component });
        return () => {};
      },
    },
    ...overrides,
  };
  return { ctx, registrations, writes, scope };
}

async function loadClient(extra = {}) {
  const code = await readFile(new URL("../client.js", import.meta.url), "utf8");
  const models = [];
  let definition;
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    document: { body: null },
    MutationObserver: class { observe() {} disconnect() {} },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    ...extra,
  };
  vm.runInNewContext(code, sandbox, { filename: "client.js" });
  const exports = definition.factory((id) => clientRequire(models, id));
  return { exports, models };
}

test("client 仅删除所有完整标记段，不多删前后用户文字", async () => {
  const { exports } = await loadClient();
  const clean = exports.__test.stripBridgedText;
  assert.equal(exports.__test.START, BRIDGE_START);
  assert.equal(exports.__test.END, BRIDGE_END);
  const one = transcriptionBlock(attachment("sha256:1"), 0, "第一张").text;
  const two = transcriptionBlock(attachment("sha256:2"), 1, "第二张").text;
  assert.equal(clean(`用户前文${one}用户中段${two}用户后文`), "用户前文用户中段用户后文");
  assert.equal(clean("普通 [auto-vision-bridge:start] 文本"), "普通 [auto-vision-bridge:start] 文本");
  const incomplete = `用户文字${BRIDGE_START}\n没有结束标记`;
  assert.equal(clean(incomplete), incomplete);
  assert.equal(stripBridgedText(`A${one}B${two}C`), "ABC");
});

test("client 初次扫描覆盖刷新，MutationObserver 覆盖新增多文本块，且不创建图片预览", async () => {
  const marked = transcriptionBlock(attachment("sha256:dom"), 0, "隐藏").text;
  const nodes = [{ data: `前文${marked}后文` }];
  let observer;
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; observer = this; }
    observe(_target, options) { this.options = options; }
    disconnect() { this.disconnected = true; }
  }
  const document = {
    body: {},
    createTreeWalker() {
      let index = -1;
      return {
        currentNode: null,
        nextNode() {
          index++;
          while (index < nodes.length && !nodes[index].data.includes(BRIDGE_START)) index++;
          if (index >= nodes.length) return false;
          this.currentNode = nodes[index];
          return true;
        },
      };
    },
  };
  const { exports } = await loadClient({
    document,
    MutationObserver: FakeMutationObserver,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
  });
  const { ctx } = settingsContext();
  exports.apply(ctx);
  assert.equal(nodes[0].data, "前文后文");
  assert.equal(observer.options.childList, true);
  assert.equal(observer.options.subtree, true);
  assert.equal(observer.options.characterData, true);

  nodes.push({ data: `甲${marked}乙${marked}丙` });
  observer.callback();
  assert.equal(nodes[1].data, "甲乙丙");
  ctx.disposers.at(-1)();
  assert.equal(observer.disconnected, true);
});

test("顶层设置复用 auto-vision-bridge 配置并覆盖全部 9 项", async () => {
  const { exports, models } = await loadClient();
  const { ctx, registrations, writes, scope } = settingsContext();
  exports.apply(ctx);
  assert.deepEqual([...exports.inject], ["slots", "configForms"]);
  assert.deepEqual(registrations.map((item) => item.name), ["settings.section"]);
  assert.equal(registrations[0].id, "auto-vision-bridge");
  assert.equal(registrations[0].label, "自动视觉桥接");

  assert.equal(models.length, 1);
  const model = models[0];
  assert.equal(model.scope, scope);
  const covered = [...model.fields.map((item) => item.field), ...model.secrets.map((item) => item.field), "enabled"];
  assert.deepEqual(covered.sort(), [
    "apiKey", "apiKeyEnv", "baseURL", "enabled", "maxImageBytes",
    "maxTokens", "model", "prompt", "timeoutMs",
  ]);
  const face = registrations[0].inject();
  assert.equal(face.hooks.autoVision, registrations[0].inject().hooks.autoVision);
  face.setEnabled(false);
  await model.secrets[0].write("test-secret");
  assert.deepEqual(writes, [["enabled", false], ["apiKey", "test-secret"]]);

  const state = face.hooks.autoVision.getSnapshot();
  const tree = registrations[0].component({
    ...face,
    useAutoVision: (select) => select(state),
  });
  const nodes = [];
  function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    nodes.push(node);
    visit(node.props?.children);
  }
  visit(tree);
  assert.equal(nodes.find((node) => node.type === "h3")?.props.children, "自动视觉桥接");
  assert.equal(nodes.find((node) => node.type?.name === "SettingsSecretField")?.props.label, "视觉 API 密钥");
  assert.equal(nodes.filter((node) => node.type?.name === "SettingsValueField").length, 6);
  assert.equal(nodes.some((node) => node.props?.["data-auto-vision-prompt"] === true), true);

  ctx.disposers[0]();
  assert.equal(model.disposed, true);
});
