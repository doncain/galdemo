// 布局验收：几何层面的「互不重叠 + 都在视口内」。
//
// ── 为什么需要它（这轮的真实教训）──────────────────────────────
// 底部输入栏与开发条**都在 bottom:0**，于是开发条（z-40）把输入栏（z-35）
// 压掉一半 —— 截图里输入框只剩一条缝。
// 而当时**所有断言都是绿的**：data-* 属性全对、文本全对、按钮可用性全对。
// 因为「属性正确」与「位置正确」是两件事，前者管不住后者。
//
// 所以这里补上几何断言。写法上有一个要点：**不测「坐标等于多少」**，
// 而是测**关系**（不重叠、不越界）。等于多少会随样式微调频繁失效，
// 关系才是我们真正要守的不变量。
//
// ── 怎么测 ────────────────────────────────────────────────────
// 不用 iframe 包一层：那样会引入「父页尺寸」这个额外变量，
// 而尺寸守卫还会去改 iframe 高度，把测量对象搞乱。
// 直接把测量脚本追加到产物副本末尾，让它在自己就是顶层窗口的环境里量 ——
// 此时窗口尺寸就等于真实酒馆里 iframe 的尺寸，一一对应。

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { CHROME } from './lib-dump.mjs';
import { STUB } from './lib-tavern-stub.mjs';

const ROOT = process.cwd();
const DIST = resolve(ROOT, 'dist');
const ARTIFACT = resolve(DIST, 'yaoguai/minigal/index.html');

if (!existsSync(ARTIFACT)) {
  console.error('缺少产物，先跑 npm run build');
  process.exit(1);
}

// 只测几何关系，不测内容 —— 所以这里注入的脚本不碰 #root 里的东西。
const MEASURE = `
(function () {
  var KEYS = {
    fb: '.gal-floorbar',
    ft: '.gal-floor-tag',
    ib: '.gal-inputbar',
    db: '.gal-devbar',
    tb: '.gal-textbox',
    st: '.gal-bottom',
    pl: '.gal-place',
    nt: '.gal-notice'
  };
  var host = document.createElement('div');
  host.id = 'layout-out';
  document.body.appendChild(host);

  function snap(prefix) {
    var app = document.querySelector('.gal-app');
    for (var k in KEYS) {
      var e = document.querySelector(KEYS[k]);
      if (!e) { host.setAttribute('data-' + prefix + '-' + k, 'none'); continue; }
      var r = e.getBoundingClientRect();
      host.setAttribute('data-' + prefix + '-' + k,
        [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)].join(','));
    }
    host.setAttribute('data-' + prefix + '-vp', window.innerWidth + 'x' + window.innerHeight);
    host.setAttribute('data-' + prefix + '-var',
      (app && app.style.getPropertyValue('--gal-bottom-h')) || 'none');
  }

  // 触发一次真实的状态变化，让底部堆叠变高，验「让位」这条链路。
  //
  // 用「发送失败提示条」而不是自己塞个 div：塞 div 只有 ResizeObserver 会
  // 发现，而 **RO 在本环境下根本不触发**（见下面 ⑦ 的说明），测了等于没测。
  // 而提示条是 React 状态驱动的，走的是确定性路径 —— 这个环境能验。
  //
  // 也不要指望「输入框换行变高」：textarea 是固定高度 + 内部滚动，
  // 内容再多外框也不变（第一版我这么写，断言必然失败）。
  function clickSend() {
    var ta = document.querySelector('[data-minigal="input"]');
    var btn = document.querySelector('[data-minigal="send"]');
    if (!ta || !btn) return;
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '测试发送');
    ta.dispatchEvent(new window.Event('input', { bubbles: true }));
    // 等一个任务边界：React 要先处理 input 事件，发送按钮才从 disabled 变可用
    setTimeout(function () { btn.click(); }, 80);
  }

  // 有限次 setTimeout —— 虚拟时间下不能用 setInterval（会永不收敛）
  setTimeout(function () { snap('l'); }, 500);
  setTimeout(function () { clickSend(); }, 900);
  setTimeout(function () { snap('m'); host.setAttribute('data-done', '1'); }, 1600);
})();
`;

