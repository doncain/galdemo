// 假 TavernHelper（供多个验收脚本共用）。
//
// ── 为什么抽出来 ──────────────────────────────────────────────
// 「模拟酒馆环境」从 S4 开始需要，但需要它的地方不止一处：
//   · verify-s4-ui.mjs  —— 验读楼 / 导航 / 生成锁
//   · verify-s5-ui.mjs  —— 验变量 / 重roll / 删楼
//   · verify-layout.mjs —— 验底部堆叠布局
// 各自抄一份的话，几份会慢慢不一致（改了一处忘另一处），
// 而症状是「某个脚本突然开始假通过」，非常难查。所以只留一份。
//
// ── 它注入的位置 ──────────────────────────────────────────────
// 插在 <div id="root"></div> 之后、bundle 的 <script> 之前：
//   · 必须早于 bundle —— hasTavern 是在模块加载时求值的，
//     晚一步注入，代码走的就是「无酒馆」分支，测试全成了空转。
//   · 必须晚于 #root —— 免得将来 stub 想操作挂载点时找不到。
//
// ── 调用日志（calls）为什么必要 ────────────────────────────────
// S5 有几件事**画面上看不出来**：
//   · 重roll 的历史窗口有没有裁 —— 发多了不报错，只是贵 + 泄历史（坑 20）
//   · 变量以哪一楼为基线重算 —— 基线错了画面照样正常（坑 21）
//   · 删楼用的是不是 /cut —— 用错 API 的后果延迟出现（坑 19）
// 只验最终画面等于没验。所以 stub 记录每次调用的参数，断言直接查日志。
//
// ── 它证明不了什么 ────────────────────────────────────────────
// 只证明「面对这套宿主行为，我们的代码算得对」。
// 不证明真酒馆的接口签名/时序就是这样 —— 那是真机门的事。

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assertArtifactFresh } from './lib-dump.mjs';

