/**
 * minigal · TavernHelper API 存在性探针
 * ============================================================
 * 用途：把「酒馆/助手升级后的静默 API 漂移」变成一张响亮的对照表。
 *
 * ────────────────────────────────────────────────────────────
 * ★ 先看这里：前端里已经有这个探针了，优先用它
 * ────────────────────────────────────────────────────────────
 * 界面正则载入后，开发条（底部）右侧有一个「探 API」按钮 —— 点它即可。
 * 更好用的原因：它天然跑在**正确的 iframe 语境**里，
 * 不存在「选错上下文导致全红误报」这个最坑的问题（见下方说明）。
 *
 * 本文件保留为「手动兜底」：当界面还没加载出来（比如正则没生效、
 * 或你在排查为什么界面不出现）时，仍可以用它单独探测。
 *
 * ────────────────────────────────────────────────────────────
 * 何时跑
 * ────────────────────────────────────────────────────────────
 *   ① 第一次把这个前端装进酒馆之前（现在就是这个时候）
 *   ② SillyTavern / 酒馆助手 / MagVarUpdate 任意一方升级后
 *   ③ 距上次核验超过 6–12 个月
 *   ④ 界面「点了没反应」时 —— 先探一下，可能只是某个 API 改名了
 *
 * ────────────────────────────────────────────────────────────
 * ★ 运行语境：这一步错了，结果全是误报
 * ────────────────────────────────────────────────────────────
 * 酒馆助手是把 TavernHelper 的这些函数【注入到它创建的 iframe】里的。
 * 所以：
 *
 *   正确跑法 A（最快）：点界面开发条上的「探 API」按钮。
 *
 *   正确跑法 B：打开浏览器 DevTools，在 console 上方的
 *               「执行上下文」下拉框里选中前端 iframe
 *               （名字形如 tavernhelper…），再粘贴执行。
 *
 *   正确跑法 C：在酒馆「脚本库」里新建一个临时脚本，
 *               把下面的 PROBE 函数体贴进 content（记得末尾调用），
 *               启用它，然后看 console。
 *
 *   错误跑法：直接贴在酒馆主页面的 console。
 *             主页面 window 上没有这些函数 —— 那是【注入机制】，
 *             不是【API 漂移】。别据此报警。
 *
 * ────────────────────────────────────────────────────────────
 * 怎么判读
 * ────────────────────────────────────────────────────────────
 *   iframe 语境里缺失  → 真·漂移候选。需要改用宿主现行的等价 API。
 *   非 iframe 语境全红  → 正常，换个语境重跑。
 *   全绿               → 只证明这些 API「存在」，不证明它们「行为正确」。
 *                        行为契约（翻楼/发送/重生成/变量收账）仍要靠真机手工验。
 *
 * 本脚本零依赖、零副作用：只读取，绝不调用任何写函数。
 * ============================================================
 */

function minigalApiProbe() {
  const inIframe = (() => {
    try {
      return window.self !== window.top;
    } catch {
      return true;
    }
  })();

  const probe = (label, get) => {
    let v;
    try {
      v = get();
    } catch {
      v = undefined;
    }
    // null 也算「不存在」：window.frameElement 在顶层页面返回 null，
    // 若只判 !== undefined 会把它算成存在，摘要里就会多出一个假阳性。
    return { label, ok: v !== undefined && v !== null, detail: typeof v };
  };

  // 权威清单来源：skill 的 architecture.md §8
  const fns = [
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
  ];
  const rows = fns.map((n) => probe(n, () => window[n]));

  const evts = [
    ['tavern_events.CHAT_CHANGED', () => window.tavern_events?.CHAT_CHANGED],
    ['tavern_events.MESSAGE_RECEIVED', () => window.tavern_events?.MESSAGE_RECEIVED],
    ['tavern_events.MESSAGE_UPDATED', () => window.tavern_events?.MESSAGE_UPDATED],
    ['tavern_events.GENERATION_AFTER_COMMANDS', () => window.tavern_events?.GENERATION_AFTER_COMMANDS],
    ['iframe_events.GENERATION_ENDED', () => window.iframe_events?.GENERATION_ENDED],
    ['Mvu.events.VARIABLE_UPDATE_ENDED', () => window.Mvu?.events?.VARIABLE_UPDATE_ENDED],
    ['Mvu.getMvuData', () => window.Mvu?.getMvuData],
    ['Mvu.replaceMvuData', () => window.Mvu?.replaceMvuData],
    ['Mvu.parseMessage', () => window.Mvu?.parseMessage],
    ['window.parent.$', () => window.parent?.$],
    ['window.frameElement', () => window.frameElement],
  ].map(([l, g]) => probe(l, g));

  const all = [...rows, ...evts];
  const miss = all.filter((r) => !r.ok);

  try {
    console.table(all);
  } catch {
    // 某些脚本库环境没有 console.table，退回逐行打印
    for (const r of all) console.log(`  ${r.ok ? 'OK  ' : 'MISS'}  ${r.label}  (${r.detail})`);
  }

  console.log(
    `[minigal-api-probe] iframe语境=${inIframe} | ${all.length - miss.length}/${all.length} 存在 | 缺失: ${
      miss.length ? miss.map((r) => r.label).join(', ') : '无'
    }`
  );

  if (!inIframe) {
    console.warn(
      '[minigal-api-probe] 当前不是 iframe 语境 —— 上面若大量缺失，大概率是注入机制而非 API 漂移。请换到 iframe 语境重跑。'
    );
  }

  return { inIframe, total: all.length, missing: miss.map((r) => r.label), rows: all };
}

// ── 直接在 console 粘贴时，这一行让它跑起来 ──
minigalApiProbe();
