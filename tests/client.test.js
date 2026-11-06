import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { BRIDGE_END, BRIDGE_START, stripBridgedText, transcriptionBlock } from "../lib/markers.js";
import { attachment } from "./helpers.js";

/** 宿主快照 store 的深冻结行为：只有新对象能写，被冻结对象写入无效。 */
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function clientRequire(models, id) {
  if (id === "react/jsx-runtime") {
    const element = (type, props, key) => ({ type, props, key });
    return { jsx: element, jsxs: element };
  }
  if (id === "react") {
    // 识图历史页用到 useState/useEffect；测试里只提供最小替身。
    return {
      useState: (init) => [typeof init === "function" ? init() : init, () => {}],
      useEffect: () => {},
    };
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
      bind(project) {
        const store = {
          snapshot: project(),
          getSnapshot() { return this.snapshot; },
          // 宿主快照 store 会深冻结写入的值；草稿数组本体若被交给它，
          // 后续字段赋值会被静默吞掉（读取正常、写入无效）。
          set(value) { this.snapshot = deepFreeze(value); },
          subscribe() { return () => {}; },
        };
        return store;
      }
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
  const mutates = [];
  const scope = {
    value: { enabled: true, pool: [] },
    getSnapshot() {
      return { value: this.value, user: {}, writable: true, revision: 1 };
    },
    async set(name, value) { writes.push([name, value]); this.value[name] = value; return true; },
    async mutate(ops) { mutates.push(ops); return true; },
  };
  const mirror = {
    getSnapshot: () => ({
      view: {
        namespaces: [{ ns: "auto-vision-bridge", secrets: [{ path: ["apiKey"], set: true }] }],
      },
    }),
  };
  const catalog = {
    ok: true,
    value: {
      groups: [
        {
          id: "c2a",
          name: "c2a (codingplan2api)",
          models: [
            { id: "vision", name: "c2a vision", inputModalities: ["text", "image"] },
            { id: "paid", name: "c2a paid", inputModalities: ["text"] },
          ],
        },
        {
          id: "other",
          name: "另一个提供方",
          models: [{ id: "vl", name: "视觉模型", inputModalities: ["text", "image"] }],
        },
      ],
      failures: [],
    },
  };
  const ctx = {
    disposers: [],
    effect(fn) { const dispose = fn(); this.disposers.push(dispose); return dispose; },
    remote: {
      session: {
        async modelCatalog() { return catalog; },
      },
    },
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
  return { ctx, registrations, writes, mutates, scope };
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

/**
 * 构造贴近 DSH 真实结构的假 DOM：消息列里是附件行 + 气泡兄弟。
 *
 * 元素桩只提供客户端实际用到的那几个接口：textContent、children、
 * childNodes、appendChild、hasAttribute、getAttribute、setAttribute、querySelector。
 */
function buildBubbleDocument(specs) {
  const registry = new Map();
  const body = { children: [], childNodes: [] };
  const createElement = (tag) => {
    const element = {
      tagName: tag.toUpperCase(),
      children: [],
      childNodes: [],
      attributes: {},
      style: {},
      parentElement: null,
      get textContent() {
        return this.childNodes.map((node) => node.textContent ?? "").join("");
      },
      set textContent(value) {
        this.childNodes = [{ textContent: String(value) }];
      },
      appendChild(node) {
        this.childNodes.push(node);
        this.children.push(node);
        node.parentElement = this;
        return node;
      },
      hasAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name);
      },
      getAttribute(name) {
        return this.hasAttribute(name) ? this.attributes[name] : null;
      },
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      querySelector(selector) {
        for (const child of this.children) {
          if (child.tagName === String(selector).toUpperCase()) return child;
          const found = child.querySelector?.(selector);
          if (found) return found;
        }
        return null;
      },
    };
    return element;
  };

  for (const spec of specs) {
    const column = createElement("div");
    const bubble = createElement("div");
    // 文本节点要挂在气泡下，客户端从它往上找气泡。
    // 客户端改的是 data，bubble 的 textContent 由它派生。
    const textNode = { data: spec.text, childNodes: [], children: [] };
    Object.defineProperty(textNode, "textContent", {
      get() { return this.data; },
      set(value) { this.data = String(value); },
    });
    bubble.appendChild(textNode);
    column.appendChild(bubble);
    if (spec.hasAttachments) {
      const row = createElement("div");
      row.setAttribute("data-message-attachments", "true");
      column.appendChild(row);
    }
    body.children.push(column);
    body.childNodes.push(column);
    registry.set(spec.name, { column, bubble, textNode });
  }

  // 客户端靠 TreeWalker 找文本节点；这里按深度优先吐出所有文本节点。
  const textNodes = [];
  const collect = (element) => {
    for (const child of element.childNodes ?? []) {
      if (!child || !Array.isArray(child.childNodes)) continue;
      if (child.childNodes.length === 0) {
        textNodes.push(child);
        continue;
      }
      collect(child);
    }
  };
  collect(body);
  const walker = () => {
    let index = 0;
    return {
      nextNode() {
        const node = textNodes[index];
        index += 1;
        return node ?? null;
      },
      get currentNode() { return textNodes[index - 1] ?? null; },
    };
  };

  // 客户端用的是 document.createTreeWalker(document.body, ...)。
  const document = {
    body,
    createTreeWalker: walker,
  };

  return {
    body,
    document,
    byName(name) { return registry.get(name); },
  };
}

test("仅图片消息的空气泡被隐藏，图片与用户文字气泡不受影响", async () => {
  const marked = transcriptionBlock(attachment("sha256:bubble"), 0, "隐藏").text;
  const document = buildBubbleDocument([
    { name: "empty-bubble", text: marked, hasAttachments: true },
    { name: "text-bubble", text: `用户文字${marked}`, hasAttachments: true },
    { name: "no-attachment", text: marked, hasAttachments: false },
  ]);
  const { exports } = await loadClient({
    document: document.document,
    MutationObserver: class { observe() {} disconnect() {} },
  });
  const { ctx } = settingsContext();
  exports.apply(ctx);

  const empty = document.byName("empty-bubble");
  assert.equal(empty.bubble.style.display, "none");
  assert.equal(empty.bubble.getAttribute("data-auto-vision-empty-bubble"), "true");

  const withText = document.byName("text-bubble");
  assert.notEqual(withText.bubble.style.display, "none");
  assert.equal(withText.bubble.getAttribute("data-auto-vision-empty-bubble"), null);
  assert.equal(withText.bubble.textContent, "用户文字");

  // 没有附件行时不做任何隐藏，避免误伤助手消息或其他文本容器。
  const noAttachment = document.byName("no-attachment");
  assert.notEqual(noAttachment.bubble.style.display, "none");
});

test("顶层设置复用 auto-vision-bridge 配置，只保留模型池与并发/重试项", async () => {
  const { exports, models } = await loadClient();
  const { ctx, registrations, writes } = settingsContext();
  exports.apply(ctx);
  assert.deepEqual([...exports.inject], ["slots", "remote", "remote.session", "configForms"]);
  // 设置页 + 识图历史页（侧栏条目与独立主页面）。
  assert.deepEqual(registrations.map((item) => item.name), ["settings.section", "main", "sidebar.panellist"]);
  assert.equal(registrations[0].id, "auto-vision-bridge");
  assert.equal(registrations[0].label, "自动视觉桥接");
  assert.equal(registrations[1].key, "auto-vision-bridge-history");
  assert.equal(registrations[1].label, "识图历史");
  assert.equal(registrations[2].id, "auto-vision-bridge-history");
  assert.equal(registrations[2].label, "识图历史");

  assert.equal(models.length, 1);
  const model = models[0];
  assert.equal(model.scope, ctx.configForms.get("auto-vision-bridge"));
  const covered = [...model.fields.map((item) => item.field), ...model.secrets.map((item) => item.field), "enabled"];
  // 不再有端点、凭据与独立的视觉模型字段。
  assert.deepEqual(covered.sort(), [
    "cooldownMs", "dumpThreshold", "enabled", "failureThreshold", "maxConcurrent",
    "maxImageBytes", "prompt", "retries", "retryDelayMs",
    "summaryLength", "timeoutMs",
  ]);

  const face = registrations[0].inject();
  assert.equal(face.hooks.autoVision, registrations[0].inject().hooks.autoVision);
  face.setEnabled(false);
  // 不再有密钥字段：写入的只有开关。
  assert.deepEqual(writes, [["enabled", false]]);
  assert.equal(model.secrets.length, 0);

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
  // 不再有独立的密钥控件与端点/视觉模型输入框。
  assert.equal(nodes.some((node) => node.type?.name === "SettingsSecretField"), false);
  // 10 个标量输入框（含识图历史保留天数）；提示词是独立的 textarea。
  assert.equal(nodes.filter((node) => node.type?.name === "SettingsValueField").length, 10);
  assert.equal(nodes.some((node) => node.props?.["data-auto-vision-prompt"] === true), true);

  ctx.disposers[0]();
  assert.equal(model.disposed, true);
});

test("模型池条目可自由增减，整组经 scope.mutate 写回", async () => {
  const { exports } = await loadClient();
  const { ctx, registrations, mutates } = settingsContext();
  exports.apply(ctx);
  const face = registrations[0].inject();

  // 加五个条目：条目数没有上限。
  for (let i = 0; i < 5; i++) face.addEntry("c2a", `model-${i}`);
  face.editEntry(0, "maxConcurrent", "3");
  face.removeEntry(0);

  const state = face.hooks.autoVision.getSnapshot();
  assert.equal(state.entries.length, 4);
  assert.equal(state.entries[0].provider, "c2a");
  assert.equal(state.entries[0].model, "model-1");
  assert.equal(state.poolDirty, true);

  await face.save();
  assert.equal(mutates.length, 1);
  const payload = JSON.parse(JSON.stringify(mutates[0]));
  assert.equal(payload[0].op, "set");
  assert.deepEqual(payload[0].path, ["pool"]);
  assert.equal(payload[0].value.length, 4);
  assert.deepEqual(Object.keys(payload[0].value[0]).sort(), ["maxConcurrent", "model", "priority", "provider"]);
});

test("池条目只接受来自模型目录的 provider 与模型，重复项不入池", async () => {
  const { exports } = await loadClient();
  const { ctx, registrations } = settingsContext();
  exports.apply(ctx);
  const face = registrations[0].inject();

  face.addEntry("c2a", "vision");
  face.addEntry("c2a", "vision");
  face.addEntry("", "vision");
  face.addEntry("c2a", "");
  const state = face.hooks.autoVision.getSnapshot();
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].provider, "c2a");
  assert.equal(state.entries[0].model, "vision");
});

