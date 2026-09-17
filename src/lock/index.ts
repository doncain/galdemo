/**
 * minigal-锁定前端 —— 独立酒馆助手脚本（不进前端构建，单独发布）
 *
 * ── 它解决什么问题 ────────────────────────────────────────────
 * 全屏玩的时候，酒馆自己还会往聊天里塞新楼层、也会因为重新渲染而
 * 拆掉旧楼层的 iframe。对我们来说这两种都致命：
 *   · 新楼层冒出来 → 伪全屏的布局被挤开
 *   · 当前楼 iframe 被销毁 → 游戏直接白屏，而且是在玩家全屏时白屏
 *
 * 所以这个脚本做两件事：**藏掉其它楼层** + **保护锁定楼的 iframe 不被删**。
 *
 * ── 为什么「保护」必须在父页 JS 引擎里做 ──────────────────────
 * 要拦住删除，就得包掉 `<iframe>.remove()` / `Node.prototype.removeChild` /
 * `jQuery.fn.remove` —— 而这些原型属于**酒馆主页面**，不属于我们所在的 iframe。
 * 所以本脚本的工作方式是：把一段补丁代码作为 `<script>` 注入到酒馆主页面的
 * head 里，让它在那边的引擎中执行。我们自己所在的上下文只是操作者。
 *
 * ── 触发（三条通道，任何一条通就够）───────────────────────────
 *   ① 父页 window 的标志位 `__minigalFullscreen` + `__minigalFullscreenFloor`
 *      —— 脚本**后**于全屏加载时靠它补锁
 *   ② 父页 document 的自定义事件 `minigal:fullscreen`
 *      —— 脚本**已**加载时靠它实时响应
 *   ③ 原生 `fullscreenchange`
 *      —— 原生全屏成功时浏览器自己派发
 *
 *   ★ 为什么不能只靠 ③：原生全屏**经常被浏览器策略拒绝**，那时
 *     `fullscreenchange` 永远不触发，锁定就一次都不会生效 ——
 *     而玩家看到的是「全屏着，别的楼层却照旧被删掉」，毫无提示。
 *     前端在进入/退出伪全屏时会主动派发 ①②。
 *
 * ── 命名空间（见 references/13-命名空间与迭代发布.md）──────────
 * 所有逃出 iframe 的名字都带 minigal 前缀：style id、script id、
 * window 标志位、清理函数、事件名。否则装两个 gal 前端会互删楼层。
 */

const STYLE_ID = 'minigal-lock-floor-style';
const PROTECT_ID = 'minigal-lock-protect-script';
const CLEANUP_KEY = '__minigalLockCleanup';
const FS_FLAG = '__minigalFullscreen';
const FS_FLOOR_FLAG = '__minigalFullscreenFloor';
const FS_EVENT = 'minigal:fullscreen';
const LOG = '[minigal] 锁定前端';

interface TavernCtx {
  win: any;
  doc: Document;
}

/**
 * 找出「酒馆主页面」。
 *
 * ★ 不靠猜、也不假设脚本只在一种上下文里跑：
 *   判据是「能不能读到 top 的 document」。
 *   · 在楼层 iframe 里跑 → window.top 就是酒馆主页面
 *   · 直接在酒馆主页面里跑 → top 就是自己，退化为自身 document
 * 两种都必须能工作 —— 酒馆助手把脚本注入到哪里，不同版本可能不一样。
 */
function tavernContext(): TavernCtx | null {
  try {
    const top = window.top as any;
    if (top && top !== window && top.document) return { win: top, doc: top.document as Document };
  } catch {
    /* 跨域：那就退到自身 */
  }
  try {
    if (typeof document !== 'undefined' && document.head) return { win: window, doc: document };
  } catch {
    /* noop */
  }
  return null;
}

