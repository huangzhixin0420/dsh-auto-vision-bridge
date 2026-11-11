import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { BRIDGE_END, BRIDGE_START } from "../lib/markers.js";

// 跨节点清理的验证场景（2026-11-10 实测定位的缺陷）：
//   DSH 0.2.2 起把一段用户文本切成多个节点，节点之间可能夹 chip 元素
//   （skill / 文件引用 / 密钥遮罩），于是 START 与 END 落进**不同父元素**。
//   旧算法只认「同一父元素下的兄弟 text node」，跨父元素时找不到 END 就
//   静默放弃 —— Chrome 实测：清理模式 none、0 节点清除、转写正文完整泄漏。
//   生产 44 个转写块里 1 例命中（2.3%），与「偶现」吻合。
//
// 现在按文档序遍历，跨任意层级都能找到 END。

/** client.js 的 factory 需要宿主依赖；本组用例只测纯 DOM 工具，给最小替身。 */
function clientRequire(id) {
  if (id === "react/jsx-runtime") {
    const element = (type, props, key) => ({ type, props, key });
    return { jsx: element, jsxs: element };
  }
  if (id === "react") {
    return {
      useState: (init) => [typeof init === "function" ? init() : init, () => {}],
      useEffect: () => {},
    };
  }
  if (id === "@deepseek-ai/dsh-client-ui-primitives") {
    return {
      SettingsFormModel: class {},
      settingsTextField: () => {},
      settingsNumberField: () => {},
      SettingsForm() {}, SettingsValueField() {}, SettingsSecretField() {}, Switch() {},
    };
  }
  throw new Error(`未预期的客户端依赖：${id}`);
}

async function loadClient(extra = {}) {
  const code = await readFile(new URL("../client.js", import.meta.url), "utf8");
  let definition;
  const body = { nodeType: 1, tagName: "BODY", childNodes: [], parentElement: null, nextSibling: null };
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    document: { body },
    MutationObserver: class { observe() {} disconnect() {} },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    ...extra,
  };
  vm.runInNewContext(code, sandbox, { filename: "client.js" });
  const exports = definition.factory(clientRequire);
  return { exports, body };
}

/**
 * 造一棵带 nextSibling / parentElement 的假 DOM 树。
 *
 * 用数组表示每个元素节点的子节点数组；文本节点有 data。
 * 根节点挂在 body 下，body 是文档序的终点（算法在 body 处停下）。
 */
function buildTree(spec, parent = null) {
  const node = {
    nodeType: spec.type === "text" ? 3 : 1,
    data: spec.data ?? "",
    parentElement: parent,
    childNodes: [],
    nextSibling: null,
  };
  if (spec.type === "text") return node;
  for (const child of spec.children ?? []) {
    node.childNodes.push(buildTree(child, node));
  }
  // 串起兄弟链
  for (let index = 0; index < node.childNodes.length; index += 1) {
    node.childNodes[index].nextSibling = node.childNodes[index + 1] ?? null;
  }
  return node;
}

/** 取整棵树的文本内容。 */
function textOf(node) {
  if (node.nodeType === 3) return node.data;
  return node.childNodes.map(textOf).join("");
}

/** 收集所有 text node。 */
function textNodesOf(node, out = []) {
  if (node.nodeType === 3) {
    out.push(node);
    return out;
  }
  for (const child of node.childNodes) textNodesOf(child, out);
  return out;
}

/** 构造带标记的文本（START + 正文 + END）。 */
function marked(body) {
  return `${BRIDGE_START}\n[附件：a.png]\n${body}\n${BRIDGE_END}`;
}

test("跨节点清理：START 与 END 分处不同 text node（同父）时整段被清掉", async () => {
  const { exports } = await loadClient();
  const stripRange = exports.__test.stripBridgedRange;
  const content = marked("转写正文");
  const end = content.indexOf(BRIDGE_END);
  const root = buildTree({
    type: "el",
    children: [
      { type: "text", data: content.slice(0, end) },
      { type: "text", data: "中间正文" },
      { type: "text", data: content.slice(end) },
    ],
  });
  const [head, middle, tail] = textNodesOf(root);

  const cleared = stripRange(head);
  assert.ok(cleared.length > 0, "应清掉至少一个节点");
  assert.equal(head.data, "");
  assert.equal(middle.data, "");
  assert.equal(tail.data, "");
  assert.equal(root.childNodes.length, 3, "只清内容，不删节点");
});

