// minigal · 酒馆 API 安全层（S4）
//
// ── 它解决什么问题 ─────────────────────────────────────────────
// 酒馆助手把 TavernHelper 的函数**注入到它创建的 iframe** 里。
// 但同一份产物也要能在「浏览器裸跑」下打开（本地开发、无头验收），
// 那时这些全局根本不存在 —— 直接调用会抛 `getChatMessages is not defined`，
// 界面整个白屏。
//
// 所以这里把每一个调用都包一层：**环境缺失时返回中性值，绝不抛错**。
// 于是同一份代码在两种环境下都能跑，只是裸跑时「没有酒馆数据」而已。
//
// ── 项目纪律（重要）───────────────────────────────────────────
// **除本文件外，任何地方不得出现裸的 `getChatMessages` / `triggerSlash` /
// `eventOn` / `Mvu` / `generate` / `setChatMessages` 等调用。**
// 必须经由本文件导出。
// 理由：这是唯一一处集中做环境判断的地方。散落各处的话，
// 漏掉一处判空就是一个只在裸跑下出现的崩溃，而裸跑恰恰是自动化验收的环境。
//
// ── 返回值的「中性值」怎么定 ───────────────────────────────────
//   · 数组类 → 空数组（调用方 `.length` / `.map` 都安全）
//   · id 类  → null（调用方用 `!= null` 判断，且接得住）
//   · 布尔类 → false（调用方据此走降级分支）
//   · 订阅类 → 返回一个空的退订函数（调用方在 cleanup 里无条件调用）

const g = (typeof globalThis !== 'undefined' ? globalThis : {}) as any;

/** 是否运行在酒馆 iframe 内。所有功能的降级判断都基于它。 */
export const hasTavern = typeof g.getChatMessages === 'function';

/**
 * 读楼层消息。
 * range 支持：楼层号、'a-b'、'0-{{lastMessageId}}'（宏由酒馆展开）；
 * opts 可带 { role: 'assistant' } 之类过滤。
 */
