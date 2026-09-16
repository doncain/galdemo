import React, { useMemo, useState } from 'react';
import { PlayScreen } from './components/PlayScreen';
import { parseFloor } from './core/scriptParser';
import { MOCK_FLOOR_STAGE, MOCK_FLOOR_WITH_CONTENT } from './core/fixtures';
import { CHARACTERS, hasSprite } from './core/assets';
import { resolveEmotion } from './core/scriptProtocol';
import { runApiProbe, probeVerdict } from './core/apiProbe';
import type { ProbeResult } from './core/apiProbe';

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

  // API 探针结果。null = 还没跑过（默认），所以默认 DOM 里不出现面板——
  // 这很重要：验收脚本按 data-* 断言，默认态多出一堆文本会污染断言。
  // ?probe=1 可自动跑一次（便于无头验证，也可存成书签）。
  const [probe, setProbe] = useState<ProbeResult | null>(() =>
    readSearch('probe') === '1' ? runApiProbe() : null,
  );

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

        {/* API 探针（S2 交付物，应用内版）。
            做成按钮而不是让人贴 DevTools：它天然跑在正确的 iframe 语境里，
            不存在「选错上下文导致全红误报」的问题。 */}
        <button
          type="button"
          className="gal-devbtn"
          data-minigal="api-probe-btn"
          onClick={() => setProbe(runApiProbe())}
        >
          探 API
        </button>
      </div>

      {probe && <ApiProbePanel result={probe} onClose={() => setProbe(null)} />}
    </div>
  );
}

/**
 * 探针结果面板。
 * 只在点过按钮后渲染 —— 默认态不进入 DOM，避免干扰验收断言。
 */
function ApiProbePanel({ result, onClose }: { result: ProbeResult; onClose: () => void }) {
  const verdict = probeVerdict(result);
  const groups: Array<ProbeResult['rows'][number]['group']> = ['核心函数', '事件常量', 'MVU（可选）'];

  return (
    <div className="gal-probe" data-minigal="api-probe-panel" onClick={(e) => e.stopPropagation()}>
      <div className="gal-probe-head">
        <strong>TavernHelper API 探针</strong>
        <span data-minigal="api-probe-summary">
          iframe={String(result.inIframe)} · {result.present}/{result.total} 存在
        </span>
        <button type="button" onClick={onClose}>
          关闭
        </button>
      </div>

      <div className={'gal-probe-verdict is-' + verdict.level} data-minigal="api-probe-verdict"
        data-level={verdict.level}>
        {verdict.text}
      </div>

      <div className="gal-probe-cols">
        {groups.map((g) => (
          <div key={g} className="gal-probe-col">
            <div className="gal-probe-colhead">{g}</div>
            {result.rows
              .filter((r) => r.group === g)
              .map((r) => (
                <div key={r.label} className={'gal-probe-row' + (r.ok ? ' is-ok' : ' is-miss')}>
                  <span className="gal-probe-mark">{r.ok ? '✓' : '✗'}</span>
                  <span className="gal-probe-label">{r.label}</span>
                  <span className="gal-probe-type">{r.type}</span>
                </div>
              ))}
          </div>
        ))}
      </div>

      <div className="gal-probe-foot">
        只做存在性检查，未调用任何写函数。探针只证明「存在」，不证明「行为正确」。
      </div>
    </div>
  );
}
