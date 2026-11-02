// 手写 ModuleLoader 客户端：设置入口与转写隐藏共用同一个轻量客户端。
(function () {
  var START = "\u200b[auto-vision-bridge:start]";
  var END = "\u200b[auto-vision-bridge:end]";
  var SETTINGS_NS = "auto-vision-bridge";

  function stripBridgedText(value) {
    var input = String(value == null ? "" : value);
    var output = "";
    var cursor = 0;
    while (cursor < input.length) {
      var start = input.indexOf(START, cursor);
      if (start === -1) {
        output += input.slice(cursor);
        break;
      }
      var end = input.indexOf(END, start + START.length);
      if (end === -1) {
        output += input.slice(cursor);
        break;
      }
      output += input.slice(cursor, start);
      cursor = end + END.length;
    }
    return output;
  }

  window.__ModuleLoader__.load({
    id: "dsh-auto-vision-bridge",
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
      var jsxRuntime = require("react/jsx-runtime");
      var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
      var jsx = jsxRuntime.jsx;
      var jsxs = jsxRuntime.jsxs;

      var CSS = [
        ".avb-settings{padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
        ".avb-header{margin-bottom:12px}.avb-title{margin:0;font-size:14px;line-height:20px}",
        ".avb-description{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
        ".avb-toggle{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px;font-size:13px;line-height:20px}",
        ".avb-prompt{display:grid;gap:6px;margin-top:12px}.avb-prompt-label{font-size:13px;line-height:20px}",
        ".avb-prompt-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
        ".avb-prompt-input{box-sizing:border-box;width:100%;min-height:112px;resize:vertical;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-background-primary);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px}",
        ".avb-prompt-input:focus{outline:2px solid var(--dsw-alias-focus);outline-offset:1px}"
      ].join("");
      if (typeof document !== "undefined" && typeof document.querySelector === "function"
        && document.querySelector("style[data-auto-vision-bridge-css]") === null) {
        var style = document.createElement("style");
        style.setAttribute("data-auto-vision-bridge-css", "true");
        style.textContent = CSS;
        document.head.appendChild(style);
      }

      var LABELS = {
        unavailable: "插件当前未运行，暂时无法配置。",
        readOnly: "当前部署的配置为只读。",
        saveFailed: "保存失败，请检查填写内容后重试。",
        save: "保存",
        saving: "保存中…"
      };

      function AutoVisionController(scope, mirror) {
        this.scope = scope;
        this.mirror = mirror;
        this.form = new primitives.SettingsFormModel(scope, [
          primitives.settingsTextField("baseURL"),
          primitives.settingsTextField("apiKeyEnv"),
          primitives.settingsTextField("model"),
          primitives.settingsTextField("prompt"),
          primitives.settingsNumberField("maxTokens"),
          primitives.settingsNumberField("timeoutMs"),
          primitives.settingsNumberField("maxImageBytes")
        ], [{
          field: "apiKey",
          write: function (text) { return scope.set("apiKey", text); }
        }]);
        this.store = this.form.bind(() => this.projection());
      }
      AutoVisionController.prototype.projection = function () {
        var mirrored = this.scope.getSnapshot();
        var described = this.mirror.getSnapshot().view?.namespaces.find(function (item) {
          return item.ns === SETTINGS_NS;
        });
        var secret = described?.secrets?.find(function (item) {
          return item.path.join(".") === "apiKey";
        });
        return Object.assign({}, this.form.shell(), {
          enabled: mirrored.value?.enabled !== false,
          baseURL: this.form.field("baseURL"),
          apiKey: this.form.field("apiKey"),
          apiKeyConfigured: secret?.set === true,
          apiKeyEnv: this.form.field("apiKeyEnv"),
          model: this.form.field("model"),
          prompt: this.form.field("prompt"),
          maxTokens: this.form.field("maxTokens"),
          timeoutMs: this.form.field("timeoutMs"),
          maxImageBytes: this.form.field("maxImageBytes")
        });
      };
      AutoVisionController.prototype.inject = function () {
        return Object.assign({
          hooks: { autoVision: this.store },
          setEnabled: (enabled) => { void this.scope.set("enabled", enabled); }
        }, this.form.actions());
      };
      AutoVisionController.prototype.dispose = function () { this.form.dispose(); };

      function valueField(name, props, state, label, hint, numeric) {
        return jsx(primitives.SettingsValueField, {
          id: "auto-vision-" + name,
          label,
          hint,
          overriddenLabel: "已覆盖",
          resetLabel: "恢复默认",
          invalidLabel: numeric ? "请输入有效的非负数字。" : "请输入有效内容。",
          numeric: numeric === true,
          disabled: !state.writable || state.saving,
          ...state[name],
          onEdit: function (text) { props.edit(name, text); },
          onReset: function () { props.resetField(name); }
        }, name);
      }

      function AutoVisionSettings(props) {
        var state = props.useAutoVision(function (snapshot) { return snapshot; });
        var disabled = !state.writable || state.saving;
        var children = [
          jsxs("label", {
            className: "avb-toggle",
            children: [
              jsx("span", { children: "启用自动视觉桥接" }),
              jsx(primitives.Switch, {
                checked: state.enabled,
                label: "启用自动视觉桥接",
                disabled,
                onChange: props.setEnabled
              })
            ]
          }, "enabled"),
          jsx(primitives.SettingsSecretField, {
            id: "auto-vision-api-key",
            label: "视觉 API 密钥",
            hint: "优先使用这里保存的密钥；留空表示保持当前密钥，未设置时从下方环境变量读取。",
            disabled,
            text: state.apiKey.text,
            configured: state.apiKeyConfigured,
            stateLabel: state.apiKeyConfigured ? "已设置" : "未设置",
            onEdit: function (text) { props.edit("apiKey", text); }
          }, "apiKey"),
          valueField("baseURL", props, state, "视觉 API 基础地址", "OpenAI 兼容接口地址，例如 https://api.openai.com/v1。", false),
          valueField("apiKeyEnv", props, state, "密钥环境变量", "未填写 API Key 时读取的环境变量名。", false),
          valueField("model", props, state, "视觉模型", "独立视觉端点使用的模型名称。", false),
          valueField("maxTokens", props, state, "最大输出 Token", "限制每次识图的最长输出；不影响主模型回复。", true),
          valueField("timeoutMs", props, state, "请求超时（毫秒）", "单次视觉请求允许等待的时间。", true),
          valueField("maxImageBytes", props, state, "图片大小上限（字节）", "超过上限的图片会跳过转写。", true),
          jsxs("label", {
            className: "avb-prompt",
            children: [
              jsx("span", { className: "avb-prompt-label", children: "识图提示词" }),
              jsx("p", { className: "avb-prompt-hint", children: "要求视觉模型如何转写图片；针对性复核会附加用户的问题。" }),
              jsx("textarea", {
                className: "avb-prompt-input",
                "data-auto-vision-prompt": true,
                value: state.prompt.text,
                disabled,
                onChange: function (event) { props.edit("prompt", event.currentTarget.value); }
              })
            ]
          }, "prompt")
        ];
        var form = jsx(primitives.SettingsForm, {
          labels: LABELS,
          state,
          onSave: props.save,
          onDiscard: props.discard,
          children
        });
        return jsxs("section", {
          className: "avb-settings",
          "data-auto-vision-settings": true,
          children: [
            jsxs("header", {
              className: "avb-header",
              children: [
                jsx("h3", { className: "avb-title", children: "自动视觉桥接" }),
                jsx("p", { className: "avb-description", children: "为纯文本模型自动转写图片，并提供原图复核工具。" })
              ]
            }),
            form
          ]
        });
      }

      function registerSettings(ctx) {
        var scope = ctx.configForms.get(SETTINGS_NS);
        var controller = new AutoVisionController(scope, ctx.configForms.describe());
        ctx.effect(function () { return function () { controller.dispose(); }; }, "auto-vision-bridge: 配置表单");
        ctx.effect(function () {
          return ctx.configForms.whileServed([SETTINGS_NS], function () {
            return ctx.slots.inject("settings.section", function () {
              return ctx.slots.register({
                name: "settings.section",
                id: SETTINGS_NS,
                order: 80,
                label: "自动视觉桥接",
                inject: function () { return controller.inject(); }
              }, AutoVisionSettings);
            });
          });
        }, "auto-vision-bridge: 顶层设置入口");
      }

      function apply(ctx) {
        registerSettings(ctx);
        ctx.effect(function () {
          function scan() {
            if (!document.body) return;
            var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
              acceptNode: function (node) {
                return node.data && node.data.indexOf(START) !== -1
                  ? NodeFilter.FILTER_ACCEPT
                  : NodeFilter.FILTER_REJECT;
              }
            });
            var nodes = [];
            while (walker.nextNode()) nodes.push(walker.currentNode);
            for (var i = 0; i < nodes.length; i++) {
              var cleaned = stripBridgedText(nodes[i].data);
              if (cleaned !== nodes[i].data) nodes[i].data = cleaned;
            }
          }

          // 初次扫描覆盖刷新后的持久消息；observer 覆盖后续流式/多图 DOM 更新。
          scan();
          var observer = new MutationObserver(scan);
          observer.observe(document.body, { childList: true, subtree: true, characterData: true });
          return function () { observer.disconnect(); };
        }, "auto-vision-bridge: 隐藏转写清理");
      }

      exports.apply = apply;
      exports.inject = ["slots", "configForms"];
      // 无 DOM 依赖的测试出口，不影响宿主模块契约。
      exports.__test = {
        stripBridgedText,
        START,
        END,
        SETTINGS_NS,
        AutoVisionController,
        AutoVisionSettings
      };
      return module.exports;
    }
  });
})();
