// 锁定前端脚本验收：在一个「假酒馆」里验藏楼与防删。
//
// ── 为什么必须在假酒馆里验，而不是裸跑 ────────────────────────
// 这个脚本的全部工作都发生在**父页**：藏掉其它楼层、包掉父页的三个删除 API。
// 裸跑时没有父页、没有楼层、没有可删的东西 —— 什么都验不了。
// 所以这里造一个父页：`#chat` 里放三个 `.mes[mesid]`，每个里面一个 iframe，
// 其中一个 iframe 里加载锁定脚本（模拟「酒馆助手把脚本注入到楼层 iframe」）。
//
// ── 这个脚本里最重要的一条设计：对照实验 ──────────────────────
// 「我调了 remove，iframe 还在」有两种可能：
//   (a) 拦截成功
//   (b) 本来就没删掉（我的调用姿势不对 / 元素根本不在 DOM 里 / 选择器错了）
// 两者在断言上完全一样。所以**解锁之后必须再删一次，并断言它真的消失了**。
// 没有这个对照，「拦截成功」这个结论是不成立的。
//
// ── 环境限制 ──────────────────────────────────────────────────
// Chrome 在本机无法访问本机 HTTP，只能用 file:// + --allow-file-access-from-files
// （楼层 iframe 要读 window.top.document，同源是前提）。

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { CHROME, assertArtifactFresh } from './lib-dump.mjs';

const ROOT = process.cwd();
const DIST = resolve(ROOT, 'dist');
const LOCK_BUNDLE = resolve(DIST, 'minigal-lock/index.js');

// 先确认锁定脚本是新的 —— 否则整轮断言都在验旧产物
assertArtifactFresh(ROOT, 'lock');
if (!existsSync(LOCK_BUNDLE)) {
  console.error('缺少锁定脚本产物，先跑 npm run build');
  process.exit(1);
}

// ── 中立页：按参数决定要不要加载锁定脚本 ──────────────────────
const BLANK = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>blank</title></head>
<body>
<script>
  var q = new URLSearchParams(location.search);
  if (q.get('lock') === '1') {
    var s = document.createElement('script');
    s.src = './minigal-lock/index.js';
    document.head.appendChild(s);
  }
