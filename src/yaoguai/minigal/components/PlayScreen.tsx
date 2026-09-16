// minigal · PlayScreen（S1 骨架 + S3 演出层）
//
// 职责：把解析好的 ScriptLine[] 一幕一幕演出来。
//   S1：三态文本（旁白/对话/独白）+ 名牌 + 情绪标签 + 翻页 + 选项面板
//   S3：背景 CG 层 + 三槽位立绘舞台（说话人亮、旁听暗、同屏 ≤3）
//
// 层级关系（由 index.css 的 z-index 保证，不靠 DOM 顺序）：
//   z-0  背景图
//   z-5  立绘舞台（pointer-events:none，不能挡住点击翻页）
//   z-10 文本框
//   z-30 场景标签（在文本框之上，因为换景时要压住它）

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PLAYER_SPEAKER, emotionLabel } from '../core/scriptProtocol';
import type { ScriptLine } from '../core/scriptProtocol';
import { sceneOf } from '../core/assets';
import { advanceStage, collectSpriteUrls, replayBackgroundRefTo, replayStageTo, type StageCharacter } from '../core/stage';
import { TypingText } from './TypingText';

/** 每字毫秒；0 = 瞬发。S3 会接成可调档位。 */
const DEFAULT_SPEED_MS = 35;
const PLAYER_LABEL = '我';

interface PlayScreenProps {
  lines: ScriptLine[];
  options: string[];
  /** 覆盖打字速度；0 = 瞬发（自动化验收用） */
  speedMs?: number;
  /** 播放进度上抛，供楼层导航与阅读进度恢复使用（S4） */
  onProgress?: (index: number, total: number) => void;
  /** 选了一个选项。S1 只上抛，S4 接「起草」进输入框 */
  onChoose?: (option: string) => void;
  /** 走到本楼末尾，再点一次。S4 接「翻到下一楼」 */
  onReachEnd?: () => void;
  /** 停在本楼第一行，再往前退。S4 接「翻到上一楼」 */
  onAtStart?: () => void;
  /** 起始行号（0 基）。仅供自动化截图核对各态用。 */
  startIndex?: number;
}

