// minigal · scriptParser（S1）
//
// 纯函数：楼层文本 -> 可播放数据。零酒馆依赖，可单测，浏览器裸跑也能跑。
//
// 三条纪律：
//   1. 顺序铁律：先剥思维链，再提取正文。
//   2. <content> 限定可播范围；没有标签时降级为「剥完思维链后全文视为剧本」。
//   3. 解析算法是带状态变量（currentLocation）的单遍逐行状态机；
//      控制行从此行起生效直到下一个控制行（逐楼快照继承语义）。

import {
  DEFAULT_EMOTION,
  PLAYER_SPEAKER,
  RE_DIALOG,
  RE_SCENE,
  RE_SUSPECT_NARRATOR,
  RE_THOUGHT,
  RE_USER_DIALOG,
  extractContentBlocks,
  isPlayerSpeaker,
  normalizeLeadingTags,
  parseOptions,
  resolveEmotion,
  stripOptionBlocks,
  stripThinking,
  toLocation,
  type ScriptLine,
  type ScriptLocation,
} from './scriptProtocol';
import { spriteOf } from './assets';

export interface ParsedFloor {
  lines: ScriptLine[];
  options: string[];
  /** true = 走了严格 <content> 路径；false = 降级为全文 */
  usedContentTag: boolean;
}

type SpokenMatch = Pick<ScriptLine, 'type' | 'speaker' | 'emotion' | 'text' | 'emotionTagged'>;

/**
 * 立绘只有「非玩家、且上台说话的角色」才有——
 * 玩家（<user>）不占立绘位（踩坑 9），旁白根本没有 speaker。
 *
 * 解析期就把 URL 定好，而不是丢一个情绪 key 给渲染层去查表。两个理由：
 *   ① 渲染层不必知道「情绪 → 差分 → URL」这套映射，接口更窄；
 *   ② 预加载可以直接遍历 lines 收集 URL，不需要再走一次查表。
 *
 * ⚠ 参数 emotion 传的是**原始中文**（spoken.emotion），不是 resolveEmotion 的结果。
 *   曾经这里传的是解析后的 key，而 spriteOf 内部又会 resolveEmotion 一次——
 *   把 'smile' 当成未知中文情绪、静默落回 'calm'，导致所有差分都不切换。
 *   现在 resolveEmotion 已能接受 key，但这里仍传原始值：
 *   让「解析中文 → key」这一步只发生在 spriteOf 内部一处，避免职责重叠。
 */
function spriteFor(speaker: string, rawEmotion: string | undefined, isPlayer: boolean): string | undefined {
  if (isPlayer) return undefined;
  return spriteOf(speaker, rawEmotion);
}

function matchSpoken(line: string): SpokenMatch | null {
  const user = RE_USER_DIALOG.exec(line);
  if (user) {
    // 玩家行协议允许省略方括号。此处不写死 false：AI 偶尔会写成
    // <user>[平静]:"…"，那样方括号确实是存在的，如实报告比一刀切准确。
    // 情绪仍然解析（界面上会显示标签），但立绘恒为 undefined。
    return {
      type: 'dialog',
      speaker: PLAYER_SPEAKER,
      emotion: DEFAULT_EMOTION,
      emotionTagged: false,
      text: user[1],
    };
  }

  const userTagged = /^<user>\[([^\[\]]+?)\]:"([^"]*)"$/.exec(line);
  if (userTagged) {
    return {
      type: 'dialog',
      speaker: PLAYER_SPEAKER,
      emotion: userTagged[1],
      emotionTagged: true,
      text: userTagged[2],
    };
  }

  const dialog = RE_DIALOG.exec(line);
  if (dialog) {
    const speaker = dialog[1].trim();
    return {
      type: 'dialog',
      speaker: isPlayerSpeaker(speaker) ? PLAYER_SPEAKER : speaker,
      emotion: dialog[2],
      emotionTagged: true, // 能进这个分支，方括号必然存在
      text: dialog[3],
    };
  }

  const thought = RE_THOUGHT.exec(line);
  if (thought) {
    const speaker = thought[1].trim();
    return {
      type: 'thought',
      speaker: isPlayerSpeaker(speaker) ? PLAYER_SPEAKER : speaker,
      emotion: thought[2],
      emotionTagged: true,
      text: thought[3],
    };
  }

  return null;
}

export function parseFloor(rawText: string): ParsedFloor {
  const withoutThinking = stripThinking(rawText ?? '');

  const blocks = extractContentBlocks(withoutThinking);
  const usedContentTag = blocks.length > 0;
  const body = usedContentTag ? blocks.join('\n') : withoutThinking;

  const options = parseOptions(body);
  const cleaned = stripOptionBlocks(body);

  const lines: ScriptLine[] = [];
  let currentLocation: ScriptLocation | undefined;

  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const scene = RE_SCENE.exec(line);
    if (scene) {
      currentLocation = toLocation(scene[1]);
      continue;
    }

    const normalized = normalizeLeadingTags(line);
    const spoken = matchSpoken(normalized);

    if (spoken) {
      const isPlayer = spoken.speaker === PLAYER_SPEAKER;
      const emotion = resolveEmotion(spoken.emotion);
      lines.push({
        ...spoken,
        emotion,
        location: currentLocation,
        // 立绘：玩家恒 undefined（不占立绘位），未登记角色同样 undefined。
        // 传 spoken.emotion（原始中文）而非 emotion（已解析的 key）——
        // 见 spriteFor 的注释：两处都解析会导致 key 被当成中文、静默落回默认。
        sprite: spriteFor(spoken.speaker ?? '', spoken.emotion, isPlayer),
      });
      continue;
    }

    // 兜底：伪旁白。注意只做行首整行匹配，绝不扫描自由文本——
    // 旁白里的引号台词（他笑了笑:"…"）没有情绪方括号，天然落进这里。
    //
    // 旁白按规范应当只有客观描写。这一行如果长成 角色名:"…" 的样子，
    // 说明 AI 把台词或心理写进了旁白：照样按旁白播（协议不放宽），
    // 但打上标记，让界面能弱化显示、让日志能统计，而不是静默冒充好输出。
    lines.push({
      type: 'narrator',
      text: normalized,
      location: currentLocation,
      emotionTagged: false,
      suspectNarrator: RE_SUSPECT_NARRATOR.test(normalized),
    });
  }

  return { lines, options, usedContentTag };
}

/** 只要可播行时的便捷入口 */
export function parseScript(rawText: string): ScriptLine[] {
  return parseFloor(rawText).lines;
}