/** 元素所属楼层的 mesid；不在楼层里返回 null。 */
function floorIdOf(el: Element | null): number | null {
  try {
    const raw = el?.closest('[mesid]')?.getAttribute('mesid');
    if (raw == null) return null;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

/**
 * 判断是否元素节点。
 *
 * ★ 绝不能用 `x instanceof HTMLElement`：本脚本跑在**楼层 iframe** 里，
 * 而它观察的是**父页**的 DOM —— 两个 realm 的构造器不是同一个对象，
 * `instanceof` 对父页节点**恒为 false**。
 *
 * 这个坑实测踩到过，而且症状极具欺骗性：整个观察者形同不存在，
 * 但 CSS 的 `:not()` 规则照样把新楼层藏住了，表面上「功能正常」，
 * 只有专门验兜底机制的那条断言才会红。
 * 判元素一律用 nodeType（跨 realm 可靠）。
 */
function isElement(n: unknown): boolean {
  const el = n as any;
  return !!el && el.nodeType === 1 && typeof el.matches === 'function';
}

/** 现在该锁哪一楼：先信我们自己的标志位，再退到原生全屏元素。 */
function readLockedFloor(win: any, doc: Document): number | null {
  try {
    const flagged = win?.[FS_FLOOR_FLAG];
    if (typeof flagged === 'number') return flagged;
  } catch {
    /* noop */
  }
  return floorIdOf(doc.fullscreenElement);
}

function start(): void {
  const ctx = tavernContext();
  if (!ctx) {
    console.warn(`${LOG}：拿不到酒馆页面上下文，锁定不生效`);
    return;
  }
  const { win, doc } = ctx;

  let locked: number | null = null;
  let hideObserver: MutationObserver | null = null;
  let headObserver: MutationObserver | null = null;

  /**
   * 被**我们**用 inline style 藏起来的节点。
   *
   * ★ 为什么要记账：解锁时得把 inline `display:none` 撤掉。
   * 只删 `<style>` 是不够的 —— inline 样式还在，那些楼层就**永久消失**了，
   * 而玩家会以为「退出全屏之后楼层被吃掉了」。
   * 只记我们改过的，不动酒馆自己设的 inline display（别抢别人的活）。
   */
  const hiddenByUs = new Set<HTMLElement>();

  function hideByUs(el: HTMLElement): void {
    if (!el.style || el.style.display === 'none') return; // 已是 none：可能是酒馆自己藏的
    hiddenByUs.add(el);
    el.style.display = 'none';
  }

  function restoreHiddenByUs(): void {
    hiddenByUs.forEach((el) => {
      if (el.isConnected) el.style.display = '';
    });
    hiddenByUs.clear();
  }

  /* ── ① 藏掉其它楼层 ──
     用 :not() 规则而不是「逐个给已有楼层设 display:none」——
     前者天然覆盖**之后**新增的楼层（规则不是快照），后者不会。 */
  function updateHideStyle(floorId: number | null): void {
    try {
      doc.getElementById(STYLE_ID)?.remove();
      if (floorId == null) return;
      const style = doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `#chat .mes:not([mesid="${floorId}"]){display:none !important}`;
      doc.head.appendChild(style);
    } catch (e) {
      console.warn(`${LOG}：写隐藏样式失败`, e);
    }
  }

  /* ── ② 把删除拦截补丁注入父页引擎 ── */
  function injectProtection(floorId: number): void {
    removeProtection();
    try {
      const script = doc.createElement('script');
      script.id = PROTECT_ID;
      script.textContent = buildProtectionSource(floorId);
      doc.head.appendChild(script);
    } catch (e) {
      console.warn(`${LOG}：注入保护脚本失败`, e);
    }
  }

  function removeProtection(): void {
    try {
      (win as any)[CLEANUP_KEY]?.();
    } catch {
      /* noop */
    }
    try {
      doc.getElementById(PROTECT_ID)?.remove();
    } catch {
      /* noop */
    }
  }

  function lockFloor(floorId: number): void {
    if (locked === floorId) return;
    if (locked !== null) unlockFloor();
    locked = floorId;
    updateHideStyle(floorId);
    injectProtection(floorId);
    console.info(`${LOG}：已锁定第 ${floorId} 楼`);
  }

  function unlockFloor(): void {
    if (locked === null) return;
    removeProtection();
    updateHideStyle(null);
    // ★ 必须把观察者打上的 inline display:none 撤掉（见 hiddenByUs 的注释）：
    //   只删样式的话，锁定期新增的楼层会永久隐身。
    restoreHiddenByUs();
    console.info(`${LOG}：已解锁第 ${locked} 楼`);
    locked = null;
  }

  /* ── ③ 触发通道 ── */
  const onSelfEvent = (e: Event): void => {
    const d = (e as CustomEvent).detail ?? {};
    const id = typeof d.floorId === 'number' ? d.floorId : null;
    if (d.on === true && id != null) lockFloor(id);
    else unlockFloor();
  };
  const onNativeFs = (): void => {
    const id = floorIdOf(doc.fullscreenElement);
    if (doc.fullscreenElement && id != null) lockFloor(id);
    else unlockFloor();
  };
  try {
    doc.addEventListener(FS_EVENT, onSelfEvent);
    doc.addEventListener('fullscreenchange', onNativeFs);
  } catch {
    /* noop */
  }

  /* ── ④ 锁定期新楼当场藏掉（样式被移除时的兜底）──
     为什么还要这个：上面的 :not() 规则会覆盖新增楼层，
     但**如果酒馆自己把 head 里的样式清掉**（重新渲染 head、换主题等），
     规则就没了。这时只有靠观察者当场给新节点打上 inline display:none。
     不依赖样式是否还在 —— 它守的是结果，而样式只是一条路径。*/
  try {
    const chat = doc.getElementById('chat') ?? doc.body;
    hideObserver = new MutationObserver((muts) => {
      if (locked === null) return;
      for (const m of muts) {
        for (const node of Array.from(m.addedNodes)) {
          // ★ 用 isElement 而不是 instanceof —— 见它的注释（跨 realm 陷阱）
          if (!isElement(node)) continue;
          const el = node as HTMLElement;
          if (el.matches('.mes') && floorIdOf(el) !== locked) hideByUs(el);
          else if (el.querySelectorAll) {
            el.querySelectorAll('.mes').forEach((sub) => {
              if (floorIdOf(sub) !== locked) hideByUs(sub as HTMLElement);
            });
          }
        }
      }
    });
    hideObserver.observe(chat, { childList: true, subtree: true });
  } catch {
    /* noop */
  }

  /* ── ④' 样式被酒馆清掉时补回来 ──
     ★ 为什么这条必须有：`lockFloor` 开头有「同一楼已在锁定就早退」的判断，
     所以**重复锁同一楼不会重写样式**。而酒馆重新渲染 head、换主题、
     或别的脚本清 head 时，我们的 `<style>` 会消失 —— 那时：
       · 新增楼层还有观察者兜底（见上）
       · 但**已经存在的其它楼层会立刻全部显形**，伪全屏当场破功
     这是个静默的、只在特定时序下出现的退化，所以用一个盯着 head 的
     观察者在样式消失时把它补回来。它只在「样式真的不见了」时动手，
     不会自激（补完样式就存在了）。 */
  try {
    headObserver = new MutationObserver(() => {
      if (locked === null) return;
      if (!doc.getElementById(STYLE_ID)) updateHideStyle(locked);
    });
    headObserver.observe(doc.head, { childList: true });
  } catch {
    /* noop */
  }
    /* ── ⑤ 初始化：脚本可能是全屏之后才加载的 ── */
  try {
    if (win?.[FS_FLAG] === true) {
      const id = readLockedFloor(win, doc);
      if (id != null) lockFloor(id);
      else console.warn(`${LOG}：检测到全屏中，但拿不到楼层号，暂不锁定`);
    } else {
      onNativeFs();
    }
  } catch {
    /* noop */
  }

  /* ── ⑥ 卸载清理：绝不留一个「永久隐藏其它楼层」的脚本 ── */
  const cleanup = (): void => {
    unlockFloor();
    // 兜底：即使 locked 已是 null，也不留下我们打过的 inline 隐藏
    restoreHiddenByUs();
    hideObserver?.disconnect();
    hideObserver = null;
    headObserver?.disconnect();
    headObserver = null;
    try {
      doc.removeEventListener(FS_EVENT, onSelfEvent);
      doc.removeEventListener('fullscreenchange', onNativeFs);
    } catch {
      /* noop */
    }
  };
  try {
    win.addEventListener('pagehide', cleanup);
  } catch {
    /* noop */
  }
  if (typeof window !== 'undefined' && window !== win) window.addEventListener('pagehide', cleanup);
}

/**
 * 生成注入到父页执行的补丁源码。
 *
 * ★ 三条删除路径都要包，缺一条就有一个绕过口：
 *   ① `HTMLIFrameElement.prototype.remove` —— 最常见的
 *   ② `Node.prototype.removeChild` —— 直接 DOM 操作，且**要处理嵌套**：
 *      父页往往删的是楼层的祖先容器，而不是 iframe 本身
 *   ③ `jQuery.fn.remove` —— 酒馆大量用 jQuery，它自己实现了 remove
 *
 * 全部「静默拒绝」：不抛错、不提示 —— 抛错会打断酒馆自己的渲染循环，
 * 造成比白屏更难查的故障。
 *
 * 提供 `__minigalLockCleanup()` 完整还原三个原型：这是**必须**的，
 * 否则脚本一卸载，酒馆就再也删不掉任何东西了。
 */
function buildProtectionSource(lockedFloor: number): string {
  return `
(function () {
  var LOCKED = ${lockedFloor};
  var CLEANUP = '${CLEANUP_KEY}';

  // 幂等：重复注入时先把上一次的补丁还原，否则会叠成多层包装，
  // cleanup 只能还原最外层，里层永远回不去。
  if (window[CLEANUP]) { try { window[CLEANUP](); } catch (e) {} }

  function lockedByMes(el) {
    if (!el || !el.closest) return false;
    var mes = el.closest('[mesid]');
    return !!mes && parseInt(mes.getAttribute('mesid'), 10) === LOCKED;
  }

  var _iframeRemove = HTMLIFrameElement.prototype.remove;
  HTMLIFrameElement.prototype.remove = function () {
    if (lockedByMes(this)) return;                 // ① 原生 remove
    return _iframeRemove.call(this);
  };

  var _removeChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function (child) {
    if (child && child.nodeName === 'IFRAME' && lockedByMes(child)) return child;
    // ② 嵌套：上层可能删的是楼层的祖先容器
    if (child && child.querySelector && child.querySelector('.mes[mesid="' + LOCKED + '"] iframe')) {
      return child;
    }
    return _removeChild.call(this, child);
  };

  var _jqRemove = null;
  if (window.jQuery && window.jQuery.fn && window.jQuery.fn.remove) {
    _jqRemove = window.jQuery.fn.remove;
    window.jQuery.fn.remove = function () {       // ③ jQuery remove
      var self = this;
      if (self && typeof self.splice === 'function') {
        for (var i = 0; i < self.length; i++) {
          if (lockedByMes(self[i])) { self.splice(i, 1); i--; }
        }
      }
      return self && self.length > 0 ? _jqRemove.call(self) : self;
    };
  }

  window[CLEANUP] = function () {
    HTMLIFrameElement.prototype.remove = _iframeRemove;
    Node.prototype.removeChild = _removeChild;
    if (_jqRemove && window.jQuery && window.jQuery.fn) window.jQuery.fn.remove = _jqRemove;
    delete window[CLEANUP];
  };
})();
`;
}

/* ── 入口 ──
   不依赖 jQuery ready：本脚本可能被注入到「有没有 $ 都不确定」的上下文，
   所以自己判 DOM 就绪。 */
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}

export {};
