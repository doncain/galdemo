// minigal · 真机迭代的监听构建
//
// ── 它解决什么 ─────────────────────────────────────────────────
// 真机迭代（酒馆里看效果）的循环是：
//     改代码 → 构建 → 内联 → 酒馆刷新
// 手工做的话每改一行都要敲一次 `npm run build`，而且很容易忘——
// 忘了的后果是「改了没效果」，去查代码，白花时间。
//
// 这个脚本把前两步自动化：webpack 增量重建，重建一结束就立刻重新内联。
// 你只需要在酒馆里刷新。
//
// ── 用法 ───────────────────────────────────────────────────────
//   终端 A： npm run watch     ← 本脚本（改代码就自动重建）
//   终端 B： npm run serve     ← 本机静态服务（酒馆通过它加载）
//   酒馆里： 启用「minigal-界面-实时修改」，禁用「minigal-界面-正式」
//
// 改完代码后，在酒馆里**切一下楼层再切回来**即可看到新效果
// （iframe 是渲染楼层时创建的，不切不会重新加载）。
//
// ── 为什么不用 webpack --watch 直接接插件 ───────────────────────
// 内联这一步依赖「webpack 已写完 index.js」这个时序。
// 用插件钩子（done 事件）拿不到准确时机，而 webpack 的 output.clean
// 会在每次重建时先清空输出目录——必须等它写完再内联，
// 否则会内联到一个空文件。所以这里监听文件落盘，最可靠。
//
// Ctrl+C 停止（会一并关掉 webpack 子进程）。

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, readFileSync, watch } from 'node:fs';

const ROOT = process.cwd();
const DIST = resolve(ROOT, 'dist/yaoguai/minigal');
const BUNDLE = resolve(DIST, 'index.js');
const ARTIFACT = resolve(DIST, 'index.html');

console.log('\n════ minigal watch ════\n');
console.log('  webpack 增量构建 + 自动内联');
console.log('  改代码 → 自动重建 → 酒馆里刷新（切楼层再切回来）\n');

// ── 启动 webpack --watch ──
// 用 **production** 模式，而不是 development。理由不是「效果更好」，是**防事故**：
//   · 这个 watch 的输出目录与 `npm run build` 完全相同；
//   · 若用 development，监听期间产物就是开发版（体积大、未压缩、
//     可能带 eval），而它躺在那个路径上，随时可能被 publish 推给玩家；
//   · 用 production，即使忘了重新构建，产物也始终是可发布形态。
// 代价是每次重建慢几秒——对「切楼层看效果」这种节奏完全够用。
//
// 想更快可以手工跑 `webpack --watch --mode development`，
// 但那样产出的东西**不要发布**。
const wp = spawn(
  process.execPath,
  [resolve(ROOT, 'node_modules/webpack/bin/webpack.js'), '--mode', 'production', '--watch'],
  { cwd: ROOT, stdio: 'inherit' },
);

wp.on('error', (e) => {
  console.error('  webpack 启动失败:', e.message);
  process.exit(1);
});

// ── 重建一落盘就重新内联 ──
let timer = null;
let count = 0;
let running = false;

/**
 * 等 index.js「确实写完了」再返回；文件不存在则直接返回 false。
 *
 * ── 这里有两类「删除」，都必须忽略 ────────────────────────────
 *   ① **inline.mjs 自己删的**：index.js 是消费完就 rmSync 掉的中间产物。
 *      内联成功 → 删除 → 触发监听 → 如果不管就会空等（第一版就栽在这，
 *      表现为「第一次重建成功、之后报等文件超时」）。
 *   ② **webpack 的 output.clean 删的**：每次重建开始时它先清空输出目录。
 *      这一次也不该内联——真正要等的是它随后**写回**的那一次。
 *
 * 所以判定条件不是「事件发生了」，而是「此刻文件在不在、写完了没」。
 * 事件只用来触发检查，不作为依据。
 *
 * 「写完没写完」用**大小连续两轮不变且非 0** 判定，避开写了一半的窗口。
 */
async function waitForStableBundle(timeoutMs = 8000) {
  const start = Date.now();
  let last = -1;
  const tick = () => new Promise((resolve) => {
    let size = -1;
    try {
      if (existsSync(BUNDLE)) size = readFileSync(BUNDLE).length;
    } catch {
      size = -1;
    }
    if (size > 0 && size === last) return resolve(true);
    last = size;
    if (Date.now() - start > timeoutMs) return resolve(false);
    setTimeout(() => resolve(tick()), 120);
  });
  return tick();
}

async function maybeInline() {
  if (running) return; // 上一次还没跑完就跳过，避免叠加
  // 文件不在 = 上面说的两类「删除」事件之一，静默忽略。
  if (!existsSync(BUNDLE)) return;
  running = true;
  try {
    const ok = await waitForStableBundle();
    if (!ok) {
      console.log('\n  ⚠ index.js 一直写不稳定（webpack 可能正在构建，或构建失败了，看上面的输出）\n');
      return;
    }
    count += 1;
    const t0 = Date.now();
    const r = spawn(process.execPath, [resolve(ROOT, 'scripts/inline.mjs')], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    r.stdout.on('data', (d) => {
      out += d;
    });
    r.stderr.on('data', (d) => {
      out += d;
    });
    await new Promise((res) => r.on('close', res));
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (/FAIL/.test(out)) {
      console.log(`\n  ✗ 第 ${count} 次内联失败（${secs}s）——产物可能不完整，别急着刷新\n`);
      out
        .split('\n')
        .filter((l) => /FAIL|Error/.test(l))
        .forEach((l) => console.log('    ' + l.trim()));
      return;
    }
    let size = 0;
    try {
      size = readFileSync(ARTIFACT).length;
    } catch {
      /* noop */
    }
    const time = new Date().toLocaleTimeString('zh-CN');
    console.log(`\n  ✓ 第 ${count} 次重建完成  ${time}  ${size} B（内联 ${secs}s）`);
    console.log('    → 酒馆里切一下楼层再切回来\n');
  } finally {
    running = false;
  }
}

// 监听输出目录。事件只用来触发检查，真正的判定在 maybeInline 里。
// 去抖合并密集事件：一次重建可能产生多个事件，不去抖会重复内联。
try {
  watch(DIST, (_event, filename) => {
    if (filename !== 'index.js') return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(maybeInline, 300);
  });
} catch (e) {
  console.error('  监听失败:', e.message);
  wp.kill();
  process.exit(1);
}

// 首轮：webpack 启动后本来就会构建一次，等它落盘即可。
// 但若 index.js 已经存在（上一轮遗留），先内联一次让状态确定。
if (existsSync(BUNDLE)) {
  console.log('  （检测到已有 index.js，先内联一次对齐状态）');
  setTimeout(maybeInline, 400);
}

// ── 退出清理 ──
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n  停止 watch…');
    try {
      wp.kill();
    } catch {
      /* noop */
    }
    process.exit(0);
  });
}
