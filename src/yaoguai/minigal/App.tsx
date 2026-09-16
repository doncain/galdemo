import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PlayScreen } from './components/PlayScreen';
import { parseFloor } from './core/scriptParser';
import { MOCK_FLOOR_STAGE, MOCK_FLOOR_WITH_CONTENT } from './core/fixtures';
import { CHARACTERS, hasSprite } from './core/assets';
import { resolveEmotion } from './core/scriptProtocol';
import { runApiProbe, probeVerdict } from './core/apiProbe';
import type { ProbeResult } from './core/apiProbe';
import { hasTavern, getMessages, slash, onEvent, TE, IE, STORY_UPDATED } from './core/tavern';
import { getAssistantFloors, getLatestAssistantId, floorMessage } from './core/floors';
import { deleteFloors, regenerateCurrentFloor } from './core/tavernOps';
import { VariablesView } from './components/VariablesView';
import {
  enterFullscreen,
  exitFullscreen,
  diagnoseSize,
  startSizeGuard,
  type GuardHandle,
  type SizeDiag,
} from './core/fullscreen';

// 降级夹具 = 把严格夹具的 <content> 标签摘掉，其余原样。
// 这样「切换严格 / 降级」对比的是同一条故事，差异只来自协议边界。
const MOCK_FLOOR_DEGRADED = MOCK_FLOOR_WITH_CONTENT.replace(/<\/?content>/g, '');

/** 夹具档位。?fixture=stage 切换，默认 S1 夹具。 */
const FIXTURES: Record<string, { text: string; label: string }> = {
  s1: { text: MOCK_FLOOR_WITH_CONTENT, label: 'S1 夹具（协议边界）' },
  stage: { text: MOCK_FLOOR_STAGE, label: 'S3 夹具（立绘舞台）' },
};

function readSearch(key: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(key);
}

/**
 * 便宜的内容指纹，只用来判断「这一楼的内容是不是变了」。
 *
 * 为什么需要它：PlayScreen 用 React 的 key 控制重挂载——
 *   换楼 → 要重挂载（回到那一楼上次读到的位置）
 *   内容变了（重生成）→ 要重挂载（从头读）
 *   只是翻页 → 绝对不能重挂载（否则每翻一页都重置）
 * 所以 key 里必须包含「内容指纹」，而不是「当前读到的行号」。
 *
 * 用长度 + djb2 就够了：碰撞概率极低，而代价是 O(n) 一次。
 */
