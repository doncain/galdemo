// S3 演出层验收：从无头浏览器 dump 出的 DOM 判定「舞台真的在按规则演」。
//
// 判定原则与 S1 一致，且必须一致：
//   ① 一律从 #root 内部取内容再断言，绝不全文档搜索——
//      bundle 里也含同样的字符串（"data-minigal":"stage" 这类），
//      全文档搜索会被自己的代码骗过。
//   ② 断言挂在 **data-* 属性**上，不挂可见文本。
//      舞台状态（谁在台上、谁亮着、谁暂退）本来就是属性，
//      用文本反推既脆弱又读不出语义。
//
// 用法：
//   node scripts/verify-s3-ui.mjs                 # 断言首帧（第 1 行）
//   node scripts/verify-s3-ui.mjs --line=5        # 断言停在第 5 行时的舞台
//   node scripts/verify-s3-ui.mjs --all           # 依次核对 10 行（需逐行 dump，见 run-s3.sh）
//
// 前置：先由 Chrome 生成 dist/dump.html。见 scripts/shoot-s3.sh。

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// dump 落盘路径由调用方给（verify-s3-all.mjs 传），默认与它一致。
// 独立于 S1 的 dump-s1.html：共用文件会「谁最后跑谁赢」。
const dumpArg = (process.argv.find((a) => a.startsWith('--dump=')) || '').split('=')[1];
const dumpPath = resolve(process.cwd(), dumpArg || 'dist/dump-s3.html');
if (!existsSync(dumpPath)) {
  console.error(`缺少 ${dumpPath} —— 先用 Chrome dump 一次页面（或跑 verify-s3-all.mjs）`);
  process.exit(1);
}

const dump = readFileSync(dumpPath, 'utf8');

// #root 边界：#root 之后紧跟注入的 <script>，天然是内容右边界
const start = dump.indexOf('<div id="root">');
const end = dump.indexOf('<script>', start);
if (start === -1 || end === -1) {
  console.error('FAIL  无法定位 #root 边界');
  process.exit(1);
}
const body = dump.slice(start, end);

// ── DOM 快照 ──────────────────────────────────────────────────

const nodes = {
  bg: /data-minigal="bg"/.test(body),
  bgMissing: /data-minigal="bg-missing"/.test(body),
  stage: /data-minigal="stage"/.test(body),
  sprite: /data-minigal="sprite"/.test(body),
  place: /data-minigal="place"/.test(body),
  textbox: /class="gal-textbox/.test(body),
  devbarStage: /data-minigal="devbar-stage"/.test(body),
};

/**
 * 立绘快照：从属性读，不从可见文本读。
 * 这是本脚本的核心数据结构——舞台的全部状态都在这里。
 */
const cast = [...body.matchAll(
  /data-minigal="sprite"[^>]*data-speaker="([^"]*)"[^>]*data-position="([^"]*)"[^>]*data-active="([01])"[^>]*data-hidden="([01])"[^>]*data-emotion-key="([^"]*)"[^>]*data-resolved-key="([^"]*)"[^>]*data-fallback="([01])"/g,
)].map((m) => ({
  speaker: m[1],
  position: m[2],
  active: m[3] === '1',
  hidden: m[4] === '1',
  emotionKey: m[5],
  resolvedKey: m[6],
  fallback: m[7] === '1',
}));

/** 台上可见的人（未暂退） */
const visible = cast.filter((c) => !c.hidden);
/** 亮着的人（正在说话） */
const active = cast.filter((c) => c.active && !c.hidden);

const bgScene = (/data-minigal="bg"[^>]*data-scene="([^"]*)"/.exec(body) || [])[1] ?? null;

const asText = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const lineArg = process.argv.find((a) => a.startsWith('--line='));
const lineNo = lineArg ? Number(lineArg.slice('--line='.length)) : 1;

// ── 按行号分流的断言 ──────────────────────────────────────────
//
// 每一行的期望都由 S3 夹具的舞台语义决定（见 core/fixtures.ts 的 STAGE_LINE_MAP）。
// 不写成「一张大表统一断言」：不同行的舞台状态本来就不同，
// 硬套一套断言只会得到「大部分行都不通过」的假失败。

const checks = [];
const ck = (label, pass, note = '') => checks.push([label, pass, note]);

// —— 所有行通用的地基 ——
ck('舞台容器已渲染', nodes.stage);
ck('文本框已渲染', nodes.textbox);
ck('开发条已含舞台统计', nodes.devbarStage);
ck('同屏立绘不超过 3 个（硬上限）', visible.length <= 3, `${visible.length} 个`);
ck('同一时刻至多一人亮着', active.length <= 1, `${active.length} 人`);

