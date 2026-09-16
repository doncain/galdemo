// S5 验收：在「假酒馆」里验变量读取 / 静默重roll / 删楼。
//
// ── 为什么 S5 尤其需要它 ──────────────────────────────────────
// S5 有三件事**在画面上看不出来**：
//   · 重roll 的历史窗口有没有裁（坑 20）—— 发多了不报错，只是贵 + 泄历史
//   · 变量以哪一楼为基线重算（坑 21）—— 基线错了画面照样正常
//   · 删楼用的是不是 /cut（坑 19）—— 用错 API 的后果延迟出现
// 所以这里除了看画面，还**直接查宿主收到的调用参数**（stub 的 calls 日志）。
// 只验最终画面等于没验。
//
// ── 环境限制（与 verify-s4-ui 同源）────────────────────────────
// 1. Chrome 在本机无法访问本机 HTTP，只能用 file:// + --allow-file-access-from-files
// 2. 绝不用 setInterval 采样（虚拟时间下不收敛）
// 3. harness 记录的键名必须全小写（HTML 属性名大小写不敏感）
//    本脚本改用「整段 JSON 塞进 textContent」的方式，绕开这条限制

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { CHROME } from './lib-dump.mjs';
import { buildAppWithStub } from './lib-tavern-stub.mjs';

const ROOT = process.cwd();
const DIST = resolve(ROOT, 'dist');
const ARTIFACT = resolve(DIST, 'yaoguai/minigal/index.html');
const APP_COPY = resolve(DIST, 'dump-s5-app.html');

if (!existsSync(ARTIFACT)) {
  console.error('缺少产物，先跑 npm run build');
  process.exit(1);
}

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
var RESULT = {};
function set(k, v) { RESULT[k] = v; }
function fail(e) { set('error', (e && e.message) || String(e)); finish(); }
function finish() { out.textContent = 'JSON_BEGIN' + JSON.stringify(RESULT) + 'JSON_END'; }
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function d() { return app.contentDocument; }
function q(s) { var doc = d(); return doc ? doc.querySelector(s) : null; }
function tx(s) { var e = q(s); return e ? e.textContent.trim().replace(/\\s+/g, ' ') : '(缺)'; }
function at(s, a) { var e = q(s); return e ? e.getAttribute(a) : '(缺)'; }
function dis(s) { var e = q(s); return e ? String(e.disabled) : '(缺)'; }
function has(s) { return q(s) ? '1' : '0'; }
// 只查 #root 内部 —— 绝不全文档搜索。注入的 stub <script> 就在 body 里，
// 而脚本源码含被测文本的字面量，扫 body 会永远命中（假阳性）。
function rootHas(t) { var r = d() && d().getElementById('root'); return r && r.textContent.indexOf(t) >= 0 ? '1' : '0'; }
function stub() { return app.contentWindow.__MINIGAL_STUB__; }
function findCall(cs, kind) { for (var i = cs.length - 1; i >= 0; i -= 1) if (cs[i].kind === kind) return cs[i]; return null; }

async function run() {
  await wait(900);
${steps}
  finish();
}

