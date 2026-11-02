// 手写 ModuleLoader 客户端：仅清理精确标记段，原图继续由 DSH GUI 原生渲染。
(function () {
  var START = "\u200b[auto-vision-bridge:start]";
  var END = "\u200b[auto-vision-bridge:end]";

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
    factory: function () {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

      function apply(ctx) {
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
      exports.inject = [];
      // 无 DOM 依赖的测试出口，不影响宿主模块契约。
      exports.__test = { stripBridgedText: stripBridgedText, START: START, END: END };
      return module.exports;
    }
  });
})();
