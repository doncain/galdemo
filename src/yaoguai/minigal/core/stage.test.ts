// S3 舞台状态机单测
//
// 这个文件的存在意义：舞台装配是 S3 唯一有真实分支逻辑的地方，
// 而它的错误几乎都表现为「截图看着怪但说不出哪里怪」。
// 穷举验证比人眼盯截图可靠得多。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ON_STAGE,
  advanceStage,
  activeSpeaker,
  collectSpriteUrls,
  replayBackgroundRefTo,
  visibleCast,
  type StageCharacter,
} from './stage';
import { PLAYER_SPEAKER } from './scriptProtocol';
import type { ScriptLine } from './scriptProtocol';

// 【关于 line.sprite】
// 解析器会在 ScriptLine 上填一个 sprite（立绘 URL），但**舞台不采信它**——
// advanceStage 自己用 resolveSprite(speaker, emotion) 查表，
// 因为只有那样才能同时拿到「实际命中哪个 key / 有没有回退」。
// line.sprite 现在只服务预加载（collectSpriteUrls）。
// 所以下面造数据时基本不用传 sprite，传了也只会被忽略（除了 collectSpriteUrls 那条用例）。
function line(p: Partial<ScriptLine> & { text: string }): ScriptLine {
  return { type: 'dialog', emotion: 'calm', ...p } as ScriptLine;
}

/** 造一个「已上台」的角色，省去每个用例都敲全字段 */
function cast(p: Partial<StageCharacter> & { speaker: string }): StageCharacter {
  const merged = {
    sprite: 's:' + p.speaker,
    position: 'center' as const,
    isActive: false,
    hidden: false,
    emotionKey: 'calm',
    ...p,
  };
  // resolvedKey 缺省时跟随 emotionKey（=「没有发生回退」的常态）。
  // 这样新增字段不必回头改一堆用例；只有真在验回退的用例才显式给值。
  return {
    ...merged,
    resolvedKey: merged.resolvedKey ?? merged.emotionKey,
    resolvedFallback: merged.resolvedFallback ?? false,
  } as StageCharacter;
}

const LOC = { path: '旧城区/河堤', displayName: '河堤' };
const LOC2 = { path: '旧城区/茶馆', displayName: '茶馆' };

test('首个开口角色占据 center 槽', () => {
  const out = advanceStage({
    line: line({ speaker: '青梧', text: 'a', location: LOC, sprite: 's:qw' }),
    prev: [],
    prevLocationPath: LOC.path,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].speaker, '青梧');
  assert.equal(out[0].position, 'center');
  assert.equal(out[0].isActive, true);
  assert.equal(out[0].hidden, false);
});

test('第二个角色进 right，第一个人转暗但不下台', () => {
  const s1 = advanceStage({
    line: line({ speaker: '青梧', text: 'a', location: LOC, sprite: 's:qw' }),
    prev: [],
    prevLocationPath: LOC.path,
  });
  const s2 = advanceStage({
    line: line({ speaker: '沈砚', text: 'b', location: LOC, sprite: 's:sy' }),
    prev: s1,
    prevLocationPath: LOC.path,
  });

  assert.equal(s2.length, 2);
  const qw = s2.find((c) => c.speaker === '青梧')!;
  const sy = s2.find((c) => c.speaker === '沈砚')!;
  assert.equal(qw.position, 'center', '老角色槽位不变');
  assert.equal(qw.isActive, false, '旁听者不亮');
  assert.equal(qw.hidden, false, '旁听者仍在台上');
  assert.equal(sy.position, 'right', '第二个角色进 right');
  assert.equal(sy.isActive, true);
});

