// minigal · 立绘舞台状态机（S3 演出层）
//
// ── 为什么把它抽成纯函数，而不是写在组件的 useEffect 里 ─────────────
// skill 的示例代码把这段逻辑直接写在 useEffect 中。那样能跑，但有个代价：
// **它没法单测**。舞台装配有明确的输入（当前行 + 上一状态 + 是否换景）和
// 明确的输出（新状态），是纯函数；抽出来后，「四个角色上台谁被顶掉」
// 「旁白行后位置记忆有没有保留」这类边界情况可以穷举验证，
// 而不是靠截图碰运气。
//
// 组件负责调用它、并把它渲染出来；判断逻辑全部在这里。
//
// ── 舞台的三条规则（来自 skill 的踩坑 9/10/11/12）─────────────────
//   坑 9  <user> 不上台：玩家发言时不占立绘位，舞台上没有玩家立绘。
//   坑 10 同屏 ≤3：槽位 center → right → left 依次分配，第四个角色
//         进台时顶掉最老的（center 位的那个先失位）。
//   坑 11 旁白/玩家行「全员暂退」而不是「清台」：
//         保留位置记忆，下一个角色开口时能原位亮回。
//         只有**换景**才清台。
//   坑 12 立绘预加载：不在本文件（是副作用，归组件），但这里返回的
//         sprite 值就是预加载要收集的 URL。

import { PLAYER_SPEAKER, resolveEmotion } from './scriptProtocol';
import type { ScriptLine } from './scriptProtocol';
import { resolveSprite, sceneOf } from './assets';

export type StagePosition = 'left' | 'center' | 'right';

export interface StageCharacter {
  speaker: string;
  /** 立绘 URL。空串表示「该角色没有立绘资源」——仍然占位，但不渲染 img。 */
  sprite: string;
  position: StagePosition;
  /** 正在说话：亮色显示 */
  isActive: boolean;
  /** 暂退：旁白/玩家发言时全员退场，opacity 归零但 DOM 保留（保位置记忆） */
  hidden: boolean;
  /**
   * 作者/协议要求的情绪 key（'calm' / 'smile' …）。
   * 注意它**不代表实际用了哪张图**——该角色缺这张差分时会静默回退到 calm，
   * 而这里仍记录原请求。要判断「回退是否发生」，看 resolvedKey 或 resolvedFallback。
   */
  emotionKey: string;
  /**
   * 实际命中的差分 key（= sprite 对应的那张图的 key）。
   * 与 emotionKey 不同时说明发生了回退。
   */
  resolvedKey: string;
  /** 是否发生了「缺差分回退」（emotionKey 查不到，退到了 calm）。 */
  resolvedFallback: boolean;
}

/**
 * 槽位分配顺序。center 是「第一个上台的人」——
 * 单角色场景里他会站在正中，这是 galgame 的通行做法。
 *
 * 注意这里用「当前台上已有几个」来决定新人的槽位，
 * 而不是「找第一个空槽」——两者的差别在「左槽的人走了之后」：
 * 前者会把下一个新人放进空出来的左槽（保持紧凑），
 * 后者也一样，但当台上只有 center + left（右槽空）时会不同。
 * 选前者：槽位由人数决定，台上永远是紧凑的 center/center+right/center+right+left。
 */
const SLOT_ORDER: StagePosition[] = ['center', 'right', 'left'];

/** 同上舞台最多容纳的立绘数。第四个角色上台必须顶掉一个。 */
export const MAX_ON_STAGE = 3;

/**
 * 决定一个新上台角色的槽位。
 * 传入的 cast 是「上台后的最终名单」（不含新人），本函数只看数量。
 */
function slotFor(existingCount: number): StagePosition {
  return SLOT_ORDER[Math.min(existingCount, MAX_ON_STAGE - 1)];
}

export interface StageTransitionInput {
  line: ScriptLine | undefined;
  /** 上一帧的舞台状态 */
  prev: StageCharacter[];
  /** 上一帧的场景路径（undefined = 还没有场景） */
  prevLocationPath: string | null;
}

/**
 * 舞台状态转移：给定「当前行 + 上一状态」，算出「这一帧该显示什么」。
 *
 * 这是整个演出层唯一需要动脑的地方，其余都是渲染。
 */
