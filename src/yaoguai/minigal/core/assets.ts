// minigal · 资源映射表（S3 演出层）
//
// 这一层解决一个问题：**把「文字里的名字/情绪/地点」翻译成「画面上该显示的图」**。
//
// 翻译分两段，不要混在一起：
//   ① 语义 → 稳定 key     「微笑」→ 'smile'、「旧城区/河堤」→ 场景路径
//   ② 稳定 key → 图片      'smile' + 角色名 → 某个 URL
//
// ①落在 scriptProtocol.ts 的 EMOTION_MAP（协议层，AI 侧要认）；②落在本文件。
// 分开的好处：换图片来源（占位图 → 真图 → CDN）只动本文件，协议与解析器零改动。
//
// ── 关于占位图 ────────────────────────────────────────────────
// 当前用的是**程序生成的 SVG data URI**，不是外部图片文件。理由：
//   · 零外部依赖：单文件产物铁律要求零外部引用，data URI 天然满足；
//   · 可自证身份：**立绘**上写着角色名 + 情绪名，截图验收时一眼能核对
//     「状态机切换是否正确」——换成纯色块的话，根本分不清两张图有没有换过去；
//   · 换真图只改 SCENES / CHARACTERS 两个表，其余代码一行不动。
//
// 【立绘与背景对「文字」的处理不同，这是刻意的】
//   立绘：图上写名字与情绪 —— 它是画面上唯一能区分「谁、什么表情」的东西，
//         不写就只剩色相，人眼核对成本太高。
//   背景：**图上什么都不写** —— 场景名由界面右上角的场景标签负责。
//         把文字烙进背景图会让画面看着像半成品，且与标签争位置。
//   一句话：**图负责观感，文字信息交给界面元素。**
//
// 升级路径：把 SCENES 的 value 换成背景图直链，
// 把 CHARACTERS[].sprites 的 value 换成立绘直链即可。见文件末尾说明。

import { resolveEmotion } from './scriptProtocol';

// ─────────────────────────────────────────────────────────────
// 占位图生成器（仅用于开发/验收；换真图后可以整个删掉这一段）
// ─────────────────────────────────────────────────────────────

/** 角色的配色盘：每个角色一个固定色相，占位图上用色相区分「是谁」 */
const CHARACTER_HUE: Record<string, number> = {
  青梧: 205,
  沈砚: 285,
  阿棠: 25,
};