// 注入 stub（酒馆模式，楼层条与输入栏才有真实内容）后再追加测量脚本
const withStub = readFileSync(ARTIFACT, 'utf8').replace(
  '<div id="root"></div>',
  '<div id="root"></div>\n<script>' + STUB + '</script>',
);
const page = withStub.replace('</body>', '<script>' + MEASURE + '</script>\n</body>');
const PAGE = resolve(DIST, 'dump-layout-app.html');
writeFileSync(PAGE, page);

// ── 断言工具 ─────────────────────────────────────────────────
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

const parseRect = (s) => {
  if (!s || s === 'none' || s === '(缺)') return null;
  const [l, t, r, b] = s.split(',').map(Number);
  return { l, t, r, b };
};
const overlaps = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const inside = (a, vw, vh) => a.l >= 0 && a.t >= 0 && a.r <= vw && a.b <= vh;

// ── 跑各个视口尺寸 ───────────────────────────────────────────
// ★ headless 下 --window-size ≠ 实际视口：实测会裁小，且宽度有下限
// （请求 480 实际约 526）。所以断言一律用**实测视口**做边界，
// 标签只表示「请求的窗口尺寸」。在标签里写死 480 会让人以为测的是 480。
const SIZES = [
  [1000, 700, '桌面（请求窗口 1000×700）'],
  [480, 800, '窄屏（请求窗口 480×800）'],
];

console.log('════ S4/S6 · 布局几何验收 ════\n');