export function getMessages(range: number | string, opts?: any): any[] {
  try {
    const r = g.getChatMessages(range, opts);
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}

/** 最后一条消息的楼层号。无酒馆 / 空聊天时返回 null。 */
export function lastMessageId(): number | null {
  try {
    const v = g.getLastMessageId();
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

/**
 * 执行 slash 命令。返回是否**成功执行**（不是命令本身的结果）。
 *
 * 注意 `await` 语义要看得清楚：`/trigger await=true` 会一直等到生成结束
 * 才 resolve —— 这是「生成锁」能正确配对的依据（见 App 的 handleSend）。
 * 若不等它，`finishGenerating()` 会在生成刚开始时就跑，锁等于没有。
 */
export async function slash(cmd: string): Promise<boolean> {
  if (typeof g.triggerSlash !== 'function') return false;
  try {
    await g.triggerSlash(cmd);
    return true;
  } catch (e) {
    console.error('[minigal] slash 失败:', cmd, e);
    return false;
  }
}

/** 订阅事件，返回退订函数（环境缺失时返回空函数，可无条件调用）。 */
export function onEvent(event: string | undefined, cb: (...args: any[]) => void): () => void {
  if (!event || typeof g.eventOn !== 'function') return () => {};
  try {
    const ret = g.eventOn(event, cb);
    return () => {
      try {
        ret?.stop?.();
      } catch {
        /* noop */
      }
    };
  } catch {
    return () => {};
  }
}

/** 发自定义事件。事件名必须带项目前缀（命名空间规范）。 */
export function emit(event: string, ...args: any[]): void {
  try {
    g.eventEmit?.(event, ...args);
  } catch {
    /* noop */
  }
}

/** 聊天变量读写。S5 才会用到，但属同一层，先放这里避免 S5 再开一个文件。 */
export function chatVars(): any {
  try {
    return g.getVariables?.({ type: 'chat' }) ?? {};
  } catch {
    return {};
  }
}

export function updateChatVars(fn: (vars: any) => any): void {
  try {
    g.updateVariablesWith?.(fn, { type: 'chat' });
  } catch {
    /* noop */
  }
}

// ── S5：MVU 变量框架（MagVarUpdate）─────────────────────────────
//
// MVU 是**可选依赖**：没装框架脚本时一切降级，正文操作照常（踩坑 22）。
// 所以这里只提供「拿到它」和「等它就绪」两个动作，判定与降级在 tavernOps 里。

/** MVU 框架本体。未装时返回 null —— 调用方一律用 `if (m)` 判空，不要直接取属性。 */
export function mvu(): any {
  return (g as any).Mvu ?? null;
}

/**
 * 等待宿主脚本初始化完成（例如 `waitGlobalInitialized('Mvu')`）。
 *
 * ★ 必须带超时。宿主脚本可能因为网络（MVU 本体走 CDN）迟迟不初始化，
 * 而 `waitGlobalInitialized` 在那种情况下会**一直等下去** ——
 * 表现是「点了重roll 之后界面卡住、没有任何反馈」。
 * 竞速超时后返回 false，调用方走降级（没变量照样能改正文）。
 */
export async function waitGlobalInitialized(name: string, timeoutMs = 8000): Promise<boolean> {
  const w = g.waitGlobalInitialized;
  if (typeof w !== 'function') return false;
  try {
    const outcome = await Promise.race([
      Promise.resolve(w(name)).then(() => 'ok'),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);
    return outcome === 'ok';
  } catch {
    return false;
  }
}

/**
 * 宿主生成。返回 AI 原始文本；失败返回 null。
 *
 * ★ 这里**不做任何后处理**，也不决定「要不要建楼层」——
 * 「只生成、不建楼」靠的是调用方传的 `should_silence: true` +
 * `overrides.chat_history`，见 tavernOps.regenerateCurrentFloor 的注释。
 */
export async function generate(options: any): Promise<string | null> {
  if (typeof g.generate !== 'function') return null;
  try {
    const r = await g.generate(options);
    return typeof r === 'string' ? r : null;
  } catch (e) {
    console.error('[minigal] generate 失败:', e);
    return null;
  }
}

/**
 * 原位改写楼层内容。
 *
 * ★ `refresh: 'none'` 是关键（调用方传）：不让宿主自己刷新界面。
 * 宿主刷新会重建 iframe、可能退出全屏、丢前端状态（踩坑 24）。
 * 我们改用自定义事件通知各楼自刷新。
 */
export async function setChatMessages(msgs: any[], opts?: any): Promise<boolean> {
  if (typeof g.setChatMessages !== 'function') return false;
  try {
    await g.setChatMessages(msgs, opts);
    return true;
  } catch (e) {
    console.error('[minigal] setChatMessages 失败:', e);
    return false;
  }
}

export interface RegenCapability {
  ok: boolean;
  /** 缺失的能力名，用于给出**具体**的失败原因。 */
  missing: string[];
}

/**
 * 静默重roll 所需能力是否齐备。
 *
 * 为什么要单独探一次：失败时只说「需要酒馆环境」，作者根本不知道
 * 是「不在酒馆里」还是「宿主版本太老没有 generate」——
 * 而这两者的处理方式完全不同（前者换环境，后者要改实现）。
 */
export function regenCapability(): RegenCapability {
  const need: Array<[string, unknown]> = [
    ['getChatMessages', g.getChatMessages],
    ['getLastMessageId', g.getLastMessageId],
    ['generate', g.generate],
    ['setChatMessages', g.setChatMessages],
  ];
  const missing = need.filter(([, fn]) => typeof fn !== 'function').map(([name]) => name);
  return { ok: missing.length === 0, missing };
}

/**
 * 酒馆 / iframe 事件名集合。
 * 环境缺失时是空对象 —— onEvent 收到 undefined 会自己跳过，
 * 所以调用方不需要额外判空。
 */
export const TE: any = (typeof g.tavern_events === 'object' && g.tavern_events) || {};
export const IE: any = (typeof g.iframe_events === 'object' && g.iframe_events) || {};

/** minigal 自定义刷新事件（删楼 / 重roll 完成后通知各楼 iframe 重新解析）。 */
export const STORY_UPDATED = 'minigal_story_updated';
