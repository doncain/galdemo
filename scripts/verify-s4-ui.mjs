// S4 验收：把「假酒馆」造出来，验读楼 / 导航 / 生成锁 / 降级。
//
// ── 为什么需要这个脚本 ────────────────────────────────────────
// S4 依赖酒馆注入的接口，本地裸跑时那些函数根本不存在 ——
// 所以「本地全绿」证明不了 S4 是活的，只能证明它不崩。
//
// 但反过来，S4 的**逻辑正确性**（读到的是哪一楼、生成中画面有没有被钉住、
// 玩家楼有没有被误当 AI 楼）不该只能靠真机手工点。所以这里注入一套假的
// TavernHelper，把宿主行为复现出来：
//
//   · 往产物副本的 <head> 之后插一段 stub，先于 bundle 执行 ——
//     必须早于 bundle，因为 hasTavern 是在模块加载时算出来的。
//   · 父页是壳，负责按脚本操作 iframe 里的界面并记录每一步的状态。
//
// ── 这个脚本证不了什么（要说清楚，不然会误用）──────────────────
// 它证明的是「面对这套宿主行为，我们的代码算得对」。
// 它**不证明**真酒馆的接口签名/时序就是这样 —— 那是真机门的事。
// stub 里的行为是照着官方文档写的，文档与真机不一致时本脚本会一起错。
//
// ── 环境限制（踩过的坑）────────────────────────────────────────
// 1. 本机 Chrome **无法访问本机 HTTP**（连极简页面也挂），只能用 file://
//    + --allow-file-access-from-files 让父子同源。
// 2. **绝不能用 setInterval** 采样：虚拟时间下有永不收敛的任务，
//    --dump-dom 会一直等下去。用有限次 setTimeout。
// 3. **harness 里记录的键名必须全小写**。它最终变成 DOM 属性
//    （data-r-xxx），而 HTML 属性名是大小写不敏感的 —— DOM 序列化会把
//    驼峰压成小写，于是断言侧按驼峰写的正则永远匹配不到，表现为
//    「这个字段整个缺失」（实得 (缺)），很容易误判成功能没跑。
//    第一次写这个脚本就踩了：d-lastId / b-userLeak 两个键全丢。

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { CHROME } from './lib-dump.mjs';
import { buildAppWithStub } from './lib-tavern-stub.mjs';

const ROOT = process.cwd();
const DIST = resolve(ROOT, 'dist');
const ARTIFACT = resolve(DIST, 'yaoguai/minigal/index.html');
const APP_COPY = resolve(DIST, 'dump-s4-app.html');

if (!existsSync(ARTIFACT)) {
  console.error('缺少产物，先跑 npm run build');
  process.exit(1);
}


// ── 把 stub 注入产物副本 ──
// 实现在 lib-tavern-stub.mjs：与布局验收脚本共用同一份，避免两份渐渐漂移。
buildAppWithStub(ARTIFACT, APP_COPY);

