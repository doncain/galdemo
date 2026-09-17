// 一条命令跑完全部本地验收。
//
// ── 为什么要有它 ──────────────────────────────────────────────
// 到 S4 为止，本地验收已经有 8 套（类型检查 / 单测 / S1 / S3 / S4 /
// 布局 / 探针 / 撑高 / 交付），各自是一条 node 命令。
// 靠手敲的话，迟早会出现「改完只跑了印象里相关的那两套」——
// 而回归恰恰发生在你没想到的那一套里。
//
// 这个脚本把结果汇总成一张表：谁过了、谁挂了、挂了几条。
// 有一条失败就非零退出，方便串进别的流程。
//
// ── 注意 ──────────────────────────────────────────────────────
// 它只覆盖**本地能验的**部分。S4 的读楼/发送/生成锁还有一道真机门
// （见 导入到酒馆中/S4真机验证清单.txt），本地全绿**不等于**真机通过。

import { spawnSync } from 'node:child_process';

const NODE = process.execPath;
const ROOT = process.cwd();

const STEPS = [
  { name: '类型检查', args: ['node_modules/typescript/bin/tsc', '--noEmit'], expect: /^\s*$/ },
  { name: '单测编译', args: ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.test.json'], expect: /^\s*$/ },
  {
    name: '单元测试',
    args: ['--test', 'dist-test/**/*.test.js'],
    extract: (o) => (o.match(/# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# fail (\d+)/) || []).slice(1).join('/'),
    ok: (o) => /# fail 0\b/.test(o),
  },
  { name: 'S1 界面', args: ['scripts/verify-s1-ui.mjs'], extract: (o) => (o.match(/(\d+)\/(\d+) 通过/) || [])[0] },
  { name: 'S3 逐行', args: ['scripts/verify-s3-all.mjs'], extract: (o) => (o.match(/(\d+)\/(\d+) 行通过/) || [])[0] },
  { name: 'S4 模拟酒馆', args: ['scripts/verify-s4-ui.mjs'], extract: (o) => (o.match(/汇总：([\d/]+) 通过/) || [])[1] },
  { name: 'S5 模拟酒馆', args: ['scripts/verify-s5-ui.mjs'], extract: (o) => (o.match(/汇总：([\d/]+) 通过/) || [])[1] },
  { name: '布局几何', args: ['scripts/verify-layout.mjs'], extract: (o) => (o.match(/汇总：([\d/]+) 通过/) || [])[1] },
  { name: '锁定前端', args: ['scripts/verify-lock.mjs'], extract: (o) => (o.match(/汇总：([\d/]+) 通过/) || [])[1] },
  { name: '探针自检', args: ['scripts/verify-api-probe.mjs'], extract: (o) => (o.match(/(\d+)\/(\d+) 通过/) || [])[0] },
  { name: '撑高集成', args: ['scripts/verify-iframe-guard.mjs'], extract: (o) => (o.match(/(\d+)\/(\d+) 通过/) || [])[0] },
  { name: '交付自检', args: ['scripts/verify-delivery.mjs'], extract: (o) => (o.match(/结果: (PASS \d+ \/ FAIL \d+)/) || [])[1] },
];

console.log('════ minigal · 本地全量验收 ════\n');

const rows = [];
for (const s of STEPS) {
  const r = spawnSync(NODE, s.args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  const ok = s.ok ? s.ok(out) && r.status === 0 : r.status === 0;
  const detail = s.extract ? s.extract(out) || '' : ok ? '0 错误' : '';
  rows.push({ name: s.name, ok, detail });
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${s.name.padEnd(12)} ${detail || (ok ? '' : '失败')}\n`);
  if (!ok) {
    // 失败时把有用的几行打出来，省得再去翻原始输出
    const bad = out
      .split('\n')
      .filter((l) => /FAIL|not ok|error TS|Error:/.test(l))
      .slice(0, 8);
    if (bad.length) bad.forEach((l) => console.log('      ' + l.trim()));
  }
}

const failed = rows.filter((r) => !r.ok);
console.log(`\n════ ${rows.length - failed.length}/${rows.length} 套通过 ════`);
if (failed.length) {
  console.log('  失败：' + failed.map((r) => r.name).join('、'));
}
console.log('  ⚠ 本地全绿 ≠ 真机通过。S4/S5/S6 各有一道真机门：');
console.log('    导入到酒馆中/S4真机验证清单.txt、S5真机验证清单.txt、S6真机验证清单.txt\n');

process.exit(failed.length ? 1 : 0);