function contentFingerprint(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

export default function App() {
  const floorParam = readSearch('floor');
  const fixtureKey = readSearch('fixture') ?? 's1';
  const fixture = FIXTURES[fixtureKey] ?? FIXTURES.s1;
  const lineParam = readSearch('line');
  const instant = readSearch('instant') === '1';

  // 夹具文本可以被开发条的「切换严格/降级」改写
  const [fixtureText, setFixtureText] = useState<string>(fixture.text);

  // ── 楼层状态（S4 三态机）──
  //   viewingFloorId = null  → 跟随最新楼（默认）
  //   viewingFloorId = 数字  → 钉在历史某楼（回看）
  const [viewingFloorId, setViewingFloorId] = useState<number | null>(null);
  const [lastAssistantFloorId, setLastAssistantFloorId] = useState<number | null>(null);
  const [generatingFloorId, setGeneratingFloorId] = useState<number | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [floors, setFloors] = useState<number[]>([]);

  // 事件回调里要读最新的 isGenerating，但订阅只注册一次（空依赖）——
  // 用 ref 打通，避免「每次生成都重新订阅一遍事件」。
  const isGenRef = useRef(false);
  isGenRef.current = isGenerating;

  // 楼层内容变化时用来驱动 rawMessage 重算。
  // 为什么用一个计数器而不是把内容存进 state：内容可能很长，
  // 而每次要读的都是「此刻的真实内容」，没必要在 state 里留一份副本。
  const [floorTick, setFloorTick] = useState(0);

  /** 当前应当显示的楼号：钉住的历史楼优先，否则跟随最新 AI 楼 */
  const targetFloorId = viewingFloorId ?? lastAssistantFloorId;

  /**
   * 楼层文本来源（优先级从高到低）：
   *   ① ?floor=   —— 显式覆盖，供无头验收 / 本地预览工具用
   *   ② 酒馆楼层  —— 真机下的正常路径
   *   ③ 内置夹具  —— 浏览器裸跑时的兜底，保证界面不空
   */
  const sourceKind: 'url' | 'tavern' | 'fixture' = floorParam != null ? 'url' : hasTavern ? 'tavern' : 'fixture';

  const rawMessage = useMemo(() => {
    if (sourceKind === 'url') return floorParam ?? '';
    if (sourceKind === 'tavern') return floorMessage(targetFloorId) ?? '';
    return fixtureText;
    // floorTick 是刻意的依赖：楼层被重生成时内容变了，但 targetFloorId
    // 可能没变，必须靠这个计数器把重算推起来。
  }, [sourceKind, floorParam, targetFloorId, fixtureText, floorTick]);

  const parsed = useMemo(() => parseFloor(rawMessage), [rawMessage]);

  // ── 按楼阅读进度 ──
  // 楼号 → 读到第几行（0 基）。换楼时恢复；只有「同一楼内容真的变了」才清零。
  const progressRef = useRef<Map<number, number>>(new Map());
  const lastParseRef = useRef<{ key: string; content: string }>({ key: '', content: '' });

  /** 当前楼的标识：URL/夹具模式下用固定串，避免跨楼串味 */
  const sourceKey = sourceKind === 'tavern' ? `tavern:${targetFloorId ?? 'none'}` : `${sourceKind}:${fixtureKey}`;
  const contentKey = useMemo(() => `${sourceKey}#${contentFingerprint(rawMessage)}`, [sourceKey, rawMessage]);

  useEffect(() => {
    const prev = lastParseRef.current;
    const sameFloor = prev.key === sourceKey;
    const contentChanged = prev.content !== rawMessage;
    // 同一楼的内容变了（重生成）→ 这一楼的进度作废，从头读（踩坑 17）
    if (sameFloor && contentChanged && targetFloorId != null) {
      progressRef.current.delete(targetFloorId);
    }
    lastParseRef.current = { key: sourceKey, content: rawMessage };
  }, [sourceKey, rawMessage, targetFloorId]);

  // ── 楼层数据同步 ──
  //
  // 抽成 useCallback 而不是写在 effect 里：删楼 / 重roll 之后要**主动**同步一次。
  // 不能只依赖事件 —— 某些宿主环境里 eventEmit 未必回灌到同一个窗口，
  // 那时界面就停在旧状态，而且完全没有报错。
  const syncFloors = useCallback(() => {
    const latestId = getLatestAssistantId();
    const list = getAssistantFloors();
    if (latestId != null) {
      if (isGenRef.current) {
        // 生成中：只把「生成楼」往后推，不动正在看的画面
        setGeneratingFloorId((p) => (p != null && latestId <= p ? p : latestId));
      } else {
        setLastAssistantFloorId(latestId);
      }
    }
    setFloors(list);
    // ★ 删楼之后，被钉住的历史楼可能已经不存在了。
    // 不归位就会去读一个不存在的楼层 → 拿到空文本 → 整片画面空白，
    // 而用户看不出原因（只会觉得「删了一楼之后界面就坏了」）。
    setViewingFloorId((v) => (v != null && !list.includes(v) ? null : v));
    setFloorTick((t) => t + 1); // 内容可能变了，推动重算
  }, []);

  useEffect(() => {
    if (!hasTavern) return;
    syncFloors();
    const offs = [
      onEvent(TE.MESSAGE_RECEIVED, syncFloors),
      onEvent(TE.MESSAGE_UPDATED, syncFloors),
      // 生成结束事件后延迟一点再同步：消息落库与事件触发之间有窗口，
      // 立刻读可能拿到还没写完的楼层。
      onEvent(IE.GENERATION_ENDED, () => window.setTimeout(syncFloors, 300)),
      // 本项目的自定义事件：删楼 / 重roll 之后由操作层发出（坑 24）。
      // 用它而不是 location.reload() —— reload 会退出全屏、丢全部前端状态。
      onEvent(STORY_UPDATED, syncFloors),
      onEvent(TE.CHAT_CHANGED, () => {
        // 换聊天：进度作废、回到跟随最新
        progressRef.current.clear();
        setViewingFloorId(null);
        syncFloors();
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [syncFloors]);

  // ── 生成锁 ──
  // 成对调用：startGenerating 钉住当前画面，finishGenerating 解锁并跳回最新。
  // 只用其中一个 = 界面要么卡死在旧楼、要么生成中乱跳。
  const startGenerating = useCallback(() => {
    setViewingFloorId((v) => v ?? lastAssistantFloorId);
    setIsGenerating(true);
  }, [lastAssistantFloorId]);

  const finishGenerating = useCallback(() => {
    setIsGenerating(false);
    const latest = getLatestAssistantId();
    if (latest != null) {
      setGeneratingFloorId(latest);
      setLastAssistantFloorId(latest);
    }
    setViewingFloorId(null); // ★ 归位 null = 自动跟随最新楼
    setFloorTick((t) => t + 1);
  }, []);

  // ── 楼层导航 ──
  // 生成中只允许翻到「生成楼之前」：新楼正在生成，翻过去会看到半截内容。
  const availableFloors = useMemo(
    () => (isGenerating && generatingFloorId != null ? floors.filter((f) => f < generatingFloorId) : floors),
    [floors, isGenerating, generatingFloorId],
  );
  const navIndex = targetFloorId != null ? availableFloors.indexOf(targetFloorId) : -1;
  const canPrevFloor = navIndex > 0;
  const canNextFloor = navIndex >= 0 && navIndex < availableFloors.length - 1;

  const goNextFloor = useCallback(() => {
    if (!(navIndex >= 0 && navIndex < availableFloors.length - 1)) return;
    // 走到最后一楼就归位，重新「跟随最新」（这样后续新楼会自动跟上来）
    if (navIndex + 1 === availableFloors.length - 1) setViewingFloorId(null);
    else setViewingFloorId(availableFloors[navIndex + 1]);
  }, [navIndex, availableFloors]);

  const goPrevFloor = useCallback(() => {
    if (navIndex > 0) setViewingFloorId(availableFloors[navIndex - 1]);
  }, [navIndex, availableFloors]);

  // ── 发送 ──
  const [inputText, setInputText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const handleSend = useCallback(async () => {
    const trimmed = inputText.trim();
    if (!trimmed || isGenerating) return;
    setInputText('');
    if (!hasTavern) {
      setNotice('本地预览模式：没有酒馆环境，发送不可用。真机里才能真的发送。');
      return;
    }
    setNotice(null);
    startGenerating();
    try {
      if (!(await slash('/send ' + trimmed))) {
        setNotice('发送失败：酒馆没有响应 /send。');
        return;
      }
      // ★ 必须 await 到生成结束。不等的话 finishGenerating 会在生成刚开始时
      // 就执行，锁等于没有——画面会在 AI 还在写的时候就开始乱跳。
      await slash('/trigger await=true');
    } finally {
      // 无论成功失败都解锁，否则一次异常会让界面永久卡在「生成中」。
      finishGenerating();
    }
  }, [inputText, isGenerating, startGenerating, finishGenerating]);

  // ── S5：变量面板 / 重roll 本楼 / 删本楼 ──
  const [varsOpen, setVarsOpen] = useState(false);

  // 删楼用**站内确认条**，不用 window.confirm。两条理由：
  //   · iframe 里原生对话框可能被沙箱策略拦掉 —— 表现是「点了删楼没反应」，
  //     而且看不出原因；
  //   · 原生对话框无法被自动化验收驱动，删楼这条路就成了「永远验不到」。
  // 站内确认条还能顺手把「删哪一楼」写清楚。
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);

  const handleRegen = useCallback(async () => {
    if (isGenerating) return;
    setNotice(null);
    startGenerating();
    try {
      const r = await regenerateCurrentFloor();
      setNotice(r.ok ? `重roll 完成：${r.detail ?? ''}` : `重roll 未完成：${r.error ?? ''}`);
    } finally {
      // ★ 与发送同理：无论成败都要解锁，否则一次异常就让界面永久卡在「生成中」
      finishGenerating();
    }
  }, [isGenerating, startGenerating, finishGenerating]);

  const handleConfirmDelete = useCallback(async () => {
    const t = pendingDelete;
    setPendingDelete(null);
    if (t == null) return;
    setNotice(null);
    const r = await deleteFloors(t, t);
    if (!r.ok) {
      setNotice(`删楼未完成：${r.error ?? ''}`);
      return;
    }
    // 事件未必回灌到本窗口（见 syncFloors 的注释），这里主动同步一次
    syncFloors();
  }, [pendingDelete, syncFloors]);

  // ── 行内导航（PlayScreen 内部走，到头/到首时交回这里翻楼）──
  const onAtStart = useCallback(() => goPrevFloor(), [goPrevFloor]);
  const onReachEnd = useCallback(() => goNextFloor(), [goNextFloor]);

  // ── 阅读进度读写 ──
  const savedIndex = useMemo(() => {
    if (lineParam != null) return Math.max(0, (Number(lineParam) || 1) - 1);
    if (targetFloorId == null) return 0;
    return progressRef.current.get(targetFloorId) ?? 0;
    // contentKey 参与依赖：换楼/换内容时重新取一次
  }, [lineParam, targetFloorId, contentKey]);

  const handleProgress = useCallback(
    (i: number) => {
      if (targetFloorId != null) progressRef.current.set(targetFloorId, i);
      setIndexMirror(i);
    },
    [targetFloorId],
  );
  // 开发条要显示当前行号，所以行号也需要一个 state 副本
  const [indexMirror, setIndexMirror] = useState(0);

  // ── 探针 / 尺寸守卫（S2、S6）──
  const [probe, setProbe] = useState<ProbeResult | null>(() =>
    readSearch('probe') === '1' ? runApiProbe() : null,
  );
  const guardRef = useRef<GuardHandle | null>(null);
  const [isFs, setIsFs] = useState(false);
  const [sizeDiag, setSizeDiag] = useState<SizeDiag | null>(null);

  useEffect(() => {
    guardRef.current = startSizeGuard(false);
    const sample = () => setSizeDiag(diagnoseSize());
    sample();
    const timers = [300, 1200, 2500].map((t) => window.setTimeout(sample, t));
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      guardRef.current?.destroy();
      guardRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onFsChange = async () => {
      if (!document.fullscreenElement && isFs) {
        await exitFullscreen(() => guardRef.current?.burst());
        setIsFs(false);
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, [isFs]);

  // ── 开发条统计 ──
  const strictMode = parsed.usedContentTag;
  const drifted = parsed.lines.filter((l) => l.suspectNarrator).length;
  const stageRows = parsed.lines.filter((l) => l.speaker && l.type !== 'narrator' && l.speaker !== '<user>').length;
  const spritedRows = parsed.lines.filter((l) => l.sprite).length;
  const fallbackRows = parsed.lines.filter((l) => {
    if (!l.speaker || !l.sprite) return false;
    return !hasSprite(l.speaker, resolveEmotion(l.emotion));
  }).length;
  const unknownSpeakers = [
    ...new Set(
      parsed.lines
        .filter((l) => l.speaker && l.type !== 'narrator' && l.speaker !== '<user>' && !l.sprite)
        .map((l) => l.speaker as string),
    ),
  ];

  const sourceLabel =
    sourceKind === 'tavern'
      ? `酒馆 第${targetFloorId ?? '?'}楼`
      : sourceKind === 'url'
        ? 'URL 指定文本'
        : `夹具 ${fixtureKey}`;

  const floorOrdinal = targetFloorId != null && floors.indexOf(targetFloorId) >= 0 ? floors.indexOf(targetFloorId) + 1 : null;

  // ── 底部堆叠高度 → CSS 变量 ──
  // 底部三块（提示条 / 输入栏 / 开发条）装在一个 flex 列里，高度由内容决定。
  // 文本框必须知道这个总高才能让位：写死一个数字是猜的 ——
  // 提示条一出现、输入框换行长高，就会盖住「点击继续」和进度。
  const appRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const applyBottomHeight = useCallback(() => {
    const host = appRef.current;
    const stack = bottomRef.current;
    if (!host || !stack) return;
    host.style.setProperty('--gal-bottom-h', `${Math.round(stack.getBoundingClientRect().height)}px`);
  }, []);

  useEffect(() => {
    applyBottomHeight();
    const stack = bottomRef.current;
    // ResizeObserver 覆盖「不来自 React 状态」的高度变化：字体加载完成、
    // 文字换行等。窗口尺寸变化则单独监听。
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(applyBottomHeight) : null;
    if (stack) ro?.observe(stack);
    window.addEventListener('resize', applyBottomHeight);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', applyBottomHeight);
    };
  }, [applyBottomHeight]);

  // ★ 不能只靠 ResizeObserver。
  // 实测探针：在 headless + --virtual-time-budget 下，ResizeObserver 与
  // requestAnimationFrame **都 0 次触发**（真浏览器正常）。这意味着
  // 「文本框让位」这条功能无法被自动化验收覆盖到，同时也说明：
  // 把一项必要能力完全押在异步观察者上是不必要的风险。
  // 而底部堆叠的高度变化几乎都来自这两个状态（提示条出现/消失、生成中），
  // 所以用一条确定性路径兜住它们 —— 不依赖任何观察者。
  useEffect(() => {
    applyBottomHeight();
  }, [applyBottomHeight, notice, isGenerating]);

  return (
    // 底部堆叠的高度通过 --gal-bottom-h 传给 CSS，文本框据此让位。
    <div className="gal-app" ref={appRef}>
      <div className="gal-floor-tag" data-minigal="source" data-source-kind={sourceKind}>
        {sourceKind === 'fixture' ? '本地预览模式 · ' : ''}
        {strictMode ? '严格 content 路径' : '降级路径（未找到 content）'}
      </div>

      <PlayScreen
        key={contentKey}
        lines={parsed.lines}
        options={parsed.options}
        speedMs={instant ? 0 : undefined}
        startIndex={savedIndex}
        onProgress={handleProgress}
        onAtStart={onAtStart}
        onReachEnd={onReachEnd}
      />

      {/* 楼层导航条：生成中按钮按 availableFloors 自动禁用。
          ★ 裸跑时**也渲染**（按钮全禁用、显示「无 AI 楼层」）——
          理由有两条：① 布局在本地就能看到、能截图核对，不用非进酒馆；
          ② 用户一眼能分辨「我在预览模式」而不是「界面坏了」。 */}
      <div className="gal-floorbar" data-minigal="floorbar" onClick={(e) => e.stopPropagation()}>
        <button type="button" disabled={!canPrevFloor} onClick={goPrevFloor} data-minigal="floor-prev">
          ‹ 上一楼
        </button>
        <span data-minigal="floor-pos">
          {floorOrdinal != null ? `第 ${floorOrdinal} / ${availableFloors.length} 楼` : '无 AI 楼层'}
          {viewingFloorId !== null ? ' · 历史' : ''}
        </span>
        <button type="button" disabled={!canNextFloor} onClick={goNextFloor} data-minigal="floor-next">
          下一楼 ›
        </button>
        {viewingFloorId !== null && (
          <button type="button" onClick={() => setViewingFloorId(null)} data-minigal="floor-latest">
            回到最新
          </button>
        )}

        {/* S5：重roll / 删楼。
            放在楼层条上而不是开发条里 —— 它们是**玩家功能**，而开发条将来要隐藏。
            裸跑时禁用（没酒馆环境就没有 generate / setChatMessages）。 */}
        <button
          type="button"
          disabled={isGenerating || !hasTavern}
          onClick={handleRegen}
          data-minigal="regen-btn"
          title="让 AI 重写本楼：楼号不变、正文原位替换、变量跟着重算"
        >
          重roll 本楼
        </button>
        <button
          type="button"
          disabled={isGenerating || !hasTavern || targetFloorId == null}
          onClick={() => {
            if (targetFloorId != null) setPendingDelete(targetFloorId);
          }}
          data-minigal="delete-btn"
          title="删除本楼（不可复原）"
        >
          删本楼
        </button>

        {isGenerating && <span className="gal-gening" data-minigal="generating">生成中…</span>}
      </div>

      {/* 底部堆叠：提示条 / 输入栏 / 开发条。
          ★ 为什么必须堆在同一列：三者原本各自 absolute bottom:0，
          开发条（z-40）会把输入栏（z-35）压掉一半 —— 实测截图里输入框只剩一条缝。
          堆叠后高度由内容决定，再通过 --gal-bottom-h 把总高告诉文本框让它让位，
          于是任何视口高度都不用写死数字（原来写死 56px，提示条一出现就不对了）。 */}
      <div className="gal-bottom" ref={bottomRef}>
        {/* 删楼确认条（S5）。用站内条而不是 window.confirm —— 理由见 pendingDelete 的注释 */}
        {pendingDelete != null && (
          <div className="gal-confirm" data-minigal="confirm" onClick={(e) => e.stopPropagation()}>
            <span data-minigal="confirm-text">
              删除第 {pendingDelete} 楼？这一层的内容会消失，不可复原。
            </span>
            <button type="button" className="gal-confirm-yes" onClick={handleConfirmDelete} data-minigal="confirm-yes">
              删除
            </button>
            <button type="button" onClick={() => setPendingDelete(null)} data-minigal="confirm-no">
              取消
            </button>
          </div>
        )}

        {notice && (
          <div className="gal-notice" data-minigal="notice" onClick={(e) => e.stopPropagation()}>
            {notice}
            <button type="button" onClick={() => setNotice(null)}>
              知道了
            </button>
          </div>
        )}

        {/* 输入栏：真实发送入口（点击不冒泡到翻页）。
            裸跑时保留，点发送会给出明确的「无酒馆环境」提示，而不是静默无事发生。 */}
        <div className="gal-inputbar" data-minigal="inputbar" onClick={(e) => e.stopPropagation()}>
        <textarea
          rows={1}
          value={inputText}
          disabled={isGenerating}
          data-minigal="input"
          placeholder={isGenerating ? '生成中…' : hasTavern ? '输入消息，Enter 发送' : '本地预览模式，发送不可用'}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <button
          type="button"
          disabled={!inputText.trim() || isGenerating}
          onClick={handleSend}
          data-minigal="send"
        >
          发送
        </button>
      </div>

        <div className="gal-devbar">
        <span data-minigal="devbar-state">
          {sourceLabel} · 已解析 {parsed.lines.length} 行
          {parsed.options.length > 0 ? ` · ${parsed.options.length} 个选项` : ''}
          {parsed.lines.length > 0 ? ` · 第 ${indexMirror + 1} 行` : ''}
          {drifted > 0 ? ` · 旁白越界 ${drifted} 行` : ''}
        </span>

        <span data-minigal="devbar-stage">
          上台行 {stageRows}/{spritedRows} 有立绘
          {fallbackRows > 0 ? ` · 差分回退 ${fallbackRows} 行` : ''}
          {unknownSpeakers.length > 0 ? ` · 未登记 ${unknownSpeakers.join('/')}` : ''}
          {` · 角色表 ${CHARACTERS.length}`}
        </span>

        <button
          type="button"
          className="gal-devbtn"
          data-minigal="toggle-source"
          onClick={() => {
            setFixtureText(() => (strictMode ? MOCK_FLOOR_DEGRADED : MOCK_FLOOR_WITH_CONTENT));
            setIndexMirror(0);
          }}
        >
          切换严格 / 降级
        </button>

        <span
          data-minigal="devbar-size"
          data-size-status={sizeDiag?.status ?? 'pending'}
          title={sizeDiag?.note ?? '检测中…'}
        >
          {sizeDiag ? sizeDiagText(sizeDiag) : '撑高 检测中…'}
        </span>

        <button
          type="button"
          className="gal-devbtn"
          data-minigal="api-probe-btn"
          onClick={() => setProbe(runApiProbe())}
        >
          探 API
        </button>

        {/* 变量面板开关（S5）。它是**调试工具**，所以放开发条；
            而重roll / 删楼是玩家功能，放在楼层条上。
            面板本身只在打开时才进 DOM，避免污染别的断言。 */}
        <button
          type="button"
          className="gal-devbtn"
          data-minigal="vars-btn"
          data-open={varsOpen ? '1' : '0'}
          onClick={() => setVarsOpen((o) => !o)}
        >
          变量
        </button>

        <button
          type="button"
          className="gal-devbtn gal-fsbtn"
          data-minigal="fullscreen-btn"
          data-fs={isFs ? '1' : '0'}
          onClick={async () => {
            if (isFs) {
              await exitFullscreen(() => guardRef.current?.burst());
              setIsFs(false);
            } else if (await enterFullscreen()) {
              setIsFs(true);
            }
            setSizeDiag(diagnoseSize());
          }}
        >
          {isFs ? '退出全屏' : '全屏'}
          </button>
        </div>
      </div>

      {probe && <ApiProbePanel result={probe} onClose={() => setProbe(null)} />}

      {/* 变量面板（S5）。放在底部堆叠**之外** ——
          它是绝对定位的浮层，塞进堆叠会变成 flex 子项、把底部整块撑高。 */}
      <VariablesView floorId={targetFloorId} open={varsOpen} onClose={() => setVarsOpen(false)} />
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

/**
 * 把尺寸诊断压成一行短标签。
 *
 * 为什么显示得这么具体：这个功能在不同环境下有 4 种失败形态，
 * 而它们的修法完全不同——光看「没生效」分不出是哪一种。
 *   · 不在 iframe   → 本地裸跑，正常，不用管
 *   · 读不到父页     → 跨域或沙箱，从内部无解，得改投递方式
 *   · 写入被覆盖     → 酒馆有更强的尺寸逻辑在跟我们抢
 *   · 已生效         → 正常，后面跟着实测的宽高
 * 悬停有完整说明（title 里是 note）。
 */
function sizeDiagText(d: SizeDiag): string {
  const size = d.rect ? ` ${d.rect.w}×${d.rect.h}` : '';
  switch (d.status) {
    case 'ok':
      return `撑高 已生效${size}`;
    case 'no-iframe':
      return '撑高 不在 iframe（裸跑）';
    case 'blocked':
      return '撑高 受阻：读不到父页';
    case 'write-failed':
      return `撑高 写入被覆盖${size}`;
    default:
      return '撑高 检测中…';
  }
}