function hueOf(name: string): number {
  if (CHARACTER_HUE[name] !== undefined) return CHARACTER_HUE[name];
  // 未登记的角色：名字的字符和取模，保证同名同色、不同名不同色
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

/**
 * 生成一个立绘占位图（SVG → data URI）。
 *
 * 形状做成「人形剪影」而不是矩形，这样截图里一眼能看出
 * 「立绘层有没有真的在渲染」，而不是某块背景色。
 *
 * ── 标签为什么放在脚下（一次真实的观感回归）──────────────────
 * 最初把「角色名 + 情绪」标签画在人形胸口，理由是截图核对方便。
 * 实际看截图才发现：标签正压在画面中央，和场景标签、背景文字叠成一团，
 * 三张占位图同时上台时几乎看不清谁是谁——为「好核对」牺牲了「像画面」。
 * 改放到底部贴近画面下沿：那一带会被文本框盖住，
 * 观感上干净了，而截图放大后标签仍然可读，核对需求不受影响。
 */
function spritePlaceholder(name: string, emotionKey: string): string {
  const hue = hueOf(name);
  const emotionCn = EMOTION_LABEL_CN[emotionKey] ?? emotionKey;

  // 不同情绪给不同姿态：身体倾斜角度 + 头部位置微调，让差分「看得出来」
  const pose = EMOTION_POSE[emotionKey] ?? EMOTION_POSE.calm;

  // 立绘更瘦一些：真立绘的宽高比通常在 1:2.5 ~ 1:3，
  // 300x600（1:2）会让三个人挤在一起（见 index.css 的 max-width 注释）。
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 640">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="hsl(${hue},58%,68%)"/>
      <stop offset="100%" stop-color="hsl(${hue},52%,44%)"/>
    </linearGradient>
  </defs>
  <g transform="rotate(${pose.tilt} 130 540)">
    <ellipse cx="130" cy="${104 + pose.head}" rx="54" ry="64" fill="hsl(${hue},62%,76%)"/>
    <path d="M130 ${176 + pose.head} C 84 ${200 + pose.head} 70 250 68 320 L 62 640 L 198 640 L 192 320 C 190 250 176 ${200 + pose.head} 130 ${176 + pose.head} Z"
          fill="url(#body)"/>
    <rect x="80" y="${186 + pose.head}" width="100" height="9" rx="4.5" fill="hsl(${hue},40%,38%)" opacity="0.55"/>
  </g>
  <g transform="translate(130 604)">
    <rect x="-84" y="-20" width="168" height="38" rx="8" fill="rgba(12,14,20,0.72)"/>
    <text x="0" y="-3" text-anchor="middle" font-family="sans-serif" font-size="19"
          font-weight="500" fill="hsl(${hue},90%,84%)">${name}</text>
    <text x="0" y="13" text-anchor="middle" font-family="sans-serif" font-size="12"
          fill="hsl(${hue},55%,68%)">${emotionCn} · ${emotionKey}</text>
  </g>
</svg>`;

  return toDataUri(svg);
}

/** 情绪 → 姿态微调。让「换差分」在静态截图里也看得出来（否则全靠颜色深浅，太含糊）。 */
const EMOTION_POSE: Record<string, { tilt: number; head: number }> = {
  calm: { tilt: 0, head: 0 },
  smile: { tilt: -3, head: -6 },
  happy: { tilt: 4, head: -10 },
  angry: { tilt: -6, head: 4 },
  sad: { tilt: 2, head: 12 },
  shy: { tilt: -2, head: 8 },
  surprised: { tilt: 0, head: -14 },
  scared: { tilt: 5, head: 10 },
  helpless: { tilt: 3, head: 6 },
  cold: { tilt: 0, head: 2 },
  serious: { tilt: -1, head: 0 },
  confused: { tilt: -5, head: -4 },
};

/** 情绪 key → 中文（占位图上显示用）。与 EMOTION_MAP 的反查表同源，此处仅取本地副本避免循环依赖。 */
const EMOTION_LABEL_CN: Record<string, string> = {
  calm: '平静', smile: '微笑', happy: '开心', angry: '生气', shy: '害羞',
  sad: '悲伤', surprised: '惊讶', scared: '害怕', helpless: '无奈',
  cold: '冷淡', serious: '认真', confused: '困惑',
};

/**
 * 生成一个背景占位图。
 * 画成「天-地两段 + 地平线」的极简风景，**不在画面上写任何文字**——
 * 场景名靠右上角的场景标签（.gal-place）显示，图本身只管「像一处地方」。
 *
 * 【为什么不把场景名画进图里（一次真实的观感回归）】
 * 早先为了「截图时一眼核对换景」，把场景名画在图上（先正中、后上部）。
 * 但那是**把调试信息烙进了画面**：三张占位图叠加时文字与人争位置，
 * 看着像半成品，真正的场景标签反而被抢了戏。
 * 现在图只负责观感，场景信息交给场景标签——两者的职责分开。
 *
 * 区分是靠色相：同一路径的 hash 决定天空/地面色相，
 * 换景时画面整体色调会变，截图里仍然能看出「背景换了」。
 */
function scenePlaceholder(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i += 1) h = (h * 37 + path.charCodeAt(i)) % 360;
  const skyTop = `hsl(${h},42%,26%)`;
  const skyLow = `hsl(${(h + 28) % 360},48%,52%)`;
  const ground = `hsl(${(h + 200) % 360},26%,20%)`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 675">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${skyTop}"/>
      <stop offset="100%" stop-color="${skyLow}"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="675" fill="url(#sky)"/>
  <circle cx="${900 + (h % 120)}" cy="150" r="52" fill="hsl(${(h + 40) % 360},80%,80%)" opacity="0.42"/>
  <path d="M0 430 L 180 372 L 340 428 L 520 356 L 700 424 L 900 366 L 1080 428 L 1200 392 L 1200 675 L 0 675 Z" fill="${ground}"/>
  <path d="M0 470 L 240 440 L 420 486 L 660 434 L 880 490 L 1120 446 L 1200 470 L 1200 675 L 0 675 Z"
        fill="hsl(${(h + 200) % 360},24%,14%)"/>
</svg>`;

  return toDataUri(svg);
}

/** SVG 文本 → data URI。用 encodeURIComponent 而非 base64：体积更小且可读（调试时能直接看出内容）。 */
function toDataUri(svg: string): string {
  const compact = svg.replace(/\n\s*/g, ' ').trim();
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(compact);
}

// ─────────────────────────────────────────────────────────────
// 角色表
// ─────────────────────────────────────────────────────────────

export interface CharacterDef {
  name: string;
  /**
   * 差分 key → 图片 URL。
   * 当前全部是程序生成的占位图；换真图时把 value 换成直链即可。
   */
  sprites: Record<string, string>;
  /**
   * 该角色有哪些差分。用于预加载与「缺差分回退」判断。
   * 由 sprites 的键推导，不必手写——见下方 buildCharacter。
   */
}

/**
 * 声明一个角色：给出名字与「它有哪些差分」。
 *
 * 关键约束：**每张差分都必须有对应图片**。缺的那张在运行时回退到默认情绪，
 * 这是刻意的设计（踩坑 7）——宁可显示「平静」的表情，也不要一个破图图标或空白。
 */
function buildCharacter(name: string, diffKeys: string[]): CharacterDef {
  const sprites: Record<string, string> = {};
  for (const key of diffKeys) sprites[key] = spritePlaceholder(name, key);
  return { name, sprites };
}

export const CHARACTERS: CharacterDef[] = [
  // 青梧：主要对话对象，差分较全。
  // 注意**刻意不给 helpless（无奈）**——夹具第 10 行 `青梧[无奈]` 正是用来验
  // 「缺差分回退 calm」（踩坑 7）的。若哪天把 helpless 加进来，
  // S3 验收的第 10 行会立刻变红，提醒你「这条覆盖没了」。
  buildCharacter('青梧', ['calm', 'smile', 'happy', 'serious', 'shy', 'sad']),
  // 沈砚：配角，只给了少量差分 —— 用来演示「查不到差分时回退默认」
  buildCharacter('沈砚', ['calm', 'cold', 'angry']),
  // 阿棠：第三个角色，用来把三个槽位填满（center/right/left 各一）
  buildCharacter('阿棠', ['calm', 'happy', 'surprised']),
];

/** 立绘查表：拿不到就返回 undefined（调用方据此决定「不占立绘位」） */
const CHARACTER_INDEX: Map<string, CharacterDef> = new Map(CHARACTERS.map((c) => [c.name, c]));

export function characterOf(name: string): CharacterDef | undefined {
  return CHARACTER_INDEX.get(name.trim());
}

/**
 * 角色 + 情绪 → 立绘 URL。
 *
 * 两级回退，都不能抛错：
 *   ① 情绪 key 查不到 → resolveEmotion 已兜底为 'calm'；
 *   ② 该角色没有这张差分 → 回退到它自己的 calm（踩坑 7）。
 *   ③ 连角色都查不到 → undefined。
 *
 * 返回 undefined 是**正常路径**，不是错误：玩家（<user>）和未登记角色本就该没有立绘。
 */
export function spriteOf(name: string, emotion?: string): string | undefined {
  const c = characterOf(name);
  if (!c) return undefined;
  const key = resolveEmotion(emotion);
  return c.sprites[key] ?? c.sprites.calm;
}

/** 该角色是否有情绪 key 对应的差分（不含回退）。用于自检脚本核对「回退确实发生了」。 */
export function hasSprite(name: string, emotionKey: string): boolean {
  const c = characterOf(name);
  return Boolean(c && c.sprites[emotionKey]);
}

/**
 * 立绘查表，**并告知实际命中了哪个 key**。
 *
 * 为什么需要它：spriteOf 的返回值是 URL，而「回退到 calm」与「本来就是 calm」
 * 会产生**完全相同的 URL**——单看 URL 分不出这两种情况。
 * 验收要断言的是「回退发生了」，就必须拿到「实际命中哪个 key」。
 *
 * 返回 null 表示该角色没有立绘（未登记 / 玩家），调用方据此不占立绘位。
 */
export function resolveSprite(name: string, emotion?: string): {
  key: string;
  url: string;
  fallback: boolean;
} | null {
  const c = characterOf(name);
  if (!c) return null;
  const wanted = resolveEmotion(emotion);
  const hit = c.sprites[wanted] ? wanted : 'calm';
  const url = c.sprites[hit];
  if (!url) return null;
  return { key: hit, url, fallback: hit !== wanted };
}

// ─────────────────────────────────────────────────────────────
// 场景表
// ─────────────────────────────────────────────────────────────

export interface SceneDef {
  path: string;
  displayName: string;
  image: string;
}

/**
 * 场景声明。path 必须与 AI 在 [scene:] 里写的路径前缀一致。
 *
 * 注意「层级回退」的语义（踩坑 13）：
 *   只有 `旧城区/河堤/柳树下` 有图时，写 `旧城区/河堤/柳树下/更细的地方`
 *   会逐级向上回退到 `旧城区/河堤/柳树下`。
 *   但 `旧城区/河堤/柳树下` 与 `旧城区/河堤` 是**不同的场景**，
 *   前者不会「包含」后者——回退方向永远是「向上找父路径」，不是「向下找子场景」。
 */
function buildScene(path: string): SceneDef {
  const parts = path.split('/').map((s) => s.trim()).filter(Boolean);
  const displayName = parts.length ? parts[parts.length - 1] : path;
  // displayName 只用于界面上的场景标签，不画进图里（见 scenePlaceholder 的注释）
  return { path, displayName, image: scenePlaceholder(path) };
}

export const SCENES: SceneDef[] = [
  buildScene('旧城区/河堤/柳树下'),
  buildScene('旧城区/河堤'),
  buildScene('旧城区/茶馆/二楼雅座'),
  buildScene('旧城区/渡口'),
  buildScene('旧城区'),
];

const SCENE_INDEX: Map<string, SceneDef> = new Map(SCENES.map((s) => [s.path, s]));

/**
 * 场景路径 → 背景图。
 *
 * 逐级向上回退：`旧城区/河堤/柳树下/西岸` 查不到时依次试
 *   → 旧城区/河堤/柳树下 → 旧城区/河堤 → 旧城区
 * 全都落空才返回 undefined。
 *
 * 返回 undefined 时**渲染层必须保留上一张背景**（不闪黑）——见 PlayScreen 的注释。
 */
export function sceneOf(path?: string): SceneDef | undefined {
  if (!path) return undefined;
  const clean = path.trim().replace(/^\/+|\/+$/g, '');
  if (!clean) return undefined;

  if (SCENE_INDEX.has(clean)) return SCENE_INDEX.get(clean);

  const parts = clean.split('/');
  while (parts.length > 1) {
    parts.pop();
    const up = parts.join('/');
    if (SCENE_INDEX.has(up)) return SCENE_INDEX.get(up);
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────
// 升级到真图（三分钟的事）
// ─────────────────────────────────────────────────────────────
//
// ① 背景：把 SCENES 的构建改成手写表——
//      export const SCENES: SceneDef[] = [
//        { path: '旧城区/河堤/柳树下', displayName: '柳树下', image: 'https://你的图床/xxx.png' },
//        ...
//      ];
//
// ② 立绘：把 buildCharacter 换成手写差分表——
//      { name: '青梧', sprites: { calm: 'https://…', smile: 'https://…' } }
//
// ③ 删掉本文件上半段的 spritePlaceholder / scenePlaceholder / toDataUri / EMOTION_POSE。
//
// 其余代码（解析器、舞台状态机、背景层）**一行都不用改**——
// 它们只依赖 spriteOf() / sceneOf() 两个函数签名。
