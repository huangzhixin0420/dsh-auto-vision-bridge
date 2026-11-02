import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { BRIDGE_END, BRIDGE_START, stripBridgedText, transcriptionBlock } from "../lib/markers.js";
import { attachment } from "./helpers.js";

async function loadClient(extra = {}) {
  const code = await readFile(new URL("../client.js", import.meta.url), "utf8");
  let definition;
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    ...extra,
  };
  vm.runInNewContext(code, sandbox, { filename: "client.js" });
  return definition.factory();
}

test("client 仅删除所有完整标记段，不多删前后用户文字", async () => {
  const exports = await loadClient();
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
  const exports = await loadClient({
    document,
    MutationObserver: FakeMutationObserver,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
  });
  let dispose;
  const ctx = { effect(fn) { dispose = fn(); } };
  exports.apply(ctx);
  assert.equal(nodes[0].data, "前文后文");
  assert.equal(observer.options.childList, true);
  assert.equal(observer.options.subtree, true);
  assert.equal(observer.options.characterData, true);

  nodes.push({ data: `甲${marked}乙${marked}丙` });
  observer.callback();
  assert.equal(nodes[1].data, "甲乙丙");
  dispose();
  assert.equal(observer.disconnected, true);
});