export function advanceStage(input: StageTransitionInput): StageCharacter[] {
  const { line, prev, prevLocationPath } = input;

  if (!line) return prev;

  const locationPath = line.location?.path ?? null;
  const sceneChanged = locationPath !== prevLocationPath;

  // ── 情形一：不该有人说话（旁白 / 玩家发言 / 没有 speaker）──
  // 换景 → 清台（人都走了）；否则只是「暂退」，位置记忆保留。
  const speaker = line.speaker;
  const isPlayer = speaker === PLAYER_SPEAKER;
  if (!speaker || line.type === 'narrator' || isPlayer) {
    if (sceneChanged) return [];
    // 全员暂退。注意 isActive 也要清掉：没人说话时不该有人亮着。
    return prev.map((c) => ({ ...c, isActive: false, hidden: true }));
  }

  // 用 resolveSprite 而不是 line.sprite：需要拿到「实际命中哪个 key」。
  // 解析器给的 line.sprite 只是 URL，无法区分「回退到 calm」与「本来就 calm」。
  const resolved = resolveSprite(speaker, line.emotion);
  const sprite = resolved?.url ?? '';
  const emotionKey = resolveEmotion(line.emotion);
  const resolvedKey = resolved?.key ?? emotionKey;
  const resolvedFallback = resolved?.fallback ?? false;

  // ── 情形二：换景后第一个开口的人 ──
  // 清台重来：他进 center，其余都没了。
  if (sceneChanged) {
    return [
      {
        speaker,
        sprite,
        position: 'center',
        isActive: true,
        hidden: false,
        emotionKey,
        resolvedKey,
        resolvedFallback,
      },
    ];
  }

  // ── 情形三：老角色开口（位置记忆）──
  // 关键：他要回到**原来的槽位**，不能重新分配。
  // 否则「A 说话 → 旁白 → B 说话 → A 再说话」会让 A 从左槽跳到别处。
  const existingIndex = prev.findIndex((c) => c.speaker === speaker);
  if (existingIndex >= 0) {
    return prev.map((c, i) => {
      if (i === existingIndex) {
        return {
          ...c,
          // 差分变了就换图；没解析出立绘时保留上一张，避免「突然空了」
          sprite: sprite || c.sprite,
          emotionKey: sprite ? emotionKey : c.emotionKey,
          resolvedKey: sprite ? resolvedKey : c.resolvedKey,
          resolvedFallback: sprite ? resolvedFallback : c.resolvedFallback,
          isActive: true,
          hidden: false,
        };
      }
      // 其余人：变暗（isActive=false），但**不解暂退**——
      // 他还在台上听着，只是不亮。这是「说话人亮、旁听暗」的语义。
      return { ...c, isActive: false, hidden: false };
    });
  }

  // ── 情形四：新角色上台 ──
  // 槽位由「目前台上人数」决定；超员时顶掉最老的。
  const position = slotFor(prev.length);
  const incoming: StageCharacter = {
    speaker,
    sprite,
    position,
    isActive: true,
    hidden: false,
    emotionKey,
    resolvedKey,
    resolvedFallback,
  };

  // 先把「退场的旧人」摘掉，再补新人，最后统一重排槽位。
  // 重排是必要的：如果新人是来顶替 center 的，剩下的 right/left 应当
  // 依次前移成 center/right，否则台上会出现「空着 center 却站 right」的怪状。
  const staying = prev.filter((c) => {
    // 顶掉谁：台上有 MAX_ON_STAGE 人时，顶掉「最早上台的」。
    // prev 的顺序就是上台顺序（append 语义），所以第一个就是最老的。
    if (prev.length >= MAX_ON_STAGE) return c !== prev[0];
    // 位置冲突：不该发生（槽位由数量算），但真发生了要保证不重叠——
    // 优先保留已在台上的人，把新人分配到自己算出的槽位上。
    return c.position !== position;
  });

  const merged = [...staying, incoming];
  // 统一重排：按「谁是新人排在最后」的顺序重新分配槽位，
  // 保证台上永远是紧凑且不重叠的 center / right / left 组合。
  return merged.map((c, i) => {
    const pos = SLOT_ORDER[Math.min(i, MAX_ON_STAGE - 1)];
    return {
      ...c,
      position: pos,
      // 只有最后一个人（= 刚开口的）亮着
      isActive: c.speaker === speaker,
      hidden: false,
    };
  });
}

