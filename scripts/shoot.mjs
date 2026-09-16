import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// S1 视觉核对：借助应用自身的 ?line=N 参数落在指定行再截图。
//
// 为什么必须 ?instant=1：无头浏览器跑虚拟时间，requestAnimationFrame 与
// performance.now() 不同步，打字机在虚拟时间下永远走不完 → 会截到空文本框。
//
// 不要用「截断楼层文本」来跳行——会破坏 <content> 结构，整个楼层落进降级路径。

const ROOT = process.cwd();
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const UD = 'C:/Users/24015/AppData/Local/Temp/minigal-chrome';
const distDir = resolve(ROOT, 'dist/yaoguai/minigal');
const appUrl = `file:///${distDir.replace(/\\/g, '/')}/index.html`;

const targets = JSON.parse(process.argv[2] ?? '[]');

for (const t of targets) {
  const url = `${appUrl}?instant=1&line=${t.line}`;
  execFileSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${UD}`,
      '--virtual-time-budget=6000',
      '--window-size=1000,700',
      `--screenshot=${resolve(ROOT, 'dist', t.out)}`,
      url,
    ],
    { stdio: 'ignore' },
  );
  console.log(`shot -> dist/${t.out}   第 ${t.line} 行 · ${t.note}`);
}
