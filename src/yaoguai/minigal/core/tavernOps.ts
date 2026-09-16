// minigal · 酒馆操作层（S5）：读变量 / 删楼 / 静默重roll
//
// ── 与 tavern.ts 的分工 ────────────────────────────────────────
//   tavern.ts    = 「怎么安全地调用宿主」——只管判空与降级，不含业务语义
//   tavernOps.ts = 「用这些调用做成一件业务的事」——七步重roll、三层变量降级
//
// ── 本阶段的三条铁律（都是别人踩过的坑，不是理论）──────────────
// 坑 19：删楼必须用 `/cut`，不能用 `deleteChatMessages` ——
//        后者只**清空内容**，楼壳还在，照常渲染出一个空 iframe。
// 坑 20：重roll 时 `overrides.chat_history` 会绕过 `/hide` 与「仅格式提示词」
//        正则 —— 等于把全部历史原文裸发出去。必须自己裁窗口。
// 坑 21：重roll 不重算变量 → 时间/地点停在上一次。
//        要以该楼**旧变量**为基线解析新回复。
// 坑 24：刷新用 `location.reload()` → 退出全屏、丢全部前端状态。
//        改用自定义事件让各楼 iframe 自刷新。
//
// ── 为什么把「裁窗口」「取正文」写成纯函数 ──────────────────────
// 这两件事都是「错了不报错」的类型：窗口裁多了只是贵、只是泄历史；
// 正文取错了画面就是错的，但流程照样走完。靠真机肉眼看很难覆盖，
// 写成纯函数就能穷举单测。

import {
  chatVars,
  emit,
  generate,
  getMessages,
  lastMessageId,
  mvu,
  regenCapability,
  setChatMessages,
  slash,
  waitGlobalInitialized,
  STORY_UPDATED,
} from './tavern';
import { stripThinking } from './scriptProtocol';

/** 重roll 时最多回带多少层 AI 楼（预算收紧，理由见 selectRegenHistory）。 */
export const REGEN_HISTORY_AI_FLOORS = 5;

export interface ChatMsg {
  message_id?: number;
  role?: string;
  message?: string;
}

export interface Prompt {
  role: string;
  content: string;
}

// ══════════════════════════════════════════════════════════════
// 纯函数区（单测覆盖）
// ══════════════════════════════════════════════════════════════

/**
 * 从「截至玩家楼的完整历史」里截出发给 AI 的窗口：**只保留最近 N 层 AI 楼**，
 * 更早的连同它们之前的玩家楼一起丢掉（坑 20）。
 *
 * 为什么要裁：`overrides.chat_history` 会绕过 `/hide` 与「仅格式提示词」正则，
 * 不裁的话就是把整本聊天记录原文发出去 —— 既贵，又把本该隐藏的历史泄露给模型。
 *
 * 为什么按「AI 楼层数」而不是「消息条数」来算预算：一次生成的成本主要随
 * 上下文长度增长，而 AI 楼的长度差异极大（一层可能比十层玩家楼还长）。
 * 按 AI 楼计数至少能保证「不随剧情推进无限膨胀」。
 *
 * 不足预算时全带上 —— 不为了凑数去编造内容。
 */
export function selectRegenHistory(all: ChatMsg[], aiFloorBudget = REGEN_HISTORY_AI_FLOORS): ChatMsg[] {
  if (!Array.isArray(all) || all.length === 0) return [];
  if (aiFloorBudget <= 0) return [];
  let seen = 0;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i]?.role === 'assistant') {
      seen += 1;
      if (seen >= aiFloorBudget) return all.slice(i);
    }
  }
  return all.slice();
}

/** 转成宿主 generation 接口要的 prompts 形状。role 只可能是 user / assistant。 */
export function toPrompts(msgs: ChatMsg[]): Prompt[] {
  return msgs.map((m) => ({
    role: m?.role === 'user' ? 'user' : 'assistant',
    content: m?.message ?? '',
  }));
}

/**
 * 从 AI 原始回复里取出「要写回楼层的正文」。
 *
 * 两步：先剥思维链，再优先取 `<maintext>` 主体；没有该标签就整段用。
 *
 * ★ 注意这里**只管正文**。变量更新块（`<UpdateVariable>`）在 `<content>` 之外，
 * 提取正文会把它丢掉 —— 所以重roll 时要另外拿「剥链后的全文」去解析变量，
 * 两个产物不一样（见 regenerateCurrentFloor 的 ⑥）。
 */
