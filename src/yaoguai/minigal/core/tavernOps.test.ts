// S5 操作层单测
//
// ── 为什么这两件事值得单测 ────────────────────────────────────
// 「裁历史窗口」和「取正文」都属于**错了不报错**的类型：
//   · 窗口裁多了：生成照样成功，只是贵 + 把本该隐藏的历史发给了模型（坑 20）
//   · 正文取错了：画面就是错的，但整条链路会「成功」走完
// 靠真机肉眼看很难覆盖（要看 console 里发出去的请求），
// 而它们都是纯函数 —— 穷举一遍的成本几乎为零。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REGEN_HISTORY_AI_FLOORS,
  extractMaintext,
  lastIndexOfRole,
  selectRegenHistory,
  toPrompts,
  type ChatMsg,
} from './tavernOps';

/** 造一段「AI 楼 + 玩家楼」交替的聊天，与真实形状一致。 */
function alternating(aiCount: number): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (let i = 0; i < aiCount; i += 1) {
    out.push({ message_id: 1 + i * 2, role: 'assistant', message: `AI-${i + 1}` });
    out.push({ message_id: 2 + i * 2, role: 'user', message: `玩家-${i + 1}` });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
// selectRegenHistory（坑 20）
// ══════════════════════════════════════════════════════════════

test('窗口裁剪：AI 楼多于预算时，只保留最近 5 层 AI 楼及其之后的玩家楼', () => {
  // 8 层 AI 楼 + 8 层玩家楼 = 16 条，AI 楼号 1,3,…,15
  const all = alternating(8);
  const w = selectRegenHistory(all);

  // 倒数第 5 层 AI 楼是 AI-4（楼号 7），窗口应从它开始
  assert.equal(w[0].message, 'AI-4', '窗口起点应是倒数第 5 层 AI 楼');
  assert.equal(w[0].message_id, 7);
  // 5 层 AI 楼 + 它们之后的 5 层玩家楼
  assert.equal(w.filter((m) => m.role === 'assistant').length, 5);
  assert.equal(w.length, 10);
  // 最后一个元素必须是最后一条（玩家楼），否则等于把本轮输入丢了
  assert.equal(w[w.length - 1].message, '玩家-8');
});

test('窗口裁剪：AI 楼恰好等于预算时，不动（全带上）', () => {
  const all = alternating(REGEN_HISTORY_AI_FLOORS);
  const w = selectRegenHistory(all);
  assert.equal(w.length, all.length);
  assert.equal(w[0].message_id, all[0].message_id);
});

test('窗口裁剪：AI 楼少于预算时，全带上而不是报错或补空', () => {
  const all = alternating(2);
  const w = selectRegenHistory(all);
  assert.equal(w.length, all.length);
});

test('窗口裁剪：AI 楼不足预算且玩家楼在末尾时，末尾仍保留', () => {
  const all: ChatMsg[] = [
    { message_id: 0, role: 'assistant', message: 'A' },
    { message_id: 1, role: 'user', message: 'U' },
  ];
  const w = selectRegenHistory(all);
  assert.equal(w.length, 2);
  assert.equal(w[1].role, 'user');
});

test('窗口裁剪：空数组 / 预算非正 → 空数组（不抛错）', () => {
  assert.deepEqual(selectRegenHistory([]), []);
  assert.deepEqual(selectRegenHistory(alternating(3), 0), []);
  assert.deepEqual(selectRegenHistory(alternating(3), -1), []);
});

test('窗口裁剪：不修改入参（纯函数）', () => {
  const all = alternating(8);
  const snapshot = JSON.stringify(all);
  selectRegenHistory(all);
  assert.equal(JSON.stringify(all), snapshot, '不得原地修改历史数组');
});

test('窗口裁剪：一条 AI 楼都没有时原样返回（不裁掉玩家的输入）', () => {
  const all: ChatMsg[] = [
    { message_id: 0, role: 'user', message: 'U1' },
    { message_id: 1, role: 'user', message: 'U2' },
  ];
  const w = selectRegenHistory(all);
  assert.equal(w.length, 2);
});

// ══════════════════════════════════════════════════════════════
// toPrompts
// ══════════════════════════════════════════════════════════════

test('toPrompts：user 保留为 user，其余一律 assistant（宿主只认这两种）', () => {
  const p = toPrompts([
    { role: 'user', message: 'u' },
    { role: 'assistant', message: 'a' },
    { role: 'system', message: 's' },
    { role: undefined, message: 'x' },
  ]);
  assert.deepEqual(
    p.map((x) => x.role),
    ['user', 'assistant', 'assistant', 'assistant'],
  );
});

test('toPrompts：message 缺失时给空串，绝不出现 undefined', () => {
  const p = toPrompts([{ role: 'assistant' }]);
  assert.equal(p[0].content, '');
});

// ══════════════════════════════════════════════════════════════
// extractMaintext（重roll 写回楼层的正文）
// ══════════════════════════════════════════════════════════════

test('取正文：有 <maintext> 时取它，且丢掉 content 与变量块', () => {
  const raw = [
    '<thinking>想一下</thinking>',
    '<content>旧正文</content>',
    '<maintext>【新正文】</maintext>',
    '<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>',
  ].join('\n');
  const t = extractMaintext(raw);
  assert.equal(t, '【新正文】');
  assert.ok(!t.includes('UpdateVariable'), '变量块绝不能写回楼层正文');
  assert.ok(!t.includes('旧正文'));
});

test('取正文：没有 <maintext> 时整段用（剥掉思维链之后）', () => {
  const raw = '<thinking>想一下</thinking>\n[scene:旧城区]\n旁白。\n青梧[平静]:"在。"';
  const t = extractMaintext(raw);
  assert.ok(!t.includes('想一下'), '思维链必须被剥掉');
  assert.ok(t.startsWith('[scene:旧城区]'));
  assert.ok(t.includes('青梧[平静]'));
});

test('取正文：思维链标签大小写/别名都要剥（AI 不守一种写法）', () => {
  const cases = [
    '<THINKING>a</THINKING>正文',
    '<Chain_of_Thought>a</Chain_of_Thought>正文',
    '<draft>a</draft>正文',
    '<reasoning>a</reasoning>正文',
  ];
  for (const raw of cases) {
    const t = extractMaintext(raw);
    assert.equal(t, '正文', `未剥干净：${raw}`);
  }
});

test('取正文：空串 / null 输入不抛错', () => {
  assert.equal(extractMaintext(''), '');
  assert.equal(extractMaintext(null as unknown as string), '');
});

test('取正文：<maintext> 里出现空行时只 trim 两端，不压缩内部', () => {
  const t = extractMaintext('<maintext>\n\n一\n\n二\n\n</maintext>');
  assert.equal(t, '一\n\n二');
});

// ══════════════════════════════════════════════════════════════
// lastIndexOfRole
// ══════════════════════════════════════════════════════════════

test('找最后一个玩家楼：返回的是**最后**一条，不是第一条', () => {
  const msgs: ChatMsg[] = [
    { message_id: 0, role: 'user', message: 'U1' },
    { message_id: 1, role: 'assistant', message: 'A1' },
    { message_id: 2, role: 'user', message: 'U2' },
    { message_id: 3, role: 'assistant', message: 'A2' },
  ];
  assert.equal(lastIndexOfRole(msgs, 'user'), 2, '应取最后一条玩家楼作为本轮输入');
  assert.equal(msgs[lastIndexOfRole(msgs, 'user')].message, 'U2');
});

test('找最后一个玩家楼：没有时返回 -1（而不是 0——那会误取第一条）', () => {
  assert.equal(lastIndexOfRole([{ role: 'assistant' }], 'user'), -1);
  assert.equal(lastIndexOfRole([], 'user'), -1);
});