</script>
</body></html>`;
writeFileSync(resolve(DIST, 'dump-lock-blank.html'), BLANK);

// ── 假酒馆父页 ────────────────────────────────────────────────
function parentPage(scenario) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>html,body{margin:0;font:12px monospace}
#chat{margin:0;padding:0}.mes{border:1px solid #555;margin:4px;padding:4px}
iframe{width:200px;height:50px;border:1px solid #333}</style>
</head>
<body>
<div id="chat">
  <div class="mes" mesid="0"><div class="wrap"><iframe id="f0" src="./dump-lock-blank.html"></iframe></div></div>
  <div class="mes" mesid="1"><div class="wrap"><iframe id="f1" src="./dump-lock-blank.html?lock=1"></iframe></div></div>
  <div class="mes" mesid="2"><div class="wrap"><iframe id="f2" src="./dump-lock-blank.html"></iframe></div></div>
</div>
<div id="out">pending</div>
<script>
/* ── 极简 jQuery 替身 ──
   只为让「jQuery.fn.remove」这条拦截路径可被验证。
   它的 remove 刻意用 replaceChild 而不是 removeChild ——
   否则它会被 removeChild 那层补丁顺带挡住，
   测出来的「拦住了」就分不清是哪一层拦的，等于没验。 */
window.jQuery = window.$ = function (sel) {
  var els = [];
  if (Array.isArray(sel)) els = sel.slice();
  else if (typeof sel === 'string') els = Array.prototype.slice.call(document.querySelectorAll(sel));
  else if (sel) els = [sel];
  var api = Object.create(window.jQuery.fn);
  api.length = els.length;
  for (var i = 0; i < els.length; i++) api[i] = els[i];
  return api;
};
window.jQuery.fn = window.jQuery.prototype = {
  splice: Array.prototype.splice,
  remove: function () {
    for (var j = 0; j < this.length; j++) {
      var el = this[j];
      if (el && el.parentNode) el.parentNode.replaceChild(document.createTextNode(''), el);
    }
    this.length = 0;
    return this;
  }
};
</script>
<script>
var R = {};
function put(k, v) { R[k] = String(v); }
function finish() {
  document.getElementById('out').textContent = 'JSON_BEGIN' + JSON.stringify(R) + 'JSON_END';
}
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var STYLE_ID = 'minigal-lock-floor-style';
var PROTECT_ID = 'minigal-lock-protect-script';
var CLEANUP = '__minigalLockCleanup';
var FS_EVENT = 'minigal:fullscreen';

function mes(id) { return document.querySelector('#chat .mes[mesid="' + id + '"]'); }
function frame(id) { return document.getElementById('f' + id); }
function has(id) { return document.getElementById(id) ? 1 : 0; }
function disp(el) { return el ? getComputedStyle(el).display : '(无此楼)'; }
function addFloor(id) {
  var d = document.createElement('div');
  d.className = 'mes';
  d.setAttribute('mesid', String(id));
  d.innerHTML = '<div class="wrap"><iframe id="f' + id + '" src="./dump-lock-blank.html"></iframe></div>';
  document.getElementById('chat').appendChild(d);
  return d;
}
function fire(on, floorId) {
  window.__minigalFullscreen = on;
  window.__minigalFullscreenFloor = on ? floorId : null;
  document.dispatchEvent(new CustomEvent(FS_EVENT, { detail: { on: on, floorId: on ? floorId : null } }));
}

async function flow() {
  await wait(800);
  var origIframeRemove = HTMLIFrameElement.prototype.remove;
  var origRemoveChild = Node.prototype.removeChild;
  var origJqRemove = window.jQuery.fn.remove;

  put('init.style', has(STYLE_ID));
  put('init.protect', has(PROTECT_ID));
  put('init.other0', disp(mes(0)));

  /* 进入伪全屏：走我们自己的通道（不依赖原生 fullscreenchange） */
  fire(true, 1);
  await wait(300);

  put('lock.style', has(STYLE_ID));
  put('lock.styleText', (document.getElementById(STYLE_ID) || {}).textContent || '');
  put('lock.protect', has(PROTECT_ID));
  put('lock.patch1', HTMLIFrameElement.prototype.remove !== origIframeRemove ? 1 : 0);
  put('lock.patch2', Node.prototype.removeChild !== origRemoveChild ? 1 : 0);
  put('lock.patch3', window.jQuery.fn.remove !== origJqRemove ? 1 : 0);
  put('lock.other0', disp(mes(0)));
  put('lock.other2', disp(mes(2)));
  put('lock.locked1', disp(mes(1)));

  /* 锁定期新增楼层 */
  addFloor(3);
  await wait(300);
  put('new3.computed', disp(mes(3)));
  put('new3.inline', mes(3) ? mes(3).style.display : '(无)');

  /* 样式被酒馆清掉：既有的其它楼层必须被补回来 */
  var st = document.getElementById(STYLE_ID);
  if (st) st.remove();
  await wait(300);
  put('restore.styleBack', has(STYLE_ID));
  put('restore.other0', disp(mes(0)));

  /* 三条删除路径 —— 目标：被锁的第 1 楼 iframe 必须活着 */
  var f1 = frame(1);
  put('del.startAlive', f1 ? 1 : 0);
  f1.remove();
  put('del.p1', has('f1'));
  f1.parentNode.removeChild(f1);
  put('del.p2', has('f1'));
  var wrap = f1.closest('.wrap');
  wrap.parentNode.removeChild(wrap);
  put('del.p2nest', has('f1'));
  put('del.wrapAlive', document.querySelector('#chat .mes[mesid="1"] .wrap iframe') ? 1 : 0);
  /* ③ jQuery：同一次调用里混着「被锁的」和「没被锁的」。
     这样一条断言同时证明两件事：补丁装上了（f1 存活），
     且它是**选择性**的（f2 照删）—— 而不是把 remove 整个废掉。
     （第一版我断言的是「选择器不再匹配到 iframe」——
       那是错的：iframe 被拦住了当然还在，那条断言必然失败。） */
  window.jQuery([f1, frame(2)]).remove();
  put('del.p3', has('f1'));
  put('del.jqOther', has('f2'));

  /* 定向性：**没被锁**的楼层应当照旧可删（证明不是无差别冻结一切） */
  var f0 = frame(0);
  f0.remove();
  put('scope.other0Removed', has('f0'));

  /* 解锁 */
  fire(false, null);
  await wait(300);
  put('unlock.style', has(STYLE_ID));
  put('unlock.protect', has(PROTECT_ID));
  put('unlock.cleanup', typeof window[CLEANUP]);
  put('unlock.patch1Restored', HTMLIFrameElement.prototype.remove === origIframeRemove ? 1 : 0);
  put('unlock.patch2Restored', Node.prototype.removeChild === origRemoveChild ? 1 : 0);
  put('unlock.patch3Restored', window.jQuery.fn.remove === origJqRemove ? 1 : 0);
  put('unlock.other2', disp(mes(2)));
  put('unlock.m3Inline', mes(3) ? mes(3).style.display : '(无)');
  put('unlock.m3Computed', disp(mes(3)));

  /* ★★ 对照实验：解锁之后，同一个删除调用必须真的生效。
     没有这一条，「拦住了」与「本来就删不掉」无法区分。 */
  frame(1).remove();
  put('ctrl.removed', has('f1') === 0 ? 'gone' : 'still');
}

async function late() {
  /* 脚本**后**于全屏加载：父页先置标志位，再动态插入带锁定脚本的楼层。
     这是「玩家已经全屏了，脚本才被注入」的真实时序。 */
  window.__minigalFullscreen = true;
  window.__minigalFullscreenFloor = 1;
  await wait(300);

  var d = document.createElement('div');
  d.className = 'mes';
  d.setAttribute('mesid', '1');
  d.innerHTML = '<div class="wrap"><iframe id="f1" src="./dump-lock-blank.html?lock=1"></iframe></div>';
  document.getElementById('chat').appendChild(d);

  await wait(900);
  put('late.style', has(STYLE_ID));
  put('late.protect', has(PROTECT_ID));
  put('late.other0', disp(mes(0)));
  put('late.locked1', disp(mes(1)));
  put('late.patch1', HTMLIFrameElement.prototype.remove === origIframeRemoveLate ? 0 : 1);
}
var origIframeRemoveLate = HTMLIFrameElement.prototype.remove;

(function run() {
  var scenario = '${scenario}';
  var p = scenario === 'late' ? late() : flow();
  p.then(finish).catch(function (e) { put('error', (e && e.message) || String(e)); finish(); });
})();
</script>
</body></html>`;
}

