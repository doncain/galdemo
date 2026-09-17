// minigal · 伪全屏 + iframe 尺寸守卫（S6）
//
// ── 它解决什么问题 ─────────────────────────────────────────────
// 酒馆把楼层里的代码块提升成 iframe 后，iframe 的尺寸由酒馆决定。
// 它给的往往又矮又窄，于是我们的 .gal-root（width/height:100%）
// 只能填满那一条缝——表现为「画面被切掉」。
//
// 这不是我们 CSS 的问题：内部高度链是通的
// （html/body → #root → .gal-app → .gal-root 全是 100%）。
// 缺的是**外部那一环**：iframe 自己的尺寸没人撑。
//
// 修法：从 iframe 内部访问 window.parent，直接改 iframe 元素的尺寸。
//
// ── 两条通道，先 jQuery 后原生 ─────────────────────────────────
// 文档的参考实现只走 `window.parent.$`。但那要求父页确实暴露了 jQuery；
// 若酒馆那边没有（或换了实现），守卫会静默失效——而「静默失效」正是本项目
// 最忌讳的失败形态。所以这里补一条**原生 DOM 通道**：
//   · 有 window.parent.$ → 走 jQuery（与文档一致，兼容父页的既有习惯）
//   · 没有但能读 window.parent.document → 直接改 iframe.style
//   · 两者都不行 → 明确记录「受阻」，并在界面上说出来（不静默）
//
// ── 纪律 ───────────────────────────────────────────────────────
// 一切父页操作都判空降级：裸跑预览、跨域、沙箱、酒馆结构变化时**必须静默放弃**，
// 绝不能让「撑高失败」把整个界面搞崩。所有父页访问都包在 try 里。

const STYLE_ID = 'minigal-fs-hide';

declare global {
  interface Window {
    __minigalFullscreen?: boolean;
  }
}

/** 父页 jQuery（同源前提）。拿不到 → null。 */
export function getParentJQuery(): any | null {
  try {
    if (window.parent && window.parent !== window) {
      const p$ = (window.parent as any).$;
      if (p$) return p$;
    }
  } catch {
    /* 跨域 */
  }
  return null;
}

/** 父页 document（同源前提）。跨域/沙箱时访问会抛错 → null。 */
export function getParentDocument(): Document | null {
  try {
    if (window.parent && window.parent !== window) {
      return (window.parent as any).document ?? null;
    }
  } catch {
    /* 跨域 */
  }
  return null;
}

/** 自身 iframe 元素。跨域时访问会抛错 → null。 */
export function getSelfIframe(): HTMLIFrameElement | null {
  try {
    return window.frameElement as HTMLIFrameElement | null;
  } catch {
    return null;
  }
}

