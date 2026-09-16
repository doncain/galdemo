/**
 * minigal 发布器（S2 交付层的「正式版上线」通道）
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────
 * 「正式版」界面正则指向 jsDelivr：
 *   https://cdn.jsdelivr.net/gh/<user>/<repo>@master/dist/yaoguai/minigal/index.html
 * jsDelivr 不认识你的本地文件，它只做一件事：把 GitHub 仓库的文件按路径映射成 CDN URL。
 * 所以「发布」= 把构建产物提交进 GitHub 仓库的对应路径。没有别的魔法。
 *
 * ── 为什么现在有它 ────────────────────────────────────────────────
 * skill 的 delivery.md 提到 tools/publis/publish_artifact.mjs，但注明「工作区私有工具，
 * 不随本 skill 分发」。本工作区没有那个文件，也不是 git 仓库，所以正式版此时无处可去。
 * 这个脚本把那条链路补齐，并把 delivery.md 的发布铁律做成代码里的硬检查。
 *
 * ── 两条铁律，写死在下面的 guard 里 ──────────────────────────────
 * 铁律 1：构建与发布绝不许串在同一条命令里。
 *   如果你写 `npm run build && node scripts/publish.mjs`，shell 会先跑完 build 才跑
 *   publish——这本身没错。真正的事故是反过来：把 git add 塞进构建命令的同一行、
 *   让它在 webpack 写完文件之前就去读，读到的半截产物被提交，CDN 上就是一个截断的 HTML。
 *   所以本脚本自己重新读盘、自己核对指纹，并拒绝「产物比源码还旧」的情况。
 *
 * 铁律 2：发布后必须核对 CDN 的字节数与内容指纹。
 *   提交成功不等于 CDN 拿到。jsDelivr 有缓存，@master 引用默认缓存 12 小时。
 *   脚本会在提交后给出核对命令和 purge 命令，不会假装发布已经生效。
 *
 * ── 用法 ──────────────────────────────────────────────────────────
 *   node scripts/publish.mjs --dry-run        # 只做全部检查，不碰 git（推荐先跑）
 *   node scripts/publish.mjs                  # 检查 + 提交 + 推送
 *   node scripts/publish.mjs --purge          # 推送后刷 jsDelivr 缓存
 *
 * 前提：本目录需要是一个 git 仓库，且有 origin 指向 GitHub 上的目标仓库。
 *   若还没有：  git init && git remote add origin <你的仓库URL>
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const PURGE = argv.includes('--purge');

const ARTIFACT = 'dist/yaoguai/minigal/index.html';
const artifactPath = path.join(ROOT, ARTIFACT);

let pass = 0;
let fail = 0;
const check = (label, ok, note = '') => {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label}${note ? '  — ' + note : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${note ? '  — ' + note : ''}`);
  }
};

const sh = (cmd, args) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
  }
};

console.log('\n=== minigal 发布器（正式版 → jsDelivr）===\n');
if (DRY) console.log('  [ --dry-run：只检查，不提交 ]\n');

// ── 1. 产物存在且新鲜 ────────────────────────────────────────────
check('产物存在', fs.existsSync(artifactPath), ARTIFACT);
if (!fs.existsSync(artifactPath)) {
  console.log('\n  产物不存在。先跑：npm run build\n');
  process.exit(1);
}

const html = fs.readFileSync(artifactPath, 'utf8');
const size = Buffer.byteLength(html, 'utf8');
const sha = crypto.createHash('sha256').update(html, 'utf8').digest('hex');

// 铁律 1 的机器化：产物必须比所有源码新。产物比源码旧 ⇒ 你改了代码没重新构建，
// 即将把一个旧版本发布上线（CDN 上一版之后就没变过，你会以为发布失败）。
const srcFiles = [];
const collect = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) collect(fp);
    else if (/\.(tsx?|css|html)$/.test(e.name)) srcFiles.push(fp);
  }
};
collect(path.join(ROOT, 'src'));
const artifactMtime = fs.statSync(artifactPath).mtimeMs;
const newestSrc = srcFiles.reduce((a, f) => (fs.statSync(f).mtimeMs > a.mtimeMs ? { mtimeMs: fs.statSync(f).mtimeMs, f } : a), { mtimeMs: 0, f: '(none)' });
check(
  '产物比所有源码新（否则你发的是旧版）',
  artifactMtime >= newestSrc.mtimeMs,
  artifactMtime >= newestSrc.mtimeMs ? '' : `最新源码 ${path.relative(ROOT, newestSrc.f)} 比产物新——先跑 npm run build`
);

check('产物含内联 <script>', /<script>/.test(html));
check('正式产物不含 localhost', !html.includes('localhost'));

// ── 2. 界面正则 JSON 已指向本仓库 ────────────────────────────────
console.log('\n  [ 界面正则 ]');
const formalPath = path.join(ROOT, '导入到酒馆中', 'minigal-界面-正式.json');
check('minigal-界面-正式.json 存在', fs.existsSync(formalPath));
let cdnUrl = null;
if (fs.existsSync(formalPath)) {
  const formal = JSON.parse(fs.readFileSync(formalPath, 'utf8'));
  cdnUrl = /\.load\('([^']+)'\)/.exec(formal.replaceString)?.[1] ?? null;
  const placeholder = typeof cdnUrl === 'string' && /REPLACE_ME/.test(cdnUrl);
  check('正式正则的 CDN 地址已填真实仓库', !placeholder, placeholder ? '⚠ 仍是 REPLACE_ME 占位符' : cdnUrl || '(未解析到 URL)');
}

// ── 3. git 状态 ──────────────────────────────────────────────────
console.log('\n  [ git ]');
const isRepo = sh('git', ['rev-parse', '--is-inside-work-tree']).out === 'true';
check('当前目录是 git 仓库', isRepo);
if (!isRepo) {
  console.log('\n  还没建仓库。先执行（把 URL 换成你的）：');
  console.log('    git init && git remote add origin https://github.com/<user>/<repo>.git\n');
  console.log(`  产物指纹（即便不发布也请记下）：`);
  console.log(`    大小    ${size} B`);
  console.log(`    SHA-256 ${sha}\n`);
  process.exit(1);
}

const remote = sh('git', ['remote', 'get-url', 'origin']);
check('origin 已配置', remote.ok, remote.ok ? remote.out : '（未配置 origin）');

const status = sh('git', ['status', '--porcelain']);
const dirty = status.out ? status.out.split('\n').filter(Boolean) : [];
console.log(`        待提交变更 ${dirty.length} 项`);
for (const d of dirty.slice(0, 12)) console.log('          ' + d);
if (dirty.length > 12) console.log(`          … 另有 ${dirty.length - 12} 项`);

const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out || 'master';

console.log('\n  产物指纹：');
console.log(`    大小    ${size} B`);
console.log(`    SHA-256 ${sha}`);

console.log(`\n=== 检查结果: PASS ${pass} / FAIL ${fail} ===\n`);

if (fail > 0) {
  console.log('  有检查未通过，已中止。修完重跑。\n');
  process.exit(1);
}

if (DRY) {
  console.log('  --dry-run 结束，未做任何提交。\n');
  console.log('  确认无误后去掉 --dry-run 正式发布。\n');
  process.exit(0);
}

// ── 4. 提交并推送 ────────────────────────────────────────────────
// 只提交产物与交付件，不 add -A：避免把 node_modules、本地截图、临时脚本一起推上去。
const addTargets = [ARTIFACT, '导入到酒馆中'];
for (const t of addTargets) {
  const r = sh('git', ['add', t]);
  if (!r.ok) console.log(`  git add ${t} 失败: ${r.out}`);
}
const commitMsg = `build: minigal 产物 ${new Date().toISOString().slice(0, 19).replace('T', ' ')} (${size}B)`;
const commit = sh('git', ['commit', '-m', commitMsg]);
console.log('\n  git commit: ' + (commit.ok ? 'ok' : commit.out.split('\n')[0]));

// ── 4.5 把正式版 json 的 CDN 地址钉到「刚提交的这个 commit」 ──
//
// ── 为什么必须钉提交号，而不是用 @master ──────────────────────
// jsDelivr 对**分支**的解析结果有缓存，且实测极不可靠：
//   · purge 文件路径 → 无效；purge 分支 → 同样无效；
//   · 实测 @master 长期返回几轮之前的内容（响应头 Age 很新，
//     说明边缘缓存是刚刷过的，问题出在 jsDelivr 源站的分支解析）；
//   · 而 @<commit-sha> 是**内容寻址**，实测立刻正确。
// 这是本项目花了一整轮才定位的坑：玩家那边表现是「界面还是旧版」，
// 而且无论怎么清浏览器缓存都没用——因为 CDN 给的就是旧的。
//
// 钉的是「刚刚那个包含产物的提交」，所以地址与产物永远自洽。
// 代价：地址会变，需要更新酒馆里的正则（重导入 json，或直接改 URL 那一行）。
// 开发迭代时请改用本机通道（minigal-界面-实时修改.json），它完全不经过 CDN。
const sha = sh('git', ['rev-parse', 'HEAD']).out.trim();
if (sha) {
  const formalPath = path.join(ROOT, '导入到酒馆中', 'minigal-界面-正式.json');
  if (fs.existsSync(formalPath)) {
    const raw = fs.readFileSync(formalPath, 'utf8');
    // 只替换 @<版本标识> 这一段，其余（路径、域名、转义）原样保留
    const pinned = raw.replace(
      /(cdn\.jsdelivr\.net\/gh\/[^/]+\/[^/@]+)@[^/]+(\/)/,
      `$1@${sha}$2`,
    );
    if (pinned !== raw) {
      fs.writeFileSync(formalPath, pinned, 'utf8');
      console.log(`  已把正式版地址钉到 @${sha.slice(0, 12)}…`);
      sh('git', ['add', formalPath]);
      const pinCommit = sh('git', ['commit', '-m', `chore: 正式版 CDN 地址钉到 ${sha.slice(0, 12)}`]);
      console.log('  git commit: ' + (pinCommit.ok ? 'ok (钉地址)' : pinCommit.out.split('\n')[0]));
    } else {
      console.log(`  正式版地址已是 @${sha.slice(0, 12)}…（无需改动）`);
    }
  }
}

const push = sh('git', ['push', 'origin', `HEAD:${branch}`]);
console.log('  git push  : ' + (push.ok ? 'ok' : push.out.split('\n').slice(-3).join(' | ')));

if (!push.ok) {
  console.log('\n  推送未成功，CDN 上还是旧版。手动处理：');
  console.log(`    git push origin HEAD:${branch}\n`);
  process.exit(1);
}

// ── 5. 铁律 2：发布后核对 ────────────────────────────────────────
console.log('\n  [ 发布后核对（必做）]');
if (cdnUrl) {
  console.log('  ① 核对 CDN 拿到的是同一份（浏览器打开或用 curl）：');
  console.log(`       ${cdnUrl}`);
  console.log(`     期望大小    ${size} B`);
  console.log(`     期望 SHA-256 ${sha}`);
  console.log('     用 PowerShell 核对：');
  console.log(`       (Invoke-WebRequest "${cdnUrl}").RawContentLength`);
  console.log('');
  console.log('  ② 立即生效（@master 默认缓存 12h，不刷则玩家最多 12h 后自动拿到）：');
  console.log(`       https://purge.jsdelivr.net/gh/${/gh\/([^/]+\/[^/]+)@/.exec(cdnUrl)?.[1] ?? '<user>/<repo>'}@master/${ARTIFACT}`);
  console.log('     返回 {"success": true} 即刷新成功。');
  if (PURGE) {
    console.log('\n  --purge：请手动在浏览器打开上面的 purge 链接（脚本不代发外部请求）。');
  }
}
console.log('\n  ③ 真酒馆验收：导入「minigal-界面-正式.json」，确认楼层变成 galgame 界面。');
console.log('     注意 jsDelivr 对刚推送的 commit 有时需要几十秒才回源完成。\n');