const byName = (n) => cast.find((c) => c.speaker === n);
const posOf = (n) => byName(n)?.position;

switch (lineNo) {
  // 第 1 行：旁白。背景应已建立（[scene:] 是第一行的控制行，第二行的旁白已继承到）。
  // 旁白时舞台上一个人都没有——首帧还没人上台。
  case 1: {
    ck('① 开幕已有背景（[scene:] 生效）', nodes.bg, `scene=${bgScene}`);
    ck('① 背景命中「旧城区/河堤/柳树下」', bgScene === '旧城区/河堤/柳树下', `scene=${bgScene}`);
    ck('① 旁白行：舞台上没有立绘', cast.length === 0, `${cast.length} 个`);
    ck('② 场景标签显示末级名', asText.includes('柳树下'));
    break;
  }

  // 第 2 行：青梧[平静] —— 首个开口者，进 center，亮
  case 2: {
    ck('② 青梧已上台', Boolean(byName('青梧')));
    ck('② 青梧在 center 槽', posOf('青梧') === 'center', `实得 ${posOf('青梧')}`);
    ck('② 青梧亮着（说话人）', byName('青梧')?.active === true);
    ck('② 青梧未暂退', byName('青梧')?.hidden === false);
    ck('② 差分＝calm（[平静]）', byName('青梧')?.emotionKey === 'calm', `实得 ${byName('青梧')?.emotionKey}`);
    ck('② 台上仅青梧一人', visible.length === 1, `${visible.length} 人`);
    break;
  }

  // 第 3 行：青梧[微笑] —— 同角色换差分，位置不变
  case 3: {
    ck('④ 差分已切到 smile', byName('青梧')?.emotionKey === 'smile', `实得 ${byName('青梧')?.emotionKey}`);
    ck('④ 换差分后位置不变（仍 center）', posOf('青梧') === 'center');
    ck('④ 青梧仍亮着', byName('青梧')?.active === true);
    ck('④ 台上仍只有一人（没有重复上台）', cast.length === 1, `${cast.length} 个`);
    break;
  }

  // 第 4 行：<user> —— 玩家发言。全员暂退，玩家绝不上台
  case 4: {
    ck('⑥ 玩家绝不上台（舞台上无 <user>）', !cast.some((c) => c.speaker === '<user>'));
    ck('② 玩家发言时青梧暂退', byName('青梧')?.hidden === true);
    ck('② 暂退 ≠ 清台：青梧仍在 DOM 里（位置记忆）', Boolean(byName('青梧')));
    ck('② 暂退者不亮', byName('青梧')?.active === false);
    ck('⑥ 场上无可见立绘', visible.length === 0, `${visible.length} 人`);
    ck('⑥ 舞台仍保留位置记忆（center 槽未丢）', posOf('青梧') === 'center');
    break;
  }

  // 第 5 行：沈砚[冷淡] —— 第二个角色进 right，青梧转暗但不下台
  case 5: {
    ck('③ 沈砚已上台', Boolean(byName('沈砚')));
    ck('③ 沈砚进 right 槽', posOf('沈砚') === 'right', `实得 ${posOf('沈砚')}`);
    ck('② 青梧转暗（旁听）但仍在台上', byName('青梧')?.active === false && byName('青梧')?.hidden === false);
    ck('② 青梧槽位未变（仍 center）', posOf('青梧') === 'center');
    ck('③ 沈砚亮着', byName('沈砚')?.active === true);
    ck('③ 差分＝cold（[冷淡]）', byName('沈砚')?.emotionKey === 'cold', `实得 ${byName('沈砚')?.emotionKey}`);
    ck('③ 台上共 2 人', visible.length === 2, `${visible.length} 人`);
    break;
  }

  // 第 6 行：阿棠[开心] —— 第三个角色进 left，三人同屏
  case 6: {
    ck('③ 阿棠已上台', Boolean(byName('阿棠')));
    ck('③ 阿棠进 left 槽', posOf('阿棠') === 'left', `实得 ${posOf('阿棠')}`);
    ck('③ 三人同屏', visible.length === 3, `${visible.length} 人`);
    ck('③ 三个槽位互不重叠', new Set(visible.map((c) => c.position)).size === 3);
    ck('③ 只有阿棠亮着', active.length === 1 && active[0].speaker === '阿棠');
    ck('③ 前两人仍留在台上（未暂退）', byName('青梧')?.hidden === false && byName('沈砚')?.hidden === false);
    ck('③ 差分＝happy（[开心]）', byName('阿棠')?.emotionKey === 'happy', `实得 ${byName('阿棠')?.emotionKey}`);
    break;
  }

  // 第 7 行：沈砚[生气] —— 换差分，沈砚亮、其余暗
  case 7: {
    ck('④ 沈砚差分已切到 angry', byName('沈砚')?.emotionKey === 'angry', `实得 ${byName('沈砚')?.emotionKey}`);
    ck('④ 沈砚位置不变（仍 right）', posOf('沈砚') === 'right');
    ck('② 只有沈砚亮着', active.length === 1 && active[0].speaker === '沈砚');
    ck('② 青梧转暗', byName('青梧')?.active === false);
    ck('② 阿棠转暗', byName('阿棠')?.active === false);
    ck('③ 仍为三人同屏（没被顶掉）', visible.length === 3, `${visible.length} 人`);
    break;
  }

  // 第 8 行：青梧[认真] —— 老角色回原槽
  case 8: {
    ck('② 青梧回 center（位置记忆）', posOf('青梧') === 'center');
    ck('② 青梧亮着', byName('青梧')?.active === true);
    ck('④ 差分＝serious（[认真]）', byName('青梧')?.emotionKey === 'serious', `实得 ${byName('青梧')?.emotionKey}`);
    ck('③ 三人仍在台上', visible.length === 3, `${visible.length} 人`);
    ck('② 沈砚转暗但未下台', byName('沈砚')?.active === false && byName('沈砚')?.hidden === false);
    break;
  }

  // 第 9 行：换景后的旁白 —— 场景切到「不存在的地方/虚空」，背景查不到
  case 9: {
    ck('⑤ 场景已切到不存在的路径', asText.includes('虚空'), '');
    ck('⑤ 背景回退未命中：仍显示上一张（不闪黑）', nodes.bg, `scene=${bgScene}`);
    ck('⑤ 背景仍是换景前那张', bgScene === '旧城区/河堤/柳树下', `scene=${bgScene}`);
    ck('⑤ 界面明示「无背景」（不静默）', nodes.bgMissing);
    ck('② 换景清台：旁白行舞台上无人', visible.length === 0, `${visible.length} 人`);
    break;
  }

  // 第 10 行：青梧[无奈] —— 青梧无 helpless 差分 → 回退 calm
  //
  // 【为什么断言不能写成 emotionKey === 'calm'】
  // emotionKey 记录的是「协议/作者要求什么情绪」，它**永远等于 helpless**——
  // 回退发生在查图那一步，不影响这个字段。写成 emotionKey 就是在测错对象，
  // 而且会以「失败」的形式报出来，让人误以为功能坏了。
  // 真正要验的是 resolvedKey（实际命中哪张图）与 fallback 标记。
  case 10: {
    ck('② 换景后青梧进 center', posOf('青梧') === 'center', `实得 ${posOf('青梧')}`);
    ck('② 换景后只剩青梧一人（清台重来）', visible.length === 1, `${visible.length} 人`);
    ck('② 青梧亮着', byName('青梧')?.active === true);
    ck('④ 请求的差分是 helpless（作者写了 [无奈]）', byName('青梧')?.emotionKey === 'helpless',
      `实得 ${byName('青梧')?.emotionKey}`);
    ck('④ 缺 helpless 差分 → 实际命中 calm', byName('青梧')?.resolvedKey === 'calm',
      `实得 ${byName('青梧')?.resolvedKey}`);
    ck('④ 回退标记已置位（不静默）', byName('青梧')?.fallback === true);
    break;
  }

  default:
    console.error(`未知行号 ${lineNo}（S3 夹具共 10 行）`);
    process.exit(1);
}

// ── 输出 ──────────────────────────────────────────────────────

console.log(`\n=== S3 演出层验收 · 第 ${lineNo} 行 ===\n`);
for (const [label, pass, note] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${note ? '  — ' + note : ''}`);
}

console.log('\n舞台快照：');
if (cast.length === 0) {
  console.log('  （空台）');
} else {
  for (const c of cast) {
    console.log(
      `  ${c.speaker.padEnd(6)} ${c.position.padEnd(7)} ` +
        `${c.active ? '亮' : '暗'} ${c.hidden ? '暂退' : '在场'} ` +
        `差分=${c.emotionKey}` +
        (c.fallback ? `→${c.resolvedKey}(回退)` : ''),
    );
  }
}
console.log(`  背景: ${bgScene ?? '（无）'}`);
console.log(`\n画面文本切片：\n  ${asText.slice(0, 180)}`);

const failed = checks.filter(([, p]) => !p);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过\n`);
process.exit(failed.length ? 1 : 0);
