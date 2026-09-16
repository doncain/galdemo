import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { dumpDom } from './lib-dump.mjs';

// S1 验收：从无头浏览器 dump 出的 DOM 判定「这一幕真的播出来了」。
// 判定原则：一律从「挂载点内部」取内容再断言，绝不全文档搜索——
// bundle 里也含同样的字符串，全文档搜索会被自己的代码骗过。
//
// 【dump 由本脚本自己生成，用独立的文件名】
// 早先这里是读 dist/dump.html，那个文件由 S3 验收脚本写。
// 后果是「谁最后跑，谁的内容留在里面」：S3 跑完后 S1 会读到 S3 的夹具，
// 表现为 S1 大面积失败——看着像功能崩了，其实只是读错了夹具。
// 现在各自写各自的文件（dist/dump-s1.html / dist/dump-s3.html），互不干扰。
//
// fixture=s1 必须显式带上：App 的默认档虽然就是 s1，
// 但依赖「默认值恰好是我要的」是脆弱的——哪天默认值改了，
// 这里会以「一堆看不懂的断言失败」的形式暴露，而不是一句清晰的错误。
const ROOT = process.cwd();
const dumpPath = resolve(ROOT, 'dist/dump-s1.html');

if (!existsSync(resolve(ROOT, 'dist/yaoguai/minigal/index.html'))) {
  console.error('缺少产物，先跑 npm run build');
  process.exit(1);
}

// ?instant=1 关打字动画（虚拟时间下 rAF 走不完，会截到空文本框）。
const lineArgRaw = (process.argv.find((a) => a.startsWith('--line=')) || '').split('=')[1];
const query = `instant=1&fixture=s1${lineArgRaw ? `&line=${lineArgRaw}` : ''}`;
dumpDom(ROOT, query, dumpPath);

const dump = readFileSync(dumpPath, 'utf8');

// #root 之后紧跟注入的 <script>，天然是内容右边界
const start = dump.indexOf('<div id="root">');
const end = dump.indexOf('<script>', start);
if (start === -1 || end === -1) {
  console.error('FAIL  无法定位 #root 边界');
  process.exit(1);
}
const body = dump.slice(start, end);

const nodes = {
  textbox: /class="gal-textbox/.test(body),
  name: /class="gal-name/.test(body),
  nameIsPlayer: /class="gal-name gal-name-user/.test(body),
  text: /class="gal-text narrator/.test(body),
  place: /class="gal-place"/.test(body),
  source: /data-minigal="source"/.test(body),
  progress: /data-minigal="progress"/.test(body),
  devbar: /class="gal-devbar"/.test(body),
  cursor: /class="gal-cursor"/.test(body),
  emotion: /data-minigal="emotion"/.test(body),
  drift: /data-minigal="narrator-drift"/.test(body),
};

// 情绪标签快照：用属性而非可见文本，避免中文渲染细节干扰断言
const emotionTags = [
  ...body.matchAll(/data-emotion="([^"]*)" data-emotion-tagged="([01])"/g),
].map((m) => ({ emotion: m[1], tagged: m[2] === '1' }));

// 抽出台词文本（去掉标签），用于内容断言
const asText = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// ?instant=1 时打字瞬发：光标不该出现，正文应当已在画面上。
// 跑动画模式时反过来——见下面的动画态专项检查。
const instant = process.argv.includes('--instant');

// 行数会随夹具演进而变化，别把总数钉死——钉死它只会让每次改夹具都要来改这里。
// 真正要断言的是「停在第一行」，而不是「总共有几行」。
const totalLines = (() => {
  const m = /data-minigal="progress"[^>]*>\d+ \/ (\d+)</.exec(body);
  return m ? Number(m[1]) : 0;
})();

