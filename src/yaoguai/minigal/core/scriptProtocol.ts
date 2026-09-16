// minigal · 剧本协议（S1）
//
// 协议是「AI 侧世界书格式条目」与「前端解析器」之间的合同。
// 定协议先于写 UI：顺序反了必然返工。
//
// 行格式（AI 必须整行锚定，标点一律英文半角）：
//   角色名[情绪]:"对话"     -> dialog
//   <user>:"对话"           -> dialog（玩家，不占立绘位）
//   角色名[情绪]:*独白*     -> thought
//   其他任意文本            -> narrator
//
// 控制行（行首、独占一行）：
//   [scene:父地点/子地点/末级地点]  从此行起生效，直到下一个控制行

export type LineType = 'narrator' | 'dialog' | 'thought';

export interface ScriptLocation {
  path: string;
  displayName: string;
}

export interface ScriptLine {
  type: LineType;
  speaker?: string;
  emotion?: string;
  text: string;
  location?: ScriptLocation;
  /**
   * 情绪方括号是否存在。
   * - 对话/独白行：恒为 true（能匹配上 RE_DIALOG，方括号就是必要条件）。
   * - 玩家行 <user>:"…"：协议允许省略，故为 false，情绪按默认值处理。
   * - 旁白行：恒为 false。
   * 用途：把「AI 漏写方括号」从不可观测变成可观测——界面弱化显示、日志可统计。
   */
  emotionTagged?: boolean;
  /**
   * 旁白行疑似越界：这一行以 角色名:"…" 的形状出现，但没有 [情绪] 方括号。
   *
   * 这不是解析器的错——按协议它就该落进旁白（否则「旁白里的引号台词」会被
   * 误认成对话，即 skill 里的「坑 2」）。标记它是为了让 AI 的坏输出在界面上
   * 看得见，而不是静静地冒充客观描写。
   *
   * 旁白应当只有客观描写。出现本标记 = AI 把台词/心理写进了旁白。
   */
  suspectNarrator?: boolean;
  /**
   * 该行要显示的立绘 URL（S3 演出层）。
   *
   * 三态语义，都靠这个字段区分：
   *   · 字符串     → 上台显示这张立绘
   *   · undefined  → 不上台。两种正常情形：玩家发言（不占立绘位，踩坑 9）、
   *                  角色未登记进 assets.ts 的 CHARACTERS。
   *   · 旁白行恒为 undefined（没有 speaker）。
   *
   * 由解析期算好（而非渲染期查表），使渲染层不必知道映射规则。
   */
  sprite?: string;
  custom?: Record<string, unknown>;
}

export const PLAYER_SPEAKER = '<user>';
export const DEFAULT_EMOTION = 'calm';

/**
 * 旁白越界探测：以 角色名:"…" 的形状出现却没有 [情绪] 方括号（只标记，不改判定）。
 *
 * 【为什么必须非全行锚定】
 * 这个探测的唯一职责是「AI 把台词写进了旁白」。这样的行几乎总是**尾随描述**的——
 *   `他笑了笑:"我什么都没看见。"——这话是对着河面说的，不像讲给我听。`
 * 第一版写成了 ^…:"…"$（要求整行就是一个干净的对话形状），结果这类真正需要
 * 报警的行全部逃逸，只有格式干净到可以直接当对话用的行才会被标记——正好标记反了。
 *
 * 改用贪婪匹配引号（[^"]* 而非 [^"]+?）保证引号能吃到最后一个 "，
 * 再加 [^\s]{0,24} ?$ 只容忍结尾的短标点/破折号尾巴，避免把真正自由的旁白误伤。
 */
