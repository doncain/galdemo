// iframe 高度守卫的集成验证（S6）
//
// ── 为什么需要它 ───────────────────────────────────────────────
// 撑高是本次要修的核心问题：酒馆给的 iframe 只有 ~230px 高，
// 我们的 .gal-root（height:100%）只能填满那条窄缝，画面被切掉。
//
// 这个问题**在本地裸跑时根本复现不出来**（没有父页、没有 iframe），
// 所以「S1/S3 验收全绿」不能说明它修好了。必须造一个「像酒馆」的环境：
// 同源的父页 + 一个 height=230 的 iframe + 父页 window 上挂最小 jQuery 模拟。
//
// ── 本环境的两个限制（都踩过）─────────────────────────────────
//   ① Chrome **无法访问本机 HTTP**：起个 localhost 服务让它加载，
//      连最简单的页面也永久挂住（不是虚拟时间的问题，加 --no-proxy-server 也没用）。
//      → 改用 file:// 加载，并加 `--allow-file-access-from-files` 让父子同源。
//   ② 父页采样**不能用 setInterval**：重复定时器会让渲染器永远不进入空闲，
//      --virtual-time-budget 于是永远等不到终点，--dump-dom 不返回。
//      → 用**有限次** setTimeout。
//
// ── 三层断言 ──────────────────────────────────────────────────
//   ① 守卫识别出酒馆环境（应用内徽标显示「已生效」）
//   ② iframe 真的被撑高（230 → ~800）
//   ③ 画面高度跟随（.gal-root 撑满 iframe，不被裁）
//
// 用法：node scripts/verify-iframe-guard.mjs   （前置：npm run build）

import { resolve } from 'node:path';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const ARTIFACT = resolve(ROOT, 'dist/yaoguai/minigal/index.html');

if (!existsSync(ARTIFACT)) {
  console.error('缺少产物，先跑 npm run build');
  process.exit(1);
}

const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/');
const artifactUrl = fileUrl(ARTIFACT);