export function extractMaintext(raw: string): string {
  const filtered = stripThinking(raw ?? '');
  const m = /<maintext>([\s\S]*?)<\/maintext>/i.exec(filtered);
  return (m ? m[1] : filtered).trim();
}

/** 最后一个指定角色的下标；找不到返回 -1。 */
export function lastIndexOfRole(msgs: ChatMsg[], role: string): number {
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i]?.role === role) return i;
  }
  return -1;
}

// ══════════════════════════════════════════════════════════════
// 读变量：三层降级
// ══════════════════════════════════════════════════════════════

export interface StatReading {
  data: Record<string, any> | null;
  /**
   * 数据来自哪一层。**必须如实标注** ——
   * 把「此刻的聊天变量」当成「某一楼的快照」显示出来，是所有错法里最坏的一种：
   * 界面看起来完全正常，数值也是真的，只是回答的不是你问的那个问题。
   */
  source: 'floor' | 'chat' | 'none';
}

/**
 * 读 stat_data，并如实报告来源。降级链（每一层都可能落空）：
 *
 *   ① 该楼的 MVU 数据（Mvu.getMvuData）           → source: 'floor'
 *   ② 聊天变量（getVariables({type:'chat'})）      → source: 'chat'
 *   ③ 什么都没有                                  → source: 'none'
 *
 * ★ 第 ② 层默认**只对「看最新」开放**（`messageId == null`）。
 * 指定了历史楼还去读聊天变量是错的：聊天变量是「此刻」的快照。
 * 需要拿到它时（例如调试面板）要**显式**打开 `allowChatFallback`，
 * 并据 source 如实标注，而不是默认悄悄回退。
 *
 * ★ 读不到时返回 null 而不是 `{}`：调用方需要能分辨「没有变量」
 * 与「变量是个空对象」，前者要显示降级文案，后者是合法状态。
 */
export function readStatDataWithSource(messageId?: number, allowChatFallback?: boolean): StatReading {
  const wantChat = allowChatFallback ?? messageId == null;

  const m = mvu();
  if (m) {
    try {
      const sd = m.getMvuData?.({ type: 'message', message_id: messageId ?? 'latest' })?.stat_data;
      if (sd && typeof sd === 'object') return { data: sd, source: 'floor' };
    } catch {
      /* 楼层读数失败 → 回退下一层 */
    }
  }

  if (wantChat) {
    const sd = chatVars()?.stat_data;
    if (sd && typeof sd === 'object') return { data: sd, source: 'chat' };
  }

  return { data: null, source: 'none' };
}

/** 只要数据、不关心来源时用这个。语义与 readStatDataWithSource 完全一致。 */
export function readStatData(messageId?: number): Record<string, any> | null {
  return readStatDataWithSource(messageId).data;
}

// ══════════════════════════════════════════════════════════════
// 删楼（坑 19 / 24）
// ══════════════════════════════════════════════════════════════

export interface OpResult {
  ok: boolean;
  error?: string;
  detail?: string;
}

export async function deleteFloors(start: number, end: number): Promise<OpResult> {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return { ok: false, error: `楼层范围不合法：${start}-${end}` };
  }
  // /cut 是**彻底删除**；deleteChatMessages 只清空内容，楼壳还在（坑 19）
  const ok = await slash(`/cut ${start}-${end}`);
  if (!ok) {
    return { ok: false, error: '宿主没有执行 /cut（不在酒馆里，或该命令被禁用）' };
  }
  // ★ 通知前端自刷新，绝不 reload —— reload 会退出全屏、丢前端状态（坑 24）
  emit(STORY_UPDATED);
  return { ok: true, detail: `已删除第 ${start}-${end} 楼` };
}

// ══════════════════════════════════════════════════════════════
// 静默重roll：七步
// ══════════════════════════════════════════════════════════════

export interface RegenResult extends OpResult {
  /** 重roll 后楼号（成功时给出，便于界面提示「第 N 楼已更新」）。 */
  floorId?: number;
}

