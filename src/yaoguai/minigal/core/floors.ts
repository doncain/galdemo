// minigal · 楼层扫描工具（S4）
//
// 职责单一：把「聊天里有哪些 AI 楼层、最新的是哪一楼、某楼正文是什么」
// 这三件事封装起来，供界面做楼层导航与阅读。
//
// 为什么单独一个文件而不是塞进 tavern.ts：
//   tavern.ts 是「与宿主打交道的安全层」，只关心「怎么安全地调用」；
//   floors.ts 是「业务语义层」，关心「哪些楼是 AI 楼、最新楼怎么找」。
//   分开之后，楼层语义的规则（比如「最后一楼可能是 user」）有地方写注释。

import { getMessages, lastMessageId } from './tavern';

/**
 * 扫描所有 AI 楼层号（升序）。
 *
 * 用 `0-{{lastMessageId}}` 而不是逐个读：宏由酒馆展开成实际最大楼号，
 * 一次调用拿回全部，比循环 N 次快得多，也不会漏。
 */
export function getAssistantFloors(): number[] {
  const msgs = getMessages('0-{{lastMessageId}}', { role: 'assistant' });
  return msgs
    .map((m: any) => m?.message_id)
    .filter((id: any) => typeof id === 'number')
    .sort((a: number, b: number) => a - b);
}

/**
 * 最新 AI 楼层号。
 *
 * ★ 关键：**最后一楼往往是 user 楼**（玩家刚发完消息、AI 还没回），
 * 所以不能直接取 `lastMessageId()` 当 AI 楼。必须校验角色，
 * 不是 assistant 就往前看一楼。
 *
 * 这个细节漏掉的后果很隐蔽：玩家发消息的瞬间，界面会去读「最后一楼」，
 * 拿到的是玩家自己的输入，然后把它当剧本来解析 —— 画面会短暂变成
 * 玩家那句话。生成结束后又变回来。表现为「发送瞬间闪一下怪东西」。
 */
export function getLatestAssistantId(): number | null {
  const lastId = lastMessageId();
  if (lastId == null) return null;

  const msg = getMessages(lastId)[0];
  if (msg?.role === 'assistant') return msg.message_id;

  if (lastId > 0) {
    const prev = getMessages(lastId - 1)[0];
    if (prev?.role === 'assistant') return prev.message_id;
  }
  return null;
}

/** 读某楼正文原文。楼层不存在返回 null。 */
export function floorMessage(floorId: number | null): string | null {
  if (floorId == null) return null;
  const m = getMessages(floorId)[0];
  return typeof m?.message === 'string' ? m.message : null;
}

/**
 * 楼层号 → 在 AI 楼层列表里的序号（1 基，给界面显示用）。
 * 不在列表里返回 null。
 */
export function floorOrdinal(floorId: number | null, floors: number[]): number | null {
  if (floorId == null) return null;
  const i = floors.indexOf(floorId);
  return i < 0 ? null : i + 1;
}