test('第三个角色进 left', () => {
  let s = advanceStage({ line: line({ speaker: 'A', text: '1', location: LOC, sprite: 's:a' }), prev: [], prevLocationPath: LOC.path });
  s = advanceStage({ line: line({ speaker: 'B', text: '2', location: LOC, sprite: 's:b' }), prev: s, prevLocationPath: LOC.path });
  s = advanceStage({ line: line({ speaker: 'C', text: '3', location: LOC, sprite: 's:c' }), prev: s, prevLocationPath: LOC.path });

  assert.equal(s.length, 3);
  const c = s.find((x) => x.speaker === 'C')!;
  assert.equal(c.position, 'left');
  const pos = new Set(s.map((x) => x.position));
  assert.equal(pos.size, 3, '三个槽位互不重叠');
});

test('第四个角色上台会顶掉最老的（同屏 ≤3）', () => {
  let s = advanceStage({ line: line({ speaker: 'A', text: '1', location: LOC, sprite: 's:a' }), prev: [], prevLocationPath: LOC.path });
  s = advanceStage({ line: line({ speaker: 'B', text: '2', location: LOC, sprite: 's:b' }), prev: s, prevLocationPath: LOC.path });
  s = advanceStage({ line: line({ speaker: 'C', text: '3', location: LOC, sprite: 's:c' }), prev: s, prevLocationPath: LOC.path });
  s = advanceStage({ line: line({ speaker: 'D', text: '4', location: LOC, sprite: 's:d' }), prev: s, prevLocationPath: LOC.path });

  assert.equal(s.length, MAX_ON_STAGE, '台上恒不超过 3 人');
  assert.equal(s.some((c) => c.speaker === 'A'), false, 'A 是最老的，被顶掉');
  assert.ok(s.some((c) => c.speaker === 'D'), 'D 在台上');

  // 顶替后槽位必须重排成紧凑的 center/right/left，不能留下空洞
  const pos = new Set(s.map((c) => c.position));
  assert.deepEqual([...pos].sort(), ['center', 'left', 'right']);

  // 新人必须亮着，且只有他亮
  assert.equal(activeSpeaker(s), 'D');
  assert.equal(s.filter((c) => c.isActive).length, 1, '同时只有一个人在说话');
});

test('旁白行：全员暂退（hidden），但位置记忆保留', () => {
  let s = advanceStage({ line: line({ speaker: '青梧', text: 'a', location: LOC, sprite: 's:qw' }), prev: [], prevLocationPath: LOC.path });
  s = advanceStage({ line: line({ speaker: '沈砚', text: 'b', location: LOC, sprite: 's:sy' }), prev: s, prevLocationPath: LOC.path });

  const afterNarrator = advanceStage({
    line: line({ type: 'narrator', text: '风停了。', location: LOC }),
    prev: s,
    prevLocationPath: LOC.path,
  });

  assert.equal(afterNarrator.length, 2, '没有清台——位置记忆保留');
  assert.equal(afterNarrator.every((c) => c.hidden), true, '全员暂退');
  assert.equal(afterNarrator.every((c) => c.isActive), false, '没人亮着');
  assert.equal(afterNarrator.find((c) => c.speaker === '青梧')!.position, 'center', '槽位记忆未丢');
  assert.equal(afterNarrator.find((c) => c.speaker === '沈砚')!.position, 'right');
});

test('旁白后老角色再开口，回到原位且重新亮起', () => {
  let s = advanceStage({ line: line({ speaker: '青梧', text: 'a', location: LOC, sprite: 's:qw' }), prev: [], prevLocationPath: LOC.path });
  s = advanceStage({ line: line({ speaker: '沈砚', text: 'b', location: LOC, sprite: 's:sy' }), prev: s, prevLocationPath: LOC.path });
  s = advanceStage({ line: line({ type: 'narrator', text: '风停了。', location: LOC }), prev: s, prevLocationPath: LOC.path });

  const back = advanceStage({
    line: line({ speaker: '沈砚', text: 'c', location: LOC, emotion: '生气' }),
    prev: s,
    prevLocationPath: LOC.path,
  });

  assert.equal(back.length, 2);
  const sy = back.find((c) => c.speaker === '沈砚')!;
  assert.equal(sy.hidden, false, '重新上台');
  assert.equal(sy.isActive, true);
  assert.equal(sy.position, 'right', '关键：回到原槽位，而不是重新分配到 center');
  // 差分从 calm 换成 angry：这里不比 URL 字面量（占位图是程序生成的，改了生成器就变），
  // 比「实际命中的 key」——它才是语义。
  assert.equal(sy.resolvedKey, 'angry', '差分已更新');
  assert.notEqual(sy.sprite, back.find((c) => c.speaker === '青梧')!.sprite, '立绘确实换了图');
});