export async function regenerateCurrentFloor(): Promise<RegenResult> {
  // ⓪ 先探能力，好给出**具体**的失败原因。
  //    笼统的「需要酒馆环境」会让人分不清是「不在酒馆里」还是
  //    「宿主版本太老没有 generate」—— 两者的处理方式完全不同。
  const cap = regenCapability();
  if (!cap.ok) {
    return {
      ok: false,
      error: `当前环境缺少：${cap.missing.join('、')}`,
      detail: '不在酒馆 iframe 内，或宿主版本过老。',
    };
  }

  try {
    /* ① 最后一楼必须是 AI 楼 */
    const lastId = lastMessageId();
    if (lastId == null) return { ok: false, error: '聊天里还没有楼层' };
    const last = getMessages(lastId)[0] as ChatMsg | undefined;
    if (!last) return { ok: false, error: `读不到第 ${lastId} 楼` };
    if (last.role !== 'assistant') {
      // 玩家刚发完、AI 还没回时点重roll 就会走到这里
      return { ok: false, error: '最后一楼不是 AI 楼（等回复落地后再试）' };
    }

    /* ② 向上找最近的玩家楼作为输入 */
    if (lastId <= 0) return { ok: false, error: '找不到上一层的玩家输入' };
    const before = getMessages(`0-${lastId - 1}`) as ChatMsg[];
    const userIdx = lastIndexOfRole(before, 'user');
    if (userIdx < 0) return { ok: false, error: '找不到上一层的玩家输入' };
    const userText = (before[userIdx]?.message ?? '').trim();
    if (!userText) return { ok: false, error: '上一层的玩家输入是空的' };

    /* ③ 裁历史窗口（坑 20） */
    const windowed = selectRegenHistory(before.slice(0, userIdx + 1));

    /* ④ 静默生成：should_silence 让它只生成、不建新楼层 */
    const raw = await generate({
      user_input: userText,
      should_stream: false,
      should_silence: true,
      overrides: { chat_history: { prompts: toPrompts(windowed) } },
    });
    if (raw == null) return { ok: false, error: '宿主没有返回生成结果' };
    if (!raw.trim()) return { ok: false, error: 'AI 返回了空响应' };

    /* ⑤ 剥思维链 + 取正文 */
    const maintext = extractMaintext(raw);
    if (!maintext) return { ok: false, error: '剥离思维链后正文是空的' };

    /* ⑥ 变量跟着重算（坑 21）。
       吃的是「剥链后的全文」而不是 maintext —— <UpdateVariable> 块在
       <content> 之外，用正文去解析会把变量更新整段丢掉。 */
    let varNote = '变量未重算（未装 MVU 或尚未就绪）';
    try {
      await waitGlobalInitialized('Mvu');
      const m = mvu();
      if (typeof m?.parseMessage === 'function') {
        const oldData = m.getMvuData?.({ type: 'message', message_id: lastId });
        await m.parseMessage(stripThinking(raw), oldData);
        varNote = '变量已按该楼旧值重算';
      }
    } catch (e) {
      // 变量算不出来不该拦住正文替换 —— 正文是玩家看得见的东西
      console.warn('[minigal] 重roll 时变量解析失败，正文照常替换：', e);
      varNote = '变量解析失败，正文已替换';
    }

    /* ⑦ 原位替换：不删不建，楼号不变。
       删楼重建会让楼层闪烁、甚至整段消失（这一步是本阶段的头号坑）。
       refresh:'none' + 自定义事件，避免宿主重建 iframe。 */
    const written = await setChatMessages([{ message_id: lastId, message: maintext }], { refresh: 'none' });
    if (!written) return { ok: false, error: '写入楼层失败（setChatMessages 未成功）' };

    emit(STORY_UPDATED);
    // ★ 把「回带了多少历史」写进返回值，让**用户不开 DevTools 也能核对**
    //   窗口裁剪（坑 20）。这一项原本只能靠翻生成请求才能验，
    //   而「需要开控制台才能验的功能，实际就是不会被验的功能」。
    const aiKept = windowed.filter((m) => m?.role === 'assistant').length;
    return {
      ok: true,
      floorId: lastId,
      detail: `${varNote}；第 ${lastId} 楼已原位更新；回带 ${windowed.length} 条历史（${aiKept} 层 AI 楼）`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `重新生成失败：${msg}` };
  }
}