export const RE_SUSPECT_NARRATOR = /^[^\[\]"“”]{1,12}:"[^"]*"[^\s]{0,24} ?$/;

// 中文情绪名 -> 立绘文件名用的 key。取不到一律 fallback 默认情绪，绝不抛错。
export const EMOTION_MAP: Record<string, string> = {
  平静: 'calm',
  微笑: 'smile',
  开心: 'happy',
  高兴: 'happy',
  生气: 'angry',
  愤怒: 'angry',
  害羞: 'shy',
  悲伤: 'sad',
  难过: 'sad',
  惊讶: 'surprised',
  害怕: 'scared',
  无奈: 'helpless',
  冷淡: 'cold',
  认真: 'serious',
  困惑: 'confused',
};

const PLAYER_ALIASES = new Set([PLAYER_SPEAKER, '我', '玩家']);

/** EMOTION_MAP 的值域（全部合法 key）。用于判断「传进来的已经是 key 还是中文」。 */
const EMOTION_KEYS = new Set(Object.values(EMOTION_MAP));

/**
 * 情绪 → 稳定 key。中文名与 key 都能进，其余落默认。
 *
 * 【为什么要接受 key 本身】
 * 曾经这里只认中文，调用方若传已解析过的 key（如 'smile'）会**静默落回 calm**：
 * 查表成功、有图、不报错，只是表情永远是平静脸。
 * 这个 bug 表现为「所有立绘差分都不切换」，而验收时恰好
 * 第 2 行（本来就该 calm）通过——差点溜过去。
 *
 * 现在显式接受两类输入：中文名（'微笑'）与 key（'smile'）。
 * 判据是「先看是不是已知 key，再查中文表」，顺序不能反。
 */
export function resolveEmotion(raw?: string): string {
  if (!raw) return DEFAULT_EMOTION;
  const t = raw.trim();
  if (!t) return DEFAULT_EMOTION;
  if (EMOTION_KEYS.has(t)) return t; // 已经是合法 key，原样返回
  return EMOTION_MAP[t] ?? DEFAULT_EMOTION;
}

/** 情绪 key -> 界面显示用的中文名。反查自 EMOTION_MAP，避免两处各维护一份。 */
export const EMOTION_LABEL: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [cn, key] of Object.entries(EMOTION_MAP)) {
    if (!out[key]) out[key] = cn;
  }
  return out;
})();

/** 情绪 key 的中文显示名；未知 key 原样回显，不抛错。 */
export function emotionLabel(key?: string): string {
  if (!key) return EMOTION_LABEL[DEFAULT_EMOTION] ?? DEFAULT_EMOTION;
  return EMOTION_LABEL[key] ?? key;
}

export function isPlayerSpeaker(name: string): boolean {
  return PLAYER_ALIASES.has(name.trim());
}

// —— 思维链剥离 ——
// 必须是单一工具函数：播放解析 / 历史视图 / 重生成三个入口共用同一份，
// 多处实现不一致会导致正文残留。
const THINKING_TAGS = ['think', 'thinking', 'Chain_of_Thought', 'draft', 'simple_thinking', 'reasoning'];
const THINKING_BLOCK = new RegExp(`<(${THINKING_TAGS.join('|')})>[\\s\\S]*?<\\/\\1>`, 'gi');
const THINKING_STRAY = new RegExp(`<\\/?(${THINKING_TAGS.join('|')})\\s*\\/?>`, 'gi');

export function stripThinking(text: string): string {
  return text.replace(THINKING_BLOCK, '').replace(THINKING_STRAY, '');
}

// —— 正文提取 ——
// 可播内容只来自 <content>…</content>（可多个）。没包标签时由调用方降级。
const CONTENT_BLOCK = /<content>([\s\S]*?)<\/content>/gi;

export function extractContentBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (const m of text.matchAll(CONTENT_BLOCK)) blocks.push(m[1]);
  return blocks;
}

// —— 选项 ——
// AI 记不住一种格式，所以三路并取：<options> 内的 > 行 / <choice> 块 / 多个独立 <choice>。
const RE_OPTIONS_BLOCK = /<options>([\s\S]*?)<\/options>/gi;
const RE_CHOICE_BLOCK = /<choice>([\s\S]*?)<\/choice>/gi;
const RE_OPTION_LINE = /^[>\-•]\s*(.+)$/;