export function PlayScreen({
  lines,
  options,
  speedMs = DEFAULT_SPEED_MS,
  onProgress,
  onChoose,
  onReachEnd,
  onAtStart,
  startIndex = 0,
}: PlayScreenProps) {
  const [index, setIndex] = useState(() =>
    startIndex >= 0 && startIndex < lines.length ? startIndex : 0,
  );
  const [isTyping, setIsTyping] = useState(false);
  const skipRef = useRef(false);

  const line = lines[index];
  const atEnd = index >= lines.length - 1;

  // ── 立绘预加载（踩坑 12）──
  // 必须在**解析完成时立刻**做，而不是「等这一行要显示时再做」。
  // 差分切换时图没下载完 → 会闪一下空白或旧图，这是最刺眼的瑕疵。
  // 用 useMemo 而不是 useEffect：预加载是幂等的，且必须在首次渲染前就发出请求。
  const spriteUrls = useMemo(() => collectSpriteUrls(lines), [lines]);
  useEffect(() => {
    const imgs = spriteUrls.map((url) => {
      const img = new Image();
      img.src = url;
      return img;
    });
    // 组件卸载时取消引用即可，不必 abort（浏览器会自己决定是否继续）
    return () => {
      for (const img of imgs) img.src = '';
    };
  }, [spriteUrls]);

  // ── 舞台状态机 ──
  //
  // 【为什么初始值不是空数组】
  // 舞台是**逐帧累积**的：第 7 行的正确舞台，是第 1~6 行依次演过之后的结果。
  // 如果直接跳到第 7 行却从空台开始，就会看到「第 7 行说话的阿棠独自站在台上」——
  // 前面 6 行建立起来的 cast 全部丢失。这不是纯测试问题：
  // S4 之后玩家从历史楼层点进第 7 行，也会遇到同样的错误画面。
  //
  // 【重放到 startIndex - 1，而不是 startIndex】
  // 这一点很容易搞错。下面的 useEffect 会在挂载后立刻用「当前行」再算一次，
  // 所以重放**只应负责「当前行之前的那些帧」**。若重放到 startIndex，
  // 当前行就会被算两遍；更糟的是第二遍用的 prevLocationPath 是 startIndex-1 的路径，
  // 与已经被重放推到 startIndex 的 prev 状态错配，换景判断会出错。
  //
  // 时序对齐后：重放给出 prev 和 prevLocationPath，effect 给出当前帧。
  // 与「逐帧点击走过来」的路径**完全相同**——这正是我们想要的等价性。
  const initialTarget = Math.min(Math.max(startIndex, 0), Math.max(lines.length - 1, 0));
  const [cast, setCast] = useState<StageCharacter[]>(() => replayStageTo(lines, 0, initialTarget - 1));
  // 重放到 initialTarget-1 之后，「上一帧的场景」就是 initialTarget-1 那一行的场景。
  // 注意 useRef 的初值是直接求值的（没有 lazy 形式），所以这里用变量承接。
  const prevLocationRef = useRef<string | null>(
    initialTarget > 0 ? (lines[initialTarget - 1]?.location?.path ?? null) : null,
  );

  useEffect(() => {
    const locationPath = line?.location?.path ?? null;
    setCast((prev) =>
      advanceStage({ line, prev, prevLocationPath: prevLocationRef.current }),
    );
    prevLocationRef.current = locationPath;
  }, [line]);

  // ── 背景层 ──
  // 关键：查不到场景时**保留上一张背景**（不闪黑）。
  // 用一个 ref 记住「最后一次成功解析到的背景」——AI 写了一个
  // 没有登记的 [scene:不存在/路径] 时，画面应当停在原地，而不是黑一下。
  //
  // 注意与立绘的处理方式不同：立绘是「换景清台」，背景是「换不成就不换」。
  // 这不是不一致，而是因为它们回答的是不同的问题——
  // 立绘回答「这个场景里有谁」，场景换了人当然就走了；
  // 背景回答「这是个什么地方」，认不出来时停在上一处，比黑屏更不打断体验。
  //
  // 【背景也必须重放——与 cast 同理，这里踩过一次】
  // 「保留上一张不动」这个行为依赖「上一张是什么」这个状态。
  // 直接跳到第 N 行时，如果背景只从**当前行**算起，
  // 而当前行的场景恰好查不到，就会以空背景开局 —— 表现为「背景丢了」。
  // 逐帧点过来时看不到这个问题（前几帧已经把 bgRef 喂饱了），
  // 是个只在跳行导航下暴露的缺陷。所以和 cast 一样，从历史重放出来。
  const initialBg = useMemo(() => replayBackgroundRefTo(lines, initialTarget - 1), [lines, initialTarget]);
  const bgRef = useRef<{ url: string; key: string } | null>(initialBg);
  const [bg, setBg] = useState<{ url: string; key: string } | null>(initialBg);

  useEffect(() => {
    const path = line?.location?.path;
    const scene = sceneOf(path);
    if (scene) {
      // 场景变了才换（key 变化触发淡入动画）
      if (bgRef.current?.key !== scene.path) {
        bgRef.current = { url: scene.image, key: scene.path };
        setBg(bgRef.current);
      }
      return;
    }
    // 查不到：不动。bgRef/bg 都保持上一次的值。
    // 首次就查不到（bgRef 为 null）时确实无背景可显示——
    // 这是正确行为：没有场景就画个背景反而是在说谎。
  }, [line]);

  useEffect(() => {
    onProgress?.(index, lines.length);
  }, [index, lines.length, onProgress]);

  const next = useCallback(() => {
    if (isTyping) {
      // 打字中第一次点击 = 跳过，第二次才是下一行
      skipRef.current = true;
      return;
    }
    if (index < lines.length - 1) {
      setIndex((i) => i + 1);
    } else {
      onReachEnd?.();
    }
  }, [isTyping, index, lines.length, onReachEnd]);

  const prev = useCallback(() => {
    if (index > 0) setIndex((i) => i - 1);
    // 已在本楼第一行 → 交回上一层（S4 的「翻到上一楼」）。
    // 不在这里直接改楼号：PlayScreen 只管「楼内怎么走」，
    // 「走到楼层边界之后去哪」是 App 的事。
    else onAtStart?.();
  }, [index, onAtStart]);

  // 键盘：Enter / Space / → 前进，← 回退（输入框聚焦时不抢）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prev();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev]);

  if (!line) {
    return (
      <div className="gal-root">
        <div className="gal-empty">
          本楼没有可播内容。
          <br />
          检查 AI 输出是否包含 &lt;content&gt; 正文块。
        </div>
      </div>
    );
  }

  const showOptions = atEnd && options.length > 0;
  const speakerLabel = line.speaker === PLAYER_SPEAKER ? PLAYER_LABEL : line.speaker;
  const scenePath = line.location?.path;
  // 有立绘在场时给文本框加实底（CSS 里 .has-cast .gal-textbox）：
  // 立绘挡在文本框后面，浅色立绘配浅色文字会糊。
  const hasVisibleCast = cast.some((c) => !c.hidden);

  return (
    <div
      className={'gal-root' + (hasVisibleCast ? ' has-cast' : '')}
      onClick={showOptions ? undefined : next}
    >
      {/* ── 背景层（z-0）──
          key 用场景路径：key 变化 = React 重建节点 = CSS 动画重新触发，
          于是每次换景都有一次淡入。同一个场景内翻页不会重放动画。 */}
      {bg && (
        <img
          key={bg.key}
          className="gal-bg"
          src={bg.url}
          alt=""
          data-minigal="bg"
          data-scene={bg.key}
        />
      )}

      {/* ── 立绘舞台（z-5）──
          旁听者不 hidden 但 isActive=false → 用 CSS 变暗，而不是不上台。
          hidden=true 才 opacity:0（旁白/玩家行全员暂退）。
          注意 DOM 保留：暂退的人仍然在 DOM 里，这是「位置记忆」能生效的前提。 */}
      <div className="gal-stage" data-minigal="stage" data-cast-count={cast.length}>
        {cast.map((c) => (
          <div
            key={c.speaker}
            className={
              'gal-sprite pos-' +
              c.position +
              (c.hidden ? ' is-hidden' : '') +
              (c.isActive ? ' is-active' : ' is-idle')
            }
            data-minigal="sprite"
            data-speaker={c.speaker}
            data-position={c.position}
            data-active={c.isActive ? '1' : '0'}
            data-hidden={c.hidden ? '1' : '0'}
            data-emotion-key={c.emotionKey}
            data-resolved-key={c.resolvedKey}
            data-fallback={c.resolvedFallback ? '1' : '0'}
          >
            {c.sprite && <img src={c.sprite} alt={c.speaker} />}
          </div>
        ))}
      </div>

      {/* 场景标签（z-30） */}
      {line.location && (
        <div className="gal-place" data-minigal="place">
          {line.location.displayName}
          {scenePath && !bgKeyMatches(bg?.key, scenePath) && (
            // 背景没跟上场景时明示出来：AI 写了一个没登记的场景路径。
            // 不静默——否则作者会以为「背景功能坏了」。
            <span className="gal-place-warn" data-minigal="bg-missing"
              title="这个场景路径在 assets.ts 的 SCENES 里查不到，背景保持上一张">
              无背景
            </span>
          )}
        </div>
      )}

      <div className="gal-textbox">
        {line.speaker && (
          <div className={'gal-name' + (line.speaker === PLAYER_SPEAKER ? ' gal-name-user' : '')}>
            <span className="gal-name-text">{speakerLabel}</span>
            {line.emotion && (
              <span
                className={
                  'gal-emotion' +
                  (line.emotionTagged ? '' : ' gal-emotion-default') +
                  (line.type === 'thought' ? ' gal-emotion-thought' : '')
                }
                data-minigal="emotion"
                data-emotion={line.emotion}
                data-emotion-tagged={line.emotionTagged ? '1' : '0'}
                title={line.emotionTagged ? '作者标注的情绪' : '未标注，按默认情绪处理'}
              >
                {emotionLabel(line.emotion)}
              </span>
            )}
          </div>
        )}

        {line.type === 'narrator' && line.suspectNarrator && (
          // 旁白应当是纯客观描写。这一行以 角色名:"…" 的形状出现却没有 [情绪] 方括号，
          // 按协议只能落进旁白——但不该让它静静地冒充好输出。此处明示异常，
          // 供作者回头修 AI 的世界书格式条目。
          <div
            className="gal-narrator-warn"
            data-minigal="narrator-drift"
            title="旁白里出现了台词形态的引语：给这一行补上 [情绪] 方括号，它就会变成正常的对话行"
          >
            旁白越界：这一行像是台词但没有 [情绪] 方括号，已按旁白播放
          </div>
        )}

        <TypingText
          key={index}
          text={line.text}
          speedMs={speedMs}
          lineType={line.type}
          suspect={line.suspectNarrator}
          onTypingStateChange={setIsTyping}
          skipRef={skipRef}
        />

        {showOptions && (
          <div className="gal-options">
            {options.map((opt, i) => (
              <button
                key={opt}
                type="button"
                className="gal-option"
                onClick={(e) => {
                  e.stopPropagation();
                  onChoose?.(opt);
                }}
              >
                <span className="gal-option-key">{i + 1}</span>
                {opt}
              </button>
            ))}
          </div>
        )}

        <div className="gal-foot">
          <span className="gal-hint">
            {showOptions ? '选择一个行动' : '点击继续'}
          </span>
          <span data-minigal="progress">
            {index + 1} / {lines.length}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * 背景是否与当前场景相符。
 *
 * 为什么需要它：背景「查不到就保留旧图」的行为会让「作者写错了场景路径」
 * 完全静默——画面看着正常（有个背景），但其实是上一个场景的。
 * 这个函数让界面能区分「背景是对的」与「背景是上一张残留的」，
 * 从而显示「无背景」提示。
 */
function bgKeyMatches(bgKey: string | undefined, scenePath: string): boolean {
  if (!bgKey) return false;
  // 背景 key 是「查表命中的那个场景路径」，可能比 scenePath 短（逐级回退命中）
  return scenePath === bgKey || scenePath.startsWith(bgKey + '/');
}
