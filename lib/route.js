// Symbol.for 让 HMR 重新加载模块后仍能识别同一宿主服务上的包装。
export const LLM_WRAP_MARK = Symbol.for("dsh-auto-vision-bridge.resolveModelInfo");
/** 适配器层包装的标记：让池内模型真正能接收图片。 */
export const ADAPTER_WRAP_MARK = Symbol.for("dsh-auto-vision-bridge.adapterPrepareCall");

/** 当前路由严格优先使用模型选择 projection 的 pending，再读 lastUsed。 */
export function currentRoute(agent, sessionProjections) {
  let state;
  try { state = sessionProjections?.stateOf(agent?.session, "modelSelection"); } catch { /* 使用兼容回退 */ }
  const selected = state?.pending ?? state?.lastUsed;
  if (typeof selected?.provider === "string" && typeof selected?.model === "string") {
    return { provider: selected.provider, model: selected.model, source: state.pending ? "pending" : "lastUsed" };
  }
  const header = agent?.session?.requestHeader?.();
  const config = header?.config;
  if (typeof config?.model === "string") {
    return {
      provider: config.provider ?? agent?.options?.provider,
      model: config.model,
      source: "requestHeader",
    };
  }
  if (typeof agent?.options?.model === "string") {
    return { provider: agent.options.provider, model: agent.options.model, source: "agent.options" };
  }
  return { provider: undefined, model: undefined, source: "none" };
}

/** 模态判断只读取准入包装前的真实函数。 */
export function unwrappedResolveModelInfo(llm) {
  const marked = llm?.[LLM_WRAP_MARK];
  const fn = marked?.original ?? llm?.resolveModelInfo;
  return typeof fn === "function" ? fn.bind(llm) : undefined;
}

/** image=原生直发；text=显式文本路由；unknown=无法确认，不擅自识图。 */
export async function routeModality(llm, route, signal) {
  const resolve = unwrappedResolveModelInfo(llm);
  if (!resolve || typeof route?.provider !== "string" || typeof route?.model !== "string") return "unknown";
  try {
    const info = await resolve(route.provider, route.model, signal);
    const modalities = info?.inputModalities;
    if (!Array.isArray(modalities)) return "unknown";
    return modalities.includes("image") ? "image" : "text";
  } catch {
    return "unknown";
  }
}

/**
 * 只补宿主的图片上传准入。registration、adapter、prepareCall 一律不碰。
 * 多实例引用计数保证 HMR 幂等，最后一个 dispose 才恢复原函数。
 */
export function installAutoImageAdmission(llm, logger) {
  if (!llm || typeof llm.resolveModelInfo !== "function") {
    logger?.warn?.("[auto-vision-bridge] llm.resolveModelInfo 不可用，未安装图片准入");
    return () => {};
  }
  const owner = Symbol("auto-vision-bridge-owner");
  let marker = llm[LLM_WRAP_MARK];
  if (!marker) {
    const raw = llm.resolveModelInfo;
    const original = raw.bind(llm);
    const wrapped = async (provider, model, signal) => {
      const info = await original(provider, model, signal);
      const modalities = info?.inputModalities;
      // 只给明确声明、且尚未包含 image 的文本模型补准入。
      if (!info || !Array.isArray(modalities) || modalities.includes("image")) return info;
      return { ...info, inputModalities: [...modalities, "image"] };
    };
    marker = { raw, original, wrapped, owners: new Set() };
    llm[LLM_WRAP_MARK] = marker;
    llm.resolveModelInfo = wrapped;
  }
  marker.owners.add(owner);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const live = llm[LLM_WRAP_MARK];
    if (live !== marker) return;
    marker.owners.delete(owner);
    if (marker.owners.size > 0) return;
    if (llm.resolveModelInfo === marker.wrapped) llm.resolveModelInfo = marker.raw;
    delete llm[LLM_WRAP_MARK];
  };
}