// ── 父页：壳 + 脚本化操作 ─────────────────────────────────────
function parentPage(appHref, steps) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>html,body{margin:0;background:#1b1a22;color:#ddd;font:12px monospace}
iframe{display:block;width:100%;height:230px;border:0}</style></head>
<body>
<iframe id="app" src="${appHref}"></iframe>
<div id="out">pending</div>
<script>
var out = document.getElementById('out');
var app = document.getElementById('app');
function rec(k, v) { out.setAttribute('data-r-' + k, String(v)); }
function fail(e) { rec('error', (e && e.message) || String(e)); rec('done', '1'); }
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function d() { return app.contentDocument; }
function q(s) { var doc = d(); return doc ? doc.querySelector(s) : null; }
function tx(s) { var e = q(s); return e ? e.textContent.trim().replace(/\\s+/g, ' ') : '(缺)'; }
function at(s, a) { var e = q(s); return e ? e.getAttribute(a) : '(缺)'; }
function dis(s) { var e = q(s); return e ? String(e.disabled) : '(缺)'; }
function stub() { return app.contentWindow.__MINIGAL_STUB__; }
// 只查 #root 内部 —— 绝不全文档搜索。
// 第一次写这里时我扫的是 body.textContent，结果永远命中：
// 注入的 stub <script> 就在 body 里，而脚本源码里含玩家那句台词的字面量。
// 于是「玩家的话有没有被当剧本演」这条断言变成永远失败（假阳性）。
// 这跟 S1 阶段「bundle 里也含同样字符串，全文档搜会被自己的代码骗过」
// 是同一类错误 —— 换了个位置又犯一次。
function rootHas(t) { var r = d() && d().getElementById('root'); return r && r.textContent.indexOf(t) >= 0 ? '1' : '0'; }

async function run() {
  await wait(800);
  rec('a-src', at('[data-minigal="source"]', 'data-source-kind'));
  rec('a-devbar', tx('[data-minigal="devbar-state"]'));
  rec('a-place', tx('[data-minigal="place"]'));
  rec('a-pos', tx('[data-minigal="floor-pos"]'));
  rec('a-prev', dis('[data-minigal="floor-prev"]'));
  rec('a-next', dis('[data-minigal="floor-next"]'));
${steps}
  rec('done', '1');
}

run().catch(fail);
</script>
</body></html>`;
}

const STEPS_A = `
  q('[data-minigal="floor-prev"]').click();
  await wait(350);
  rec('b-place', tx('[data-minigal="place"]'));
  rec('b-pos', tx('[data-minigal="floor-pos"]'));
  rec('b-next', dis('[data-minigal="floor-next"]'));
  rec('b-latestbtn', q('[data-minigal="floor-latest"]') ? '1' : '0');

  q('[data-minigal="floor-latest"]').click();
  await wait(350);
  rec('c-place', tx('[data-minigal="place"]'));
  rec('c-pos', tx('[data-minigal="floor-pos"]'));
  rec('c-latestbtn', q('[data-minigal="floor-latest"]') ? '1' : '0');

  var ta = q('[data-minigal="input"]');
  var setVal = Object.getOwnPropertyDescriptor(app.contentWindow.HTMLTextAreaElement.prototype, 'value').set;
  setVal.call(ta, '我走过去了。');
  ta.dispatchEvent(new app.contentWindow.Event('input', { bubbles: true }));
  await wait(250);
  rec('d-send', dis('[data-minigal="send"]'));

  q('[data-minigal="send"]').click();
  await wait(450);
  rec('d-generating', q('[data-minigal="generating"]') ? '1' : '0');
  rec('d-input', dis('[data-minigal="input"]'));
  rec('d-place', tx('[data-minigal="place"]'));
  rec('d-pos', tx('[data-minigal="floor-pos"]'));
  rec('d-devbar', tx('[data-minigal="devbar-state"]'));
  rec('d-lastid', String(app.contentWindow.getLastMessageId()));

  await wait(3200);
  rec('e-generating', q('[data-minigal="generating"]') ? '1' : '0');
  rec('e-place', tx('[data-minigal="place"]'));
  rec('e-pos', tx('[data-minigal="floor-pos"]'));
  rec('e-devbar', tx('[data-minigal="devbar-state"]'));
  rec('e-msgs', stub() ? stub().messages.map(function (m) { return m.role + m.message_id; }).join(',') : '(无)');
  rec('e-usertext', stub() ? stub().messages.filter(function (m) { return m.role === 'user'; }).map(function (m) { return m.message; }).join('|') : '(无)');
`;

const STEPS_B = `
  rec('b-place', tx('[data-minigal="place"]'));
  rec('b-devbar', tx('[data-minigal="devbar-state"]'));
  rec('b-variant', stub() ? stub().variant : '(无)');
  rec('b-userleak', rootHas('推门进去'));
  // 正向对照：否定断言（「不含某文本」）在容器为空时会假通过。
  // 先证明 #root 里确实渲染了第 3 楼的正文，那条否定才有意义。
  // ★ 键名必须全小写（HTML 属性名大小写不敏感）。
  rec('b-roothasfloor3', rootHas('市声涌上来'));
  rec('b-lastid', String(app.contentWindow.getLastMessageId()));
`;

// ── 跑一个场景 ───────────────────────────────────────────────
function runScenario(variant, steps) {
  const appHref = `file:///${APP_COPY.replace(/\\/g, '/')}?instant=1&variant=${variant}`;
  const page = resolve(DIST, `dump-s4-parent-${variant}.html`);
  writeFileSync(page, parentPage(appHref, steps));

  const dump = execFileSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--allow-file-access-from-files',
      '--user-data-dir=C:/Users/24015/AppData/Local/Temp/minigal-chrome-s4',
      '--virtual-time-budget=25000',
      '--window-size=1000,900',
      '--dump-dom',
      `file:///${page.replace(/\\/g, '/')}`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 120000 },
  );

  const pick = (k) => {
    const m = new RegExp(`data-r-${k}="([^"]*)"`).exec(dump);
    return m ? m[1] : '(缺)';
  };
  unlinkSync(page);
  return pick;
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

console.log('════ S4 · 模拟酒馆环境验收 ════\n');