for (const [w, h, label] of SIZES) {
  console.log(`【${label}】`);
  const dump = execFileSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--user-data-dir=C:/Users/24015/AppData/Local/Temp/minigal-chrome-layout',
      '--virtual-time-budget=12000',
      `--window-size=${w},${h}`,
      '--dump-dom',
      `file:///${PAGE.replace(/\\/g, '/')}?instant=1&variant=nosend`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 120000 },
  );

  const pick = (k) => {
    const m = new RegExp(`data-${k}="([^"]*)"`).exec(dump);
    return m ? m[1] : '(缺)';
  };

  if (pick('done') !== '1') {
    ck(`${label} 测量脚本跑完`, false, '超时或报错');
    console.log('');
    continue;
  }

  const vp = (pick('l-vp') || '').split('x').map(Number);
  const [vw, vh] = vp;
  const varH = Number(pick('l-var').replace('px', ''));

  // ★ 别漏 st（.gal-bottom 堆叠容器）——「变量值等于堆叠实测高度」那条要用它。
  // 第一版漏了，表现是「变量值等于…」永远 (缺)，而它其实只是没被读进来。
  const snapKeys = ['fb', 'ft', 'ib', 'db', 'tb', 'st', 'pl'];
  const read = (p) => {
    const o = {};
    for (const k of snapKeys) o[k] = parseRect(pick(`${p}-${k}`));
    return o;
  };
  const L = read('l');
  const M = read('m');

  console.log(`  视口 ${vw}×${vh}  --gal-bottom-h=${pick('l-var')}`);
  console.log(
    `  基线  输入栏 ${pick('l-ib')}  开发条 ${pick('l-db')}  文本框 ${pick('l-tb')}\n` +
      `  撑高后 输入栏 ${pick('m-ib')}  开发条 ${pick('m-db')}  文本框 ${pick('m-tb')}\n`,
  );

  // ① 底部堆叠内部：输入栏与开发条不许互相压（本轮的原始 bug）
  ck('① 输入栏与开发条不重叠', !!L.ib && !!L.db && !overlaps(L.ib, L.db),
    L.ib && L.db ? `输入栏底 ${L.ib.b} vs 开发条顶 ${L.db.t}` : '(缺)');
  ck('① 输入栏在开发条之上', !!L.ib && !!L.db && L.ib.b <= L.db.t + 1,
    L.ib && L.db ? `${L.ib.b} <= ${L.db.t}` : '(缺)');

  // ② 文本框不许被底部任何一块盖住
  ck('② 文本框与输入栏不重叠', !!L.tb && !!L.ib && !overlaps(L.tb, L.ib),
    L.tb && L.ib ? `文本框底 ${L.tb.b} vs 输入栏顶 ${L.ib.t}` : '(缺)');
  ck('② 文本框与开发条不重叠', !!L.tb && !!L.db && !overlaps(L.tb, L.db));
  ck('② 文本框底边在输入栏顶边之上', !!L.tb && !!L.ib && L.tb.b <= L.ib.t + 1);

  // ③ 顶部两个标签不许与居中的楼层条撞车
  ck('③ 解析来源标签与楼层条不重叠', !!L.ft && !!L.fb && !overlaps(L.ft, L.fb),
    L.ft && L.fb ? `标签 ${L.ft.l}-${L.ft.r}/${L.ft.t}-${L.ft.b} vs 楼层条 ${L.fb.l}-${L.fb.r}/${L.fb.t}-${L.fb.b}` : '(缺)');
  ck('③ 场景标签与楼层条不重叠', !!L.pl && !!L.fb && !overlaps(L.pl, L.fb));
  ck('③ 场景标签与解析来源标签不重叠', !!L.pl && !!L.ft && !overlaps(L.pl, L.ft));

  // ④ 所有块都在视口内（不许被切掉）
  for (const k of snapKeys) {
    const name = { fb: '楼层条', ft: '解析来源标签', ib: '输入栏', db: '开发条', tb: '文本框', st: '底部堆叠', pl: '场景标签' }[k];
    ck(`④ ${name} 完整在视口内`, !!L[k] && inside(L[k], vw, vh), L[k] ? JSON.stringify(L[k]) : '(缺)');
  }

  // ⑤ 让位机制本身：变量被写入、且与实际堆叠高度一致
  ck('⑤ --gal-bottom-h 已写入', pick('l-var').endsWith('px') && varH > 0, pick('l-var'));
  ck('⑤ 变量值等于底部堆叠实测高度', !!L.st && varH === L.st.b - L.st.t,
    L.st ? `变量 ${varH} vs 堆叠 ${L.st.b - L.st.t}` : '(缺)');

  // ⑥ 一次真实的状态变化（发送失败 → 提示条）让堆叠变高：变量要跟上、文本框要让位。
  //    写死高度（原来是 56px）会在这里失效 —— 提示条一出现就不够了。
  const Mnotice = parseRect(pick('m-nt'));
  ck('⑥ 前置：提示条确实出现了', !!Mnotice, Mnotice ? JSON.stringify(Mnotice) : '(缺)');
  ck('⑥ 堆叠变高后：变量跟着更新', pick('m-var') !== pick('l-var'),
    `${pick('l-var')} → ${pick('m-var')}`);
  ck('⑥ 堆叠变高后：文本框上移让位', !!M.tb && !!L.tb && M.tb.b < L.tb.b,
    L.tb && M.tb ? `文本框底 ${L.tb.b} → ${M.tb.b}` : '(缺)');
  ck('⑥ 堆叠变高后：仍不重叠', !!M.tb && !!M.ib && !overlaps(M.tb, M.ib),
    M.tb && M.ib ? `文本框底 ${M.tb.b} vs 输入栏顶 ${M.ib.t}` : '(缺)');
  ck('⑥ 提示条与输入栏不重叠', !!Mnotice && !!M.ib && !overlaps(Mnotice, M.ib));

  console.log('');
}

console.log(`════ 汇总：${pass}/${pass + fail} 通过 ════`);
console.log('  ⚠ 覆盖不到的：ResizeObserver 那条路径。');
console.log('    最小探针实测：本环境（headless + 虚拟时间）下 RO 与 rAF 均 0 次触发');
console.log('    （scripts/_probe-ro.mjs 的记录），所以「不来自 React 状态的高度变化」');
console.log('    在这里验不了 —— 这是测试环境的边界，不是应用没做。');
console.log('    应用为此加了确定性路径：notice / isGenerating 变化时重新测量（不依赖观察者）。');
console.log('  （可人工核对：dist/dump-layout-app.html，用浏览器打开并拖窗口宽度）\n');

process.exit(fail > 0 ? 1 : 0);
