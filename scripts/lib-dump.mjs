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
import { resolve } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

export const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p)) ?? CHROME_CANDIDATES[0];

const USER_DATA_DIR = 'C:/Users/24015/AppData/Local/Temp/minigal-chrome';

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
  const url = `${appUrl(root)}${query ? '?' + query : ''}`;
  execFileSync(CHROME, chromeArgs([`--screenshot=${outPath}`, url]), {
    cwd: root,
    stdio: 'ignore',
  });
  return outPath;
}
