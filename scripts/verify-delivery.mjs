/**
 * minigal 交付件自检（S2）
 *
 * 存在的理由：界面正则 JSON 里有几个字段「写错了不报错、只在真机上静默失效」——
 *   · placement 写成 [1]  → 正则改动会污染发给 AI 的提示词（AI 会开始模仿 iframe 代码）
 *   · 正式版混进 localhost → 玩家拉不到东西，白屏
 *   · replaceString 丢了 ``` 围栏 → 酒馆助手不把代码块提升为 iframe，楼层里直接显示一堆源码
 *   · JSON 里多一个尾逗号 → 导入时直接失败
 * 这些都不该靠人眼盯。每次构建完跑一遍。
 *
 * 用法：node scripts/verify-delivery.mjs
 * 退出码非 0 表示有 FAIL。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, '导入到酒馆中');

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

console.log('\n=== minigal 交付件自检（S2 界面正则）===\n');

if (!fs.existsSync(DIR)) {
  console.log('  FAIL  交付目录不存在: ' + DIR);
  process.exit(1);
}

const files = fs.readdirSync(DIR);
console.log('  交付目录内容: ' + files.join(', ') + '\n');

/**
 * 共用的结构断言。每个正则 JSON 都必须满足这些——不分正式/实时。
 */
