import { attachPreStepBridge } from "./bridge.js";
import { createInspectImageTool } from "./inspect-image.js";
import { installAutoImageAdmission } from "./route.js";
import { VisionClient } from "./vision-client.js";

const SETTINGS_NS = "auto-vision-bridge";

/** 运行时组合与配置 schema 分离，便于用假 Cordis fiber 验证热禁用。 */
export function applyRuntime(ctx, config, defineTool) {
  const getConfig = () => typeof config?.get === "function" ? config.get() : config;
  let featureFiber = null;

  function installFeatures() {
    if (featureFiber) return;
    featureFiber = ctx.plugin({
      name: "dsh-auto-vision-bridge:features",
      apply(inner) {
        const client = new VisionClient(getConfig);
        attachPreStepBridge(inner, { client, getConfig });
        const restoreAdmission = installAutoImageAdmission(inner.get("llm"), inner.logger);
        inner.effect(() => restoreAdmission, "auto-vision-bridge: 图片上传准入");
        inner.tools.register(createInspectImageTool(defineTool, { ctx: inner, client, getConfig }));
      },
    });
  }

  function uninstallFeatures() {
    const fiber = featureFiber;
    featureFiber = null;
    if (fiber) Promise.resolve(fiber.dispose()).catch((error) => {
      ctx.logger?.warn?.(`[auto-vision-bridge] 功能卸载失败：${String(error?.message ?? error)}`);
    });
  }

  function syncFeatures() {
    if (getConfig().enabled === false) uninstallFeatures();
    else installFeatures();
  }

  ctx.on("settings/document-updated", (id) => {
    if (id === SETTINGS_NS) syncFeatures();
  });
  ctx.effect(() => () => uninstallFeatures(), "auto-vision-bridge: 功能生命周期");
  syncFeatures();
}