run().catch(fail);
</script>
</body></html>`;
}

// ══════════════════════════════════════════════════════════════
// 场景 A：装了 MVU —— 楼层快照 / 重roll / 删楼
// ══════════════════════════════════════════════════════════════
const STEPS_S5 = `
  var cs = stub().calls;

  set('boot.place', tx('[data-minigal="place"]'));
  set('boot.pos', tx('[data-minigal="floor-pos"]'));
  set('boot.devbar', tx('[data-minigal="devbar-state"]'));

  // ── ① 变量面板：应当读到**第 17 楼的快照**（第 ① 层）──
  q('[data-minigal="vars-btn"]').click();
  await wait(300);
  set('vars.panel', has('[data-minigal="vars-panel"]'));
  set('vars.source', at('[data-minigal="vars-panel"]', 'data-vars-source'));
  set('vars.where', tx('[data-minigal="vars-where"]'));
  var body = tx('[data-minigal="vars-body"]');
  set('vars.hasQingwu', body.indexOf('青梧') >= 0 ? '1' : '0');
  set('vars.hasShexian', body.indexOf('沈砚') >= 0 ? '1' : '0');
  set('vars.hour', (/时辰\":\\s*(\\d+)/.exec(body) || [])[1] || 'none');

  q('[data-minigal="vars-close"]').click();
  await wait(250);
  set('vars.afterClose', has('[data-minigal="vars-panel"]'));

  // ── ② 重roll ──
  set('regen.btnDisabled', dis('[data-minigal="regen-btn"]'));
  q('[data-minigal="regen-btn"]').click();
  await wait(1400);

  set('regen.place', tx('[data-minigal="place"]'));
  set('regen.pos', tx('[data-minigal="floor-pos"]'));
  set('regen.devbar', tx('[data-minigal="devbar-state"]'));
  set('regen.notice', tx('[data-minigal="notice"]'));
  set('regen.hasNewLine', rootHas('渡口的木栈道响了一声'));
  set('regen.stillOld', rootHas('茶已经凉了'));

  var gen = findCall(cs, 'generate');
  set('gen.found', gen ? '1' : '0');
  var gp = gen ? gen.payload : null;
  set('gen.silence', gp ? String(gp.should_silence) : '(缺)');
  set('gen.stream', gp ? String(gp.should_stream) : '(缺)');
  set('gen.userInput', gp ? gp.user_input : '(缺)');
  var pr = gp && gp.overrides && gp.overrides.chat_history ? gp.overrides.chat_history.prompts : null;
  set('gen.promptCount', pr ? pr.length : -1);
  set('gen.aiCount', pr ? pr.filter(function (p) { return p.role === 'assistant'; }).length : -1);
  set('gen.firstRole', pr && pr.length ? pr[0].role : '(缺)');
  set('gen.firstText', pr && pr.length ? String(pr[0].content).split('\\n').slice(-1)[0] : '(缺)');
  set('gen.lastRole', pr && pr.length ? pr[pr.length - 1].role : '(缺)');
  set('gen.lastText', pr && pr.length ? pr[pr.length - 1].content : '(缺)');

  var wr = findCall(cs, 'setChatMessages');
  var wp = wr ? wr.payload : null;
  set('set.msgId', wp && wp.msgs ? wp.msgs[0].message_id : '(缺)');
  set('set.refresh', wp && wp.opts ? String(wp.opts.refresh) : '(缺)');
  set('set.count', wp && wp.msgs ? wp.msgs.length : -1);
  set('set.hasVarBlock', wp && wp.msgs ? (String(wp.msgs[0].message).indexOf('UpdateVariable') >= 0 ? '1' : '0') : '(缺)');
  set('set.hasMaintext', wp && wp.msgs ? (String(wp.msgs[0].message).indexOf('重写之后的版本') >= 0 ? '1' : '0') : '(缺)');

  var pm = findCall(cs, 'mvu.parseMessage');
  var pp = pm ? pm.payload : null;
  set('pm.textHasVar', pp ? (String(pp.text).indexOf('UpdateVariable') >= 0 ? '1' : '0') : '(缺)');
  set('pm.textHasThinking', pp ? (String(pp.text).indexOf('先想一下') >= 0 ? '1' : '0') : '(缺)');
  set('pm.baselineHour', pp && pp.oldData && pp.oldData.stat_data ? pp.oldData.stat_data.时间.时辰 : '(缺)');
  set('mvu.afterHour', stub().mvuStore[17] ? stub().mvuStore[17].时间.时辰 : '(缺)');
  set('mvu.keptShexian', stub().mvuStore[17] && stub().mvuStore[17].状态 && stub().mvuStore[17].状态.沈砚 !== undefined ? '1' : '0');
  set('emit.storyUpdated', String(cs.filter(function (c) { return c.kind === 'eventEmit' && c.payload === 'minigal_story_updated'; }).length));

  // ── ③ 删楼 ──
  set('del.btnDisabled', dis('[data-minigal="delete-btn"]'));
  q('[data-minigal="delete-btn"]').click();
  await wait(350);
  set('del.confirmShown', has('[data-minigal="confirm"]'));
  set('del.confirmText', tx('[data-minigal="confirm-text"]'));

  q('[data-minigal="confirm-yes"]').click();
  await wait(900);
  set('del.confirmAfter', has('[data-minigal="confirm"]'));
  set('del.place', tx('[data-minigal="place"]'));
  set('del.pos', tx('[data-minigal="floor-pos"]'));
  set('del.devbar', tx('[data-minigal="devbar-state"]'));
  set('del.gone17', stub().messages.some(function (m) { return m.message_id === 17; }) ? '1' : '0');
  var cuts = cs.filter(function (c) { return c.kind === 'slash' && String(c.payload).indexOf('/cut') === 0; });
  set('del.cutCmd', cuts.length ? cuts[cuts.length - 1].payload : '(缺)');
  set('del.reloaded', '0');
`;

// ══════════════════════════════════════════════════════════════
// 场景 B：没装 MVU —— 变量走聊天变量兜底，重roll 降级但正文照换
// ══════════════════════════════════════════════════════════════
const STEPS_NOMVU = `
  var cs = stub().calls;
  set('boot.place', tx('[data-minigal="place"]'));

  q('[data-minigal="vars-btn"]').click();
  await wait(300);
  set('vars.source', at('[data-minigal="vars-panel"]', 'data-vars-source'));
  set('vars.where', tx('[data-minigal="vars-where"]'));
  var body = tx('[data-minigal="vars-body"]');
  set('vars.body', body.slice(0, 120));
  set('vars.hasChatPlace', body.indexOf('聊天变量里的地点') >= 0 ? '1' : '0');
  q('[data-minigal="vars-close"]').click();
  await wait(200);

  q('[data-minigal="regen-btn"]').click();
  await wait(1400);
  set('regen.place', tx('[data-minigal="place"]'));
  set('regen.hasNewLine', rootHas('渡口的木栈道响了一声'));
  set('regen.notice', tx('[data-minigal="notice"]'));

  var wr = findCall(cs, 'setChatMessages');
  set('set.msgId', wr && wr.payload && wr.payload.msgs ? wr.payload.msgs[0].message_id : '(缺)');
  var pm = findCall(cs, 'mvu.parseMessage');
  set('pm.called', pm ? '1' : '0');
`;

// ══════════════════════════════════════════════════════════════
// 场景 C：三层全空 —— 只显示降级文案，界面不许坏
// ══════════════════════════════════════════════════════════════
const STEPS_NOVARS = `
  set('boot.place', tx('[data-minigal="place"]'));
  set('boot.devbar', tx('[data-minigal="devbar-state"]'));

  q('[data-minigal="vars-btn"]').click();
  await wait(300);
  set('vars.source', at('[data-minigal="vars-panel"]', 'data-vars-source'));
  set('vars.empty', has('[data-minigal="vars-empty"]'));
  set('vars.emptyText', tx('[data-minigal="vars-empty"]'));
  set('vars.hasBody', has('[data-minigal="vars-body"]'));
`;

// ── 跑一个场景 ───────────────────────────────────────────────
function runScenario(variant, steps) {
  const appHref = `file:///${APP_COPY.replace(/\\/g, '/')}?instant=1&variant=${variant}`;
  const page = resolve(DIST, `dump-s5-parent-${variant}.html`);
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
      '--user-data-dir=C:/Users/24015/AppData/Local/Temp/minigal-chrome-s5',
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
  // textContent 在 dump 里是 HTML 转义的，还原顺序：&amp; 必须最后
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

console.log('════ S5 · 模拟酒馆环境验收 ════\n');

// ── 场景 A ──
console.log('【场景 A】装了 MVU：楼层快照 / 静默重roll / 删楼（聊天 9 层 AI 楼）');
const A = runScenario('s5', STEPS_S5);
if (A.__missing) {
  console.log('  FAIL  ' + A.__missing);
  fail += 1;
} else if (A.error) {
  console.log('  FAIL  脚本抛错：' + A.error);
  fail += 1;
} else {
  console.log(
    `  实测首屏  ${A['boot.pos']}  ${A['boot.place']}  |  ${A['boot.devbar']}\n` +
      `  重roll 后  ${A['regen.pos']}  ${A['regen.place']}  |  ${A['regen.devbar']}\n` +
      `  删楼 后   ${A['del.pos']}  ${A['del.place']}  |  ${A['del.devbar']}\n`,
  );

  console.log('  ① 变量（第 ① 层：楼层快照）');
  ck('变量面板能打开', A['vars.panel'] === '1');
  ck('来源标注为楼层快照', A['vars.source'] === 'floor', `实得 ${A['vars.source']}`);
  ck('标注写的是具体楼号', String(A['vars.where']).includes('17'), A['vars.where']);
  ck('读到该楼快照的字段（青梧）', A['vars.hasQingwu'] === '1');
  ck('读到该楼快照的字段（沈砚）', A['vars.hasShexian'] === '1');
  ck('读到的时辰是该楼的值 19（不是别的来源）', A['vars.hour'] === '19', `实得 ${A['vars.hour']}`);
  ck('关闭后面板完全离开 DOM（不污染别的断言）', A['vars.afterClose'] === '0');

  console.log('\n  ② 重roll：窗口裁剪（坑 20）');
  ck('宿主收到了 generate 调用', A['gen.found'] === '1');
  ck('should_silence=true（只生成不建楼）', A['gen.silence'] === 'true', `实得 ${A['gen.silence']}`);
  ck('should_stream=false', A['gen.stream'] === 'false', `实得 ${A['gen.stream']}`);
  ck('输入用的是最后一次玩家楼', A['gen.userInput'] === '第8次行动', `实得 ${A['gen.userInput']}`);
  ck('历史窗口只带 5 层 AI 楼（8 层里裁掉 3 层）', A['gen.aiCount'] === 5, `实得 ${A['gen.aiCount']}`);
  ck('窗口共 10 条（5 AI + 5 玩家）', A['gen.promptCount'] === 10, `实得 ${A['gen.promptCount']}`);
  ck('窗口起点是被保留的最早那层 AI 楼', A['gen.firstRole'] === 'assistant', `实得 ${A['gen.firstRole']}`);
  ck('窗口末尾是本轮玩家输入（不能把它裁掉）', A['gen.lastRole'] === 'user', `实得 ${A['gen.lastRole']}`);
  ck('窗口末尾内容正确', A['gen.lastText'] === '第8次行动', `实得 ${A['gen.lastText']}`);

  console.log('\n  ③ 重roll：变量以该楼旧值为基线重算（坑 21）');
  ck('调用了 mvu.parseMessage', A['pm.baselineHour'] !== '(缺)', `baseline=${A['pm.baselineHour']}`);
  ck('基线是**该楼旧快照**（时辰 19，不是种子 7）', A['pm.baselineHour'] === 19, `实得 ${A['pm.baselineHour']}`);
  ck('变量确实被重算（19 → 20）', A['mvu.afterHour'] === 20, `实得 ${A['mvu.afterHour']}`);
  ck('旧基线里的其它字段被保留（沈砚还在）', A['mvu.keptShexian'] === '1');
  ck('变量解析吃的是剥链**全文**（含变量块）', A['pm.textHasVar'] === '1');
  ck('剥链生效（思维链没喂给变量解析）', A['pm.textHasThinking'] === '0');

  console.log('\n  ④ 重roll：原位替换（不删不建）');
  ck('写回的楼号就是原楼号 17', A['set.msgId'] === 17, `实得 ${A['set.msgId']}`);
  ck('只写一条消息（没新建楼层）', A['set.count'] === 1, `实得 ${A['set.count']}`);
  ck('refresh=none（不让宿主重建 iframe）', A['set.refresh'] === 'none', `实得 ${A['set.refresh']}`);
  ck('写回的是 maintext 正文', A['set.hasMaintext'] === '1');
  ck('写回的内容**不含**变量块（变量块只喂给解析）', A['set.hasVarBlock'] === '0');
  ck('发出了自定义刷新事件（不是 reload）', Number(A['emit.storyUpdated']) >= 1, `实得 ${A['emit.storyUpdated']}`);

  console.log('\n  ⑤ 重roll：画面跟着换 + 楼号不变');
  ck('楼号不变（仍是第 9 楼）', String(A['regen.pos']).includes('第 9 / 9 楼'), A['regen.pos']);
  ck('场景换成新内容的场景（渡口）', A['regen.place'] === '渡口', `实得 ${A['regen.place']}`);
  ck('画面渲染的是新正文', A['regen.hasNewLine'] === '1');
  ck('旧正文已经不在画面上', A['regen.stillOld'] === '0');
  ck('开发条显示新行数（2 行）', String(A['regen.devbar']).includes('已解析 2 行'), A['regen.devbar']);
  ck('给出了「重roll 完成」提示', String(A['regen.notice']).includes('重roll 完成'), A['regen.notice']);
  // 提示里要能看到「回带多少历史」—— 让用户不开 DevTools 也能核对窗口裁剪（坑 20）
  ck('提示里写明了回带的历史层数（免开控制台）', String(A['regen.notice']).includes('5 层 AI 楼'), A['regen.notice']);

  console.log('\n  ⑥ 删楼');
  ck('用的是站内确认条（不是原生对话框）', A['del.confirmShown'] === '1');
  ck('确认条写清了删哪一楼', String(A['del.confirmText']).includes('17'), A['del.confirmText']);
  ck('执行的是 /cut（不是 deleteChatMessages）', A['del.cutCmd'] === '/cut 17-17', `实得 ${A['del.cutCmd']}`);
  ck('楼层真的从聊天里消失了', A['del.gone17'] === '0');
  ck('确认条用完即收', A['del.confirmAfter'] === '0');
  ck('楼号收敛到 8 / 8', String(A['del.pos']).includes('第 8 / 8 楼'), A['del.pos']);
  ck('自动切到剩下的最新楼（河堤）', A['del.place'] === '河堤', `实得 ${A['del.place']}`);
  ck('删楼后没有变成空白（画面仍渲染）', String(A['del.devbar']).includes('已解析'), A['del.devbar']);
}

// ── 场景 B ──
console.log('\n【场景 B】没装 MVU：变量走聊天变量兜底，重roll 降级但正文照换（踩坑 22）');
const B = runScenario('nomvu', STEPS_NOMVU);
if (B.__missing) {
  console.log('  FAIL  ' + B.__missing);
  fail += 1;
} else if (B.error) {
  console.log('  FAIL  脚本抛错：' + B.error);
  fail += 1;
} else {
  console.log(`  实测  source=${B['vars.source']}  where=${B['vars.where']}  重roll 后场景=${B['regen.place']}\n`);
  ck('降级到第 ② 层（聊天变量）', B['vars.source'] === 'chat', `实得 ${B['vars.source']}`);
  ck('来源标注如实说明「不是某楼快照」', String(B['vars.where']).includes('不是某楼快照'), B['vars.where']);
  ck('读到的确实是聊天变量里的值', B['vars.hasChatPlace'] === '1', B['vars.body']);
  ck('重roll 仍然成功（正文照换）', B['regen.hasNewLine'] === '1');
  ck('楼号仍是原楼号 3', Number(B['set.msgId']) === 3, `实得 ${B['set.msgId']}`);
  ck('没有 MVU 就不调它的变量解析', B['pm.called'] === '0');
  ck('提示里说明了变量未重算（不静默）', String(B['regen.notice']).includes('变量未重算'), B['regen.notice']);
}

// ── 场景 C ──
console.log('\n【场景 C】三层全空：只显示降级文案，界面不许坏');
const C = runScenario('novars', STEPS_NOVARS);
if (C.__missing) {
  console.log('  FAIL  ' + C.__missing);
  fail += 1;
} else if (C.error) {
  console.log('  FAIL  脚本抛错：' + C.error);
  fail += 1;
} else {
  console.log(`  实测  source=${C['vars.source']}  |  ${C['boot.devbar']}\n`);
  ck('来源为 none', C['vars.source'] === 'none', `实得 ${C['vars.source']}`);
  ck('显示降级文案而不是 JSON', C['vars.empty'] === '1');
  ck('降级文案说明了原因且不吓人', String(C['vars.emptyText']).includes('没有装 MVU'), C['vars.emptyText']);
  ck('没有渲染空的 JSON 块', C['vars.hasBody'] === '0');
  ck('界面其它部分照常工作（读楼没受影响）', String(C['boot.devbar']).includes('酒馆 第3楼'), C['boot.devbar']);
  ck('画面仍正常渲染', C['boot.place'] === '二楼雅座', `实际 ${C['boot.place']}`);
}

console.log(`\n════ 汇总：${pass}/${pass + fail} 通过 ════`);
console.log('  ⚠ 本脚本验的是「面对这套宿主行为，代码算得对」。');
console.log('    真酒馆的接口签名/时序仍需真机确认 —— 见 导入到酒馆中/S5真机验证清单.txt');
console.log('  （可人工核查的产物副本：dist/dump-s5-app.html）\n');

process.exit(fail > 0 ? 1 : 0);
