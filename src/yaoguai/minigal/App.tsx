import React, { useMemo, useState } from 'react';
import { PlayScreen } from './components/PlayScreen';
import { parseFloor } from './core/scriptParser';
import { MOCK_FLOOR_STAGE, MOCK_FLOOR_WITH_CONTENT } from './core/fixtures';
import { CHARACTERS, hasSprite } from './core/assets';
import { resolveEmotion } from './core/scriptProtocol';

// 降级夹具 = 把严格夹具的 <content> 标签摘掉，其余原样。
// 这样「切换严格 / 降级」对比的是同一条故事，差异只来自协议边界。
const MOCK_FLOOR_DEGRADED = MOCK_FLOOR_WITH_CONTENT.replace(/<\/?content>/g, '');

/** 夹具档位。?fixture=stage 切换，默认 S1 夹具。 */
const FIXTURES: Record<string, { text: string; label: string }> = {
  s1: { text: MOCK_FLOOR_WITH_CONTENT, label: 'S1 夹具（协议边界）' },
  stage: { text: MOCK_FLOOR_STAGE, label: 'S3 夹具（立绘舞台）' },
};

/**
 * 浏览器裸跑用的楼层文本。
 *
 * 接入酒馆后，这里换成 getChatMessages(楼层号)[0].message（S4）。
 * 在那之前，换楼层文本有三条路：
 *   1. URL 参数 ?floor=<encodeURIComponent(楼层文本)>  —— 供无头浏览器自动化验收
 *   2. URL 参数 ?fixture=s1|stage                        —— 切换内置夹具
 *   3. 右下角开发条的「严格 / 降级」切换
 *
 * 附：?instant=1 关闭打字动画。
 * 无头浏览器用虚拟时间跑，requestAnimationFrame 与 performance.now() 不同步，
 * 打字会永远走不完——自动化验收需要能拿到「完整画面」，所以必须有这个开关。
 * ?line=N 直接落在第 N 行（1 基），供逐态截图核对。
 */
function readSearch(key: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(key);
}

export default function App() {
  const fixtureKey = readSearch('fixture') ?? 's1';
  const fixture = FIXTURES[fixtureKey] ?? FIXTURES.s1;

  const [floorText, setFloorText] = useState<string>(() => readSearch('floor') ?? fixture.text);

  const parsed = useMemo(() => parseFloor(floorText), [floorText]);
  const [index, setIndex] = useState(0);

  const hasContent = parsed.lines.length > 0;
  const strictMode = parsed.usedContentTag;
  const drifted = parsed.lines.filter((l) => l.suspectNarrator).length;
  const instant = readSearch('instant') === '1';
  const startLine = Math.max(0, (Number(readSearch('line')) || 1) - 1);

  // 立绘相关统计：让「有几行会上台」「有几行缺图」在开发条上一眼可见。
  // 缺图的行不是错误（未登记角色本就没有立绘），但作者需要知道。
  const stageRows = parsed.lines.filter((l) => l.speaker && l.type !== 'narrator' && l.speaker !== '<user>').length;
  const spritedRows = parsed.lines.filter((l) => l.sprite).length;
  // 差分回退次数：有情绪方括号、但该角色没有这张差分 → 实际用了 calm。
  const fallbackRows = parsed.lines.filter((l) => {
    if (!l.speaker || !l.sprite) return false;
    const key = resolveEmotion(l.emotion);
    return !hasSprite(l.speaker, key);
  }).length;
  const unknownSpeakers = [
    ...new Set(
      parsed.lines
        .filter((l) => l.speaker && l.type !== 'narrator' && l.speaker !== '<user>' && !l.sprite)
        .map((l) => l.speaker as string),
    ),
  ];

  return (
    <div className="gal-app">
      <div className="gal-floor-tag" data-minigal="source">
        {strictMode ? '严格 content 路径' : '降级路径（未找到 content）'}
      </div>

      <PlayScreen
        key={floorText + ':' + startLine}
        lines={parsed.lines}
        options={parsed.options}
        speedMs={instant ? 0 : undefined}
        startIndex={startLine}
        onProgress={(i) => setIndex(i)}
      />

      <div className="gal-devbar">
        <span data-minigal="devbar-state">
          已解析 {parsed.lines.length} 行
          {parsed.options.length > 0 ? ` · ${parsed.options.length} 个选项` : ''}
          {hasContent ? ` · 第 ${index + 1} 行` : ''}
          {drifted > 0 ? ` · 旁白越界 ${drifted} 行` : ''}
        </span>

        {/* 舞台统计（S3）：把「谁会上台 / 谁缺图 / 谁用了兜底差分」摆出来。
            这些信息只看截图是看不出的——缺图的行和差分回退的行，
            画面都"正常"，只有对照 assets.ts 才知道对不对。 */}
        <span data-minigal="devbar-stage">
          夹具 {fixtureKey} · 上台行 {stageRows}/{spritedRows} 有立绘
          {fallbackRows > 0 ? ` · 差分回退 ${fallbackRows} 行` : ''}
          {unknownSpeakers.length > 0 ? ` · 未登记 ${unknownSpeakers.join('/')}` : ''}
          {` · 角色表 ${CHARACTERS.length}`}
        </span>

        <button
          type="button"
          className="gal-devbtn"
          data-minigal="toggle-source"
          onClick={() => {
            setFloorText(() => (strictMode ? MOCK_FLOOR_DEGRADED : MOCK_FLOOR_WITH_CONTENT));
            setIndex(0);
          }}
        >
          切换严格 / 降级
        </button>
      </div>
    </div>
  );
}
