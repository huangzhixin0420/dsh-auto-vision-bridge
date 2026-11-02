import test from "node:test";
import assert from "node:assert/strict";
import { currentRoute, installAutoImageAdmission, routeModality, unwrappedResolveModelInfo } from "../lib/route.js";

test("路由选择 pending > lastUsed > requestHeader > agent.options", () => {
  const session = { requestHeader: () => ({ config: { provider: "header", model: "header-model" } }) };
  const agent = { session, options: { provider: "option", model: "option-model" } };
  const projections = (state) => ({ stateOf: () => state });
  assert.deepEqual(currentRoute(agent, projections({
    pending: { provider: "pending", model: "pending-model" },
    lastUsed: { provider: "last", model: "last-model" },
  })), { provider: "pending", model: "pending-model", source: "pending" });
  assert.deepEqual(currentRoute(agent, projections({
    pending: null,
    lastUsed: { provider: "last", model: "last-model" },
  })), { provider: "last", model: "last-model", source: "lastUsed" });
  assert.deepEqual(currentRoute(agent, projections(null)), {
    provider: "header", model: "header-model", source: "requestHeader",
  });
  assert.deepEqual(currentRoute({ options: agent.options }, projections(null)), {
    provider: "option", model: "option-model", source: "agent.options",
  });
});

test("准入仅包装 resolveModelInfo：文本补 image，原生和未知声明不改写", async () => {
  const raw = async (_provider, model) => {
    if (model === "text") return { inputModalities: ["text"] };
    if (model === "native") return { inputModalities: ["text", "image"] };
    return {};
  };
  const registration = () => ({ adapter: { prepareCall() {} } });
  const llm = { resolveModelInfo: raw, registration };
  const dispose = installAutoImageAdmission(llm);
  assert.notStrictEqual(llm.resolveModelInfo, raw);
  assert.strictEqual(llm.registration, registration);
  assert.deepEqual((await llm.resolveModelInfo("p", "text")).inputModalities, ["text", "image"]);
  const native = await llm.resolveModelInfo("p", "native");
  assert.deepEqual(native.inputModalities, ["text", "image"]);
  assert.deepEqual((await llm.resolveModelInfo("p", "unknown")), {});
  assert.equal(await routeModality(llm, { provider: "p", model: "text" }), "text");
  assert.equal(await routeModality(llm, { provider: "p", model: "native" }), "image");
  assert.equal(await routeModality(llm, { provider: "p", model: "unknown" }), "unknown");
  dispose();
  assert.strictEqual(llm.resolveModelInfo, raw);
});

test("HMR 重复安装幂等，最后一个 dispose 恢复原函数并清理标记", async () => {
  const raw = async () => ({ inputModalities: ["text"] });
  const llm = { resolveModelInfo: raw };
  const disposeA = installAutoImageAdmission(llm);
  const wrapped = llm.resolveModelInfo;
  const originalA = unwrappedResolveModelInfo(llm);
  const disposeB = installAutoImageAdmission(llm);
  assert.strictEqual(llm.resolveModelInfo, wrapped);
  disposeA();
  disposeA(); // dispose 自身也幂等
  assert.strictEqual(llm.resolveModelInfo, wrapped);
  assert.equal(await routeModality(llm, { provider: "p", model: "m" }), "text");
  assert.strictEqual(unwrappedResolveModelInfo(llm) !== undefined, true);
  assert.strictEqual(typeof originalA, "function");
  disposeB();
  assert.strictEqual(llm.resolveModelInfo, raw);
});
