// 手写 ModuleLoader 客户端：设置入口与转写隐藏共用同一个轻量客户端。
(function () {
  var START = "\u200b[auto-vision-bridge:start]";
  var END = "\u200b[auto-vision-bridge:end]";
  var SETTINGS_NS = "auto-vision-bridge";
  var DEFAULT_ENTRY_LIMIT = 1;
  var DEFAULT_ENTRY_PRIORITY = 1;

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
        ".avb-prompt-input:focus{outline:2px solid var(--dsw-alias-focus);outline-offset:1px}",
        ".avb-pool{display:grid;gap:6px;margin-top:8px}",
        ".avb-poolHead{display:flex;align-items:center;justify-content:space-between;gap:8px}",
        ".avb-poolTitle{font-size:13px;line-height:20px}",
        ".avb-poolHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
        ".avb-empty{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
        ".avb-entry{display:grid;gap:4px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;padding:6px 8px}",
        ".avb-entryGrid{display:flex;align-items:center;justify-content:space-between;gap:8px}",
        ".avb-entryNums{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
        ".avb-entryId{display:flex;align-items:baseline;gap:6px;min-width:0}",
        ".avb-entryProvider{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap}",
        ".avb-entryModel{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".avb-input{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-background-primary);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;padding:2px 6px}",
        ".avb-num{width:64px;text-align:right}",
        ".avb-btn{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-background-secondary);color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;font-size:12px;line-height:18px;padding:3px 10px}",
        ".avb-btn:disabled{opacity:.5;cursor:not-allowed}",
        ".avb-btnDanger{color:var(--dsw-alias-state-danger-label)}",
        ".avb-catalog{display:grid;gap:4px}",
        ".avb-catalogGroup{border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;padding:6px 8px;display:grid;gap:4px}",
        ".avb-catalogGroupName{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
        ".avb-catalogRow{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}",
        ".avb-catalogModel{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;display:flex;align-items:baseline;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".avb-catalogTag{color:var(--dsw-alias-state-warn-label);font-size:11px;line-height:16px;white-space:nowrap}"
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

      /**
       * 池条目归一：缺字段补默认值。
       *
       * maxConcurrent 与 priority 可能是用户正在输入的字符串（草稿里原样保留），
       * 因此这里不强行转数字，只把非字符串的数值规范化。
       */
      function normalizeEntry(raw, index) {
        var entry = raw && typeof raw === "object" ? raw : {};
        var limit = entry.maxConcurrent;
        if (typeof limit !== "string") {
          var numeric = Number(limit);
          limit = Number.isFinite(numeric) && numeric >= 1
            ? Math.floor(numeric)
            : DEFAULT_ENTRY_LIMIT;
        }
        var priority = entry.priority;
        if (typeof priority !== "string") {
          var level = Number(priority);
          priority = Number.isFinite(level) && level >= 1
            ? Math.floor(level)
            : DEFAULT_ENTRY_PRIORITY;
        }
        return {
          provider: typeof entry.provider === "string" ? entry.provider : "",
          model: typeof entry.model === "string" ? entry.model : "",
          maxConcurrent: limit,
          priority: priority,
          index: index
        };
      }

      /** 草稿里的并发值转成可落盘的数字；非法或空值按 1 回落。 */
      function limitValue(raw) {
        var numeric = Number(raw);
        if (!Number.isFinite(numeric) || numeric < 1) return DEFAULT_ENTRY_LIMIT;
        return Math.floor(numeric);
      }

      /**
       * 草稿里的优先级转成可落盘的整数。
       *
       * 只认 >= 1 的有限整数，不做宽容转换：floor 会把 2.7 变成 2，
       * 与后端 lib/pool.js 的 priorityInteger 口径必须一致，否则前端落盘的值
       * 和后端解析出的层会错位。
       */
      function priorityValue(raw) {
        var numeric = Number(raw);
        if (!Number.isInteger(numeric) || numeric < 1) return DEFAULT_ENTRY_PRIORITY;
        return numeric;
      }

      function AutoVisionController(scope, mirror, ctx) {
        this.scope = scope;
        this.mirror = mirror;
        this.ctx = ctx;
        this.draft = undefined;
        this.saving = false;
        this.failed = false;
        this.catalogGroups = [];
        this.catalogStatus = "idle";
        this.catalogFailure = "";
        this.form = new primitives.SettingsFormModel(scope, [
          primitives.settingsTextField("prompt"),
          primitives.settingsNumberField("timeoutMs"),
          primitives.settingsNumberField("maxImageBytes"),
          primitives.settingsNumberField("retries"),
          primitives.settingsNumberField("retryDelayMs"),
          primitives.settingsNumberField("maxConcurrent"),
          primitives.settingsNumberField("failureThreshold"),
          primitives.settingsNumberField("cooldownMs"),
          primitives.settingsNumberField("dumpThreshold"),
          primitives.settingsNumberField("summaryLength")
        ], []);
        this.actions = this.form.actions();
        this.store = this.form.bind(function () { return this.projection(); }.bind(this));
      }

      /** 当前生效的池配置（来自 Host）。必须逐字段重建新对象。 */
      AutoVisionController.prototype.currentEntries = function () {
        var value = this.scope.getSnapshot().value;
        var pool = value && Array.isArray(value.pool) ? value.pool : [];
        var out = [];
        for (var i = 0; i < pool.length; i++) out.push(normalizeEntry(pool[i], i));
        return out;
      };

      /** 草稿基于当前生效值懒创建，保存成功后丢弃。 */
      AutoVisionController.prototype.beginDraft = function () {
        if (this.draft === undefined) {
          this.draft = this.currentEntries().map(function (entry) {
            return {
              provider: entry.provider,
              model: entry.model,
              maxConcurrent: entry.maxConcurrent,
              priority: entry.priority
            };
          });
        }
        return this.draft;
      };

      AutoVisionController.prototype.desiredEntries = function () {
        return this.beginDraft().map(function (entry) {
          return {
            provider: entry.provider.trim(),
            model: entry.model.trim(),
            maxConcurrent: limitValue(entry.maxConcurrent),
            priority: priorityValue(entry.priority)
          };
        });
      };

      AutoVisionController.prototype.isPoolDirty = function () {
        if (this.draft === undefined) return false;
        var desired = JSON.stringify(this.desiredEntries());
        var current = JSON.stringify(this.currentEntries().map(function (entry) {
          return {
            provider: entry.provider.trim(),
            model: entry.model.trim(),
            maxConcurrent: limitValue(entry.maxConcurrent),
            priority: priorityValue(entry.priority)
          };
        }));
        return desired !== current;
      };

      /**
       * 加入一个池条目。
       *
       * 候选来自模型目录，provider 与 model 一起确定；条目数没有上限，
       * 点多少次添加按钮就加多少个。
       */
      AutoVisionController.prototype.addEntry = function (provider, model) {
        if (this.saving) return;
        var providerId = typeof provider === "string" ? provider.trim() : "";
        var modelId = typeof model === "string" ? model.trim() : "";
        if (!providerId || !modelId) return;
        var draft = this.beginDraft();
        var exists = draft.some(function (entry) {
          return entry.provider === providerId && entry.model === modelId;
        });
        if (exists) return;
        draft.push({
          provider: providerId,
          model: modelId,
          maxConcurrent: DEFAULT_ENTRY_LIMIT,
          priority: DEFAULT_ENTRY_PRIORITY
        });
        this.failed = false;
        this.store.set(this.projection());
      };

      AutoVisionController.prototype.removeEntry = function (index) {
        if (this.saving) return;
        var draft = this.beginDraft();
        if (index < 0 || index >= draft.length) return;
        draft.splice(index, 1);
        this.failed = false;
        this.store.set(this.projection());
      };

      AutoVisionController.prototype.editEntry = function (index, key, value) {
        if (this.saving) return;
        var draft = this.beginDraft();
        if (index < 0 || index >= draft.length) return;
        if (key === "maxConcurrent" || key === "priority") {
          // 原样保留输入文本：数字框清空时若回落成旧值，用户接着输入会拼成
          // "13" 这种错值。非法值留到保存时才按 1 回落。
          draft[index][key] = String(value);
        } else {
          draft[index][key] = String(value);
        }
        this.failed = false;
        this.store.set(this.projection());
      };

      /**
       * 载入实时模型目录。
       *
       * 候选来自 ctx.remote.session.modelCatalog()：这是 DSH 自己的模型目录，
       * 插件不经手端点与凭据。
       */
      AutoVisionController.prototype.loadCatalog = function () {
        var self = this;
        if (this.catalogStatus === "loading") return;
        // ctx.remote 是 cordis 服务代理，未 inject 时读属性会直接抛，必须先兜住。
        var remote;
        try {
          remote = this.ctx && this.ctx.remote;
        } catch (error) {
          remote = undefined;
        }
        if (!remote || !remote.session || typeof remote.session.modelCatalog !== "function") {
          this.catalogStatus = "error";
          this.catalogFailure = "当前会话不支持模型目录，无法列出候选模型。";
          this.store.set(this.projection());
          return;
        }
        this.catalogStatus = "loading";
        this.store.set(this.projection());
        Promise.resolve(remote.session.modelCatalog()).then(function (response) {
          if (response && response.ok && response.value) {
            self.catalogGroups = response.value.groups || [];
            self.catalogStatus = "ready";
            var failures = response.value.failures || [];
            self.catalogFailure = failures.length > 0
              ? "部分提供方读取失败：" + failures.map(function (item) {
                return item.name || item.id;
              }).join("、")
              : "";
          } else {
            self.catalogStatus = "error";
            self.catalogFailure = "读取模型目录失败。";
          }
          self.store.set(self.projection());
        }, function () {
          self.catalogStatus = "error";
          self.catalogFailure = "读取模型目录失败。";
          self.store.set(self.projection());
        });
      };

      /**
       * 候选分组：列出模型目录里的全部模型，并标出每个的视觉能力状态。
       *
       * - vision=true：目录声明支持图片，可直接用。
       * - vision=false：目录声明只接受文本。这样的模型要进池，必须先在
       *   DSH「设置 → 模型」里给它声明输入含 image，否则宿主会把图片
       *   投影成一句「该模型只接受文本」，模型根本看不到图。
       * - vision=null：目录没声明模态，按可用处理。
       */
      AutoVisionController.prototype.catalogCandidates = function () {
        var selected = {};
        var entries = this.draft === undefined ? this.currentEntries() : this.beginDraft();
        for (var i = 0; i < entries.length; i++) {
          selected[entries[i].provider + "\u0000" + entries[i].model] = true;
        }
        var groups = [];
        for (var g = 0; g < this.catalogGroups.length; g++) {
          var group = this.catalogGroups[g];
          var rows = [];
          var models = group?.models || [];
          for (var m = 0; m < models.length; m++) {
            var model = models[m];
            var modalities = model?.inputModalities;
            var vision = Array.isArray(modalities)
              ? modalities.includes("image")
              : null;
            var providerId = group.id || "";
            var modelId = model.id || "";
            if (!providerId || !modelId) continue;
            rows.push({
              provider: providerId,
              model: modelId,
              name: model.name || modelId,
              selected: selected[providerId + "\u0000" + modelId] === true,
              vision: vision
            });
          }
          if (rows.length > 0) {
            groups.push({ id: group.id, name: group.name || group.id, rows: rows });
          }
        }
        return groups;
      };
      AutoVisionController.prototype.projection = function () {
        var mirrored = this.scope.getSnapshot();
        var shell = this.form.shell();
        var poolDirty = this.isPoolDirty();
        return Object.assign({}, shell, {
          enabled: mirrored.value?.enabled !== false,
          prompt: this.form.field("prompt"),
          timeoutMs: this.form.field("timeoutMs"),
          maxImageBytes: this.form.field("maxImageBytes"),
          retries: this.form.field("retries"),
          retryDelayMs: this.form.field("retryDelayMs"),
          maxConcurrent: this.form.field("maxConcurrent"),
          failureThreshold: this.form.field("failureThreshold"),
          cooldownMs: this.form.field("cooldownMs"),
          dumpThreshold: this.form.field("dumpThreshold"),
          summaryLength: this.form.field("summaryLength"),
          // 快照会被 store 深冻结；草稿数组本体交给它就再也写不进去。
          // 这里只交出拷贝，冻结的永远不是草稿自己。
          entries: (this.draft === undefined ? this.currentEntries() : this.beginDraft())
            .map(function (entry) {
              return {
                provider: entry.provider,
                model: entry.model,
                maxConcurrent: entry.maxConcurrent,
                priority: entry.priority
              };
            }),
          // 池数组不走 SettingsFormModel，保存按钮的 dirty 必须自己合并进去。
          dirty: shell.dirty === true || poolDirty,
          poolDirty: poolDirty,
          catalogStatus: this.catalogStatus,
          catalogFailure: this.catalogFailure,
          // 目录候选已标出视觉能力状态。
          catalogGroups: this.catalogCandidates(),
          saving: this.saving || shell.saving === true,
          failed: this.failed || shell.failed === true
        });
      };

      /** 保存：先提交标量（带乐观锁），再提交池数组（整组写回）。 */
      AutoVisionController.prototype.save = function () {
        var self = this;
        var snapshot = this.scope.getSnapshot();
        if (this.saving || !snapshot || snapshot.writable === false) return;
        var poolDirty = this.isPoolDirty();
        var shell = this.form.shell();
        if (!poolDirty && shell.dirty !== true) return;

        this.saving = true;
        this.failed = false;
        this.store.set(this.projection());

        var formWriting = shell.dirty === true
          ? Promise.resolve(this.form.save()).then(function () {
            return self.form.shell().failed !== true;
          }, function () { return false; })
          : Promise.resolve(true);

        var writing = formWriting.then(function (formOk) {
          if (!formOk) return false;
          if (!poolDirty) return true;
          return Promise.resolve(self.scope.mutate([{
            op: "set",
            path: ["pool"],
            value: self.desiredEntries()
          }])).then(function () { return true; }, function () { return false; });
        });

        writing.then(function (ok) {
          self.saving = false;
          self.failed = ok === false;
          if (ok && poolDirty) self.draft = undefined;
          self.store.set(self.projection());
        }, function () {
          self.saving = false;
          self.failed = true;
          self.store.set(self.projection());
        });
      };

      AutoVisionController.prototype.discard = function () {
        if (this.saving) return;
        this.draft = undefined;
        this.failed = false;
        this.actions.discard();
        this.store.set(this.projection());
      };
      AutoVisionController.prototype.inject = function () {
        var self = this;
        return Object.assign({}, this.actions, {
          hooks: { autoVision: this.store },
          setEnabled: (enabled) => { void self.scope.set("enabled", enabled); },
          addEntry: (provider, model) => { self.addEntry(provider, model); },
          removeEntry: (index) => { self.removeEntry(index); },
          editEntry: (index, key, value) => { self.editEntry(index, key, value); },
          loadCatalog: () => { self.loadCatalog(); },
          clearPool: function () {
            if (self.saving) return;
            self.draft = [];
            self.failed = false;
            self.store.set(self.projection());
          },
          resetPool: function () {
            if (self.saving) return;
            self.draft = [];
            self.failed = false;
            self.store.set(self.projection());
          },
          save: () => { self.save(); },
          discard: () => { self.discard(); }
        });
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

      /**
       * 模型池编辑器。
       *
       * 上半是已配置的条目（可删、可改并发上限），下半是 DSH 模型目录里的
       * 候选（点「添加」即入池）。条目数没有上限。
       */
      function PoolEditor(props) {
        var state = props.useAutoVision(function (snapshot) { return snapshot; });
        var disabled = !state.writable || state.saving;

        var selected = {};
        for (var i = 0; i < state.entries.length; i++) {
          selected[state.entries[i].provider + "\u0000" + state.entries[i].model] = true;
        }

        var rows = [];
        for (var e = 0; e < state.entries.length; e++) {
          (function (entry, index) {
            rows.push(jsx("div", {
              className: "avb-entry",
              "data-avb-pool-entry": index,
              children: [
                jsxs("div", {
                  className: "avb-entryGrid",
                  children: [
                    jsxs("div", {
                      className: "avb-entryId",
                      children: [
                        jsx("span", {
                          className: "avb-entryProvider",
                          "data-avb-pool-provider": index,
                          children: entry.provider
                        }),
                        jsx("span", {
                          className: "avb-entryModel",
                          "data-avb-pool-model": index,
                          children: entry.model
                        })
                      ]
                    }),
                    jsx("button", {
                      type: "button",
                      className: "avb-btn avb-btnDanger",
                      disabled: disabled,
                      "data-avb-pool-remove": index,
                      onClick: function () { props.removeEntry(index); },
                      children: "删除"
                    })
                  ]
                }),
                jsx("div", {
                  className: "avb-entryNums",
                  children: [
                    jsx("span", { className: "avb-poolHint", children: "优先级" }),
                    jsx("input", {
                      className: "avb-input avb-num",
                      type: "number",
                      min: 1,
                      step: 1,
                      value: String(entry.priority),
                      disabled: disabled,
                      "data-avb-pool-priority": index,
                      onChange: function (event) { props.editEntry(index, "priority", event.currentTarget.value); }
                    }),
                    jsx("span", { className: "avb-poolHint", children: "并发上限" }),
                    jsx("input", {
                      className: "avb-input avb-num",
                      type: "number",
                      min: 1,
                      step: 1,
                      value: String(entry.maxConcurrent),
                      disabled: disabled,
                      "data-avb-pool-limit": index,
                      onChange: function (event) { props.editEntry(index, "maxConcurrent", event.currentTarget.value); }
                    })
                  ]
                })
              ]
            }, index));
          })(state.entries[e], e);
        }

        var groups = state.catalogGroups || [];
        var catalogRows = [];
        for (var g = 0; g < groups.length; g++) {
          var group = groups[g];
          var modelRows = [];
          for (var m = 0; m < group.rows.length; m++) {
            (function (candidate) {
              var key = candidate.provider + "\u0000" + candidate.model;
              var already = selected[key] === true;
              modelRows.push(jsx("div", {
                className: "avb-catalogRow",
                "data-avb-catalog-model": candidate.model,
                children: [
                  jsxs("span", {
                    className: "avb-catalogModel",
                    children: [
                      jsx("span", { children: candidate.name }),
                      candidate.vision === false
                        ? jsx("span", {
                          className: "avb-catalogTag",
                          "data-avb-catalog-tag": "need-decl",
                          children: "需声明支持图片"
                        })
                        : null
                    ]
                  }),
                  already
                    ? jsx("span", { className: "avb-poolHint", children: "已在池中" })
                    : jsx("button", {
                      type: "button",
                      className: "avb-btn",
                      disabled: disabled,
                      "data-avb-pool-add": candidate.model,
                      onClick: function () { props.addEntry(candidate.provider, candidate.model); },
                      children: "添加"
                    })
                ]
              }, candidate.model));
            })(group.rows[m]);
          }
          catalogRows.push(jsx("div", {
            className: "avb-catalogGroup",
            "data-avb-catalog-group": group.id,
            children: [
              jsx("span", { className: "avb-catalogGroupName", children: group.name }),
              jsx("div", { className: "avb-catalog", children: modelRows })
            ]
          }, group.id));
        }

        var statusText = "";
        if (state.catalogStatus === "idle") statusText = "";
        else if (state.catalogStatus === "loading") statusText = "正在读取模型目录…";
        else if (state.catalogStatus === "error") statusText = state.catalogFailure || "读取模型目录失败。";
        else if (state.catalogFailure) statusText = state.catalogFailure;

        return jsxs("div", {
          className: "avb-pool",
          children: [
            jsxs("div", {
              className: "avb-poolHead",
              children: [
                jsx("span", { className: "avb-poolTitle", children: "识图模型池" }),
                jsx("button", {
                  type: "button",
                  className: "avb-btn",
                  disabled: disabled || state.catalogStatus === "loading",
                  "data-avb-catalog-refresh": true,
                  onClick: props.loadCatalog,
                  children: "刷新模型目录"
                })
              ]
            }),
            jsx("p", {
              className: "avb-poolHint",
              children: "候选来自 DSH 的模型目录，可自由增减。识别请求优先派发给优先级数字更小的模型（1 最高），高优先级模型满载时才降级到下一层；同层内按占用轮转。标了「需声明支持图片」的模型，要先在「设置 → 模型」里给它声明输入含图片，否则宿主会把图片当成纯文本丢掉。"
            }),
            statusText
              ? jsx("p", {
                className: "avb-poolHint",
                "data-avb-catalog-status": state.catalogStatus,
                children: statusText
              })
              : null,
            state.entries.length === 0
              ? jsx("p", { className: "avb-empty", children: "模型池为空，请从下面的模型目录里添加候选模型。" })
              : null,
            rows,
            state.catalogStatus === "ready" && catalogRows.length === 0
              ? jsx("p", { className: "avb-empty", children: "模型目录里没有可选的模型。" })
              : null,
            catalogRows.length > 0
              ? jsx("div", { className: "avb-catalog", children: catalogRows })
              : null,
            state.entries.length > 0
              ? jsx("button", {
                type: "button",
                className: "avb-btn",
                disabled: disabled,
                "data-avb-pool-clear": true,
                onClick: props.clearPool || props.resetPool,
                children: "清空模型池"
              })
              : null
          ]
        });
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
          valueField("timeoutMs", props, state, "请求超时（毫秒）", "单次视觉请求允许等待的时间。", true),
          valueField("maxImageBytes", props, state, "图片大小上限（字节）", "超过上限的图片会跳过转写。", true),
          valueField("retries", props, state, "识图失败重试次数", "识别失败后自动重试的次数；0 表示不重试。", true),
          valueField("retryDelayMs", props, state, "重试退避基数（毫秒）", "第 n 次重试等待 基数×n 毫秒。", true),
          valueField("maxConcurrent", props, state, "多图并发上限", "同一条消息里同时识别的图片数量上限。", true),
          valueField("failureThreshold", props, state, "模型熔断阈值（次）", "同一模型连续失败多少次后临时停止派发；0 表示不熔断。", true),
          valueField("cooldownMs", props, state, "熔断冷却时长（毫秒）", "熔断后暂停派发该模型的时长；结束后只放一个探测请求，成功即恢复。", true),
          valueField("dumpThreshold", props, state, "转写落盘阈值（字符）", "转写超过这个长度就只留摘要进上下文，全文写进临时目录并返回路径；0 表示不截断。", true),
          valueField("summaryLength", props, state, "截断后摘要长度（字符）", "转写被截断时，进上下文保留多少字符。", true),
          jsx(PoolEditor, {
            useAutoVision: props.useAutoVision,
            addEntry: props.addEntry,
            removeEntry: props.removeEntry,
            editEntry: props.editEntry,
            loadCatalog: props.loadCatalog,
            clearPool: props.clearPool,
            resetPool: props.resetPool
          }, "pool"),
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

      /**
       * 隐藏转写后的空容器处理。
       *
       * DSH 把一条消息的所有 text block 拼成一个用户气泡；我们的隐藏转写块
       * 让「只发图片」的消息也多出一个气泡。删掉标记文本后气泡变空，
       * 这里把空气泡整体隐藏，避免图片下方出现空对话框。
       */
      function hideEmptyBubble(node) {
        var element = node.parentElement;
        while (element && element !== document.body) {
          var parent = element.parentElement;
          if (!parent) break;
          // 附件行与气泡是兄弟；找到有附件行的父级，当前元素就是气泡。
          var hasAttachmentRow = false;
          for (var i = 0; i < parent.children.length; i++) {
            var child = parent.children[i];
            if (child !== element && child.hasAttribute && child.hasAttribute("data-message-attachments")) {
              hasAttachmentRow = true;
              break;
            }
          }
          if (hasAttachmentRow) {
            if (element.textContent.trim() === "" && !element.querySelector("img,svg,video,canvas")) {
              // 只隐藏不删除：React 仍持有该节点，删除会让后续重渲染报节点缺失。
              element.style.display = "none";
              element.setAttribute("data-auto-vision-empty-bubble", "true");
            }
            return;
          }
          element = parent;
        }
      }

      function registerSettings(ctx) {
        var scope = ctx.configForms.get(SETTINGS_NS);
        var controller = new AutoVisionController(scope, ctx.configForms.describe(), ctx);
        ctx.effect(function () { return function () { controller.dispose(); }; }, "auto-vision-bridge: 配置表单");
        ctx.effect(function () {
          return ctx.configForms.whileServed([SETTINGS_NS], function () {
            return ctx.slots.inject("settings.section", function () {
              return ctx.slots.register({
                name: "settings.section",
                id: SETTINGS_NS,
                order: 80,
                label: "自动视觉桥接",
                inject: function () {
                  var face = controller.inject();
                  // 首次打开设置时载入模型目录，候选即刻可用。
                  controller.loadCatalog();
                  return face;
                }
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
              if (cleaned !== nodes[i].data) {
                nodes[i].data = cleaned;
                hideEmptyBubble(nodes[i]);
              }
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
      exports.inject = ["slots", "remote", "remote.session", "configForms"];
      // 无 DOM 依赖的测试出口，不影响宿主模块契约。
      exports.__test = {
        stripBridgedText,
        hideEmptyBubble,
        START,
        END,
        SETTINGS_NS,
        AutoVisionController,
        AutoVisionSettings,
        PoolEditor,
        normalizeEntry
      };
      return module.exports;
    }
  });
})();