/** 父页视口尺寸。拿不到 → null。 */
function parentViewport(): { w: number; h: number } | null {
  try {
    const p = window.parent;
    if (!p) return null;
    return { w: p.innerWidth, h: p.innerHeight };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 诊断状态：守卫每一步的结果都记在这里，界面据此显示「撑高 已生效 / 受阻」
// ─────────────────────────────────────────────────────────────

export type SizeStatus = 'ok' | 'no-iframe' | 'no-parent' | 'blocked' | 'write-failed';

export interface SizeDiag {
  /** 是否在 iframe 里（self !== top） */
  inIframe: boolean;
  /** window.frameElement 是否可读 */
  hasFrameElement: boolean;
  /** window.parent.document 是否可读（同源/非沙箱） */
  parentDocReadable: boolean;
  /** window.parent.$ 是否存在 */
  hasParentJQuery: boolean;
  /** 实际使用的通道 */
  channel: 'jquery' | 'native' | 'none';
  /** iframe 当前实际尺寸（父页坐标系） */
  rect: { w: number; h: number } | null;
  /** 计算出的目标高度 */
  targetH: number;
  /** 最后一次成功写入的高度；0 = 没写过 */
  writtenH: number;
  status: SizeStatus;
  note: string;
}

const diag: SizeDiag = {
  inIframe: false,
  hasFrameElement: false,
  parentDocReadable: false,
  hasParentJQuery: false,
  channel: 'none',
  rect: null,
  targetH: 0,
  writtenH: 0,
  status: 'no-iframe',
  note: '未初始化',
};

function refreshDiagStatic(): void {
  diag.inIframe = (() => {
    try {
      return window.self !== window.top;
    } catch {
      return true;
    }
  })();
  diag.hasFrameElement = Boolean(getSelfIframe());
  const pd = getParentDocument();
  diag.parentDocReadable = Boolean(pd);
  diag.hasParentJQuery = Boolean(getParentJQuery());
  diag.channel = diag.hasParentJQuery ? 'jquery' : pd ? 'native' : 'none';
}

/** 供界面读取的诊断快照。每次调用都重新测量实际尺寸，保证不是过期数据。 */
export function diagnoseSize(): SizeDiag {
  refreshDiagStatic();
  const iframe = getSelfIframe();
  if (iframe) {
    try {
      const r = iframe.getBoundingClientRect();
      diag.rect = { w: Math.round(r.width), h: Math.round(r.height) };
    } catch {
      diag.rect = null;
    }
  }
  if (!diag.inIframe) {
    diag.status = 'no-iframe';
    diag.note = '不在 iframe 里（浏览器裸跑）。高度由窗口决定，属正常。';
  } else if (!iframe) {
    diag.status = 'blocked';
    diag.note = '在 iframe 里但读不到 frameElement——沙箱或跨域限制，无法从内部改尺寸。';
  } else if (diag.channel === 'none') {
    diag.status = 'blocked';
    diag.note = 'iframe 存在，但父页 document 与 jQuery 都读不到——跨域或沙箱。';
  } else if (diag.writtenH === 0) {
    diag.status = 'write-failed';
    diag.note = '通道可用，但还没有成功写入过尺寸（守卫可能没跑起来）。';
  } else {
    diag.status = 'ok';
    diag.note = `已通过 ${diag.channel} 通道写入高度 ${diag.writtenH}px。`;
  }
  return { ...diag };
}

/**
 * 目标高度。
 *
 * 取「视口高度 - 20」与 800 的较小值，并保证不低于 400：
 *   · 减去 20 是给楼层容器留余量，避免撑出双滚动条；
 *   · 封顶 800 是因为再高就超出阅读范围，且会把页面拉得很长；
 *   · 下限 400 是为了极端矮的视口下仍能看到完整一屏。
 */
function computeTargetHeight(isMobile: boolean): number {
  const defaultH = isMobile ? 700 : 800;
  const vp = parentViewport();
  if (vp && vp.h > 0 && vp.h < defaultH + 40) return Math.max(400, vp.h - 20);
  return defaultH;
}

/** 自己所在的楼层容器。jQuery 通道失败时回退 null（原生通道走 parentElement）。 */
function closestMes(p$: any) {
  const iframe = getSelfIframe();
  return iframe ? p$(iframe).closest('.mes') : p$('#chat .mes').last();
}

/**
 * 与「锁定前端」脚本的通报契约。改名要两边一起改。
 */
export const FULLSCREEN_EVENT = 'minigal:fullscreen';
export const FS_FLAG = '__minigalFullscreen';
export const FS_FLOOR_FLAG = '__minigalFullscreenFloor';

/** 自己所在的楼层号（父页 .mes[mesid]）。拿不到返回 null。 */
export function selfFloorId(): number | null {
  const iframe = getSelfIframe();
  if (!iframe) return null;
  try {
    const raw = iframe.closest('.mes')?.getAttribute('mesid');
    if (raw == null) return null;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

/**
 * 把「我正在全屏 / 我刚退出」通报给父页。
 *
 * ── 为什么必须有这一步 ────────────────────────────────────────
 * 独立部署的「锁定前端」脚本默认只监听父页的 `fullscreenchange`。
 * 但原生全屏**经常被浏览器策略拒绝** —— 那时 `fullscreenchange` 永远不会触发，
 * 锁定脚本也就一次都不会生效：玩家明明在全屏，别的楼层却照旧被删掉，
 * 而且毫无提示。这是「伪全屏兜底」的必然代价 —— 兜底路径没有原生事件。
 *
 * 所以主动通报，三条通道一起走，任何一条通就够：
 *   ① 父页 window 上的标志位（脚本**后**加载时靠它补锁）
 *   ② 父页 document 上的自定义事件（脚本**已**加载时靠它实时响应）
 *   ③ 原生 fullscreenchange（原生全屏成功时浏览器自己会派发，不用我们管）
 *
 * 全部 try/catch：跨域或拿不到父页时静默放弃 —— 通报失败绝不能连累全屏本身。
 */
function announceFullscreen(on: boolean, floorId: number | null): void {
  const pw = window.parent as any;
  try {
    if (pw && pw !== window) {
      pw[FS_FLAG] = on;
      // ★ 楼层号也要带上：只给一个布尔标志位的话，脚本后加载时
      //   根本不知道「该锁哪一楼」，只能去猜（比如取最后一楼）—— 猜错就锁错人。
      pw[FS_FLOOR_FLAG] = on ? floorId : null;
    }
  } catch {
    /* 跨域 */
  }
  try {
    const pd = getParentDocument();
    if (pd) {
      const Ctor = pw?.CustomEvent ?? CustomEvent;
      pd.dispatchEvent(new Ctor(FULLSCREEN_EVENT, { detail: { on, floorId: on ? floorId : null } }));
    }
  } catch {
    /* noop */
  }
}

/* ── 进入伪全屏：CSS 藏楼 + .mes 顶满视口 + 原生全屏尽力而为 ── */
export async function enterFullscreen(): Promise<boolean> {
  const iframe = getSelfIframe();
  const p$ = getParentJQuery();
  const pd = getParentDocument();
  if (!iframe || (!p$ && !pd)) return false;

  try {
    const $mes = p$ ? closestMes(p$) : null;
    const mesEl: HTMLElement | null = $mes ? $mes[0] : (iframe.closest('.mes') as HTMLElement | null);
    const floorId = mesEl?.getAttribute('mesid') ?? null;

    // 藏掉其它楼层：只留自己这一楼。
    // 用楼层号而不是「保留最后一个」，这样「回到历史楼层」时也对。
    if (pd) {
      let styleEl = pd.getElementById(STYLE_ID) as HTMLStyleElement | null;
      if (!styleEl) {
        styleEl = pd.createElement('style');
        styleEl.id = STYLE_ID;
        pd.head.appendChild(styleEl);
      }
      styleEl.textContent = floorId
        ? `#chat .mes:not([mesid="${floorId}"]) { display: none !important; }`
        : `#chat .mes { display: none !important; }`;
    }

    if (mesEl) {
      mesEl.style.position = 'fixed';
      mesEl.style.top = '0';
      mesEl.style.left = '0';
      mesEl.style.width = '100vw';
      mesEl.style.height = '100vh';
      mesEl.style.zIndex = '99999';
      mesEl.style.maxWidth = 'none';
      mesEl.style.maxHeight = 'none';
    }

    setIframeSize(iframe, '100%', '100%');

    (window as any).__minigalFullscreen = true;
    // 通报给父页，让独立部署的「锁定前端」脚本能锁住这一楼
    // （原生全屏被拒时没有 fullscreenchange，只能靠这条）
    announceFullscreen(true, selfFloorId());

    // 原生全屏尽力而为：被浏览器策略拒绝也无妨，
    // 上面的 CSS 已经把画面铺满了（这是「伪全屏」兜底的价值）。
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      /* 伪全屏兜底 */
    }
    return true;
  } catch (e) {
    console.warn('[minigal] 进入全屏失败', e);
    return false;
  }
}

/* ── 退出：清样式 + 复位 + 重撑尺寸 ── */
export async function exitFullscreen(restoreSize?: () => void): Promise<void> {
  const iframe = getSelfIframe();
  const p$ = getParentJQuery();
  const pd = getParentDocument();
  if (!iframe) return;
  try {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        /* noop */
      }
    }
    const mesEl = p$ ? closestMes(p$)[0] : (iframe.closest('.mes') as HTMLElement | null);
    if (mesEl) {
      for (const k of ['position', 'top', 'left', 'width', 'height', 'zIndex', 'maxWidth', 'maxHeight']) {
        (mesEl.style as any)[k] = '';
      }
    }
    pd?.getElementById(STYLE_ID)?.remove();
    (window as any).__minigalFullscreen = false;
    // 通报退出，让「锁定前端」解锁。
    // ★ 这一步放在 catch 之内是刻意的：即使上面的清理出错，也要尽量通报 ——
    //   否则锁定脚本会一直以为你还在全屏，把其余楼层永久藏住，
    //   而玩家看到的是「酒馆突然只剩一层楼了」。
    announceFullscreen(false, null);
    // 退出后要重撑一次：全屏期间守卫是跳过的，
    // 复位后 iframe 可能停在错误尺寸（需要连补几次修竞态）。
    restoreSize?.();
  } catch (e) {
    console.warn('[minigal] 退出全屏失败', e);
  }
}

/**
 * 写 iframe 尺寸的唯一出口。两条通道都试，成功即止。
 *
 * 返回是否写入成功（用于诊断）。判定「成功」只认一件事：
 * **写完再读回来，值确实变了或已经正确。**
 * 只检查「没有抛错」是不够的——被外部覆盖时会误报成功。
 */
function setIframeSize(iframe: HTMLIFrameElement, width: string, height: string): boolean {
  const p$ = getParentJQuery();
  let wrote = false;
  try {
    if (p$) {
      p$(iframe).css({ width, height });
      wrote = true;
    } else {
      iframe.style.width = width;
      iframe.style.height = height;
      wrote = true;
    }
  } catch {
    wrote = false;
  }
  return wrote;
}

/* ── iframe 尺寸守卫 ──
 *
 * 事件驱动，**不做定时轮询**。理由：
 *   · 轮询会在「酒馆自己改尺寸」时与之互抢，表现为画面抖动；
 *   · 楼层很多时每楼一个定时器，页面会被拖慢。
 * 改为监听 iframe 的 style 变化 + 父元素变化 + body 尺寸变化，
 * 只在需要时写一次，且差值 ≤1px 就不写（避免无谓重排与观察者自激）。
 */
export interface GuardHandle {
  force(): void;
  burst(): void;
  destroy(): void;
}

export function startSizeGuard(isMobile: boolean): GuardHandle {
  const noop: GuardHandle = { force() {}, burst() {}, destroy() {} };
  const iframe = getSelfIframe();
  refreshDiagStatic();
  if (!iframe || diag.channel === 'none') {
    diag.status = diag.inIframe ? 'blocked' : 'no-iframe';
    diag.note = diag.inIframe
      ? 'iframe 存在，但父页 document 与 jQuery 都读不到——跨域或沙箱，无法从内部改尺寸。'
      : '不在 iframe 里（浏览器裸跑）。';
    return noop;
  }

  let rafId = 0;
  let destroyed = false;

  const applySize = () => {
    if (destroyed || (window as any).__minigalFullscreen) return; // 全屏时跳过，别跟 100% 打架
    try {
      const targetH = computeTargetHeight(isMobile);
      diag.targetH = targetH;

      const rect = iframe.getBoundingClientRect();
      const curH = Math.round(rect.height);
      const curW = Math.round(rect.width);

      // 目标宽度：父容器（.mes）的内容宽度。取不到就退回 100%。
      // 宽度也要管，因为酒馆给的 iframe 未必是整宽——「画面被切」不只有高度一个维度。
      let targetW: string | null = null;
      const parentEl = iframe.parentElement;
      if (parentEl) {
        const pw = Math.round(parentEl.clientWidth);
        if (pw > 0 && Math.abs(curW - pw) > 2) targetW = '100%';
      }

      const needH = Math.abs(curH - targetH) > 1;
      const needW = targetW !== null;
      if (!needH && !needW) return; // 已达标，不写（避免观察者自激）

      const ok = setIframeSize(iframe, targetW ?? '100%', `${targetH}px`);

      // 写完再读回来验证。只看「没抛错」会误报成功——
      // 外部若立刻覆盖，抛错与否都看不出来。
      const after = Math.round(iframe.getBoundingClientRect().height);
      if (ok && Math.abs(after - targetH) <= 2) {
        diag.writtenH = targetH;
        diag.status = 'ok';
        diag.note = `已通过 ${diag.channel} 通道写入高度 ${targetH}px。`;
      } else {
        diag.status = 'write-failed';
        diag.note = `写入 ${targetH}px 后读回 ${after}px——尺寸被外部覆盖了。`;
      }
    } catch (e) {
      diag.status = 'write-failed';
      diag.note = '写入尺寸时抛错：' + String((e as Error)?.message || e).slice(0, 80);
    }
  };

  const schedule = () => {
    if (rafId || destroyed) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      applySize();
    });
  };

  applySize();

  const observers: MutationObserver[] = [];
  try {
    const o = new MutationObserver(schedule);
    o.observe(iframe, { attributes: true, attributeFilter: ['style', 'height', 'width'] });
    observers.push(o);
  } catch {
    /* noop */
  }
  try {
    const parentEl = iframe.parentElement;
    if (parentEl) {
      const o = new MutationObserver(schedule);
      o.observe(parentEl, { attributes: true, attributeFilter: ['style', 'class'] });
      observers.push(o);
    }
  } catch {
    /* noop */
  }
  try {
    new ResizeObserver(schedule).observe(document.body);
  } catch {
    /* noop */
  }
  const onResize = () => schedule();
  window.addEventListener('resize', onResize);

  return {
    force: applySize,
    // 连补三次修竞态：退出全屏那一刻别的代码也在改尺寸，单次写可能被盖掉
    burst: () => {
      applySize();
      setTimeout(applySize, 100);
      setTimeout(applySize, 200);
    },
    destroy: () => {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      observers.forEach((o) => o.disconnect());
      window.removeEventListener('resize', onResize);
      try {
        setIframeSize(iframe, '', '');
        diag.writtenH = 0;
      } catch {
        /* noop */
      }
    },
  };
}
