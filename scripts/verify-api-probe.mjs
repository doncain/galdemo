// API 探针的自检
//
// ── 为什么需要它 ───────────────────────────────────────────────
// 探针本身要**在酒馆 iframe 里**跑才有意义，那一步只能人工做（见 导入说明.txt）。
// 但有一件事必须自动守住，否则会静默破坏其它所有验收：
//
//   **默认态下探针面板不得进入 DOM。**
//
// 验收脚本一律按 data-* 属性断言，而探针面板会往页面里塞 30 行文本和一批
// data-minigal 属性。如果它默认就渲染，S1/S3 的断言会被污染——
// 而且失败信息看起来会与探针毫无关系，极难定位。
//
// 所以这个脚本守住两条边界：
//   ① 默认态：探针的 DOM 一个都不许有（只有按钮）
//   ② ?probe=1：面板完整渲染，条目数、分组、结论级别都对
//
// 用法：node scripts/verify-api-probe.mjs   （前置：npm run build）

import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { dumpDom } from './lib-dump.mjs';

const ROOT = process.cwd();

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

/** 取 #root 内部（与各验收脚本同一套边界规则，避免被 bundle 里的同名串骗过） */
const sliceRoot = (dump) => {
  const s = dump.indexOf('<div id="root">');
  const e = dump.indexOf('<script>', s);
  return s === -1 || e === -1 ? '' : dump.slice(s, e);
};

const dumpOf = (query, name) => sliceRoot(readFileSync(dumpDom(ROOT, query, resolve(ROOT, name)), 'utf8'));

console.log('\n════ API 探针自检 ════\n');

// ── ① 默认态：面板必须不存在 ──
console.log('── 默认态（不带 ?probe）──');
const plain = dumpOf('instant=1', 'dist/dump-probe-plain.html');

ck('探针面板不在 DOM 里', !plain.includes('api-probe-panel'));
ck('结论条也不在', !plain.includes('api-probe-verdict'));
ck('条目行也不在', !plain.includes('class="gal-probe-row'));
ck('探针按钮在开发条里', plain.includes('api-probe-btn'));

// ── ② ?probe=1：面板完整 ──
console.log('\n── ?probe=1 ──');
const on = dumpOf('instant=1&probe=1', 'dist/dump-probe-on.html');

ck('面板已渲染', on.includes('data-minigal="api-probe-panel"'));

const summary = (/data-minigal="api-probe-summary">([^<]*)</.exec(on) || [])[1] || '';
const level = (/data-minigal="api-probe-verdict"[^>]*data-level="([^"]*)"/.exec(on) || [])[1] || '';
console.log(`        摘要       ${summary}`);
console.log(`        结论级别   ${level}`);

// 条目数 = 19 核心函数 + 7 事件常量 + 4 MVU。改清单时必须同步这里。
const EXPECT_ROWS = 19 + 7 + 4;
const rows = (on.match(/class="gal-probe-row/g) || []).length;
ck(`探针条目数 = ${EXPECT_ROWS}`, rows === EXPECT_ROWS, `实得 ${rows}`);

for (const g of ['核心函数', '事件常量', 'MVU（可选）']) {
  ck(`分组「${g}」已渲染`, on.includes(`>${g}</div>`));
}

// 无头 Chrome 里是裸跑（不在酒馆 iframe）→ 应为 0 存在、级别 bad。
// 这一条同时钉住了「null 不算存在」那个修复：
// window.frameElement 在顶层页面返回 null，若按「!== undefined」判会得到 1/30。
ck('裸跑语境判定 inIframe=false', /iframe=false/.test(summary), summary);
ck('裸跑时 0 个 API 存在（null 不得算作存在）', / 0\//.test(summary), summary);
ck('裸跑时结论级别 = bad（提示换语境）', level === 'bad', `实得 ${level}`);

console.log(`\n${pass}/${pass + fail} 通过\n`);
console.log('  说明：裸跑全 ✗ 是**正常**的——这些函数由酒馆助手注入 iframe，');
console.log('        主页面/裸跑环境本来就没有。要验真实可用性，请在酒馆里点「探 API」。\n');

process.exit(fail ? 1 : 0);