test('玩家发言：不占立绘位（踩坑 9）', () => {
  const before = [cast({ speaker: '青梧', position: 'center', isActive: true })];

  const after = advanceStage({
    // 玩家行：speaker 是 <user>，sprite 按解析器恒为 undefined
    line: line({ speaker: PLAYER_SPEAKER, text: '我只是路过。', location: LOC }),
    prev: before,
    prevLocationPath: LOC.path,
  });

  assert.equal(after.length, 1, '没有新增立绘');
  assert.equal(after.some((c) => c.speaker === PLAYER_SPEAKER), false, '玩家绝不上台');
  assert.equal(after[0].hidden, true, '玩家说话时其他人暂退');
});

test('玩家发言后角色再开口：位置记忆同样保留', () => {
  let s = advanceStage({ line: line({ speaker: '青梧', text: 'a', location: LOC, sprite: 's:qw' }), prev: [], prevLocationPath: LOC.path });
  s = advanceStage({ line: line({ speaker: PLAYER_SPEAKER, text: 'b', location: LOC }), prev: s, prevLocationPath: LOC.path });
  s = advanceStage({ line: line({ speaker: '青梧', text: 'c', location: LOC, sprite: 's:qw' }), prev: s, prevLocationPath: LOC.path });

  assert.equal(s.length, 1);
  assert.equal(s[0].position, 'center');
  assert.equal(s[0].isActive, true);
  assert.equal(s[0].hidden, false);
});

test('换景清台，换景后首个开口者进 center', () => {
  let s = advanceStage({ line: line({ speaker: '青梧', text: 'a', location: LOC, sprite: 's:qw' }), prev: [], prevLocationPath: LOC.path });
  s = advanceStage({ line: line({ speaker: '沈砚', text: 'b', location: LOC, sprite: 's:sy' }), prev: s, prevLocationPath: LOC.path });
  assert.equal(s.length, 2);

  const moved = advanceStage({
    line: line({ speaker: '沈砚', text: 'c', location: LOC2, sprite: 's:sy' }),
    prev: s,
    prevLocationPath: LOC.path, // 上一帧还在河堤
  });

  assert.equal(moved.length, 1, '换景清台：只剩新场景里开口的人');
  assert.equal(moved[0].speaker, '沈砚');
  assert.equal(moved[0].position, 'center', '换景后重新从 center 开始');
});

test('换景 + 旁白行 = 直接清台（不是暂退）', () => {
  const before = [cast({ speaker: '青梧', position: 'center', isActive: true })];
  const out = advanceStage({
    line: line({ type: 'narrator', text: '换了个地方。', location: LOC2 }),
    prev: before,
    prevLocationPath: LOC.path,
  });
  assert.deepEqual(out, [], '换景时的旁白行应当把台清空，而非暂退');
});

test('角色未登记（sprite 为空）：仍占位，但不崩', () => {
  const out = advanceStage({
    line: line({ speaker: '路人甲', text: '喂。', location: LOC, sprite: undefined }),
    prev: [],
    prevLocationPath: LOC.path,
  });
  assert.equal(out.length, 1, '占位——他有说话，只是没有图');
  assert.equal(out[0].sprite, '', 'sprite 为空串而非 undefined，渲染层据此不渲染 img');
  assert.equal(out[0].isActive, true);
});