const checks = [
  ['① 文本框已渲染', nodes.textbox, ''],
  ['② 首行是旁白：名牌隐藏', nodes.text && !nodes.name, ''],
  ['③ 场景标签已渲染（[scene:] 生效）', nodes.place, ''],
  ['④ 解析来源标签已渲染', nodes.source, ''],
  ['⑤ 进度指示已渲染', nodes.progress, ''],
  ['⑥ 开发条已渲染', nodes.devbar, ''],
  ['⑦ 旁白正文出现在画面上', asText.includes('夜里的河风'), ''],
  ['⑧ 场景 displayName 取末级', asText.includes('柳树下'), ''],
  ['⑨ 思维链未泄漏到画面', !asText.includes('用户想推进') && !asText.includes('世界书格式条目'), ''],
  ['⑩ 变量更新块未泄漏（严格路径）', !asText.includes('JSONPatch') && !asText.includes('好感度'), ''],
  ['⑪ 选项未泄漏成旁白（进度在第 1 行）', !asText.includes('顺着她的话') && !asText.includes('把伞放下就走'), ''],
  ['⑫ 停在第一行', /data-minigal="progress"[^>]*>1 \/ \d+</.test(body), `总计 ${totalLines} 行`],
  // 旁白行（第一行）应当没有名牌、没有情绪标签、没有越界横幅
  ['⑮ 旁白不显示名牌', !nodes.name, ''],
  ['⑯ 旁白不显示情绪标签（旁白没有情绪）', !nodes.emotion, ''],
  ['⑰ 好样本不触发旁白越界横幅', !nodes.drift, ''],
  ['⑱ 旁白无情绪标签残留', !nodes.name || !asText.includes('平静'), ''],
];

// 首行是旁白（第一块 content 的第一行），第二行才是青梧的台词。
// 用「第一行专有内容」而非「某个人名」来判断进度——人名会在多行里重复出现。
//
// 夹具当前的行号地图（改动夹具后请同步这里，否则下面的断言会指错行）：
//   1 narrator 旁白（纯客观）
//   2 dialog   青梧[平静]   ← 显式标注
//   3 dialog   <user>[平静]  ← 玩家别名归一 + 显式标注
//   4 dialog   青梧[微笑]   ← smile
//   5 narrator 旁白（原越界行改写而来，纯客观、无引号）
//   6 dialog   青梧[平静]   ← 归位后的那句台词
//   7 thought  <user>[无奈] ← 独白
//   8 narrator 旁白（场景切换后）
//   9 dialog   <user>       ← 免方括号，默认情绪兜底
//  10 dialog   青梧[认真]
//  11 dialog   青梧[微羞]   ← 未知情绪 fallback
const LINE1 = '夜里的河风把芦苇压向一边';
const LINE2 = '你走路的动静';
const LINE3 = '我只是路过';
const LINE5 = '把话咽了回去';
const LINE6 = '我什么都没看见';
const LINE7 = '我终究没把桥头看见的那件事说出口';

/** 当前画面停在哪一行（1 基）；读不到返回 0 */
function currentLine() {
  const m = /data-minigal="progress"[^>]*>(\d+) \/ \d+</.exec(body);
  return m ? Number(m[1]) : 0;
}

/**
 * 非首行场景（?line=N）的断言集。
 * 这些场景不复用首行的「旁白」断言——拿旁白的期望值去验对话行，
 * 只会得到一堆假失败，把真问题埋掉。
 */
