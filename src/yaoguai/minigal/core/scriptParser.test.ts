import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFloor, parseScript } from './scriptParser';
import { emotionLabel } from './scriptProtocol';
import {
  BROKEN_FLOOR_MISSING_EMOTION,
  BROKEN_FLOOR_NARRATOR_DRIFT,
  MOCK_FLOOR_NO_CONTENT,
  MOCK_FLOOR_WITH_CONTENT,
} from './fixtures';

const joinedText = (lines: { text: string }[]) => lines.map((l) => l.text).join('\n');

test('顺序铁律：先剥思维链——思维链文本不得进入可播行', () => {
  const { lines } = parseFloor(MOCK_FLOOR_WITH_CONTENT);
  const all = joinedText(lines);
  assert.ok(!all.includes('用户想推进河堤边的偶遇'), '思维链正文泄漏');
  assert.ok(!all.includes('世界书格式条目'), '思维链正文泄漏');
});

test('严格 <content> 路径：多块合并，块外内容被隔离', () => {
  const { lines, usedContentTag } = parseFloor(MOCK_FLOOR_WITH_CONTENT);
  assert.equal(usedContentTag, true);
  const all = joinedText(lines);
  assert.ok(all.includes('夜里的河风'), '第一块内容丢失');
  assert.ok(all.includes('茶烟从窗缝里漏出来'), '第二块内容丢失');
  assert.ok(!all.includes('JSONPatch'), '变量更新块泄漏进正文');
  assert.ok(!all.includes('好感度'), '变量更新块泄漏进正文');
});

test('场景控制行：自身不产出文本行，且状态向后继承', () => {
  const { lines } = parseFloor(MOCK_FLOOR_WITH_CONTENT);
  assert.ok(!lines.some((l) => l.text.includes('[scene:')), '控制行被当成正文');

  const first = lines[0];
  assert.equal(first.location?.path, '旧城区/河堤/柳树下');
  assert.equal(first.location?.displayName, '柳树下');

  const last = lines[lines.length - 1];
  assert.equal(last.location?.path, '旧城区/茶馆/二层雅间');
  assert.equal(last.location?.displayName, '二层雅间');
});

test('对话行：情绪映射 + 行首标签前缀归一', () => {
  const { lines } = parseFloor(MOCK_FLOOR_WITH_CONTENT);
  const tagged = lines.find((l) => l.text.includes('三条街外就听见了'));
  assert.ok(tagged, '未解析出行首带标签的对话');
  assert.equal(tagged.type, 'dialog');
  assert.equal(tagged.speaker, '青梧');
  assert.equal(tagged.emotion, 'calm');
});

test('玩家别名归一：我 与 <user> 都归到 <user>', () => {
  const { lines } = parseFloor(MOCK_FLOOR_WITH_CONTENT);
  const mine = lines.filter((l) => l.speaker === '<user>');
  assert.ok(mine.some((l) => l.text === '我只是路过。'), '我: 未归一');
  assert.ok(mine.some((l) => l.text === '我来还昨天的伞。'), '<user>: 未归一');
});

test('坑 2：旁白里的引号台词不得被误认成对话', () => {
  // 用坏样本测这条：好样本（夹具）里不许出现越界旁白，否则等于拿坏样本证明系统好
  const { lines } = parseFloor(BROKEN_FLOOR_NARRATOR_DRIFT);
  const n = lines.find((l) => l.text.includes('我什么都没看见'));
  assert.ok(n, '该行丢失');
  assert.equal(n.type, 'narrator');
  assert.equal(n.speaker, undefined);
});