function runScenario(scenario) {
  const page = resolve(DIST, `dump-lock-parent-${scenario}.html`);
  writeFileSync(page, parentPage(scenario));

  const dump = execFileSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--allow-file-access-from-files',
      '--user-data-dir=C:/Users/24015/AppData/Local/Temp/minigal-chrome-lock',
      '--virtual-time-budget=25000',
      '--window-size=1000,900',
      '--dump-dom',
      `file:///${page.replace(/\\/g, '/')}`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 120000 },
  );
  unlinkSync(page);

  const m = /JSON_BEGIN([\s\S]*?)JSON_END/.exec(dump);
  if (!m) return { __missing: '没有找到结果 JSON（脚本可能没跑完）' };
  const json = m[1]
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  try {
    return JSON.parse(json);
  } catch (e) {
    return { __missing: '结果 JSON 解析失败：' + e.message };
  }
}

// ── 断言 ─────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const ck = (label, ok, note = '') => {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label}${note ? '  — ' + note : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${note ? '  — ' + note : ''}`);
  }
};

console.log('════ S6 · 锁定前端脚本验收（假酒馆）════\n');

console.log('【场景 A】脚本先加载，之后进入伪全屏');
const A = runScenario('flow');
if (A.__missing) {
  console.log('  FAIL  ' + A.__missing);
  fail += 1;
} else if (A.error) {
  console.log('  FAIL  脚本抛错：' + A.error);
  fail += 1;
} else {
  console.log(`  实测  锁定后 其它楼=${A['lock.other0']} 锁定楼=${A['lock.locked1']}  |  解锁后 其它楼=${A['unlock.other2']}\n`);

  console.log('  ① 藏楼');
  ck('初始未注入任何东西', A['init.style'] === '0' && A['init.protect'] === '0',
    `style=${A['init.style']} protect=${A['init.protect']}`);
  ck('初始其它楼层可见（正向对照）', A['init.other0'] !== 'none', A['init.other0']);
  ck('锁定时注入隐藏样式', A['lock.style'] === '1');
  ck('隐藏规则只留锁定楼（用 :not，天然覆盖后加的楼层）',
    String(A['lock.styleText']).includes('mesid="1"') && String(A['lock.styleText']).includes(':not'),
    String(A['lock.styleText']).slice(0, 80));
  ck('其它楼层被藏住', A['lock.other0'] === 'none' && A['lock.other2'] === 'none',
    `楼0=${A['lock.other0']} 楼2=${A['lock.other2']}`);
  ck('锁定楼自己**没有**被藏', A['lock.locked1'] !== 'none', A['lock.locked1']);

  console.log('\n  ② 三条删除路径的补丁都装上了');
  ck('注入了保护脚本', A['lock.protect'] === '1');
  ck('HTMLIFrameElement.prototype.remove 被替换', A['lock.patch1'] === '1');
  ck('Node.prototype.removeChild 被替换', A['lock.patch2'] === '1');
  ck('jQuery.fn.remove 被替换（宿主用 jQuery 时才有）', A['lock.patch3'] === '1');

  console.log('\n  ③ 锁定期新楼层当场藏掉');
  ck('新楼被藏（视觉结果）', A['new3.computed'] === 'none', `display=${A['new3.computed']}`);
  ck('新楼被观察者打上 inline 隐藏（兜底机制真的在工作）', A['new3.inline'] === 'none',
    `inline=${A['new3.inline']}`);

  console.log('\n  ④ 样式被酒馆清掉时能补回来');
  ck('样式被清掉后脚本重新写入', A['restore.styleBack'] === '1');
  ck('已有的其它楼层仍在隐藏状态', A['restore.other0'] === 'none', `display=${A['restore.other0']}`);

  console.log('\n  ⑤ 防删：三条路径都拦得住');
  ck('前置：动手前 iframe 是在的', A['del.startAlive'] === '1');
  ck('路径① iframe.remove() 被拒', A['del.p1'] === '1', A['del.p1']);
  ck('路径② removeChild(iframe) 被拒', A['del.p2'] === '1', A['del.p2']);
  ck('路径②嵌套 removeChild(祖先容器) 被拒', A['del.p2nest'] === '1', A['del.p2nest']);
  ck('祖先容器还挂在聊天里（没被搬走）', A['del.wrapAlive'] === '1');
  ck('路径③ jQuery.remove() 被拒', A['del.p3'] === '1', A['del.p3']);
  ck('同一次 jQuery 调用里没被锁的照删（选择性，不是把 remove 废掉）',
    A['del.jqOther'] === '0', `f2 存在=${A['del.jqOther']}`);

  console.log('\n  ⑥ 定向性：没被锁的楼层照旧可删');
  ck('未被锁的楼层 iframe 可以被删（不是无差别冻结）', A['scope.other0Removed'] === '0',
    `f0 存在=${A['scope.other0Removed']}`);

  console.log('\n  ⑦ 解锁：清理干净');
  ck('隐藏样式被移除', A['unlock.style'] === '0');
  ck('保护脚本被移除', A['unlock.protect'] === '0');
  ck('清理函数已注销（原型能还原）', A['unlock.cleanup'] === 'undefined', A['unlock.cleanup']);
  ck('remove 原型已还原', A['unlock.patch1Restored'] === '1');
  ck('removeChild 原型已还原', A['unlock.patch2Restored'] === '1');
  ck('jQuery.fn.remove 已还原', A['unlock.patch3Restored'] === '1');
  ck('其它楼层恢复可见', A['unlock.other2'] !== 'none', A['unlock.other2']);
  ck(
    '锁定期新增的楼层也恢复可见（inline 隐藏被撤销）',
    A['unlock.m3Computed'] !== 'none',
    `inline=${A['unlock.m3Inline']} computed=${A['unlock.m3Computed']}`,
  );

  console.log('\n  ⑧ 对照实验：解锁后同一个删除调用必须真的生效');
  ck('解锁后 iframe.remove() 确实删掉了', A['ctrl.removed'] === 'gone', A['ctrl.removed']);
}