test('老角色换情绪：实际命中的差分跟着换', () => {
  const s1 = advanceStage({
    line: line({ speaker: '青梧', text: 'a', location: LOC, emotion: '平静' }),
    prev: [],
    prevLocationPath: LOC.path,
  });
  const s2 = advanceStage({
    line: line({ speaker: '青梧', text: 'b', location: LOC, emotion: '微笑' }),
    prev: s1,
    prevLocationPath: LOC.path,
  });
  assert.equal(s1[0].resolvedKey, 'calm');
  assert.equal(s2[0].resolvedKey, 'smile', '差分已切换');
  assert.equal(s2[0].emotionKey, 'smile');
  assert.notEqual(s2[0].sprite, s1[0].sprite, '图确实换了一张');
});

test('立绘缺失（角色未登记）：保留旧图，别把画面清空', () => {
  // 先让一个已登记角色上台
  const s1 = advanceStage({
    line: line({ speaker: '青梧', text: 'a', location: LOC, emotion: '平静' }),
    prev: [],
    prevLocationPath: LOC.path,
  });
  const before = s1[0].sprite;
  assert.ok(before, '前提：青梧有立绘');

  // 再看未登记角色：resolveSprite 返回 null → sprite 为空串 → 保留旧图
  const s2 = advanceStage({
    line: line({ speaker: '查无此人', text: 'b', location: LOC, emotion: '平静' }),
    prev: s1,
    prevLocationPath: LOC.path,
  });
  const ghost = s2.find((c) => c.speaker === '查无此人')!;
  assert.equal(ghost.sprite, '', '未登记角色没有图，占位但不渲染 img');
  assert.equal(s1.find((c) => c.speaker === '青梧')!.sprite, before, '原来那位没被牵连');
});

test('同一帧内不会出现两个 isActive', () => {
  let s: StageCharacter[] = [];
  const speakers = ['青梧', '沈砚', '阿棠', '青梧', '沈砚'];
  for (let i = 0; i < speakers.length; i += 1) {
    s = advanceStage({
      line: line({ speaker: speakers[i], text: 'x' + i, location: LOC, sprite: 's:' + speakers[i] }),
      prev: s,
      prevLocationPath: LOC.path,
    });
    assert.equal(s.filter((c) => c.isActive).length, 1, `第 ${i + 1} 帧应当恰好一人亮着`);
  }
});

test('collectSpriteUrls：去重、保序、忽略空值', () => {
  const lines: ScriptLine[] = [
    line({ text: 'a', speaker: 'A', sprite: 'u1' }),
    line({ text: 'b', speaker: 'B', sprite: 'u2' }),
    line({ text: 'c', speaker: 'A', sprite: 'u1' }),
    line({ text: 'd', type: 'narrator' }),
    line({ text: 'e', speaker: 'C', sprite: undefined }),
    line({ text: 'f', speaker: 'D', sprite: 'u3' }),
  ];
  assert.deepEqual(collectSpriteUrls(lines), ['u1', 'u2', 'u3']);
});

test('visibleCast：过滤暂退者，按左→中→右排序', () => {
  const c: StageCharacter[] = [
    cast({ speaker: 'R', position: 'right' }),
    cast({ speaker: 'L', position: 'left' }),
    cast({ speaker: 'C', position: 'center' }),
    cast({ speaker: 'X', position: 'right', hidden: true }),
  ];
  assert.deepEqual(visibleCast(c).map((x) => x.speaker), ['L', 'C', 'R']);
});

test('空行（undefined）：原样返回上一状态，不清台', () => {
  const before = [cast({ speaker: '青梧', position: 'center', isActive: true })];
  const out = advanceStage({ line: undefined, prev: before, prevLocationPath: LOC.path });
  assert.deepEqual(out, before);
});

// ── 回退的可观测性（本轮修复的核心）───────────────────────────
//
// 背景：青梧没有 helpless 差分。请求 helpless 时 sprite 会回退到 calm 那张图，
// 而 calm 与「本来就是 calm」产生**完全相同的 URL**——
// 单看图片分不出「回退发生了」还是「压根没请求过别的情绪」。
//
// 更麻烦的是 emotionKey 记录的是「请求什么」，回退后它**仍然是 helpless**。
// 于是「用 emotionKey 断言回退」的验收会永远失败，而失败的其实是断言自己。
// 这两条测试把三个字段的语义钉死，防止再次混淆。

