// 假 TavernHelper（供多个验收脚本共用）。
//
// ── 为什么抽出来 ──────────────────────────────────────────────
// 「模拟酒馆环境」这件事 S4 开始才需要，但需要它的地方不止一处：
//   · verify-s4-ui.mjs  —— 验读楼 / 导航 / 生成锁
//   · verify-layout.mjs —— 验底部堆叠布局（需要真的渲染出楼层条与输入栏）
// 各自抄一份 stub 的话，两份会慢慢不一致（改了一处忘了另一处），
// 而症状是「某个脚本突然开始假通过」，非常难查。所以只留一份。
//
// ── 它注入的位置 ──────────────────────────────────────────────
// 插在 <div id="root"></div> 之后、bundle 的 <script> 之前：
//   · 必须早于 bundle —— hasTavern 是在模块加载时求值的，
//     晚一步注入，代码走的就是「无酒馆」分支，测试全成了空转。
//   · 必须晚于 #root —— 免得将来 stub 想操作挂载点时找不到。
//
// ── 它证明不了什么 ────────────────────────────────────────────
// 只证明「面对这套宿主行为，我们的代码算得对」。
// 不证明真酒馆的接口签名/时序就是这样 —— 那是真机门的事。

import { readFileSync, writeFileSync } from 'node:fs';

export const STUB = `
(function () {
  var qs = new URLSearchParams(location.search);
  var variant = qs.get('variant') || 'A';

  function floor(id, scene, lines) {
    return { message_id: id, role: 'assistant', message: '[scene:' + scene + ']\\n' + lines.join('\\n') };
  }

  var F1 = floor(1, '旧城区/渡口', ['渡口的木栈道被水汽泡得发黑。', '青梧[平静]:"船还没来。"']);
  var F3 = floor(3, '旧城区/茶馆/二楼雅座', [
    '二楼的窗开着，市声涌上来。',
    '沈砚[冷淡]:"坐吧。"',
    '青梧[微笑]:"难得他请客。"'
  ]);
  var F5 = floor(5, '旧城区/河堤/柳树下', ['柳条垂到水里，夜色压得很低。', '青梧[认真]:"这次换我先说。"']);

  var messages = [F1, F3];
  if (variant === 'userlast') {
    messages.push({ message_id: 4, role: 'user', message: '我推门进去。' });
  }

  var handlers = {};

  function maxId() {
    var m = 0;
    for (var i = 0; i < messages.length; i += 1) if (messages[i].message_id > m) m = messages[i].message_id;
    return m || -1;
  }

  function emit(name) {
    var hs = handlers[name] || [];
    for (var i = 0; i < hs.length; i += 1) {
      try { hs[i](); } catch (e) {}
    }
  }

  window.getChatMessages = function (range, opts) {
    var role = opts && opts.role;
    var list = [];
    if (typeof range === 'number') {
      for (var i = 0; i < messages.length; i += 1) if (messages[i].message_id === range) list.push(messages[i]);
    } else if (typeof range === 'string') {
      var s = range.replace(/\\{\\{lastMessageId\\}\\}/g, String(maxId()));
      var m = /^(\\d+)-(\\d+)$/.exec(s);
      if (m) {
        var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        for (var j = 0; j < messages.length; j += 1) {
          if (messages[j].message_id >= a && messages[j].message_id <= b) list.push(messages[j]);
        }
      } else {
        list = messages.slice();
      }
    }
    if (role) list = list.filter(function (x) { return x.role === role; });
    return list.slice();
  };

  window.getLastMessageId = function () { return maxId(); };

  window.eventOn = function (name, cb) {
    (handlers[name] = handlers[name] || []).push(cb);
    return { stop: function () { handlers[name] = (handlers[name] || []).filter(function (f) { return f !== cb; }); } };
  };

  window.eventEmit = function (name) { emit(name); };

  window.tavern_events = {
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_UPDATED: 'message_updated',
    MESSAGE_SENT: 'message_sent',
    CHAT_CHANGED: 'chat_changed'
  };
  window.iframe_events = { GENERATION_ENDED: 'generation_ended' };

  window.triggerSlash = function (cmd) {
    return new Promise(function (resolveSlash) {
      // variant=nosend：让 /send 抛错。tavern.ts 的 slash() 会把异常翻译成
      // false，于是界面弹出「发送失败」提示条 —— 底部堆叠因此变高。
      // 用来验「堆叠高度变化 → 文本框让位」这条链路（不依赖 ResizeObserver）。
      if (variant === 'nosend') {
        throw new Error('stub: 本次刻意拒绝发送');
      }
      if (/^\\/send\\b/.test(cmd)) {
        messages.push({ message_id: maxId() + 1, role: 'user', message: cmd.replace(/^\\/send\\s*/, '') });
        setTimeout(function () { emit('message_updated'); }, 60);
        resolveSlash();
        return;
      }
      if (/^\\/trigger\\b/.test(cmd)) {
        // 刻意把 AI 回复推后到 900ms、结束推到 1600ms：
        // 中间那段（约 60~900ms）聊天末尾是**玩家楼**，
        // 正是「最后一楼是 user」这条规则唯一可观察的窗口。
        // 太早加进去的话，那个窗口根本不存在，断言就成了空转。
        setTimeout(function () { messages.push(F5); emit('message_received'); }, 900);
        setTimeout(function () { emit('generation_ended'); resolveSlash(); }, 1600);
        return;
      }
      resolveSlash();
    });
  };

  window.__MINIGAL_STUB__ = { messages: messages, emit: emit, variant: variant };
})();
`;

/**
 * 把 stub 注入产物副本，返回副本路径。
 * 产物本身（dist/yaoguai/minigal/index.html）绝不能被改 —— 那是要发布的东西。
 */
export function buildAppWithStub(artifactPath, outPath) {
  const anchor = '<div id="root"></div>';
  const html = readFileSync(artifactPath, 'utf8');
  const at = html.indexOf(anchor);
  if (at < 0) {
    throw new Error('产物里找不到 <div id="root"></div> —— 模板变了，需要同步 lib-tavern-stub.mjs');
  }
  writeFileSync(
    outPath,
    html.slice(0, at + anchor.length) + '\n<script>' + STUB + '</script>\n' + html.slice(at + anchor.length),
  );
  return outPath;
}