function auditShape(name, raw) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    check(`${name} · JSON 语法合法`, false, e.message);
    return null;
  }
  check(`${name} · JSON 语法合法`, true);

  check(`${name} · scriptName 为「minigal-界面」`, json.scriptName === 'minigal-界面', `实得 ${JSON.stringify(json.scriptName)}`);

  // findRegex 必须是「匹配整层」的形态。写成别的（比如只匹配某一段）会让
  // 楼层里没被匹配到的残余文本直接裸露在界面上。
  //
  // ⚠ 这里别用 /^\/\[\\\\s\\\\S\]\*\/s$/ 这种层层套娃的正则去核——
  // JSON 反序列化后 findRegex 就是一个含真实反斜杠字符的普通字符串（10 个字符：
  // / [ \ s \ S ] * / s）。断言里再叠一层转义，结果永远不会相等。
  // 直接和「期望字符串」比，让 JS 自己处理转义。
  const EXPECT_FIND_REGEX = '/' + '[' + '\\' + 's' + '\\' + 'S' + ']' + '*' + '/' + 's';
  check(
    `${name} · findRegex 为 /[\\s\\S]*/s（匹配整层）`,
    json.findRegex === EXPECT_FIND_REGEX,
    `实得 ${JSON.stringify(json.findRegex)}`
  );

  // placement=[2] 是「仅显示层」。这是本文件最容易、也最致命的写错点。
  check(
    `${name} · placement 恰为 [2]（仅显示层，不碰提示词）`,
    Array.isArray(json.placement) && json.placement.length === 1 && json.placement[0] === 2,
    `实得 ${JSON.stringify(json.placement)}`
  );

  check(`${name} · markdownOnly 为 true`, json.markdownOnly === true);
  check(`${name} · promptOnly 为 false`, json.promptOnly === false);
  check(`${name} · substituteRegex 为 false`, json.substituteRegex === false);

  // 替换串的三件套：围栏 + body + load。缺任何一个链路都断。
  const rs = json.replaceString;
  check(`${name} · replaceString 是字符串`, typeof rs === 'string');
  if (typeof rs === 'string') {
    // 注意：围栏就是三个反引号本身。不要试图把「三个反引号」写进模板字符串里——
    // 它会把模板字符串提前闭合，报一个和真正问题毫无关系的语法错。用常量拼。
    const FENCE = '`'.repeat(3);
    check(`${name} · replaceString 带 ${FENCE} 围栏（酒馆助手据此提升为 iframe）`, rs.includes(FENCE));
    check(`${name} · replaceString 含 <body>`, /<body>/.test(rs));
    check(`${name} · replaceString 用 $('body').load(...) 拉远程 HTML`, /\$\('body'\)\.load\('[^']+'\)/.test(rs));
    const urls = [...rs.matchAll(/\.load\('([^']+)'\)/g)].map((m) => m[1]);
    check(`${name} · replaceString 恰有 1 个 load URL`, urls.length === 1, `实得 ${urls.length} 个`);
    return { json, url: urls[0] };
  }
  return { json, url: null };
}

// ---- 正式版 ----
console.log('  [ 正式版 ]');
const formalPath = path.join(DIR, 'minigal-界面-正式.json');
check('minigal-界面-正式.json 存在', fs.existsSync(formalPath));
if (fs.existsSync(formalPath)) {
  const r = auditShape('正式', fs.readFileSync(formalPath, 'utf8'));
  if (r) {
    check('正式 · disabled 为 false（交付时启用）', r.json.disabled === false);
    // delivery.md 铁律：正式 JSON 里不许出现 localhost。
    check('正式 · 不含 localhost（铁律）', !fs.readFileSync(formalPath, 'utf8').includes('localhost'));
    check(
      '正式 · URL 走 jsDelivr CDN',
      typeof r.url === 'string' && r.url.startsWith('https://cdn.jsdelivr.net/gh/'),
      r.url || '(无)'
    );
    // 占位符检查：允许存在但必须显式提醒，否则发上线就是一个 404 CDN。
    const hasPlaceholder = typeof r.url === 'string' && /REPLACE_ME/.test(r.url);
    check(
      '正式 · CDN 地址已填真实仓库（未填则是上线前必改项）',
      !hasPlaceholder,
      hasPlaceholder ? '⚠ 仍是 REPLACE_ME 占位符——上线前必须替换' : r.url
    );
  }
}

// ---- 实时修改版 ----
console.log('\n  [ 实时修改版 ]');
const devPath = path.join(DIR, 'minigal-界面-实时修改.json');
check('minigal-界面-实时修改.json 存在', fs.existsSync(devPath));
if (fs.existsSync(devPath)) {
  const r = auditShape('实时', fs.readFileSync(devPath, 'utf8'));
  if (r) {
    // 这个版本就是给本机用的，所以默认必须禁用；不然玩家也会去连 localhost。
    check('实时 · disabled 为 true（默认禁用，仅开发时手工启用）', r.json.disabled === true);
    check(
      '实时 · URL 指向 localhost',
      typeof r.url === 'string' && /^http:\/\/localhost:\d+\//.test(r.url),
      r.url || '(无)'
    );
    check(
      '实时 · URL 路径为 /dist/yaoguai/minigal/index.html',
      typeof r.url === 'string' && r.url.endsWith('/dist/yaoguai/minigal/index.html'),
      r.url || '(无)'
    );
    // 两个正则的 id 必须不同，否则导入脚本库时互相覆盖。
    const fid = JSON.parse(fs.readFileSync(formalPath, 'utf8')).id;
    check('正式与实时的 id 不同（否则导入时互相覆盖）', fid !== r.json.id);
  }
}

// ---- 本地服务器 ----
console.log('\n  [ 本地开发通道 ]');
const servePath = path.join(ROOT, 'scripts', 'serve.mjs');
check('scripts/serve.mjs 存在', fs.existsSync(servePath));
if (fs.existsSync(servePath)) {
  const s = fs.readFileSync(servePath, 'utf8');
  check('serve.mjs 开 CORS（否则 iframe 跨源拉不到）', s.includes('Access-Control-Allow-Origin'));
}

// ---- 构建产物 ----
console.log('\n  [ 构建产物 ]');
const distPath = path.join(ROOT, 'dist', 'yaoguai', 'minigal', 'index.html');
check('dist/yaoguai/minigal/index.html 存在（本地正则指向它）', fs.existsSync(distPath));
if (fs.existsSync(distPath)) {
  const size = fs.statSync(distPath).size;
  const html = fs.readFileSync(distPath, 'utf8');
  check('产物非空', size > 1000, `${size}B`);

  // 结构断言只做「有没有内联脚本」这一条——产物首尾形态（<!doctype>、</html> 收尾、
  // 零外部引用）已由 scripts/inline.mjs 的 9 项自检保证，此处不重复。
  // 曾经在这里写过 `产物以 </body> 收尾`，把完整 HTML 文档（实际以 </html> 收尾）
  // 判成失败——那是断言错，不是产物错。宁可少一条冗余检查，也不要一条会误报的检查。
  check('产物含内联 <script>（单文件就绪）', /<script>/.test(html));

  // 交付层真正要盯的是「上线后的产物和现在这份是不是同一份」。
  // delivery.md 的发布铁律要求：发布后核对 CDN 返回的字节数 == 本地 size。
  // 字节数只能挡住长度不同的差异；补一个内容指纹，才算真的核过。
  const sha = crypto.createHash('sha256').update(html, 'utf8').digest('hex');
  console.log(`        产物大小 ${size}B`);
  console.log(`        SHA-256  ${sha}`);
  console.log('        发布后请核对：CDN 返回字节数 == ' + size + '，且 SHA-256 == 上面这行');
}


console.log('\n=== 结果: PASS ' + pass + ' / FAIL ' + fail + ' ===\n');
process.exit(fail > 0 ? 1 : 0);