test("模型目录按提供方分组，并标出每个模型的视觉能力", async () => {
  const { exports } = await loadClient();
  const { ctx, registrations } = settingsContext();
  exports.apply(ctx);
  const face = registrations[0].inject();

  face.loadCatalog();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const state = face.hooks.autoVision.getSnapshot();
  assert.equal(state.catalogStatus, "ready");
  const groups = state.catalogGroups;
  assert.equal(groups.length, 2);
  assert.equal(groups[0].id, "c2a");
  // 全部模型都列出，但标出视觉能力：vision 是视觉模型，paid 需要先声明模态。
  const c2aRows = groups[0].rows;
  assert.equal(c2aRows.map((m) => m.model).includes("paid"), true);
  assert.equal(c2aRows.find((m) => m.model === "vision").vision, true);
  assert.equal(c2aRows.find((m) => m.model === "paid").vision, false);
  // 已在池中的候选会被标记。
  face.addEntry("c2a", "vision");
  const after = face.hooks.autoVision.getSnapshot();
  const marked = after.catalogGroups[0].rows.find((m) => m.model === "vision");
  assert.equal(marked.selected, true);
});

test("池条目并发上限原样保留输入，非法值在落盘时回落为 1", async () => {
  const { exports } = await loadClient();
  const { ctx, registrations, mutates } = settingsContext();
  exports.apply(ctx);
  const face = registrations[0].inject();

  face.addEntry("c2a", "vision");
  // 数字框原样保留用户输入：清空后接着输入不会被拼成 "13"。
  face.editEntry(0, "maxConcurrent", "");
  assert.equal(face.hooks.autoVision.getSnapshot().entries[0].maxConcurrent, "");
  face.editEntry(0, "maxConcurrent", "4");
  assert.equal(face.hooks.autoVision.getSnapshot().entries[0].maxConcurrent, "4");
  // 落盘时才把非法或空值回落为 1。
  await face.save();
  assert.equal(mutates.at(-1)[0].value[0].maxConcurrent, 4);
});

