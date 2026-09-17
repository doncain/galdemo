// 无头浏览器 dump 的公共实现（S0 起就在用，S3 阶段抽出来共用）。
//
// ── 为什么必须抽出来（一次真实的翻车）──────────────────────────
// 原本 verify-s3-all.mjs 生成 dist/dump.html，而 verify-s1-ui.mjs 直接读它。
// 看起来省事，实际有个隐蔽后果：**谁最后跑，谁的内容就留在那个文件里**。
// S3 验收跑完后 S1 验收会读到 S3 夹具的 DOM，
// 表现为「S1 大面积失败」——十九个断言里挂了七个，看着像功能崩了，
// 其实只是读错了夹具。浪费一整轮排查。
//
// 修法：dump 生成收进本模块，调用方**各传各的 fixture 与输出路径**，
// 谁都不依赖别人的残留产物。
//
// ── 不用 shell 重定向 ────────────────────────────────────────
// dump 出的 DOM 含大量 shell 特殊字符（$、"、`、换行），
// 交给 shell 一定会被吃掉一层。用 execFileSync 拿 Buffer 直接写盘，
// 全程不经过任何解释器。

import { execFileSync } from 'node:child_process';
import { resolve, join, relative } from 'node:path';
import { existsSync, writeFileSync, readdirSync, statSync } from 'node:fs';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

export const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p)) ?? CHROME_CANDIDATES[0];

const USER_DATA_DIR = 'C:/Users/24015/AppData/Local/Temp/minigal-chrome';

/**
 * 需要保持新鲜的产物清单。
 *
 * ★ 为什么必须是「每份产物配一个源码目录」，而不是「所有产物 vs 整个 src/」：
 * 本项目有两个独立构建（前端单文件 + 锁定前端脚本）。
 * 若统一拿整个 src/ 去比，改锁定脚本会让**前端产物**被判定为过期 ——
 * 于是所有验收脚本一起拒绝运行，而真正该重建的只有那一个。
 * 这类误报会让人开始怀疑这套检查本身，最后把它关掉，那才是最坏的结果。
 */
const FRESH_TARGETS = {
  app: {
    label: '前端产物',
    artifact: 'dist/yaoguai/minigal/index.html',
    src: 'src/yaoguai',
  },
  lock: {
    label: '锁定前端脚本',
    artifact: 'dist/minigal-lock/index.js',
    src: 'src/lock',
  },
};

/**
 * 产物是否比它自己的源码新。
 *
 * ── 为什么值得做成自动检查 ────────────────────────────────────
 * 「改了源码忘了重新构建」有两种表现，都不好认：
 *   · 新功能相关的断言集体失败 —— 看着像功能坏了，其实是产物里没有那段代码
 *   · 更坏的一种：断言**全绿**，因为它验的是旧产物，而旧产物本来是对的
 * 一轮里我犯过两次。每次都要花几分钟才反应过来。
 *
 * 而它完全可以自动发现：产物的 mtime 必须 >= 对应源码目录下所有源码的 mtime。
 * 排除 *.test.ts —— 测试改动不影响产物，把它算进来会频繁误报。
 */
export function artifactStaleness(root, which = 'app') {
  const t = FRESH_TARGETS[which];
  if (!t) return { ok: false, reason: 'bad-target', newer: [] };

  const artifact = resolve(root, t.artifact);
  if (!existsSync(artifact)) return { ok: false, reason: 'missing', newer: [], label: t.label };
  const artifactMs = statSync(artifact).mtimeMs;

  const newer = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|css|html)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
        if (statSync(p).mtimeMs > artifactMs + 1) newer.push(p);
      }
    }
  };
  const src = resolve(root, t.src);
  if (existsSync(src)) walk(src);

  return { ok: newer.length === 0, reason: newer.length ? 'stale' : '', newer, label: t.label };
}

/** 不新鲜就直接退出，并说清「哪个文件比产物新」。 */
export function assertArtifactFresh(root, which = 'app') {
  const r = artifactStaleness(root, which);
  if (r.reason === 'bad-target') return;
  if (r.reason === 'missing') {
    console.error(`\n✗ 缺少${r.label ?? '产物'}。先跑：npm run build\n`);
    process.exit(1);
  }
  if (!r.ok) {
    console.error(`\n✗ ${r.label}比它的源码旧 —— 你现在验的是旧产物，结论不可信。`);
    console.error('  比产物新的源码：');
    r.newer.slice(0, 8).forEach((f) => console.error('    ' + relative(root, f).replace(/\\/g, '/')));
    if (r.newer.length > 8) console.error(`    … 另有 ${r.newer.length - 8} 个`);
    console.error('  先跑：npm run build\n');
    process.exit(1);
  }
}

/**
 * Chrome 的公共启动参数。
 *
 * --virtual-time-budget 在「够长」与「够快」之间取平衡：
 * 太短 → React 还没渲染完就 dump；太长 → 每行白等。
 * 配合 ?instant=1 关掉打字动画后，实际渲染在 100ms 内完成。
 */
export function chromeArgs(extra = []) {
  return [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${USER_DATA_DIR}`,
    '--virtual-time-budget=4000',
    '--window-size=1000,700',
    ...extra,
  ];
}

/** 产物 index.html 的 file:// URL。子目录里的空格需要转义，故先 replace 反斜杠。 */
export function appUrl(root) {
  const distDir = resolve(root, 'dist/yaoguai/minigal');
  return `file:///${distDir.replace(/\\/g, '/')}/index.html`;
}

/**
 * dump 指定页面的 DOM 并写盘，返回写出的路径。
 *
 * @param {string} root      项目根（process.cwd()）
 * @param {string} query     要带的查询串（不含 ?），例如 'instant=1&fixture=s1&line=3'
 * @param {string} outPath   dump 落盘路径
 */
export function dumpDom(root, query, outPath) {
  assertArtifactFresh(root);
  const url = `${appUrl(root)}${query ? '?' + query : ''}`;
  const buf = execFileSync(CHROME, chromeArgs(['--dump-dom', url]), {
    cwd: root,
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
  writeFileSync(outPath, buf);
  return outPath;
}

/** 对指定页面截图。outPath 必须绝对路径——Chrome 的 --screenshot 相对它自己的 CWD。 */
export function screenshot(root, query, outPath) {
  assertArtifactFresh(root);
  const url = `${appUrl(root)}${query ? '?' + query : ''}`;
  execFileSync(CHROME, chromeArgs([`--screenshot=${outPath}`, url]), {
    cwd: root,
    stdio: 'ignore',
  });
  return outPath;
}