test("跨节点清理：START 与 END 分属不同父元素时也能清干净（核心回归）", async () => {
  const { exports } = await loadClient();
  const stripRange = exports.__test.stripBridgedRange;
  const content = marked("转写正文");
  const start = content.indexOf(BRIDGE_START);
  const end = content.indexOf(BRIDGE_END) + BRIDGE_END.length;
  // 复刻真实 DOM：START 在第一个 span 里，chip 夹在中间，
  // END 在最后一个 span 里 —— START 与 END 分属不同父元素。
  const root = buildTree({
    type: "el",
    children: [
      { type: "el", children: [{ type: "text", data: content.slice(start, start + 12) }] },
      { type: "el", children: [{ type: "text", data: "@/Users/leo/x.png" }] },
      { type: "el", children: [{ type: "text", data: content.slice(start + 12, end) }] },
      { type: "el", children: [{ type: "text", data: "看图" }] },
    ],
  });
  const nodes = textNodesOf(root);
  const startNode = nodes[0];

  const cleared = stripRange(startNode);
  assert.ok(cleared.length > 0, "应清掉至少一个节点");
  // 转写正文不得残留在文本里。
  assert.ok(!textOf(root).includes("转写正文"), "转写正文必须被清掉");
  assert.ok(!textOf(root).includes(BRIDGE_START), "起始标记必须被清掉");
  assert.ok(!textOf(root).includes(BRIDGE_END), "结束标记必须被清掉");
  // 用户自己的文字要留着。
  assert.ok(textOf(root).includes("看图"), "用户文字必须保留");
});

test("跨节点清理：结束标记之后的内容原样保留", async () => {
  const { exports } = await loadClient();
  const stripRange = exports.__test.stripBridgedRange;
  const content = marked("转写正文");
  const end = content.indexOf(BRIDGE_END);
  const root = buildTree({
    type: "el",
    children: [
      { type: "text", data: content.slice(0, end) },
      { type: "text", data: `${BRIDGE_END}用户后文` },
    ],
  });
  const [head, tail] = textNodesOf(root);

  stripRange(head);
  assert.equal(head.data, "");
  assert.equal(tail.data, "用户后文");
});

test("跨节点清理：找不到结束标记时不删任何内容", async () => {
  const { exports } = await loadClient();
  const stripRange = exports.__test.stripBridgedRange;
  const root = buildTree({
    type: "el",
    children: [
      { type: "text", data: `${BRIDGE_START}没有结束标记` },
      { type: "text", data: "用户文字" },
    ],
  });
  const [head, other] = textNodesOf(root);

  const cleared = stripRange(head);
  // 找不到 END 时不能删任何内容 —— 宁可留着，也不要猜着删用户文字。
  assert.equal(cleared.length, 0, "找不到 END 时不应清任何节点");
  assert.ok(textOf(root).includes("没有结束标记"), "找不到 END 时内容必须原样保留");
  assert.equal(other.data, "用户文字");
});

test("跨节点清理：同一节点内的完整标记由单节点清理处理", async () => {
  const { exports } = await loadClient();
  const stripRange = exports.__test.stripBridgedRange;
  const content = marked("转写正文");
  const root = buildTree({
    type: "el",
    children: [{ type: "text", data: `前文${content}后文` }],
  });
  const [node] = textNodesOf(root);

  const cleared = stripRange(node);
  assert.ok(cleared.length > 0);
  assert.equal(node.data, "前文后文");
});

test("跨节点清理：START 之前的用户文字不被误删", async () => {
  const { exports } = await loadClient();
  const stripRange = exports.__test.stripBridgedRange;
  const content = marked("转写正文");
  const root = buildTree({
    type: "el",
    children: [{ type: "text", data: `用户先说的话\n${content}后说的话` }],
  });
  const [node] = textNodesOf(root);

  stripRange(node);
  assert.ok(textOf(root).includes("用户先说的话"), "START 之前的用户文字必须保留");
  assert.ok(textOf(root).includes("后说的话"), "END 之后的用户文字必须保留");
  assert.ok(!textOf(root).includes("转写正文"), "转写正文必须被清掉");
});
