export function testConfig(overrides = {}) {
  return {
    enabled: true,
    baseURL: "https://vision.example/v1",
    apiKey: "test-secret",
    apiKeyEnv: "AUTO_VISION_TEST_KEY",
    model: "vision-test",
    prompt: "默认识别提示",
    maxTokens: 512,
    timeoutMs: 1000,
    maxImageBytes: 1024 * 1024,
    ...overrides,
  };
}

export function attachment(id = "sha256:abc", name = `${id.replace(/:/g, "-")}.png`) {
  return { attachmentId: id, name, mediaType: "image/png", bytes: 3 };
}

export function imageMessage(blocks, extra = {}) {
  return {
    role: "user",
    source: { kind: "user" },
    content: blocks,
    ...extra,
  };
}

export function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

export function visionResponse(text) {
  return jsonResponse({ choices: [{ message: { content: text } }] });
}

export function imageOf(text, attachmentId = "") {
  return { data: Buffer.from(text), mediaType: "image/png", attachmentId };
}

export const identityDefineTool = (definition) => definition;
