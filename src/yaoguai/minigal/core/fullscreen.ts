// minigal · 伪全屏 + iframe 高度守卫（S6）
//
// ── 它解决什么问题 ─────────────────────────────────────────────
// 酒馆把楼层里的代码块提升成 iframe 后，iframe 的高度由酒馆决定。
// 默认它只给一个很矮的高度，于是我们的 .gal-root（height:100%）只能填满
// 那一条窄缝——表现为「只看到背景顶部 + 文本框，画面被切掉」。
//
// 这不是我们 CSS 的问题：内部高度链是通的（html/body → #root → .gal-app
// → .gal-root 全是 100%）。缺的是**外部那一环**：iframe 自己的高度没人撑。
//
// 修法：从 iframe 内部访问 window.parent，直接把 iframe 元素的高度设成
// 合理值。同源前提下可行（酒馆的楼层 iframe 与主页面同源）。
//
// ── 两个能力 ───────────────────────────────────────────────────
//   ① 高度守卫（自动，无需用户操作）：把 iframe 撑到 ~800px 或视口高度
//   ② 伪全屏（按钮触发）：藏掉其它楼层，让本楼铺满视口
//
// ── 纪律 ───────────────────────────────────────────────────────
// 一切父页操作都判空降级：裸跑预览、跨域、酒馆结构变化时**必须静默放弃**，
// 绝不能让「撑高度失败」把整个界面搞崩。所有父页访问都包在 try 里。

const STYLE_ID = 'minigal-fs-hide';

declare global {
  interface Window {
    __minigalFullscreen?: boolean;
  }
}

/** 父页 jQuery（同源前提）。拿不到 → 返回 null，后续所有父页操作放弃。 */
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

/** 自身 iframe 元素。跨域时访问会抛错 → null。 */
export function getSelfIframe(): HTMLIFrameElement | null {
  try {
    return window.frameElement as HTMLIFrameElement | null;
  } catch {
    return null;
  }
}

/** 是否运行在酒馆的 iframe 里（撑高度是否可行取决于此） */
export function inTavernIframe(): boolean {
  return Boolean(getSelfIframe() && getParentJQuery());
}

/**
 * 目标高度。
 *
 * 取「视口高度 - 20」与 800 的较小值，并保证不低于 400：
 *   · 减去 20 是给楼层容器留一点余量，避免撑出双滚动条；
 *   · 封顶 800 是因为再高就超出一般人的阅读范围，且会把页面拉得很长；
 *   · 下限 400 是为了极端矮的视口下仍然能看到完整的一屏。
 *
 * 拿不到父页视口时（跨域/裸跑）返回 800 —— 此时这个值根本不会用到。
 */
function computeTargetHeight(isMobile: boolean): number {
  const defaultH = isMobile ? 700 : 800;
  try {
    const parentH = window.parent.innerHeight;
    if (parentH > 0 && parentH < defaultH + 40) return Math.max(400, parentH - 20);
  } catch {
    /* 跨域 */
  }
  return defaultH;
}

/** 自己所在的楼层容器（.mes[mesid]）。父页查询失败就退回取最后一楼。 */
function closestMes(p$: any) {
  const iframe = getSelfIframe();
  return iframe ? p$(iframe).closest('.mes') : p$('#chat .mes').last();
}

/* ── 进入伪全屏：CSS 藏楼 + .mes 顶满视口 + 原生全屏尽力而为 ── */
export async function enterFullscreen(): Promise<boolean> {
  const p$ = getParentJQuery();
  if (!p$) return false;
  try {
    const $mes = closestMes(p$);

    // 藏掉其它楼层：只留自己这一楼。
    // 用楼层号而不是「保留最后一个」，这样「回到历史楼层」时也对。
    let hide = p$(`#${STYLE_ID}`);
    if (hide.length === 0) hide = p$(`<style id="${STYLE_ID}"></style>`).appendTo('head');
    const floorId = $mes.attr('mesid');
    hide.text(
      floorId
        ? `#chat .mes:not([mesid="${floorId}"]) { display: none !important; }`
        : `#chat .mes { display: none !important; }`,
    );

    $mes.css({
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      'z-index': 99999,
      'max-width': 'none',
      'max-height': 'none',
    });

    const iframe = getSelfIframe();
    if (iframe) p$(iframe).css({ width: '100%', height: '100%' });

    (window as any).__minigalFullscreen = true;

    // 原生全屏尽力而为：被浏览器策略拒绝也无妨，
    // 上面的 CSS 已经把画面铺满了（这叫「伪全屏」的兜底价值）。
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      /* 伪造全屏兜底 */
    }
    return true;
  } catch (e) {
    console.warn('[minigal] 进入全屏失败', e);
    return false;
  }
}

/* ── 退出：清样式 + 摘注入 + 复位标志 + 重撑高度 ── */
export async function exitFullscreen(restoreH?: () => void): Promise<void> {
  const p$ = getParentJQuery();
  if (!p$) return;
  try {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        /* noop */
      }
    }
    const $mes = closestMes(p$);
    $mes.css({
      position: '',
      top: '',
      left: '',
      width: '',
      height: '',
      'z-index': '',
      'max-width': '',
      'max-height': '',
    });
    p$(`#${STYLE_ID}`).remove();
    (window as any).__minigalFullscreen = false;
    // 退出后要重撑一次高度：全屏期间守卫是跳过的，
    // 复位后 iframe 可能停在错误高度（需要连补几次修竞态）。
    restoreH?.();
  } catch (e) {
    console.warn('[minigal] 退出全屏失败', e);
  }
}

/* ── iframe 高度守卫 ──
 *
 * 事件驱动，**不做定时轮询**。理由：
 *   · 轮询会在「酒馆自己改高度」时与之互抢，表现为画面抖动；
 *   · 楼层很多时每楼一个定时器，页面会被拖慢。
 * 改为监听 iframe 的 style 变化 + body 尺寸变化，只在需要时写一次，
 * 且差值 ≤1px 就不写（避免无谓的重排与观察者自激）。
 */
export interface GuardHandle {
  force(): void;
  burst(): void;
  destroy(): void;
}

export function startHeightGuard(isMobile: boolean): GuardHandle {
  const noop: GuardHandle = { force() {}, burst() {}, destroy() {} };
  const p$ = getParentJQuery();
  const iframe = getSelfIframe();
  if (!p$ || !iframe) return noop;

  let rafId = 0;
  let destroyed = false;

  const applyHeight = () => {
    if (destroyed || (window as any).__minigalFullscreen) return; // 全屏时跳过，别跟 100% 打架
    try {
      const targetH = computeTargetHeight(isMobile);
      const cur = p$(iframe).height();
      if (Math.abs(cur - targetH) > 1) p$(iframe).css({ height: `${targetH}px` });
    } catch {
      /* noop */
    }
  };

  const schedule = () => {
    if (rafId || destroyed) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      applyHeight();
    });
  };

  applyHeight();

  const observers: MutationObserver[] = [];
  try {
    const o = new MutationObserver(schedule);
    o.observe(iframe, { attributes: true, attributeFilter: ['style'] });
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
    force: applyHeight,
    // 连补三次修竞态：退出全屏那一刻别的代码也在改高度，单次写可能被盖掉
    burst: () => {
      applyHeight();
      setTimeout(applyHeight, 100);
      setTimeout(applyHeight, 200);
    },
    destroy: () => {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      observers.forEach((o) => o.disconnect());
      window.removeEventListener('resize', onResize);
      try {
        p$(iframe).css({ height: '' });
      } catch {
        /* noop */
      }
    },
  };
}
