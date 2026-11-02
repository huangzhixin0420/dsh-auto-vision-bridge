# dsh-auto-vision-bridge

标准 DSH Web 插件：当前模型明确声明为纯文本时，自动把用户图片逐张识别为文本；原始 `image` block 保持不变，转写以精确隐藏标记紧随原图持久化。Web 客户端只删除这些标记段，图片仍由 DSH GUI 原生渲染和点击查看。

## 功能

- 根级 `agent/pre-step` 自动桥接，不要求主 Agent 再调用工具。
- 当前路由按 `modelSelection.pending → lastUsed → requestHeader → agent.options` 读取，避免模型切换首步使用旧路由。
- 原生视觉路由的新消息原样直发；纯文本消息保持同引用；两种情况的独立视觉 API 调用均为零。
- 多图按原顺序逐张处理。单图失败只插入该图的“图片识别失败”文本，不影响其他 block。
- 文本路由下懒修复历史 `user/message`，使用 `surfaceOp: replace` 和 `sourceEventSeqs`；写回失败会重试，已有标记不会重复识别。
- 只包装 `llm.resolveModelInfo` 补上传准入，不修改 registration、adapter 或 `prepareCall`；支持 HMR 幂等和 dispose 恢复。
- 仅注册一个 `inspect_image` 工具：`path` 支持本地绝对路径、会话 cwd 相对路径和 http(s) URL；`attachmentId` 支持针对用户附件重看原图。
- 自动转写可能不完整或有误。隐藏转写块在有附件 ID 时会提示模型：核对细节、回答追问或转写不明确时，携带针对性 `question` 调用 `inspect_image` 复核，不仅凭转写猜测。
- 自动桥接与工具共用 `VisionClient`：图片 SHA-256、attachmentId、baseURL、model、prompt/question、maxTokens 共同构成缓存 key；200 项 LRU，in-flight 去重，失败不缓存。

## 安装

```bash
dsh plugin --profile web add git+https://github.com/huangzhixin0420/dsh-auto-vision-bridge.git
```

安装后需按下节说明配置独立视觉端点（`baseURL`、`apiKey` 或 `apiKeyEnv`、`model`），重启 DSH Web 以加载插件，并新建 web 会话获取最新工具 schema。

## 配置

Web 界面可直接进入「设置 → 自动视觉桥接」配置全部 9 项。该入口与「插件 → 已安装 → dsh-auto-vision-bridge → 组件 → 配置」复用宿主 `configForms.get("auto-vision-bridge")` 的同一配置存储，不创建副本；插件详情原有自动配置入口保留。

配置命名空间为 `auto-vision-bridge`：

```yaml
auto-vision-bridge:
  enabled: true
  baseURL: https://api.openai.com/v1
  apiKey: ""                  # secret；优先于 apiKeyEnv
  apiKeyEnv: AUTO_VISION_API_KEY
  model: gpt-4o-mini
  prompt: 请准确识别这张图片，描述关键视觉内容、上下文，并尽量完整转写其中的文字。只依据可见内容回答。
  maxTokens: 4096
  timeoutMs: 60000
  maxImageBytes: 10485760
```

视觉请求为 `POST {baseURL}/chat/completions`，消息 content 包含一个 `text` 和一个 `image_url`；本地、附件及远程图片统一转为 data URL。缺 key、超时、取消、非 2xx、空响应和空识别文本都会给出明确错误，错误信息会抹除已知密钥。

`enabled: false` 会卸载自动桥接与 `inspect_image`，并恢复图片准入原函数；重新启用后恢复功能。

## inspect_image

参数：

- `path`（与 `attachmentId` 二选一）：本地绝对路径、当前会话 cwd 相对路径，或 http(s) 图片 URL；适用于截图、生成图及其他本地/远程图片。
- `attachmentId`（与 `path` 二选一）：DSH 用户图片附件 ID，例如 `sha256:...`。插件从当前会话的 `user/message` 事件找回完整附件引用，再通过宿主 `attachments.readImage(ref, signal)` 读取并校验原图字节与元数据，不依赖或猜测本地路径。
- `question`（可选）：针对图片的问题；省略时使用 `prompt`。复核附件时应提供具体问题，例如核对某处文字或数字。

`path` 与 `attachmentId` 必须恰好有一个非空；同时提供、都缺失或只有空白都会在任何文件读取、附件读取和网络请求之前报错。返回值为视觉模型文本。附件读取失败会直接报错，不会生成伪造的识别文本。远程图片会先由插件下载并检查 `maxImageBytes`，不会把视觉 API key 转发给图片主机。

## 隐藏转写协议

每个未桥接的原始图片块后插入一个文本块：

```text
<BRIDGE_START>
[附件：文件名，attachmentId=...]
识别文本或“图片识别失败：原因”
复核提示：转写可能有误；需核对细节、回答追问或转写不明确时，用 attachmentId=... 调用 inspect_image，并携带针对性 question 重看原图，不要仅凭转写猜测。
<BRIDGE_END>
```

复核提示仅在附件实际带有非空 `attachmentId` 时加入，成功与失败块采用同一逻辑；没有 ID 时不会给出无法执行的指令。`client.js` 在初次加载和 `MutationObserver` 触发时删除包括复核提示在内的所有完整标记段。不完整标记段不删除，普通用户文字不参与模式猜测。客户端不会创建任何图片预览节点。

## 测试

```bash
pnpm install
node --test tests/*.test.js
```

测试使用 Node 内置 `node:test`，不需要真实视觉服务。覆盖消息桥接、多图与失败隔离、历史写回及重启幂等、pending 路由、准入生命周期、HTTP 错误、缓存、path/URL 旧行为、attachmentId 原图复核、参数校验零 I/O、附件失败、宿主服务接线、顶层设置 slot 与 9 字段配置复用、密钥控件以及 DOM 标记清理。2026-11-02 使用 Node 22.23.1 复跑：35 个顶层测试（含子测试共 39 项）通过、0 失败。

本机验收实测：真实 c2a 验收 12/12 检查通过，覆盖绝对/cwd 相对路径、共享缓存、自动桥接与纯文本零增量；附件复核中，真实 DSH 附件存储读取 1 次，真实 c2a 针对性回答匹配唯一码；Web 宿主验收 26/26 检查通过，其中前 18 项由完整自动化产生，后 8 项由分步 CDP 复核产生。

已有授权 DSH 页面接入本机 CDP `127.0.0.1:9222` 时，可复跑：

```bash
node tests/e2e-acceptance.mjs
```

脚本会创建并归档临时验收会话；不会读取或输出鉴权凭据。

## 已知边界

- 路由必须显式提供 `inputModalities`：包含 `image` 才原生直发；明确不含 `image` 才桥接。无法解析路由或缺少模态声明时保持原行为，不擅自调用视觉 API，也不补上传准入。
- “原生视觉”以宿主未包装前的路由声明为准；声明错误不在本插件中探测或修正。
- 转写允许进入会话持久化；Web 端隐藏依赖本插件的 `client.js`。
- 缓存是进程内有界缓存，重启后清空；附件内容在每次桥接时读取并校验大小。
- 真实 E2E 依赖已授权的 CDP 页面和可用 c2a 视觉路由；普通单元测试不访问真实服务。
