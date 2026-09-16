// S3 批量验收：逐行 dump + 截图 + 断言。
//
// 为什么要批量：S3 的每一条验收清单都对应「某一行」的状态切换。
// 单独跑一行只能证明那一行是对的；真正要证明的是
// 「第 4 行玩家发言后，第 5 行角色确实回到了原槽位」这类**跨行**性质。
// 所以必须逐行走一遍，把 10 行的结果串起来看。
//
// 用法：node scripts/verify-s3-all.mjs
//
// 前置：先 npm run build（本脚本只读产物 dist/yaoguai/minigal/index.html）。

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { dumpDom, screenshot } from './lib-dump.mjs';

const ROOT = process.cwd();
const distDir = resolve(ROOT, 'dist/yaoguai/minigal');

if (!existsSync(resolve(distDir, 'index.html'))) {
  console.error('缺少产物，先跑 npm run build');
  process.exit(1);
}

// S3 夹具的可播行数。
//
// ⚠ 不要照抄「源文本行数」——两个 [scene:] 控制行不产出行。
// 第一次写这个常量时我数成了 11（按源文本数的），导致行号整体错位一位。
// 正确值来自 fixtures.ts 的 STAGE_LINE_COUNT，两者必须一致。
const TOTAL_LINES = 10;

// dump 落盘路径。**独立于 S1 的 dump-s1.html**——
// 两个验收脚本共用同一个文件会出现「谁最后跑谁赢」，
// 表现是另一个人读到错误夹具后大面积失败（详见 lib-dump.mjs 顶部的说明）。
const DUMP_PATH = resolve(ROOT, 'dist/dump-s3.html');

/** S3 的查询串。fixture=stage 是主角，必须显式带。 */
function queryFor(n) {
  return `instant=1&fixture=stage&line=${n}`;
}

// 每行的验收要点（同时作为截图说明）。
// 与 core/fixtures.ts 的 STAGE_LINE_MAP 一一对应——改一处必须同步另一处。
const SHOTS = {
  1: ['s3-01-narrator-bg.png', '旁白 · 已有背景 · 空台'],
  2: ['s3-02-qingwu-center.png', '青梧 center 亮'],
  3: ['s3-03-qingwu-smile.png', '青梧换差分 smile'],
  4: ['s3-04-player.png', '玩家发言 · 全员暂退'],
  5: ['s3-05-shenyan-right.png', '沈砚进 right · 青梧转暗'],
  6: ['s3-06-atang-left.png', '阿棠进 left · 三人同屏'],
  7: ['s3-07-shenyan-angry.png', '沈砚换差分 angry'],
  8: ['s3-08-qingwu-serious.png', '青梧回 center 换差分 serious'],
  9: ['s3-09-bg-missing.png', '换景查不到 · 背景保留 + 无背景提示'],
  10: ['s3-10-fallback-calm.png', '青梧回退 calm'],
};

console.log('\n════ S3 演出层验收 · 逐行核对 ════\n');

const results = [];
for (let n = 1; n <= TOTAL_LINES; n += 1) {
  console.log(`── 第 ${n} 行 ──`);

  // ① dump DOM
  dumpDom(ROOT, queryFor(n), DUMP_PATH);

  // ② 断言（调用验收脚本，它读 DUMP_PATH）
  let out = '';
  let ok = true;
  try {
    out = execFileSync(
      process.execPath,
      [resolve(ROOT, 'scripts/verify-s3-ui.mjs'), `--line=${n}`, `--dump=${DUMP_PATH}`],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    ok = false;
    out = (e.stdout || '') + (e.stderr || '');
  }

  // 把断言脚本的输出压缩成一行摘要 + 失败明细
  const m = /(\d+)\/(\d+) 通过/.exec(out);
  const stamp = m ? `${m[1]}/${m[2]}` : '?/?';
  const fails = out.split(/\r?\n/).filter((l) => l.startsWith('FAIL'));
  if (ok) {
    console.log(`  断言 ${stamp} 通过`);
  } else {
    console.log(`  断言 ${stamp} —— 有失败：`);
    for (const f of fails) console.log('    ' + f.trim());
  }
  results.push({ n, ok, stamp, fails: fails.length });

  // ③ 截图
  const [name, note] = SHOTS[n];
  screenshot(ROOT, queryFor(n), resolve(ROOT, 'dist/shots', name));
  console.log(`  截图 dist/shots/${name}  ← 第 ${n} 行 ${note}`);
}

console.log('\n════ 汇总 ════\n');
for (const r of results) {
  console.log(`  第 ${String(r.n).padStart(2)} 行  ${r.ok ? 'PASS' : 'FAIL'}  ${r.stamp}`);
}
const bad = results.filter((r) => !r.ok);
console.log(
  `\n  ${results.length - bad.length}/${results.length} 行通过` +
    (bad.length ? `，失败行：${bad.map((r) => r.n).join(', ')}` : ''),
);
console.log(`  截图目录：dist/shots/\n`);

process.exit(bad.length ? 1 : 0);