export const STUB = `
(function () {
  var qs = new URLSearchParams(location.search);
  var variant = qs.get('variant') || 'A';

  // ── 调用日志：断言直接查它 ──
  var calls = [];
  function log(kind, payload) {
    calls.push({ kind: kind, payload: payload === undefined ? null : payload });
  }

  function floor(id, scene, lines) {
    return { message_id: id, role: 'assistant', message: '[scene:' + scene + ']\\n' + lines.join('\\n') };
  }

  var F1 = floor(1, '旧城区/渡口', ['渡口的木栈道被水汽泡得发黑。', '青梧[平静]:"船还没来。"']);
  var F3 = floor(3, '旧城区/茶馆/二楼雅座', [
    '二楼的窗开着，市声涌上来。',
    '沈砚[冷淡]:"坐吧。"',
    '青梧[微笑]:"难得他请客。"'
  ]);

  var messages = [F1, F3];

  // s5：造一段长聊天（8 层 AI 楼 + 8 层玩家楼 + 最后一层 AI 楼）。
  // 为什么需要这么多：验「历史窗口只留最近 5 层 AI 楼」必须有**多余量**，
  // 否则裁与不裁结果一样，断言就成了空转。
  if (variant === 's5') {
    messages = [];
    var S5_SCENES = [
      '旧城区/渡口', '旧城区/茶馆/二楼雅座', '旧城区/河堤', '旧城区/河堤/柳树下',
      '旧城区', '旧城区/渡口', '旧城区/河堤', '旧城区/河堤'
    ];
    for (var i = 0; i < 8; i += 1) {
      messages.push(floor(1 + i * 2, S5_SCENES[i], [
        '第 ' + (i + 1) + ' 幕的旁白。',
        '青梧[平静]:"第 ' + (i + 1) + ' 次。"'
      ]));
      messages.push({ message_id: 2 + i * 2, role: 'user', message: '第' + (i + 1) + '次行动' });
    }
    // 最后一楼：AI 楼，场景与第 15 楼不同（便于断言画面确实换了）
    messages.push(floor(17, '旧城区/茶馆/二楼雅座', ['茶已经凉了。', '沈砚[冷淡]:"说重点。"']));
  }

  if (variant === 'userlast') {
    messages.push({ message_id: 4, role: 'user', message: '我推门进去。' });
  }

  // nomvu：需要一个玩家楼，否则重roll 的「向上找最近的玩家输入」这一步
  // 根本走不到 —— 那些断言会以「找不到玩家输入」失败，看着像功能坏了，
  // 其实只是夹具里没有玩家发言。
  if (variant === 'nomvu') {
    messages = [F1, { message_id: 2, role: 'user', message: '我推门进去。' }, F3];
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

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

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

  window.eventEmit = function (name) { log('eventEmit', name); emit(name); };

  window.tavern_events = {
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_UPDATED: 'message_updated',
    MESSAGE_SENT: 'message_sent',
    CHAT_CHANGED: 'chat_changed'
  };
  window.iframe_events = { GENERATION_ENDED: 'generation_ended' };

  // ── 变量表 ──
  // 三个变体覆盖三层降级链：
  //   s5 / A   → Mvu 在，且该楼有快照            → 第 ① 层命中
  //   nomvu    → Mvu 不在，只有聊天变量          → 第 ② 层命中
  //   novars   → 两者都没有                      → 第 ③ 层（显示降级文案）
  var chatVarsData = {
    stat_data: {
      时间: { 年: 1, 月: 3, 日: 12, 时辰: 19 },
      位置: { 当前地点: '聊天变量里的地点' }
    }
  };

  // 第 17 楼的快照。时辰刻意设成 19 而不是种子里的 7 ——
  // 这样「变量重算时用的是该楼旧值」与「用的是种子」结果不同（20 vs 8），
  // 断言才能区分。状态里多一个沈砚，用来验「旧值被保留而不是被种子覆盖」。
  var mvuStore = {};
  mvuStore[3] = { 时间: { 年: 1, 月: 3, 日: 12, 时辰: 19 }, 位置: { 当前地点: '旧城区/茶馆/二楼雅座' }, 状态: { 青梧: 42 } };
  mvuStore[17] = {
    时间: { 年: 1, 月: 3, 日: 12, 时辰: 19 },
    位置: { 当前地点: '旧城区/茶馆/二楼雅座' },
    状态: { 青梧: 42, 沈砚: 15 }
  };

  if (variant !== 'novars' && variant !== 'nomvu') {
    window.Mvu = {
      getMvuData: function (opts) {
        log('mvu.getMvuData', opts);
        var id = opts && opts.message_id;
        var key = (id === undefined || id === null || id === 'latest') ? maxId() : id;
        var sd = mvuStore[key];
        return sd ? { stat_data: clone(sd) } : undefined;
      },
      parseMessage: function (text, oldData) {
        // 记录**全文**（含 UpdateVariable 块）与**基线**，这两点都是断言的靶子
        log('mvu.parseMessage', { text: text, oldData: oldData || null });
        // 模拟「变量跟着新剧情重算」：以旧值为基线推进时辰
        var base = (oldData && oldData.stat_data) ? clone(oldData.stat_data)
          : { 时间: { 年: 1, 月: 3, 日: 12, 时辰: 7 }, 位置: { 当前地点: '（种子）' }, 状态: {} };
        if (base.时间) base.时间.时辰 = (base.时间.时辰 || 0) + 1;
        base.位置 = { 当前地点: '旧城区/渡口' };
        mvuStore[maxId()] = base;
        return Promise.resolve();
      },
      replaceMvuData: function () { log('mvu.replaceMvuData', null); return Promise.resolve(); }
    };
  }

  window.getVariables = function (opts) {
    log('getVariables', opts);
    if (variant === 'novars') return {};
    return clone(chatVarsData);
  };

  window.updateVariablesWith = function (fn, opts) {
    log('updateVariablesWith', opts);
    try { fn(chatVarsData); } catch (e) {}
  };

  window.waitGlobalInitialized = function (name) {
    log('waitGlobalInitialized', name);
    return Promise.resolve();
  };

  // ── 生成与写回（S5）──
  var REGEN_TEXT = [
    '<thinking>先想一下怎么重写这一段。</thinking>',
    '<content>',
    '[scene:旧城区/渡口]',
    '渡口的木栈道响了一声。',
    '青梧[微笑]:"重写之后的版本。"',
    '</content>',
    '<maintext>',
    '[scene:旧城区/渡口]',
    '渡口的木栈道响了一声。',
    '青梧[微笑]:"重写之后的版本。"',
    '</maintext>',
    '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/时间/时辰","value":20}]</JSONPatch></UpdateVariable>'
  ].join('\\n');

  window.generate = function (opts) {
    log('generate', opts);
    return Promise.resolve(REGEN_TEXT);
  };

  window.setChatMessages = function (msgs, opts) {
    log('setChatMessages', { msgs: msgs, opts: opts });
    var arr = Array.isArray(msgs) ? msgs : [msgs];
    for (var i = 0; i < arr.length; i += 1) {
      var t = arr[i];
      for (var j = 0; j < messages.length; j += 1) {
        if (messages[j].message_id === t.message_id) messages[j].message = t.message;
      }
    }
    return Promise.resolve();
  };

  window.triggerSlash = function (cmd) {
    log('slash', cmd);
    return new Promise(function (resolveSlash) {
      // variant=nosend：让 /send 抛错。tavern.ts 的 slash() 会把异常翻译成
      // false，于是界面弹出「发送失败」提示条 —— 底部堆叠因此变高。
      // 用来验「堆叠高度变化 → 文本框让位」这条链路（不依赖 ResizeObserver）。
      if (variant === 'nosend') {
        throw new Error('stub: 本次刻意拒绝发送');
      }

      // 删楼（坑 19：必须走 /cut，它才是真删）
      var cut = /^\\/cut\\s+(\\d+)-(\\d+)$/.exec(cmd);
      if (cut) {
        var a = parseInt(cut[1], 10), b = parseInt(cut[2], 10);
        for (var k = messages.length - 1; k >= 0; k -= 1) {
          if (messages[k].message_id >= a && messages[k].message_id <= b) messages.splice(k, 1);
        }
        resolveSlash();
        return;
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
        setTimeout(function () {
          messages.push(floor(maxId() + 1, '旧城区/河堤/柳树下', ['柳条垂到水里，夜色压得很低。', '青梧[认真]:"这次换我先说。"']));
          emit('message_received');
        }, 900);
        setTimeout(function () { emit('generation_ended'); resolveSlash(); }, 1600);
        return;
      }

      resolveSlash();
    });
  };

  window.__MINIGAL_STUB__ = {
    messages: messages,
    emit: emit,
    variant: variant,
    calls: calls,
    mvuStore: mvuStore,
    chatVarsData: chatVarsData
  };
})();
`;

/**
 * 把 stub 注入产物副本，返回副本路径。
 * 产物本身（dist/yaoguai/minigal/index.html）绝不能被改 —— 那是要发布的东西。
 */
export function buildAppWithStub(artifactPath, outPath) {
  // 先确认产物是新的 —— 否则后面一整轮断言都在验旧产物。
  // 这个错误的表现是「新功能断言集体失败」或更坏的「全绿但验的是旧版」。
  assertArtifactFresh(resolve(dirname(artifactPath), '../../..'));

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
