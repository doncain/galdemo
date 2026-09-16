// minigal · 用你自己的文本预览渲染结果
//
// ── 它解决什么 ─────────────────────────────────────────────────
// 在 S4（接入酒馆）完成之前，界面读不到楼层文本，只会显示内置夹具。
// 这个脚本绕开酒馆，直接用 ?floor= 参数把「你写的文本」喂给同一条渲染链路，
// 并输出截图 + 解析摘要。
//
// 用途：
//   · 确认渲染器能不能处理你的文本（角色名、情绪、换景、选项…）
//   · 调剧本协议时的快速反馈（改一句、看一眼，不用推 CDN、不用开酒馆）
//   · 排查「是渲染层的问题，还是管道的问题」——这个脚本只用渲染层
//
// ── 用法 ───────────────────────────────────────────────────────
//   node scripts/preview-floor.mjs <文本文件>            # 渲染文件内容
//   node scripts/preview-floor.mjs <文本文件> --line=3   # 停在可播第 3 行
//   node scripts/preview-floor.mjs --fixture=stage       # 用内置夹具（对照用）
//
// 产物：
//   dist/preview/index.html   该次预览的 DOM
//   dist/preview/shot.png     截图
//
// 前置：先 npm run build。

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dumpDom, chromeArgs, appUrl, CHROME } from './lib-dump.mjs';

const ROOT = process.cwd();

if (!existsSync(resolve(ROOT, 'dist/yaoguai/minigal/index.html'))) {
  console.error('缺少产物，先跑 npm run build');
  process.exit(1);
}

const argv = process.argv.slice(2);
const argOf = (p) => (argv.find((a) => a.startsWith(p)) || '').slice(p.length);
const fixtureArg = argOf('--fixture=');
const lineArg = argOf('--line=');
const fileArg = argv.find((a) => !a.startsWith('--'));

let text = '';
let source = '';

if (fixtureArg) {
  // 用内置夹具：走 ?fixture=，不传 floor
  source = `内置夹具 ${fixtureArg}`;
} else if (fileArg) {
  if (!existsSync(fileArg)) {
    console.error(`找不到文件：${fileArg}`);
    process.exit(1);
  }
  text = readFileSync(fileArg, 'utf8');
  source = fileArg;
} else {
  console.error('用法：node scripts/preview-floor.mjs <文本文件> [--line=N]');
  console.error('  或：node scripts/preview-floor.mjs --fixture=stage');
  process.exit(1);
}

// 组装查询串。?instant=1 关打字动画（无头浏览器虚拟时间下 rAF 走不完）。
const params = ['instant=1'];
if (fixtureArg) params.push(`fixture=${encodeURIComponent(fixtureArg)}`);
if (text) params.push(`floor=${encodeURIComponent(text)}`);
if (lineArg) params.push(`line=${lineArg}`);
const query = params.join('&');

const outDir = resolve(ROOT, 'dist/preview');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const dumpPath = resolve(outDir, 'index.html');
const shotPath = resolve(outDir, 'shot.png');

dumpDom(ROOT, query, dumpPath);
execFileSync(CHROME, chromeArgs([`--screenshot=${shotPath}`, `${appUrl(ROOT)}?${query}`]), {
  cwd: ROOT,
  stdio: 'ignore',
});

// ── 解析摘要：直接调编译好的解析器，比从 DOM 反推准 ──
let summary = '';
try {
  const mod = await import('../dist-test/yaoguai/minigal/core/scriptParser.js');
  const r = mod.parseFloor(text || '');
  const lines = r.lines ?? [];
  const scenes = [...new Set(lines.map((l) => l.location?.path).filter(Boolean))];
  const speakers = [...new Set(lines.map((l) => l.speaker).filter(Boolean))];
  const fb = lines.filter((l) => l.emotionTagged === false && l.speaker).length;
  summary = [
    `  可播行数   ${lines.length}`,
    `  选项       ${r.options?.length ?? 0}`,
    `  解析路径   ${r.usedContentTag ? '严格（有 <content>）' : '降级（无 <content>）'}`,
    `  场景       ${scenes.length ? scenes.join(' → ') : '(无)'}`,
    `  说话人     ${speakers.length ? speakers.join(', ') : '(无)'}`,
    `  缺情绪标注 ${fb} 行${fb ? '（会兜底为平静，界面用虚线灰框标出）' : ''}`,
  ].join('\n');
} catch {
  summary = '  （解析器摘要不可用——先跑 tsc -p tsconfig.test.json）';
}

console.log('\n════ minigal 预览 ════\n');
console.log(`  来源   ${source}`);
console.log(`  地址   ${appUrl(ROOT)}?${query.slice(0, 120)}${query.length > 120 ? '…' : ''}\n`);
console.log('  解析摘要：');
console.log(summary);
console.log(`\n  截图   dist/preview/shot.png`);
console.log(`  DOM    dist/preview/index.html`);
console.log('\n  ★ 这个预览只走渲染链路，不涉及酒馆。');
console.log('    等 S4 接入酒馆后，界面会自动读当前楼层的文本，不再需要这一步。\n');
