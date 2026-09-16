// 一次性脚本：给两个正则 JSON 的 replaceString 加上「加载失败时的可见提示」
//
// ── 为什么值得做 ───────────────────────────────────────────────
// 现在 `$('body').load(URL)` 失败时是**完全静默**的：楼层变成空白，
// 没有任何提示。用户看到的现象是「酒馆里没有显示」，而原因可能有四五种
// （服务没起、端口不对、地址写错、仓库私有、网络不通），
// 每一种都要靠人猜。
//
// 加上回调后，失败时直接在楼层里画出原因与排查步骤——把静默故障变成
// 自解释的故障。这与本项目一贯的「不静默失败」原则一致。
//
// ── 关于 `$` 的转义陷阱 ────────────────────────────────────────
// 正则替换用的底层是 JS 的 String.replace，替换串里 `$` 有特殊含义
// （`$&` / `` $` `` / `$'` / `$1` / `$$`）。
// 所以替换串里的 `$` **只能以 `$(` 这种安全形式出现**，绝不能写 `$&` 之类。
// 本脚本生成的串只有 `$('body')`，安全。
//
// 用法：node scripts/patch-error-hint.mjs

import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = process.cwd();
const DIR = resolve(ROOT, '导入到酒馆中');

/** 生成 replaceString。url 之外的文案按渠道定制。 */
function buildReplaceString(url, hint) {
  // 注意：下面的 JS 里除了 $('body') 不要出现任何 $ 开头的特殊序列
  const js = [
    `$('body').load('${url}', function (res, status) {`,
    `  if (status === 'error') {`,
    `    $('body').html(`,
    `      '<div style="padding:22px 26px;font-family:system-ui,sans-serif;` +
      `line-height:1.8;color:#e8c98a;background:#191b21;` +
      `border-left:4px solid #e8a86a;border-radius:4px">' +`,
      `      '<div style="font-size:15px;font-weight:600;margin-bottom:8px">' +`,
      `      'minigal 界面加载失败</div>' +`,
      `      '<div style="font-size:12px;color:#9a948a;margin-bottom:10px">' +`,
      `      '请求地址：${url}</div>' +`,
      `      '<div style="font-size:12px;color:#cfc9bc">' +`,
      `      '${hint}</div>' +`,
      `      '</div>'`,
    `    );`,
    `  }`,
    `});`,
  ].join('\n');
  return '```\n<body>\n<script>\n' + js + '\n</script>\n</body>\n```';
}

const targets = [
  {
    file: 'minigal-界面-实时修改.json',
    url: 'http://localhost:5173/dist/yaoguai/minigal/index.html',
    hint:
      '排查：① 在项目根目录跑 <b>npm run serve</b>，确认它打印的地址与上面一致；' +
      '② 确认这个正则已启用、且「正式版」那条已禁用；' +
      '③ 换端口的话要同步改这里的 URL。',
  },
  {
    file: 'minigal-界面-正式.json',
    url: null, // 从现有 JSON 里取（它已被发布器钉到提交号）
    hint:
      '排查：① 确认网络能访问 cdn.jsdelivr.net；' +
      '② 确认仓库是公开的；' +
      '③ 用 node scripts/verify-cdn.mjs 核对地址内容；' +
      '④ 地址里的提交号需与已推送的产物对应（发布器会自动钉）。',
  },
];

for (const t of targets) {
  const p = resolve(DIR, t.file);
  const json = JSON.parse(readFileSync(p, 'utf8'));
  const url = t.url ?? /\.load\('([^']+)'\)/.exec(json.replaceString)[1];
  json.replaceString = buildReplaceString(url, t.hint);
  writeFileSync(p, JSON.stringify(json, null, 2) + '\n', 'utf8');
  console.log(`  已更新 ${t.file}`);
  console.log(`    URL   ${url}`);
  console.log(`    长度  ${json.replaceString.length} 字符`);
}
console.log('\n  完成。两份都已加上「加载失败时的可见提示」。');