test('好样本（夹具）里不得出现越界旁白——旁白只有客观描写', () => {
  // 夹具是「AI 正确输出长什么样」的活样本。这条断言防止以后有人往夹具里
  // 顺手塞一行带引号的旁白，把坏示范当标准示范。
  for (const [name, floor] of [
    ['MOCK_FLOOR_WITH_CONTENT', MOCK_FLOOR_WITH_CONTENT],
    ['MOCK_FLOOR_NO_CONTENT', MOCK_FLOOR_NO_CONTENT],
  ] as const) {
    const { lines } = parseFloor(floor);
    const bad = lines.filter((l) => l.suspectNarrator);
    assert.deepEqual(
      bad.map((l) => l.text),
      [],
      `${name} 的旁白里混进了引号台词`,
    );
  }
  // 旁白里也不该出现任何成对引号包裹的台词形态
  const { lines } = parseFloor(MOCK_FLOOR_WITH_CONTENT);
  const quoted = lines.filter((l) => l.type === 'narrator' && /["“”]/.test(l.text.split('。')[0]));
  assert.deepEqual(quoted.map((l) => l.text), [], '旁白句子里出现了引号');
});

test('旁白越界可观测：suspectNarrator 标记坏样本，但不改变它的判定', () => {
  const { lines } = parseFloor(BROKEN_FLOOR_NARRATOR_DRIFT);
  const bad = lines.filter((l) => l.suspectNarrator);
  assert.equal(bad.length, 1, '越界旁白未被标记');
  assert.equal(bad[0].type, 'narrator', '标记不得改变行类型');
  assert.ok(bad[0].text.includes('我什么都没看见'));

  // 合规的对话行不该被误标
  const clean = lines.find((l) => l.text.includes('船到了'));
  assert.equal(clean?.type, 'dialog');
  assert.notEqual(clean?.suspectNarrator, true, '正常对话行被误标为越界旁白');
});

test('情绪标签可见性：emotionTagged 区分「作者写了方括号」与「默认值兜底」', () => {
  const { lines } = parseFloor(MOCK_FLOOR_WITH_CONTENT);

  // 作者写了方括号的对话行（[人物:青梧][平静]:"…" 经行首标签归一后仍是显式标注）
  const tagged = lines.find((l) => l.text.includes('三条街外就听见了'));
  assert.equal(tagged?.emotionTagged, true);
  assert.equal(tagged?.emotion, 'calm');

  // 玩家行「我[平静]:"…"」——别名归一成 <user>，但方括号是实打实写了的
  const mineTagged = lines.find((l) => l.text === '我只是路过。');
  assert.equal(mineTagged?.speaker, '<user>');
  assert.equal(mineTagged?.emotionTagged, true, '写了 [平静] 的玩家行被当成没标注');
  assert.equal(mineTagged?.emotion, 'calm');

  // 玩家行「<user>:"…"」——协议允许省略方括号，此时是默认值兜底，不是作者写的
  const mineBare = lines.find((l) => l.text === '我来还昨天的伞。');
  assert.equal(mineBare?.speaker, '<user>');
  assert.equal(mineBare?.emotionTagged, false, '免方括号的玩家行被当成显式标注了情绪');
  assert.equal(mineBare?.emotion, 'calm', '免方括号的玩家行仍应拿到默认情绪');

  // 旁白行永远没有情绪
  const narrator = lines.find((l) => l.type === 'narrator');
  assert.equal(narrator?.emotionTagged, false);

  // 思考行带方括号
  const thought = lines.find((l) => l.type === 'thought');
  assert.equal(thought?.emotionTagged, true);
});

test('未知情绪 fallback 默认情绪，不抛错', () => {
  const { lines } = parseFloor(MOCK_FLOOR_WITH_CONTENT);
  const l = lines.find((x) => x.text.includes('你最好忘掉'));
  assert.equal(l?.emotion, 'calm');
});

test('思考行：type=thought，且包裹星号已被剥掉', () => {
  const { lines } = parseFloor(MOCK_FLOOR_WITH_CONTENT);
  const t = lines.find((l) => l.type === 'thought');
  assert.ok(t, '未解析出思考行');
  assert.equal(t.speaker, '<user>');
  assert.ok(!t.text.startsWith('*'), '前星号残留');
  assert.ok(!t.text.endsWith('*'), '后星号残留');
});

test('未知情绪 fallback 默认情绪，不抛错', () => {
  const { lines } = parseFloor(MOCK_FLOOR_WITH_CONTENT);
  const l = lines.find((x) => x.text.includes('你最好忘掉'));
  assert.equal(l?.emotion, 'calm');
});

test('选项三路并取：<options> 内的 > - • 三种前缀都认', () => {
  const { options } = parseFloor(MOCK_FLOOR_WITH_CONTENT);
  assert.deepEqual(options, [
    '顺着她的话，把昨天忘掉',
    '追问昨天到底发生了什么',
    '把伞放下就走',
  ]);
});

test('选项内容不得泄漏成旁白行', () => {
  const { lines } = parseFloor(MOCK_FLOOR_WITH_CONTENT);
  const all = joinedText(lines);
  assert.ok(!all.includes('顺着她的话'));
  assert.ok(!all.includes('<options>'));
});

test('降级路径：无 <content> 时全文视为剧本，usedContentTag=false', () => {
  const { lines, usedContentTag } = parseFloor(MOCK_FLOOR_NO_CONTENT);
  assert.equal(usedContentTag, false);
  const all = joinedText(lines);
  assert.ok(all.includes('风停了'), '降级后正文丢失');
  assert.ok(!all.includes('忘了包 content'), '思维链未剥离');
  assert.ok(lines.some((l) => l.type === 'dialog' && l.speaker === '青梧'));
});

test('降级路径的已知代价：变量块会混入正文（故参考实现强制 <content>）', () => {
  const { lines } = parseFloor(MOCK_FLOOR_NO_CONTENT);
  assert.ok(joinedText(lines).includes('JSONPatch'), '预期中的混入消失了，降级行为可能已变更');
});

test('降级路径：多个独立 <choice> 去重', () => {
  const { options } = parseFloor(MOCK_FLOOR_NO_CONTENT);
  assert.deepEqual(options, ['上船', '留在岸边']);
});

test('协议边界：缺 [情绪] 方括号的 名字:"台词" 必须落进旁白', () => {
  // [情绪] 方括号不是装饰，它是阻止"旁白里的引号台词被误认成对话"的唯一闸门——
  // 放宽这一条，坑 2 立刻复现。此处把它钉死，防以后有人"顺手兼容一下"。
  const { lines } = parseFloor(BROKEN_FLOOR_MISSING_EMOTION);

  // 前两行缺方括号 → 落进旁白；第三行写对了 → 正常对话
  assert.equal(lines.length, 3);
  assert.equal(lines[0].type, 'narrator', '缺方括号的 我:"…" 被误判为对话');
  assert.equal(lines[1].type, 'narrator', '缺方括号的 青梧:"…" 被误判为对话');
  assert.equal(lines[2].type, 'dialog', '写了方括号的行反而没被识别成对话');
  assert.equal(lines[2].speaker, '青梧');

  // 落进旁白的两行应当被标记为越界（可观测），好行不受牵连
  assert.equal(lines.filter((l) => l.suspectNarrator).length, 2);
  assert.equal(lines.find((l) => l.text.includes('这次写对了'))?.suspectNarrator, undefined);
});

test('emotionLabel：情绪 key 转中文显示名，未知 key 原样回显', () => {
  assert.equal(emotionLabel('calm'), '平静');
  assert.equal(emotionLabel('smile'), '微笑');
  assert.equal(emotionLabel('helpless'), '无奈');
  assert.equal(emotionLabel(undefined), '平静', '缺失时回退默认情绪的中文名');
  assert.equal(emotionLabel('brand_new_key'), 'brand_new_key', '未知 key 不得抛错');
});

test('协议边界：<content> 块外的选项不得被采纳', () => {
  const raw = ['<content>', '青梧[平静]:"到了。"', '</content>', '<options>', '> 块外选项', '</options>'].join('\n');
  const { options } = parseFloor(raw);
  assert.deepEqual(options, []);
});

test('parseScript 等价于 parseFloor().lines', () => {
  assert.deepEqual(parseScript(MOCK_FLOOR_WITH_CONTENT), parseFloor(MOCK_FLOOR_WITH_CONTENT).lines);
});