/**
 * 快进重放：从第 0 行演到第 targetIndex 行，返回那一帧的舞台状态。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 * 舞台是**逐帧累积**的。第 7 行的正确舞台，是第 1~6 行依次演过之后的结果。
 * 若直接跳到第 7 行却从空台起算，会得到「第 7 行说话的人独自站在台上」——
 * 前面建立起来的 cast 全丢了。
 *
 * 这不是纯测试问题：玩家从历史楼层点进第 7 行、或从阅读进度恢复时，
 * 都会遇到同样的路径。所以这是**产品逻辑**，不是测试脚手架。
 *
 * ── 关键实现细节 ──────────────────────────────────────────────
 * 必须同步推进 locationPath。换景清台的判断依赖「上一帧的场景」，
 * 只喂 line 不喂路径的话，重放中每一次场景变化都会被误判成「没变」。
 *
 * 成本：targetIndex 次数组计算，纯函数无副作用，可忽略。
 */
export function replayStageTo(
  lines: ScriptLine[],
  from = 0,
  targetIndex = lines.length - 1,
): StageCharacter[] {
  if (lines.length === 0) return [];

  const end = Math.min(Math.max(targetIndex, 0), lines.length - 1);
  let cast: StageCharacter[] = [];
  let locPath: string | null = null;

  for (let i = Math.max(from, 0); i <= end; i += 1) {
    cast = advanceStage({ line: lines[i], prev: cast, prevLocationPath: locPath });
    locPath = lines[i]?.location?.path ?? null;
  }
  return cast;
}

/** 背景引用：URL + 场景 key（key 用于判断「要不要换」和「有没有跟上场景」） */
export interface BgRef {
  url: string;
  key: string;
}

/**
 * 背景的快进重放：从第 0 行演到第 targetIndex 行，返回「那一帧应该显示的背景」。
 *
 * ── 为什么背景也要重放（与 replayStageTo 同理）──────────────────
 * 背景层的规则是「查不到场景就保留上一张，不闪黑」。这个规则依赖一个状态：
 * **上一张是什么**。直接跳到第 N 行时，如果背景只从第 N 行算起，
 * 而第 N 行的场景恰好查不到（作者写了个没登记的路径），
 * 结果就是「以空背景开局」——上一张根本不存在。
 *
 * 更隐蔽的是：逐帧点过来时**完全看不到这个问题**，因为前面几帧已经把
 * 「上一张」喂进去了。缺陷只在跳行导航下暴露（历史楼层点入、进度恢复）。
 * 这正是 S3 验收里第 9 行抓到的真实缺陷，不是断言写错。
 *
 * ── 与 cast 的差别 ────────────────────────────────────────────
 * cast 的重放遇到「查不到立绘」会占位（不丢失）；背景的重放遇到
 * 「查不到场景」则**跳过该帧**、保留更早的那张。语义不同，故单独实现。
 */
export function replayBackgroundRefTo(
  lines: ScriptLine[],
  targetIndex: number,
): BgRef | null {
  if (lines.length === 0) return null;

  const end = Math.min(Math.max(targetIndex, 0), lines.length - 1);
  let ref: BgRef | null = null;

  for (let i = 0; i <= end; i += 1) {
    const scene = sceneOf(lines[i]?.location?.path);
    // 查不到 → 跳过这一帧，ref 保持更早的值（与渲染层「不动」一致）
    if (scene) ref = { url: scene.image, key: scene.path };
  }
  return ref;
}

/** 收集需要预加载的立绘 URL（坑 12）。 *
 * 为什么必须预加载：差分切换时如果图还没下载完，会出现一瞬的空白或旧图，
 * 表现为「换表情时闪一下」——这是 galgame 里最刺眼的瑕疵之一。
 * 解析完就把全部 URL 塞进浏览器缓存，之后切换是瞬时的。
 */
export function collectSpriteUrls(lines: ScriptLine[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    if (l.sprite && !seen.has(l.sprite)) {
      seen.add(l.sprite);
      out.push(l.sprite);
    }
  }
  return out;
}

/** 舞台上当前正在说话的人（验收脚本用；渲染层不需要） */
export function activeSpeaker(cast: StageCharacter[]): string | undefined {
  return cast.find((c) => c.isActive && !c.hidden)?.speaker;
}

/** 台上可见的人（hidden=false），按槽位从左到右排序 */
export function visibleCast(cast: StageCharacter[]): StageCharacter[] {
  const order: Record<StagePosition, number> = { left: 0, center: 1, right: 2 };
  return cast.filter((c) => !c.hidden).sort((a, b) => order[a.position] - order[b.position]);
}
