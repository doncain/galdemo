// minigal · 发布后核对 CDN（把「铁律 2」自动化）
//
// ── 为什么需要它 ───────────────────────────────────────────────
// publish.mjs 的注释里写着「发布后必须核对 CDN 的字节数与内容指纹」，
// 但它只打印命令让人手工做。手工做的问题是：
//   · 容易省略（推完就走了）
//   · 省略的后果是「以为发布成功、其实 CDN 还是旧版」，且要等玩家反馈才发现
//
// 这个脚本把那一-步自动化，并且处理好友善度最低的环节：
// **jsDelivr 对新推送的提交需要时间回源。** 推完立刻查，多半还是旧版，
// 于是你会在「到底成功没有」上反复怀疑。脚本自己重试，把这段不确定性吃掉。
//
// ── 用法 ───────────────────────────────────────────────────────
//   node scripts/verify-cdn.mjs            # 最多重试 10 次，每次间隔递增
//   node scripts/verify-cdn.mjs --once     # 只查一次（CI / 快速检查）
//
// CDN 地址从「正式版 json」里读，不写死——这样地址一改，这里自动跟着改，
// 不会出现「脚本查的地址与交付件不一致」的假通过。

import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT = 'dist/yaoguai/minigal/index.html';
const FORMAL = '导入到酒馆中/minigal-界面-正式.json';

// 本机访问 CDN 需要走代理（直连不通）。用 http 方案而不是 socks5 —— 见 CDN仓库创建指引。
const PROXY = process.env.MINIGAL_PROXY ?? 'http://127.0.0.1:7897';

const once = process.argv.includes('--once');

const artifactPath = resolve(ROOT, ARTIFACT);
if (!existsSync(artifactPath)) {
  console.error(`缺少产物 ${ARTIFACT} —— 先跑 npm run build`);
  process.exit(1);
}

// ── 从正式版 json 里取 CDN 地址 ──
const formalPath = resolve(ROOT, FORMAL);
if (!existsSync(formalPath)) {
  console.error(`缺少 ${FORMAL}`);
  process.exit(1);
}
const formal = JSON.parse(readFileSync(formalPath, 'utf8'));
const url = /\.load\('([^']+)'\)/.exec(formal.replaceString)?.[1];
if (!url) {
  console.error('没能从正式版 json 的 replaceString 里解析出 CDN 地址');
  process.exit(1);
}

const local = readFileSync(artifactPath);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const localSha = sha(local);

console.log('\n════ 发布后核对 CDN ════\n');
console.log(`  地址   ${url}`);
console.log(`  本地   ${local.length} B  ${localSha}\n`);

if (/REPLACE_ME/.test(url)) {
  console.error('  CDN 地址仍是占位符——先填真实仓库（见 CDN仓库创建指引.txt）\n');
  process.exit(1);
}

/** 用 curl 拉取。Node 的 fetch 不读 http_proxy，所以这里直调 curl 并显式带 -x。 */
function fetchCdn() {
  const out = resolve(ROOT, 'dist/.cdn-check.bin');
  try {
    const code = execFileSync(
      'curl',
      ['-s', '-o', out, '-w', '%{http_code}', '-x', PROXY, '--max-time', '60', url],
      { encoding: 'utf8' },
    ).trim();
    if (!existsSync(out)) return { code, buf: null };
    const buf = readFileSync(out);
    execFileSync('node', ['-e', `require('fs').unlinkSync(${JSON.stringify(out)})`]);
    return { code, buf };
  } catch (e) {
    return { code: 'ERR', buf: null, err: String(e.message || e).slice(0, 120) };
  }
}

/** 用 node 做延时，不用 sleep —— 这个 shell 缺 coreutils，sleep 不可用。 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const MAX = once ? 1 : 10;
for (let attempt = 1; attempt <= MAX; attempt += 1) {
  const { code, buf, err } = fetchCdn();

  if (code !== '200' || !buf) {
    console.log(`  第 ${attempt}/${MAX} 次  HTTP ${code}${err ? '  ' + err : ''}`);
  } else if (buf.length === local.length && sha(buf) === localSha) {
    console.log(`  第 ${attempt}/${MAX} 次  HTTP 200  ${buf.length} B  ${sha(buf)}`);
    console.log('\n  ✓ 一致 —— CDN 拿到的就是本地产物，发布成功。\n');
    process.exit(0);
  } else {
    console.log(
      `  第 ${attempt}/${MAX} 次  HTTP 200  ${buf.length} B  ${sha(buf).slice(0, 24)}…  ← 与本地不符`,
    );
    if (buf.length !== local.length) {
      console.log(`        （字节差 ${local.length - buf.length}，多半是 CDN 还在旧缓存）`);
    }
  }

  if (attempt < MAX) {
    // 递增等待：jsDelivr 回源通常几十秒内完成
    const ms = Math.min(5000 + attempt * 3000, 25000);
    console.log(`        ${Math.round(ms / 1000)} 秒后重试…`);
    await wait(ms);
  }
}

console.log('\n  ✗ 仍不一致。可能原因：');
console.log('     ① 推送还没完成，或推的不是这个产物（先跑 git status / git log -1）');
console.log('     ② jsDelivr 回源慢（再等等，或用下面的 purge 链接手动刷）');
console.log('     ③ 产物没重新构建（npm run build）就发布了');
console.log('\n  手动刷缓存：');
const purge = url.replace('cdn.jsdelivr.net/gh/', 'purge.jsdelivr.net/gh/');
console.log(`     ${purge}\n`);
process.exit(1);