// ── 假酒馆页 ──
// 最小 jQuery 模拟：只实现 fullscreen.ts 用到的方法。
// 刻意不引入真 jQuery —— 那会掩盖「我们依赖了 $.fn 的某个隐式行为」这类问题。
const FAKE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>fake tavern</title>
<style>body{margin:0;font:12px monospace}.mes{margin:6px 0}
/* 真实酒馆里 iframe 是整宽的，假页面也要整宽 —— 否则截图会给人「画面很窄」的错觉 */
iframe{border:1px solid #444;width:100%;display:block}</style>
</head><body>
<div id="chat">
  <div class="mes" mesid="0"><div style="padding:6px">上一楼</div></div>
  <div class="mes" mesid="1">
    <iframe id="mini" src="${artifactUrl}?instant=1" height="230"></iframe>
  </div>
</div>
<div id="probe">pending</div>
<script>
function makeColl(el){
  const c = {
    0: el, length: el ? 1 : 0,
    height(){ return el ? el.getBoundingClientRect().height : 0; },
    css(obj){ if(el) for(const k in obj) el.style.setProperty(k.replace(/[A-Z]/g, m => '-' + m.toLowerCase()), obj[k]); return c; },
    attr(n, v){ if(!el) return undefined; if(v === undefined) return el.getAttribute(n); el.setAttribute(n, v); return c; },
    text(t){ if(el) el.textContent = t; return c; },
    closest(s){ return makeColl(el && el.closest(s)); },
    last(){ return makeColl(el); },
    remove(){ if(el && el.parentNode) el.parentNode.removeChild(el); return c; },
    appendTo(s){ const p = document.querySelector(s); if(p && el) p.appendChild(el); return c; },
    on(){ return c; },
    off(){ return c; },
  };
  return c;
}
window.$ = function(x){
  if (typeof x === 'string' && x.trim().startsWith('<')) {
    const frag = document.createRange().createContextualFragment(x);
    return makeColl(frag.firstElementChild);
  }
  if (typeof x === 'string') return makeColl(document.querySelector(x));
  return makeColl(x);
};

const iframe = document.getElementById('mini');
const out = document.getElementById('probe');

// 有限次采样。绝不用 setInterval —— 见文件头的限制 ② 。
function sample(){
  const r = iframe.getBoundingClientRect();
  out.dataset.height = String(Math.round(r.height));
  out.dataset.iframew = String(Math.round(r.width));
  const parentEl = iframe.parentElement;
  out.dataset.parentw = String(parentEl ? Math.round(parentEl.clientWidth) : -1);
  try {
    const d = iframe.contentDocument;
    const root = d && d.querySelector('.gal-root');
    const badge = d && d.querySelector('[data-minigal="devbar-size"]');
    out.dataset.inner = root ? String(Math.round(root.getBoundingClientRect().height)) : 'none';
    out.dataset.badge = badge ? badge.textContent : 'none';
    out.dataset.status = badge ? badge.getAttribute('data-size-status') : 'none';
  } catch (e) {
    out.dataset.inner = 'ERR:' + e.message;
  }
  out.textContent = 'h=' + out.dataset.height + ' w=' + out.dataset.iframew + ' inner=' + out.dataset.inner;
}
sample();
[300, 1000, 2500, 4500].forEach(t => setTimeout(sample, t));
</script>
</body></html>`;

const tmpPage = resolve(ROOT, 'dist/tmp-guard-test.html');
writeFileSync(tmpPage, FAKE_PAGE);

console.log('\n════ iframe 高度守卫 · 集成验证 ════\n');
console.log(`  iframe 初始高度  230`);
console.log(`  产物             ${artifactUrl}\n`);

let dump = '';
try {
  dump = execFileSync(
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      // 关键：让 file:// 页面之间可以互相访问（等同源），
      // 否则 window.parent.$ 与 iframe.contentDocument 都被拦住。
      '--allow-file-access-from-files',
      '--user-data-dir=C:/Users/24015/AppData/Local/Temp/minigal-chrome',
      '--virtual-time-budget=6000',
      '--window-size=1000,900',
      '--dump-dom',
      fileUrl(tmpPage),
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 90000 },
  );
} finally {
  // 顺手出一张图：撑高前后是「一眼可见」的差异，
  // 留图比留数字更便于回看与向人说明。
  try {
    execFileSync(
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--allow-file-access-from-files',
        '--user-data-dir=C:/Users/24015/AppData/Local/Temp/minigal-chrome',
        '--virtual-time-budget=6000',
        '--window-size=1000,900',
        `--screenshot=${resolve(ROOT, 'dist/shots/s6-guard.png')}`,
        fileUrl(tmpPage),
      ],
      { stdio: 'ignore', timeout: 90000 },
    );
  } catch {
    /* 截图失败不影响断言结论 */
  }
  try {
    unlinkSync(tmpPage);
  } catch {
    /* noop */
  }
}

const pick = (k) => (new RegExp(`data-${k}="([^"]*)"`).exec(dump) || [])[1] ?? '(缺)';
const iframeH = Number(pick('height'));
const iframeW = Number(pick('iframew'));
const parentW = Number(pick('parentw'));
const innerH = pick('inner');
const badge = pick('badge');
const status = pick('status');

console.log(`  iframe 尺寸        ${iframeW} × ${iframeH}`);
console.log(`  父容器宽度         ${parentW}`);
console.log(`  应用内 .gal-root   ${innerH}`);
console.log(`  诊断徽标           ${badge}`);
console.log(`  data-size-status   ${status}\n`);

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

ck('① 守卫识别出酒馆环境（status=ok）', status === 'ok', `实得 ${status}`);
ck('① 徽标显示「已生效」', /已生效/.test(badge), badge);
ck('② iframe 被撑高（不再是初始的 230）', iframeH > 400, `实得 ${iframeH}`);
ck('② 撑到目标高度 ~800', iframeH >= 700 && iframeH <= 900, `实得 ${iframeH}`);
ck('④ 宽度放到父容器整宽', Math.abs(iframeW - parentW) <= 3, `iframe ${iframeW} vs 父容器 ${parentW}`);
ck(
  '③ 画面高度跟随（.gal-root 撑满 iframe）',
  Number(innerH) > 0 && Math.abs(Number(innerH) - iframeH) <= 4,
  `iframe ${iframeH} vs inner ${innerH}`,
);
ck('③ 画面高度足以显示立绘（>600）', Number(innerH) > 600, `实得 ${innerH}`);

console.log(`\n${pass}/${pass + fail} 通过\n`);
process.exit(fail ? 1 : 0);