test('缺差分时：回退到 calm，且 resolvedKey/resolvedFallback 如实反映', () => {
  const out = advanceStage({
    // 青梧没有 helpless 差分（见 assets.ts 的 CHARACTERS）
    line: line({ speaker: '青梧', text: 'a', emotion: '无奈', location: LOC, sprite: 's:qw' }),
    prev: [],
    prevLocationPath: LOC.path,
  });
  assert.equal(out.length, 1);
  const qw = out[0];
  assert.equal(qw.emotionKey, 'helpless', 'emotionKey 记录的是"请求什么"，回退不改变它');
  assert.equal(qw.resolvedKey, 'calm', 'resolvedKey 记录的是"实际用了哪张图"');
  assert.equal(qw.resolvedFallback, true, '回退必须留下标记，不能静默');
});

test('差分齐全时：resolvedKey 与 emotionKey 一致，且不标回退', () => {
  const out = advanceStage({
    // 青梧有 smile
    line: line({ speaker: '青梧', text: 'a', emotion: '微笑', location: LOC, sprite: 's:qw' }),
    prev: [],
    prevLocationPath: LOC.path,
  });
  assert.equal(out[0].emotionKey, 'smile');
  assert.equal(out[0].resolvedKey, 'smile');
  assert.equal(out[0].resolvedFallback, false, '没回退就不该标回退——标记必须可信');
});

// ── 背景重放 ──────────────────────────────────────────────────
//
// 背景的规则是「场景查不到就保留上一张，不闪黑」。
// 直接跳到第 N 行时，如果背景只从第 N 行算起，
// 而第 N 行恰好是个没登记的路径，就会以空背景开局 —— 背景"丢了"。
// 逐帧点过来时完全看不到这个问题，只在跳行导航下暴露。
// 下面两条把「重放要回到更早那一张」钉死。

test('背景重放：目标行场景查不到时，回退到更早那张（而不是空）', () => {
  const lines = [
    line({ text: 'n1', type: 'narrator', location: { path: '旧城区/河堤', displayName: '河堤' } }),
    // 没登记的场景：sceneOf 返回 undefined
    line({ text: 'n2', type: 'narrator', location: { path: '不存在的地方/虚空', displayName: '虚空' } }),
  ];
  const bg = replayBackgroundRefTo(lines, 1);
  assert.ok(bg, '必须拿到背景，而不是 null');
  assert.equal(bg.key, '旧城区/河堤', '应停在最后一张查得到的场景上');
});

test('背景重放：首行就查不到场景时返回 null（没有背景可说，不编）', () => {
  const lines = [
    line({ text: 'n1', type: 'narrator', location: { path: '不存在的地方/虚空', displayName: '虚空' } }),
  ];
  assert.equal(replayBackgroundRefTo(lines, 0), null);
});

test('背景重放：逐级向上回退命中最近的已登记父场景', () => {
  // SCENES 登记了 旧城区/河堤/柳树下、旧城区/河堤、旧城区 等。
  // `旧城区/河堤/柳树下/西岸` 向上逐级试：
  //   ✗ 旧城区/河堤/柳树下/西岸（未登记）
  //   ✓ 旧城区/河堤/柳树下      ← 最近的一个，停在这里
  // 注意「最近」而不是「最顶层」：回退是逐级向上找第一个命中，不是跳到根。
  const lines = [
    line({
      text: 'n1',
      type: 'narrator',
      location: { path: '旧城区/河堤/柳树下/西岸', displayName: '西岸' },
    }),
  ];
  const bg = replayBackgroundRefTo(lines, 0);
  assert.ok(bg);
  assert.equal(bg.key, '旧城区/河堤/柳树下', '停在最近的已登记父路径，不越级跳到根');
});
