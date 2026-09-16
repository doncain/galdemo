import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// 浏览器裸跑验收：判定 React 是否真的挂载成功（白屏 = #root 为空）
// 用法：先用无头 Chrome 把产物 dump 成 dump.html，再跑本脚本
const dumpPath = resolve(process.cwd(), 'dist/dump.html');
if (!existsSync(dumpPath)) {
  console.error('缺少 dist/dump.html —— 请先跑无头浏览器 dump');
  process.exit(1);
}

const dump = readFileSync(dumpPath, 'utf8');

const start = dump.indexOf('<div id="root">');
const scriptAt = dump.indexOf('<script>', start);
if (start === -1 || scriptAt === -1) {
  console.error('FAIL  无法定位 #root 或内联脚本边界');
  process.exit(1);
}
const rootHtml = dump.slice(start, scriptAt);
const inner = rootHtml.replace(/^<div id="root">/, '').replace(/<\/div>\s*$/, '').trim();

const checks = [
  ['#root 非空（未白屏）', inner.length > 50, `${inner.length} 字符`],
  ['React 应用已挂载', inner.includes('data-minigal="s0-shell"'), ''],
  ['渲染出真实中文正文', inner.includes('S0 空壳挂载成功'), ''],
  ['版本号已渲染', inner.includes('v0.1.0'), ''],
  ['降级标签正确', dump.includes('阶段：S0 决策与骨架'), ''],
];

for (const [label, pass, detail] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}

const failed = checks.filter(([, pass]) => !pass);
console.log(`\n#root 内联内容预览：\n  ${inner.slice(0, 200).replace(/></g, '>\n  <')}`);
process.exit(failed.length ? 1 : 0);
