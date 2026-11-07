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

  /**
   * 跨节点清理转写标记。
   *
   * DSH 0.2.2 起把一段用户文本切成多个 <span class="_plainRun">（markdown
   * 行内渲染与 dsh-message-quotes 都会切），START 与 END 于是落在不同的
   * text node 里，单节点替换删不掉。这里按「同一父元素下的兄弟节点」
   * 聚合处理：找到含 START 的节点后，向后找到含 END 的节点，把两者之间
   * （含）的所有兄弟 text node 一起清掉。
   *
   * 返回被清空的节点列表，供调用方隐藏空容器。
   */
  function stripBridgedRange(startNode) {
    var parent = startNode.parentElement;
    if (!parent) return [];
    var children = Array.prototype.slice.call(parent.childNodes);
    var startIndex = children.indexOf(startNode);
    if (startIndex === -1) return [];
    var endIndex = -1;
    for (var i = startIndex; i < children.length; i++) {
      var node = children[i];
      if (node.nodeType !== 3) continue;
      if ((node.data || "").indexOf(END) === -1) continue;
      endIndex = i;
      break;
    }
    if (endIndex === -1) return [];
    var cleared = [];
    for (var j = startIndex; j <= endIndex; j++) {
      var target = children[j];
      if (target.nodeType !== 3) continue;
      var data = target.data || "";
      var endAt = data.indexOf(END);
      // 结束标记所在节点：保留标记之后的内容；标记之前的内容属于转写段，
      // 但同一节点里 START 之前的内容是用户文字，要留下。
      if (endAt !== -1) {
        var kept = data.slice(endAt + END.length);
        // START 之前的部分若是用户文字（同节点场景），保留。
        var startAt = data.indexOf(START);
        if (startAt > 0) kept = data.slice(0, startAt) + kept;
        if (data === kept) continue;
        target.data = kept;
        cleared.push(target);
        continue;
      }
      if (data === "") continue;
      target.data = "";
      cleared.push(target);
    }
    return cleared;
  }

  window.__ModuleLoader__.load({
    id: "dsh-auto-vision-bridge",
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
      var jsxRuntime = require("react/jsx-runtime");
      var react = require("react");
      var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
      var jsx = jsxRuntime.jsx;
      var jsxs = jsxRuntime.jsxs;
      // 识图历史页要订阅取数状态，用到 React 的两个基础钩子。
      var useState = react.useState;
      var useEffect = react.useEffect;

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
        ".avb-btnDanger{color:var(--dsw-alias-state-error-primary)}",
        ".avb-catalog{display:grid;gap:4px}",
        ".avb-catalogGroup{border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;padding:6px 8px;display:grid;gap:4px}",
        ".avb-catalogGroupName{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
        ".avb-catalogRow{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}",
        ".avb-catalogModel{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;display:flex;align-items:baseline;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".avb-catalogTag{color:var(--dsw-alias-state-warn-label);font-size:11px;line-height:16px;white-space:nowrap}",
        // ---- 识图历史页 ----
        // 页面自己滚：DSH 主面板槽整条链是 overflow:hidden，document 也不滚。
        ".avbhist-page{display:flex;flex-direction:column;gap:16px;padding:20px 24px;min-width:0;flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior-y:contain}",
        ".avbhist-head{display:flex;flex-direction:column;gap:4px}",
        ".avbhist-title{margin:0;font-size:14px;line-height:20px}",
        ".avbhist-desc{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
        // 统计块不铺满：等宽铺满整行是模板特征，这里按内容宽度靠左排。
        ".avbhist-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,112px));justify-content:start;gap:8px}",
        ".avbhist-tile{border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;padding:8px 12px;display:grid;gap:4px;min-width:0}",
        ".avbhist-tileLabel{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".avbhist-tileValue{color:var(--dsw-alias-label-primary);font-size:15px;line-height:20px;font-variant-numeric:tabular-nums}",
        // 模型分布：带比例条的列表。唯一的强调色只在这里用。
        ".avbhist-models{display:grid;gap:6px;max-width:420px}",
        ".avbhist-model{display:grid;grid-template-columns:132px 1fr 44px;gap:8px;align-items:center;font-size:12px;line-height:18px}",
        ".avbhist-modelName{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".avbhist-modelBar{height:6px;border-radius:3px;background:var(--dsw-alias-border-l3);overflow:hidden}",
        ".avbhist-modelBarFill{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-state-business-primary)}",
        ".avbhist-modelCount{text-align:right;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}",
        ".avbhist-table{width:100%;border-collapse:collapse;font-size:12px;line-height:18px;table-layout:fixed}",
        ".avbhist-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-secondary);padding:4px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2);white-space:nowrap}",
        ".avbhist-table td{padding:4px 8px;border-bottom:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        // 必须带 .avbhist-table td 前缀：否则被 .avbhist-table td 的 color 覆盖（优先级 0,1,1 > 0,1,0）。
        ".avbhist-table td.avbhist-ok{color:var(--dsw-alias-state-success-primary)}",
        ".avbhist-table td.avbhist-fail{color:var(--dsw-alias-state-error-primary)}",
        // 耗时下方那行排队小字：弱化到 tertiary，避免和主值抢注意力。
        ".avbhist-table td.avbhist-cCost .avbhist-wait{display:block;font-size:10px;line-height:1.3;color:var(--dsw-alias-label-tertiary,#8a8a8a)}",
        // 签名细节：失败行左侧一道细边，扫表时比只靠文字颜色快。
        ".avbhist-table tr.avbhist-rowFail td:first-child{box-shadow:inset 2px 0 0 var(--dsw-alias-state-error-primary)}",
        ".avbhist-empty{padding:12px 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
        "@media (max-width:640px){.avbhist-page{padding:12px 12px max(28px,calc(env(safe-area-inset-bottom,0px) + 16px));gap:12px}.avbhist-tiles{grid-template-columns:repeat(auto-fit,minmax(80px,1fr))}.avbhist-model{grid-template-columns:104px 1fr 40px}.avbhist-table{table-layout:auto}.avbhist-cSession,.avbhist-cImage{display:none}}"
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
          valueField("historyRetentionDays", props, state, "识图历史保留天数", "识图历史（每张图片一条记录）的保留时长；0 表示不自动清理。", true),
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

      // ---- 识图历史视图（第一步：最小骨架）----
      //
      // 形态照抄 dsh-subagent-model-pool 的「模型池统计」：侧栏条目
      // （sidebar.panellist）+ 独立主页面（main 槽 keyed）。
      var HISTORY_PANEL_ID = "auto-vision-bridge-history";

      /** 侧栏图标：放大镜 + 列表（内联 SVG，不依赖宿主图标组件集）。 */
      function HistoryIcon(props) {
        var size = props && props.size ? props.size : 18;
        return jsxs("svg", {
          width: size, height: size, viewBox: "0 0 24 24",
          fill: "none", stroke: "currentColor", strokeWidth: 1.6,
          strokeLinecap: "round", strokeLinejoin: "round",
          "aria-hidden": "true",
          children: [
            jsx("circle", { key: "lens", cx: 10.5, cy: 10.5, r: 6 }),
            jsx("line", { key: "handle", x1: 15, y1: 15, x2: 20, y2: 20 }),
            jsx("line", { key: "r1", x1: 17, y1: 5, x2: 21, y2: 5 }),
            jsx("line", { key: "r2", x1: 17, y1: 8.5, x2: 21, y2: 8.5 }),
            jsx("line", { key: "r3", x1: 17, y1: 12, x2: 21, y2: 12 })
          ]
        });
      }

      /** 识图历史取数路由（浏览器相对路径）。 */
      var HISTORY_ROUTE = "api/auto-vision-bridge.history";
      /** 明细表最多显示的行数。 */
      var HISTORY_ROWS = 20;

      /** 格式化耗时。 */
      function formatDuration(ms) {
        var value = Number(ms);
        if (!isFinite(value) || value < 0) return "—";
        if (value < 1000) return Math.round(value) + " ms";
        return (value / 1000).toFixed(2) + " s";
      }

      /** 格式化百分比。 */
      function formatPercent(rate) {
        var value = Number(rate);
        if (!isFinite(value)) return "—";
        return (value * 100).toFixed(1) + "%";
      }

      /** 格式化时间戳为「MM/DD HH:MM:SS」。 */
      function formatTime(time) {
        var value = Number(time);
        if (!isFinite(value) || value <= 0) return "—";
        var date = new Date(value);
        var pad = function (n) { return n < 10 ? "0" + n : String(n); };
        return pad(date.getMonth() + 1) + "/" + pad(date.getDate()) + " "
          + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
      }

      /** 一次取数；失败给出中文提示而不是抛错。 */
      function readHistory(signal) {
        return fetch(HISTORY_ROUTE, { signal: signal, credentials: "same-origin" })
          .then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
          })
          .catch(function (error) {
            if (error && error.name === "AbortError") return null;
            return { error: "读取识图历史失败：" + (error && error.message ? error.message : String(error)) };
          });
      }

      /** 极简 store：getSnapshot / subscribe / load。 */
      function createHistorySource() {
        var listeners = [];
        var snapshot = null;
        var error = null;
        var loading = false;
        var controller = null;
        var notify = function () {
          for (var i = 0; i < listeners.length; i++) listeners[i]();
        };
        var load = function () {
          if (controller !== null) controller.abort();
          controller = new AbortController();
          loading = true;
          error = null;
          notify();
          readHistory(controller.signal).then(function (value) {
            if (controller === null || controller.signal.aborted) return;
            loading = false;
            if (value === null) return;
            if (value.error) error = value.error;
            else snapshot = value;
            notify();
          });
        };
        return {
          getSnapshot: function () {
            return { snapshot: snapshot, error: error, loading: loading };
          },
          subscribe: function (listener) {
            listeners.push(listener);
            return function () {
              var index = listeners.indexOf(listener);
              if (index >= 0) listeners.splice(index, 1);
            };
          },
          load: load
        };
      }

      /** 合计条的一个小方块。 */
      function HistoryTile(props) {
        return jsxs("div", {
          className: "avbhist-tile",
          children: [
            jsx("div", { key: "l", className: "avbhist-tileLabel", children: props.label }),
            jsx("div", { key: "v", className: "avbhist-tileValue", children: props.value })
          ]
        });
      }

      /** 会话列的兜底显示：去掉 session- 前缀后取前 8 位。 */
      function shortenSessionId(value) {
        var text = String(value || "").trim();
        if (!text) return "—";
        return text.replace(/^session-/, "").slice(0, 8);
      }

      /** 图片列的显示名：优先文件名，只有 attachmentId 时缩成简短标识。 */
      function imageLabelOf(row) {
        if (row.imageName) return row.imageName;
        var id = String(row.attachmentId || "").trim();
        if (!id) return "(未命名)";
        var hex = id.replace(/^sha256:/, "");
        return "附件 " + hex.slice(0, 8);
      }

      /** 明细表。 */
      function HistoryTable(props) {
        var rows = props.rows || [];
        if (rows.length === 0) {
          return jsx("div", { className: "avbhist-empty", children: "暂无识图记录" });
        }
        var head = jsxs("tr", {
          key: "h",
          children: [
            jsx("th", { key: "t", style: { width: "96px" }, children: "时间" }),
            jsx("th", { key: "c", className: "avbhist-cSession", style: { width: "140px" }, children: "会话" }),
            jsx("th", { key: "m", className: "avbhist-cModel", style: { width: "132px" }, children: "模型" }),
            jsx("th", { key: "i", className: "avbhist-cImage", style: { width: "130px" }, children: "图片" }),
            jsx("th", { key: "s", className: "avbhist-cCost", style: { width: "88px" }, children: "耗时" }),
            jsx("th", { key: "r", children: "结果" })
          ]
        });
        var body = rows.map(function (row, index) {
          var ok = row.ok === true;
          var label = imageLabelOf(row);
          var detail = ok ? "成功" : (row.error || "失败");
          // 有标题（会话仍 live 且已生成）就用标题，否则退回短 id。
          var sessionText = row.sessionTitle || shortenSessionId(row.sessionId);
          return jsxs("tr", {
            key: "r-" + index,
            className: ok ? undefined : "avbhist-rowFail",
            children: [
              jsx("td", { key: "t", title: formatTime(row.time), children: formatTime(row.time) }),
              jsx("td", { key: "c", className: "avbhist-cSession", title: sessionText, children: sessionText }),
              jsx("td", {
                key: "m",
                title: (row.provider || "") + "/" + (row.model || ""),
                children: (row.provider || "—") + "/" + (row.model || "—")
              }),
              jsx("td", { key: "i", className: "avbhist-cImage", title: label, children: label }),
              // 耗时只报识别时间（已剔除排队）；排队非零时补一行小字，
              // 否则池满排队会被误读成「模型很慢」。
              jsxs("td", {
                key: "s",
                className: "avbhist-cCost",
                children: [
                  formatDuration(row.durationMs),
                  Number(row.waitMs) > 0
                    ? jsx("span", { key: "w", className: "avbhist-wait", children: "排队 " + formatDuration(row.waitMs) })
                    : null,
                ],
              }),
              jsx("td", {
                key: "r",
                className: ok ? "avbhist-ok" : "avbhist-fail",
                title: detail,
                children: ok ? "成功" : "失败"
              })
            ]
          });
        });
        return jsxs("table", {
          className: "avbhist-table",
          children: [
            jsx("thead", { key: "h", children: head }),
            jsx("tbody", { key: "b", children: body })
          ]
        });
      }

      /** 模型分布：带比例条的列表。这是页面上唯一放强调色的地方。 */
      function ModelBars(props) {
        var models = (props.models || []).slice().sort(function (a, b) {
          return (b.total || 0) - (a.total || 0);
        });
        if (models.length === 0) return null;
        var max = models[0].total || 1;
        return jsx("div", {
          className: "avbhist-models",
          children: models.map(function (item, index) {
            var total = item.total || 0;
            var pct = Math.max(4, Math.round((total / max) * 100));
            var name = (item.provider || "—") + "/" + (item.model || "—");
            return jsxs("div", {
              key: "m-" + index,
              className: "avbhist-model",
              children: [
                jsx("span", { key: "n", className: "avbhist-modelName", title: name, children: name }),
                jsx("span", {
                  key: "b",
                  className: "avbhist-modelBar",
                  children: jsx("span", { className: "avbhist-modelBarFill", style: { width: pct + "%" } })
                }),
                jsx("span", {
                  key: "c",
                  className: "avbhist-modelCount",
                  title: item.failed > 0 ? total + " 次，失败 " + item.failed + " 次" : total + " 次",
                  children: String(total)
                })
              ]
            });
          })
        });
      }

      /** 识图历史主页面。 */
      function HistoryPage(props) {
        var state = props.useHistory();
        var snapshot = state.snapshot;
        var summary = snapshot && snapshot.summary ? snapshot.summary : null;
        var records = snapshot && Array.isArray(snapshot.records) ? snapshot.records : [];
        var children = [
          jsxs("div", {
            key: "head",
            className: "avbhist-head",
            children: [
              jsx("h2", { className: "avbhist-title", children: "识图历史" }),
              jsx("p", {
                className: "avbhist-desc",
                children: "每张图一条记录，保留 "
                  + (snapshot && snapshot.retentionDays ? snapshot.retentionDays + " 天" : "若干天")
              })
            ]
          })
        ];
        if (state.error) {
          children.push(jsx("div", { key: "e", className: "avbhist-empty", children: state.error }));
        } else if (state.loading && !snapshot) {
          children.push(jsx("div", { key: "l", className: "avbhist-empty", children: "读取中…" }));
        } else {
          if (summary) {
            children.push(jsxs("div", {
              key: "tiles",
              className: "avbhist-tiles",
              children: [
                jsx(HistoryTile, { key: "total", label: "识图次数", value: String(summary.total) }),
                jsx(HistoryTile, { key: "ok", label: "成功率", value: formatPercent(summary.successRate) }),
                jsx(HistoryTile, { key: "fail", label: "失败", value: String(summary.failed) }),
                jsx(HistoryTile, { key: "avg", label: "平均耗时", value: formatDuration(summary.avgDurationMs) }),
                jsx(HistoryTile, { key: "cache", label: "缓存命中", value: formatPercent(summary.cacheRate) })
              ]
            }));
            // 模型分布用条列表而不是一行字：这是页面唯一的信息可视化，也省掉一行冗余标签。
            children.push(jsx(ModelBars, { key: "models", models: summary.models }));
          }
          children.push(jsx(HistoryTable, { key: "tb", rows: records.slice(0, HISTORY_ROWS) }));
        }
        return jsx("div", { className: "avbhist-page", children: children });
      }

      function registerHistory(ctx) {
        var source = createHistorySource();
        // 钩子包一层：inject 面里的函数会被渲染器当普通 prop 传给组件。
        var useHistory = function () {
          var state = useState(function () { return source.getSnapshot(); });
          var setState = state[1];
          useEffect(function () {
            var listener = function () { setState(source.getSnapshot()); };
            var dispose = source.subscribe(listener);
            source.load();
            return dispose;
          }, []);
          return state[0];
        };
        ctx.effect(function () {
          return ctx.slots.inject("main", function () {
            return ctx.slots.register({
              name: "main",
              key: HISTORY_PANEL_ID,
              label: "识图历史",
              // 参考实现（model-pool / session-changes）都声明 inject，
              // 缺了它主页面注册不生效、渲染出空白。
              inject: function () { return { useHistory: useHistory }; }
            }, HistoryPage);
          });
        }, "auto-vision-bridge: 识图历史主页面");
        ctx.effect(function () {
          return ctx.slots.inject("sidebar.panellist", function () {
            return ctx.slots.register({
              name: "sidebar.panellist",
              id: HISTORY_PANEL_ID,
              order: 31,
              label: "识图历史"
            }, HistoryIcon);
          });
        }, "auto-vision-bridge: 识图历史侧栏入口");
      }

      function apply(ctx) {
        registerSettings(ctx);
        registerHistory(ctx);
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
              // 优先按跨节点范围清理：START 与 END 常落在不同的 text node。
              var cleared = stripBridgedRange(nodes[i]);
              if (cleared.length > 0) {
                for (var j = 0; j < cleared.length; j++) hideEmptyBubble(cleared[j]);
                continue;
              }
              var cleaned = stripBridgedText(nodes[i].data);
              if (cleaned !== nodes[i].data) {
                nodes[i].data = cleaned;
                hideEmptyBubble(nodes[i]);
              }
            }
          }

          // 初次扫描覆盖刷新后的持久消息；observer 覆盖后续流式/多图 DOM 更新。
          scan();
          // 节流：观察器监听的是整个 body，流式输出时每秒几十次变更，
          // 每次都跑一遍全树 TreeWalker 会把主线程占满，导致掉帧和视觉抖动。
          // 清理旧标记不是实时需求，攒 300ms 扫一次足够。
          var pending = 0;
          var observer = new MutationObserver(function () {
            if (pending) return;
            pending = setTimeout(function () { pending = 0; scan(); }, 300);
          });
          observer.observe(document.body, { childList: true, subtree: true, characterData: true });
          return function () { if (pending) clearTimeout(pending); observer.disconnect(); };
        }, "auto-vision-bridge: 隐藏转写清理");
      }

      exports.apply = apply;
      exports.inject = ["slots", "remote", "remote.session", "configForms"];
      // 无 DOM 依赖的测试出口，不影响宿主模块契约。
      exports.__test = {
        stripBridgedText,
        stripBridgedRange,
        hideEmptyBubble,
        START,
        END,
        SETTINGS_NS,
        AutoVisionController,
        AutoVisionSettings,
        PoolEditor,
        normalizeEntry,
        // 识图历史页的展示层小工具
        HISTORY_PANEL_ID,
        HISTORY_ROUTE,
        HISTORY_ROWS,
        formatDuration,
        formatPercent,
        formatTime,
        shortenSessionId,
        imageLabelOf
      };
      return module.exports;
    }
  });
})();
