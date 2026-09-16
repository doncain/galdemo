// minigal · TavernHelper API 存在性探针（应用内版）
//
// ── 它解决什么 ─────────────────────────────────────────────────
// 酒馆助手把 TavernHelper 的函数**注入到它创建的 iframe** 里。
// S4（接入酒馆）整个阶段都建立在这些函数之上：
//   读楼层 getChatMessages / 楼层号 getLastMessageId / 事件 eventOn /
//   发送 triggerSlash / 重生成 generate …
//
// 如果宿主升级后某个函数改名或消失了，S4 的代码会**在真机上静默失效**——
// 表现是「点了没反应」「画面不动」，而 console 里未必有红错。
// 探针把这个「静默漂移」变成一张响亮的对照表：哪些在、哪些不在，一眼看完。
//
// ── 为什么做成应用内按钮，而不是让人贴 DevTools ────────────────
// docs/api-probe.md 给的官方跑法是「在 DevTools 的 console 上下文切换器里
// 选中前端 iframe 再粘贴」——这对不熟 DevTools 的人太难，而且**选错上下文
// 会全红误报**（主页面 window 上本来就没有这些函数，那是注入机制不是漂移）。
// 做成按钮后：它天然就跑在正确的 iframe 语境里，不存在选错的可能。
//
// ── 纪律：只读，不写 ───────────────────────────────────────────
// 本文件**只做存在性检查**，绝不调用任何写函数。
// 探测过程不会改动聊天、变量、世界书中的任何东西。

/** 权威清单来源：skill 的 architecture.md §8 / docs/api-probe.md §2 */
const API_FNS = [
  'getChatMessages',
  'getLastMessageId',
  'setChatMessages',
  'getVariables',
  'updateVariablesWith',
  'eventOn',
  'eventEmit',
  'triggerSlash',
  'generate',
  'generateRaw',
  'getModelList',
  'injectPrompts',
  'getCharWorldbookNames',
  'getChatWorldbookName',
  'getWorldbook',
  'getOrCreateChatWorldbook',
  'updateWorldbookWith',
  'deleteWorldbookEntries',
  'waitGlobalInitialized',
] as const;

/** 事件名常量。缺了不致命（onEvent 收到 undefined 会自己跳过），但要知道。 */
const EVENT_KEYS: Array<[string, (w: any) => unknown]> = [
  ['tavern_events.CHAT_CHANGED', (w) => w.tavern_events?.CHAT_CHANGED],
  ['tavern_events.MESSAGE_RECEIVED', (w) => w.tavern_events?.MESSAGE_RECEIVED],
  ['tavern_events.MESSAGE_UPDATED', (w) => w.tavern_events?.MESSAGE_UPDATED],
  ['tavern_events.GENERATION_AFTER_COMMANDS', (w) => w.tavern_events?.GENERATION_AFTER_COMMANDS],
  ['iframe_events.GENERATION_ENDED', (w) => w.iframe_events?.GENERATION_ENDED],
  ['window.parent.$', (w) => w.parent?.$],
  ['window.frameElement', (w) => w.frameElement],
];

/** S5 才用到的 MVU（可选依赖，缺了应当降级而不是报错） */
const MVU_KEYS: Array<[string, (w: any) => unknown]> = [
  ['Mvu.events.VARIABLE_UPDATE_ENDED', (w) => w.Mvu?.events?.VARIABLE_UPDATE_ENDED],
  ['Mvu.getMvuData', (w) => w.Mvu?.getMvuData],
  ['Mvu.replaceMvuData', (w) => w.Mvu?.replaceMvuData],
  ['Mvu.parseMessage', (w) => w.Mvu?.parseMessage],
];

export interface ProbeRow {
  group: '核心函数' | '事件常量' | 'MVU（可选）';
  label: string;
  ok: boolean;
  /** 实际类型，如 'function' / 'number' / 'undefined' */
  type: string;
}

export interface ProbeResult {
  inIframe: boolean;
  rows: ProbeRow[];
  total: number;
  present: number;
  /** 核心函数里缺失的名字——这些才是真·漂移候选 */
  missingCore: string[];
  hasMvu: boolean;
}

function typeOf(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  return typeof v;
}

export function runApiProbe(): ProbeResult {
  const w = (typeof window !== 'undefined' ? window : globalThis) as any;

  // 是否在 iframe 内。跨源时访问 window.top 会抛错——抛错本身说明是跨源 iframe。
  const inIframe = (() => {
    try {
      return w.self !== w.top;
    } catch {
      return true;
    }
  })();

  const grab = (get: () => unknown) => {
    try {
      const v = get();
      // 关键：null 也算「不存在」。
      // 踩过的坑：window.frameElement 在顶层页面（不在 iframe 里）返回 null，
      // 而最初写成 `v !== undefined`，于是它被算成「存在」——
      // 裸跑时摘要显示「1/30 存在」，看着像有个 API 可用，其实那正是
      // 「你不在 iframe 里」的证据。
      // 对存在性探针来说，null 的语义是「此处没有这个东西」，不是「有」。
      return { ok: v !== undefined && v !== null, type: typeOf(v) };
    } catch {
      return { ok: false, type: '（访问抛错）' };
    }
  };

  const rows: ProbeRow[] = [
    ...API_FNS.map((n) => ({ group: '核心函数' as const, label: n, ...grab(() => w[n]) })),
    ...EVENT_KEYS.map(([label, get]) => ({ group: '事件常量' as const, label, ...grab(() => get(w)) })),
    ...MVU_KEYS.map(([label, get]) => ({ group: 'MVU（可选）' as const, label, ...grab(() => get(w)) })),
  ];

  const missingCore = rows.filter((r) => r.group === '核心函数' && !r.ok).map((r) => r.label);
  const present = rows.filter((r) => r.ok).length;

  return {
    inIframe,
    rows,
    total: rows.length,
    present,
    missingCore,
    hasMvu: rows.some((r) => r.group === 'MVU（可选）' && r.ok),
  };
}

/**
 * 把探针结果压成一句人话结论。
 *
 * 为什么需要它：raw 表格对不熟 API 的人是噪音。
 * 真正要回答的问题只有一个——「S4 能不能开工」。
 */
export function probeVerdict(r: ProbeResult): { level: 'ok' | 'warn' | 'bad'; text: string } {
  if (!r.inIframe) {
    return {
      level: 'bad',
      text: '当前不在 iframe 语境里（你可能在裸跑浏览器里打开的）。此处的缺失不代表 API 漂移——请在酒馆里点这个按钮。',
    };
  }
  if (r.missingCore.length === 0) {
    return {
      level: 'ok',
      text: `核心函数全部存在（${r.present}/${r.total}）。S4 可以按 skill 文档的写法开工。注意：探针只证明「存在」，不证明「行为正确」——真实发送/翻楼/重生成仍要在酒馆里手工验。`,
    };
  }
  return {
    level: 'warn',
    text: `iframe 语境里缺失 ${r.missingCore.length} 个核心函数：${r.missingCore.join('、')}。这可能是宿主的 API 漂移——S4 依赖它们，需要改用等价 API 或降级。`,
  };
}
