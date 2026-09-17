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
// ── 现在它核对**两份**产物 ────────────────────────────────────
// 前端单文件 + 独立发布的锁定前端脚本。两份走不同的 CDN 路径、各自的提交钉点。
// 只核对其中一份的话，另一份可能 404 而无人发现 —— 而症状是
// 「界面是新的，但锁定功能没生效」，几乎不会有人往发布漏了产物这个方向想。
//
// ── 用法 ───────────────────────────────────────────────────────
//   node scripts/verify-cdn.mjs            # 最多重试 10 次，每次间隔递增
//   node scripts/verify-cdn.mjs --once     # 只查一次（CI / 快速检查）
//
// CDN 地址从交付 JSON 里读，不写死——这样地址一改，这里自动跟着改，
// 不会出现「脚本查的地址与交付件不一致」的假通过。

import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadUrl, isBranchRef } from './lib-delivery.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 本机访问 CDN 需要走代理（直连不通）。用 http 方案而不是 socks5 —— 见 CDN仓库创建指引。
const PROXY = process.env.MINIGAL_PROXY ?? 'http://127.0.0.1:7897';

const once = process.argv.includes('--once');
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** 脚本类 JSON 的地址在 content 里，形如 `import '<url>';` */
function importUrl(content) {
  return /import\s+'([^']+)'/.exec(String(content ?? ''))?.[1] ?? null;
}

/** 要核对的两份产物：各自的交付 JSON + 各自的产物体。 */
const TARGETS = [
  {
    label: '前端单文件',
    json: '导入到酒馆中/minigal-界面-正式.json',
    artifact: 'dist/yaoguai/minigal/index.html',
    pick: (j) => loadUrl(j.replaceString),
    where: 'replaceString',
  },
  {
    label: '锁定前端脚本',
    json: '导入到酒馆中/minigal-锁定前端.json',
    artifact: 'dist/minigal-lock/index.js',
    pick: (j) => importUrl(j.content),
    where: 'content',
  },
];

// ── 组装 ──
const prepared = [];
for (const t of TARGETS) {
  const jsonPath = resolve(ROOT, t.json);
  if (!existsSync(jsonPath)) {
    prepared.push({ ...t, fatal: `缺少 ${t.json}` });
    continue;
  }
  let url = null;
  try {
    url = t.pick(JSON.parse(readFileSync(jsonPath, 'utf8')));
  } catch (e) {
    prepared.push({ ...t, fatal: `解析 ${t.json} 失败：${e.message}` });
    continue;
  }
  if (!url) {
    prepared.push({ ...t, fatal: `没能从 ${t.json} 的 ${t.where} 里解析出 CDN 地址（提取逻辑见 lib-delivery.mjs）` });
    continue;
  }
  const artifactPath = resolve(ROOT, t.artifact);
  if (!existsSync(artifactPath)) {
    prepared.push({ ...t, fatal: `缺少产物 ${t.artifact} —— 先跑 npm run build` });
    continue;
  }
  const local = readFileSync(artifactPath);
  prepared.push({ ...t, url, local, localSha: sha(local) });
}

console.log('\n════ 发布后核对 CDN ════\n');
for (const t of prepared) {
  if (t.fatal) {
    console.log(`  [${t.label}]  ✗ ${t.fatal}\n`);
    continue;
  }
  console.log(`  [${t.label}]`);
  console.log(`    地址   ${t.url}`);
  console.log(`    本地   ${t.local.length} B  ${t.localSha.slice(0, 40)}`);

  if (/REPLACE_ME/.test(t.url)) {
    console.log('    ✗ 地址仍是占位符——先填真实仓库（见 CDN仓库创建指引.txt）');
  }

  // 分支引用（@master / @main / @任意分支名）不可靠，必须警告。
  // 实测：jsDelivr 对分支的解析有缓存，purge 文件路径与 purge 分支都无效，
  // @master 会长期返回几轮之前的内容；而 @<commit-sha> 是内容寻址，立刻正确。
  // 危害在于「看起来一切正常」——CDN 返回 200、字节数稳定，只是内容是旧的。
  if (isBranchRef(t.url)) {
    const ref = /@([^/]+)\//.exec(t.url)?.[1] ?? '';
    console.log(`    ⚠ 地址用的是分支引用 @${ref} —— 这不可靠，purge 也修不好。`);
    console.log('      让发布器自动钉提交号：node scripts/publish.mjs');
  }
  console.log('');
}

// ── 逐个核对 ──
/** 用 curl 拉取。Node 的 fetch 不读 http_proxy，所以这里直调 curl 并显式带 -x。 */
function fetchCdn(url) {
  const out = resolve(ROOT, 'dist/.cdn-check.bin');
  try {
    const code = execFileSync(
      'curl',
      ['-s', '-o', out, '-w', '%{http_code}', '-x', PROXY, '--max-time', '60', url],
      { encoding: 'utf8' },
    ).trim();
    if (!existsSync(out)) return { code, buf: null };
    const buf = readFileSync(out);
    execFileSync(process.execPath, ['-e', `require('fs').unlinkSync(${JSON.stringify(out)})`]);
    return { code, buf };
  } catch (e) {
    return { code: 'ERR', buf: null, err: String(e.message || e).slice(0, 120) };
  }
}

/** 用 node 做延时，不用 sleep —— 这个 shell 缺 coreutils，sleep 不可用。 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkOne(t) {
  const MAX = once ? 1 : 10;
  console.log(`  ── ${t.label}`);
  for (let attempt = 1; attempt <= MAX; attempt += 1) {
    const { code, buf, err } = fetchCdn(t.url);

    if (code !== '200' || !buf) {
      console.log(`    第 ${attempt}/${MAX} 次  HTTP ${code}${err ? '  ' + err : ''}`);
    } else if (buf.length === t.local.length && sha(buf) === t.localSha) {
      console.log(`    第 ${attempt}/${MAX} 次  HTTP 200  ${buf.length} B  ✓ 一致`);
      return true;
    } else {
      console.log(`    第 ${attempt}/${MAX} 次  HTTP 200  ${buf.length} B  ← 与本地不符`);
      if (buf.length !== t.local.length) {
        console.log(`          （字节差 ${t.local.length - buf.length}，多半是 CDN 还在旧缓存）`);
      }
    }

    if (attempt < MAX) {
      const ms = Math.min(5000 + attempt * 3000, 25000);
      console.log(`          ${Math.round(ms / 1000)} 秒后重试…`);
      await wait(ms);
    }
  }

  console.log(`    ✗ 仍不一致。可能原因：`);
  console.log('       ① 推送还没完成（先跑 git status / git log -1）');
  console.log('       ② jsDelivr 回源慢（再等等，或用下面链接手动刷）');
  console.log('       ③ 产物没重新构建（npm run build）就发布了');
  console.log(`       手动刷：${t.url.replace('cdn.jsdelivr.net/gh/', 'purge.jsdelivr.net/gh/')}`);
  return false;
}

let allOk = true;
let anyChecked = false;
for (const t of prepared) {
  if (t.fatal) {
    allOk = false;
    continue;
  }
  anyChecked = true;
  const ok = await checkOne(t);
  if (!ok) allOk = false;
}

console.log('');
if (!anyChecked) {
  console.log('  ✗ 没有任何可核对的产物 —— 先修上面的致命问题。\n');
  process.exit(1);
}
console.log(allOk ? '  ✓ 全部一致 —— 发布成功。\n' : '  ✗ 有产物未通过核对（见上）。\n');
process.exit(allOk ? 0 : 1);
