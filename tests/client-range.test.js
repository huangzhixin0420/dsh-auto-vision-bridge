import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { BRIDGE_END, BRIDGE_START, transcriptionBlock } from "../lib/markers.js";
import { attachment } from "./helpers.js";

/** client.js 的 factory 需要宿主依赖；本组用例只测纯 DOM 工具，给最小替身。 */
function clientRequire(id) {
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
    return {
      SettingsFormModel: class {},
      settingsTextField: () => {},
      settingsNumberField: () => {},
      SettingsForm() {}, SettingsValueField() {}, SettingsSecretField() {}, Switch() {},
    };
  }
  throw new Error(`未预期的客户端依赖：${id}`);
}

/** 最小假的 text node：只需要 data、nodeType 与 parentElement。 */
function textNode(data, parent) {
  return {
    nodeType: 3,
    nodeName: "#text",
    data,
    parentElement: parent ?? null,
  };
}

/** 构造一个父元素，把若干 text node 挂成它的子节点。 */
function parentWith(children) {
  const parent = { nodeType: 1, tagName: "SPAN", childNodes: [] };
  for (const child of children) {
    child.parentElement = parent;
    parent.childNodes.push(child);
  }
  return parent;
}

async function loadClient(extra = {}) {
  const code = await readFile(new URL("../client.js", import.meta.url), "utf8");
  let definition;
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    document: { body: null },
    MutationObserver: class { observe() {} disconnect() {} },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    ...extra,
  };
  vm.runInNewContext(code, sandbox, { filename: "client.js" });
  const exports = definition.factory(clientRequire);
  return { exports };
}

test("跨节点清理：START 与 END 分处不同 text node 时整段被清掉", async () => {
  const { exports } = await loadClient();
  const stripRange = exports.__test.stripBridgedRange;
  const marked = transcriptionBlock(attachment("sha256:split"), 0, "转写正文").text;
  const start = marked.indexOf(BRIDGE_START);
  const end = marked.indexOf(BRIDGE_END);
  // DSH 0.2.2 会把一段文本切成多个 span，标记落在不同节点。
  const head = textNode(marked.slice(0, end - start));
  const middle = textNode("中间正文");
  const tail = textNode(marked.slice(end - start));
  const parent = parentWith([head, middle, tail]);

  const cleared = stripRange(head);
  assert.ok(cleared.length > 0, "应清掉至少一个节点");
  assert.equal(head.data, "");
  assert.equal(middle.data, "");
  assert.equal(tail.data, "");
  assert.equal(parent.childNodes.length, 3, "只清内容，不删节点");
});

test("跨节点清理：结束标记之后的内容原样保留", async () => {
  const { exports } = await loadClient();
  const stripRange = exports.__test.stripBridgedRange;
  const marked = transcriptionBlock(attachment("sha256:keep"), 0, "转写正文").text;
  const end = marked.indexOf(BRIDGE_END);
  const head = textNode(marked.slice(0, end));
  const tail = textNode(`${BRIDGE_END}用户后文`);
  parentWith([head, tail]);

  stripRange(head);
  assert.equal(head.data, "");
  assert.equal(tail.data, "用户后文");
});

test("跨节点清理：找不到结束标记时不删任何内容", async () => {
  const { exports } = await loadClient();
  const stripRange = exports.__test.stripBridgedRange;
  const head = textNode(`${BRIDGE_START}没有结束标记`);
  const other = textNode("用户文字");
  parentWith([head, other]);

  const cleared = stripRange(head);
  assert.equal(cleared.length, 0);
  assert.equal(head.data, `${BRIDGE_START}没有结束标记`);
  assert.equal(other.data, "用户文字");
});

test("跨节点清理：同一节点内的完整标记仍由单节点清理处理", async () => {
  const { exports } = await loadClient();
  const stripRange = exports.__test.stripBridgedRange;
  const marked = transcriptionBlock(attachment("sha256:same"), 0, "转写正文").text;
  const node = textNode(`前文${marked}后文`);
  parentWith([node]);

  // 同一节点里 END 在 START 之后，跨节点清理同样能覆盖。
  const cleared = stripRange(node);
  assert.ok(cleared.length > 0);
  assert.equal(node.data, "前文后文");
});