console.log('\n【场景 B】先全屏，脚本之后才加载（靠标志位补锁）');
const B = runScenario('late');
if (B.__missing) {
  console.log('  FAIL  ' + B.__missing);
  fail += 1;
} else if (B.error) {
  console.log('  FAIL  脚本抛错：' + B.error);
  fail += 1;
} else {
  console.log(`  实测  其它楼=${B['late.other0']} 锁定楼=${B['late.locked1']}\n`);
  ck('脚本初始化就补上了锁定（不依赖事件）', B['late.style'] === '1');
  ck('保护脚本也补上了', B['late.protect'] === '1');
  ck('其它楼层被藏', B['late.other0'] === 'none', `display=${B['late.other0']}`);
  ck('锁定楼可见', B['late.locked1'] !== 'none', `display=${B['late.locked1']}`);
  ck('原型已被替换', B['late.patch1'] === '1');
}

console.log(`\n════ 汇总：${pass}/${pass + fail} 通过 ════`);
console.log('  ⚠ 本脚本验的是「脚本逻辑对」+「在假酒馆里真的拦住了」。');
console.log('    真酒馆的楼层结构/删除路径仍需真机确认 —— 见 导入到酒馆中/S6真机验证清单.txt');
console.log('  （可人工核查：dist/dump-lock-blank.html 与两个 parent 页会在运行时重建）\n');

process.exit(fail > 0 ? 1 : 0);