export function stripOptionBlocks(text: string): string {
  return text.replace(RE_OPTIONS_BLOCK, '\n').replace(RE_CHOICE_BLOCK, '\n');
}

export function parseOptions(text: string): string[] {
  const fromChoice: string[] = [];
  const prefixed: string[] = [];
  const plain: string[] = [];

  let work = text.replace(RE_CHOICE_BLOCK, (_full, inner: string) => {
    const t = String(inner).trim();
    if (t) fromChoice.push(t);
    return '\n';
  });

  work.replace(RE_OPTIONS_BLOCK, (_full, inner: string) => {
    for (const raw of String(inner).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const m = RE_OPTION_LINE.exec(line);
      if (m) prefixed.push(m[1].trim());
      else plain.push(line);
    }
    return '\n';
  });

  // <options> 里优先只认 > 前缀行；一条都没有时才退回「非空行即选项」
  const merged = [...fromChoice, ...(prefixed.length ? prefixed : plain)];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of merged) {
    if (!o || seen.has(o)) continue;
    seen.add(o);
    out.push(o);
  }
  return out;
}

// —— 行级匹配 ——
// 对话行：按 §3 协议必须【整行锚定】，所以引号后除空格外不再容忍任何尾巴。
//
// 这里曾经写成 "([\s\S]+)"$，配合开头的 [^\[\]]+? 偷跑，会吞掉引号后面的叙述——
//   青梧[平静]:"船到了。"他转身走向渡口。
// 会被解析成 text='船到了。"他转身走向渡口。'（引号本身混进台词里）。
// 现在把引号内容限定为「不含引号」并封死行尾：写法越界就落进旁白，
// 由 suspectNarrator 标记出来，而不是被悄悄吞掉。
export const RE_SCENE = /^\[scene:([^\]]+?)\]$/;
export const RE_USER_DIALOG = /^<user>:"([^"]*)"$/;
export const RE_DIALOG = /^([^\[\]:]{1,20}?)\[([^\[\]]+?)\]:"([^"]*)"$/;
export const RE_THOUGHT = /^([^\[\]:]{1,20}?)\[([^\[\]]+?)\]:\*([^*]*)\*$/;
const RE_TAG_PREFIX = /^\[([^\[\]:]+):([^\[\]]+)\]/;

/** 行首就是 [情绪] 方括号的形状：[平静]:"…" / [微笑]:*…* —— 情绪缺了角色名前缀 */
const RE_EMOTION_ONLY_PREFIX = /^\[([^\[\]]+)\]:("[^"]*"|\*[^*]*\*)$/;

export function toLocation(path: string): ScriptLocation {
  const clean = path.trim().replace(/^\/+|\/+$/g, '');
  const parts = clean.split('/').map((p) => p.trim()).filter(Boolean);
  return { path: clean, displayName: parts.length ? parts[parts.length - 1] : clean };
}

// AI 常把标签和对话写在同一行（[人物:茶客甲][害怕]:"…"）：
// 把行首标签替换成其中的角色名，再走对话正则。
//
// ⚠️ 这里有个非常容易踩的坑：对 [平静]:"…" 这种「缺角色名」的形状，
// 替换会把它变成 平静:"…"，于是情绪被当成了角色名，解析结果变成
// speaker='平静'、台词里带着引号——整行语义反转。
// 所以替换前先检查一下：替换结果是否还长着 [情绪]:"…" 的样子，
// 是的话说明我们正在把情绪当角色名用，这种情况绝不能替换。
export function normalizeLeadingTags(line: string): string {
  let s = line;
  for (let guard = 0; guard < 4; guard += 1) {
    const m = RE_TAG_PREFIX.exec(s);
    if (!m) break;
    const [full, key, value] = m;
    if (key === 'scene') break;

    const next = value + s.slice(full.length);
    if (RE_EMOTION_ONLY_PREFIX.test(next)) break; // 替换会把情绪降级成角色名，停手
    s = next;
  }
  return s;
}