console.log('【场景 A】聊天末尾是 AI 楼 —— 读楼 / 导航 / 发送 / 生成锁');
const A = runScenario('A', STEPS_A);
if (A('done') !== '1') {
  console.log('  FAIL  脚本未跑完，error=' + A('error'));
  fail += 1;
} else {
  console.log(
    `  实测首屏  source=${A('a-src')}  场景=${A('a-place')}  ${A('a-pos')}\n` +
      `            ${A('a-devbar')}\n`,
  );

  ck('① 识别出酒馆环境（source=tavern）', A('a-src') === 'tavern', `实得 ${A('a-src')}`);
  ck('① 读到的是最新 AI 楼（第 3 楼）', A('a-devbar').includes('第3楼'), A('a-devbar'));
  ck('① 读到的是那一楼的原文（3 行）', A('a-devbar').includes('已解析 3 行'), A('a-devbar'));
  ck('① 首屏场景来自第 3 楼，不是夹具', A('a-place') === '二楼雅座', `实得 ${A('a-place')}`);
  ck('① 楼层计数正确（AI 楼共 2 楼）', A('a-pos') === '第 2 / 2 楼', `实得 ${A('a-pos')}`);

  ck('③ 已在最后一楼：上一楼可用', A('a-prev') === 'false', `disabled=${A('a-prev')}`);
  ck('③ 已在最后一楼：下一楼禁用', A('a-next') === 'true', `disabled=${A('a-next')}`);

  console.log('');
  ck('③ 回看第 1 楼：场景切到渡口', A('b-place') === '渡口', `实得 ${A('b-place')}`);
  ck('③ 回看时标记「历史」', A('b-pos').includes('历史'), A('b-pos'));
  ck('③ 回看时下一楼变可用', A('b-next') === 'false', `disabled=${A('b-next')}`);
  ck('③ 回看时出现「回到最新」', A('b-latestbtn') === '1');

  console.log('');
  ck('③ 「回到最新」回到第 3 楼', A('c-place') === '二楼雅座', `实得 ${A('c-place')}`);
  ck('③ 回到最新后不再标「历史」', !A('c-pos').includes('历史'), A('c-pos'));
  ck('③ 回到最新后按钮消失', A('c-latestbtn') === '0');

  console.log('');
  ck('② 输入文字后发送按钮可用', A('d-send') === 'false', `disabled=${A('d-send')}`);
  ck('④ 生成中标记出现', A('d-generating') === '1');
  ck('④ 生成中输入框被锁', A('d-input') === 'true', `disabled=${A('d-input')}`);
  ck('④ 生成中画面被钉住（仍是第 3 楼）', A('d-place') === '二楼雅座', `实得 ${A('d-place')}`);
  ck('④ 生成中不跳到玩家楼（仍显示第 3 楼）', A('d-devbar').includes('第3楼'), A('d-devbar'));
  ck(
    '① 生成窗口期聊天末尾确实是玩家楼（lastMessageId=4）',
    A('d-lastid') === '4',
    `实得 ${A('d-lastid')}`,
  );

  console.log('');
  ck('② 发送的文字真的传给了酒馆', A('e-usertext') === '我走过去了。', `实得 ${A('e-usertext')}`);
  ck('② 聊天里出现了新 AI 楼', A('e-msgs').includes('assistant5'), A('e-msgs'));
  ck('④ 生成结束后锁自动解除', A('e-generating') === '0');
  ck('④ 生成结束后自动跟到新楼（第 3 / 3 楼）', A('e-pos') === '第 3 / 3 楼', `实得 ${A('e-pos')}`);
  ck('④ 自动跟到新楼后不标「历史」', !A('e-pos').includes('历史'), A('e-pos'));
  ck('① 新楼的内容被读到（场景→柳树下）', A('e-place') === '柳树下', `实得 ${A('e-place')}`);
  ck('① 新楼的行数正确（2 行）', A('e-devbar').includes('已解析 2 行'), A('e-devbar'));
}

console.log('\n【场景 B】聊天末尾是玩家楼 —— 最后一楼是 user 的边界');
const B = runScenario('userlast', STEPS_B);
if (B('done') !== '1') {
  console.log('  FAIL  脚本未跑完，error=' + B('error'));
  fail += 1;
} else {
  console.log(`  实测  变体=${B('b-variant')}  lastMessageId=${B('b-lastid')}  场景=${B('b-place')}  |  ${B('b-devbar')}\n`);

  // ★ 先验「前置条件成立」，再验业务结论。
  // 第一次跑这个场景时我把变体令牌写错了（传 B、stub 比的是 userlast），
  // 于是玩家那条消息压根没进聊天 —— 结果「没有泄漏」照样 PASS。
  // 是补的那条正向对照把它抓出来的。这类「变体没生效导致的空过」
  // 只能靠显式断言前置条件来防。
  ck('前置：变体确实生效（userlast）', B('b-variant') === 'userlast', `实得 ${B('b-variant')}`);
  ck('前置：末尾确实是玩家楼（lastMessageId=4）', B('b-lastid') === '4', `实得 ${B('b-lastid')}`);

  ck('① 末尾是玩家楼时，仍取到上一个 AI 楼', B('b-devbar').includes('第3楼'), B('b-devbar'));
  ck('① 显示的是那一楼的内容', B('b-place') === '二楼雅座', `实得 ${B('b-place')}`);
  ck(
    '① 正向对照：第 3 楼正文确实渲染了',
    B('b-roothasfloor3') === '1',
    `实得 ${B('b-roothasfloor3')}`,
  );
  ck(
    '① 玩家那句话没有被当成剧本来演（关键回归点）',
    B('b-userleak') === '0',
    B('b-userleak') === '1' ? '画面里出现了玩家原文' : `未泄漏（实得 ${B('b-userleak')}）`,
  );
}

console.log(`\n════ 汇总：${pass}/${pass + fail} 通过 ════`);
console.log(`  （可人工核对的产物副本：dist/dump-s4-app.html，用浏览器直接打开即可）\n`);

process.exit(fail > 0 ? 1 : 0);