test("池条目优先级原样保留输入，非法值在落盘时回落为 1", async () => {
  const { exports } = await loadClient();
  const { ctx, registrations, mutates } = settingsContext();
  exports.apply(ctx);
  const face = registrations[0].inject();

  face.addEntry("c2a", "vision");
  // 新条目默认优先级 1。
  assert.equal(face.hooks.autoVision.getSnapshot().entries[0].priority, 1);

  // 数字框原样保留用户输入，不当场回落。
  face.editEntry(0, "priority", "");
  assert.equal(face.hooks.autoVision.getSnapshot().entries[0].priority, "");
  face.editEntry(0, "priority", "3");
  assert.equal(face.hooks.autoVision.getSnapshot().entries[0].priority, "3");

  await face.save();
  assert.equal(mutates.at(-1)[0].value[0].priority, 3);
});

test("优先级非法值在落盘时回落为 1，且 dirty 判定包含优先级", async () => {
  const { exports } = await loadClient();
  const { ctx, registrations, mutates } = settingsContext();
  exports.apply(ctx);
  const face = registrations[0].inject();

  face.addEntry("c2a", "vision");
  face.editEntry(0, "priority", "0");
  assert.equal(face.hooks.autoVision.getSnapshot().poolDirty, true);

  await face.save();
  assert.equal(mutates.at(-1)[0].value[0].priority, 1);
});