function checksForLine(n) {
  const base = [
    ['① 文本框已渲染', nodes.textbox, ''],
    ['② 解析来源标签已渲染', nodes.source, ''],
    ['③ 进度指示已渲染', nodes.progress, ''],
    ['④ 开发条已渲染', nodes.devbar, ''],
    ['⑤ 停在请求的行', currentLine() === n, `line=${currentLine()}`],
  ];
  const hasEmotion = (key, tagged) =>
    emotionTags.some((e) => e.emotion === key && e.tagged === tagged);

  switch (n) {
    case 2: // 青梧[平静] —— 显式标注
      return [
        ...base,
        ['⑥ 显示名牌', nodes.name, ''],
        ['⑦ 显示情绪标签', nodes.emotion, ''],
        ['⑧ 情绪 = calm 且标记为显式标注', hasEmotion('calm', true), JSON.stringify(emotionTags)],
        ['⑨ 情绪中文名已上屏（平静）', asText.includes('平静'), ''],
        ['⑩ 台词正文已上屏，引号未混入', asText.includes(LINE2) && !asText.includes('"' + LINE2), ''],
      ];
    case 3: // 玩家别名行
      return [
        ...base,
        ['⑥ 玩家行显示名牌', nodes.name, ''],
        ['⑦ 玩家行显示情绪标签', nodes.emotion, ''],
        ['⑧ 情绪 = calm 且标记为显式标注', hasEmotion('calm', true), JSON.stringify(emotionTags)],
        ['⑨ 情绪中文名已上屏（平静）', asText.includes('平静'), ''],
        ['⑩ 台词正文已上屏，引号未混入', asText.includes(LINE3) && !asText.includes('"' + LINE3), ''],
      ];
    case 5: // 原越界行改写后的纯旁白
      return [
        ...base,
        ['⑥ 旁白无名牌', !nodes.name, ''],
        ['⑦ 旁白无情绪标签', !nodes.emotion, ''],
        ['⑧ 正文已上屏（纯客观描写）', asText.includes(LINE5), ''],
        ['⑨ 旁白句内无引号', !asText.includes('"') && !asText.includes('“'), asText.slice(0, 120)],
        ['⑩ 好样本不触发越界横幅', !nodes.drift, ''],
      ];
    case 6: // 归位后的对话行
      return [
        ...base,
        ['⑥ 归位后的对话行显示名牌', nodes.name, ''],
        ['⑦ 归位后的对话行显示情绪标签', nodes.emotion, ''],
        ['⑧ 台词正文已上屏', asText.includes(LINE6), ''],
        ['⑨ 本行不是旁白，不应有越界横幅', !nodes.drift, ''],
      ];
    case 7: // 独白
      return [
        ...base,
        ['⑥ 独白显示名牌', nodes.name, ''],
        ['⑦ 独白显示情绪标签', nodes.emotion, ''],
        ['⑧ 情绪 = helpless（无奈）', hasEmotion('helpless', true), JSON.stringify(emotionTags)],
        ['⑨ 独白正文已上屏，星号已剥', asText.includes(LINE7) && !asText.includes('*' + LINE7), ''],
      ];
    case 9: // 免方括号的玩家行 —— 默认情绪兜底
      return [
        ...base,
        ['⑥ 玩家行显示名牌', nodes.name, ''],
        ['⑦ 仍显示情绪标签（兜底也要可见）', nodes.emotion, ''],
        ['⑧ 情绪 = calm 但标记为「非显式标注」', hasEmotion('calm', false), JSON.stringify(emotionTags)],
      ];
    case 11: // 未知情绪 fallback
      return [
        ...base,
        ['⑥ 显示名牌', nodes.name, ''],
        ['⑦ 未知情绪（微羞）已 fallback 成默认情绪', hasEmotion('calm', true), JSON.stringify(emotionTags)],
        ['⑧ 上屏显示的是「平静」而非原词「微羞」', asText.includes('平静') && !asText.includes('微羞'), asText.slice(0, 120)],
      ];
    default:
      return base;
  }
}

// targetLine 已在顶部解析过（用来构造 dump 的 URL），此处直接复用——
// 重复解析一遍会让两处的参数处理有分叉的可能。
const targetLine = Number(lineArgRaw) || 0;
if (targetLine) {
  checks.length = 0;
  checks.push(...checksForLine(targetLine));
  for (const [label, pass] of checks) console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  console.log('\n画面文本切片：');
  console.log('  ' + asText.slice(0, 220));
  const bad = checks.filter(([, p]) => !p);
  console.log(`\n${checks.length - bad.length}/${checks.length} 通过`);
  process.exit(bad.length ? 1 : 0);
}

if (instant) {
  checks.push(['⑬ 瞬发模式：首行已完整（含句末）', asText.includes(LINE1) && asText.includes('没有回头'), '']);
  checks.push(['⑭ 瞬发模式：不应出现打字光标', !nodes.cursor, '']);
} else {
  // 动画模式下只要求「打字机确实在推进」：要么光标还在，要么已打满首行；
  // 且无论如何都不该越到第二行（进度仍是 1 / 10）。
  const typingInProgress = nodes.cursor || asText.includes('没有回头');
  checks.push(['⑬ 动画模式：打字机在推进（光标在 或 首行已打满）', typingInProgress, '']);
  checks.push(['⑭ 动画模式：未越到第二行', !asText.includes(LINE2), '']);
}

for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
}

console.log('\n画面文本切片：');
console.log('  ' + asText.slice(0, 220));

const failed = checks.filter(([, p]) => !p);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);