test("识图历史展示层：短 id、图片名与数值格式化", async () => {
  const { exports } = await loadClient();
  const t = exports.__test;

  assert.equal(t.shortenSessionId("session-10b9ce26-3049-4863-8767-aaa5ad6a96ea"), "10b9ce26");
  assert.equal(t.shortenSessionId(""), "—");
  assert.equal(t.shortenSessionId(undefined), "—");
  assert.equal(t.shortenSessionId("a392b4b0"), "a392b4b0");

  assert.equal(t.imageLabelOf({ imageName: "photo.png", attachmentId: "sha256:abc" }), "photo.png");
  assert.equal(t.imageLabelOf({ imageName: "", attachmentId: "sha256:3f1628eb609f321d" }), "附件 3f1628eb");
  assert.equal(t.imageLabelOf({}), "(未命名)");

  assert.equal(t.formatDuration(0), "0 ms");
  assert.equal(t.formatDuration(850), "850 ms");
  assert.equal(t.formatDuration(1500), "1.50 s");
  assert.equal(t.formatDuration(-1), "—");
  assert.equal(t.formatPercent(0), "0.0%");
  assert.equal(t.formatPercent(0.727), "72.7%");
  assert.equal(t.formatPercent("x"), "—");

  assert.equal(t.HISTORY_ROWS, 20);
  assert.equal(t.HISTORY_ROUTE, "api/auto-vision-bridge.history");
  assert.equal(t.HISTORY_PANEL_ID, "auto-vision-bridge-history");
});
