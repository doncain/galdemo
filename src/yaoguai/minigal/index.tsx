import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// 宿主（酒馆助手 iframe）会注入 jQuery；浏览器裸跑时它不存在。
// 所有宿主能力一律先探测再使用，探测不到就降级——裸跑不白屏是本项目的硬纪律。
declare const $: any;

export const VERSION = '0.2.0';

function hasJQuery(): boolean {
  return typeof $ === 'function';
}

function whenReady(fn: () => void): void {
  if (hasJQuery()) {
    $(fn);
    return;
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

whenReady(() => {
  const host = document.getElementById('root');
  if (!host) {
    console.error('[minigal] 找不到 #root，挂载中止');
    return;
  }

  const root = createRoot(host);
  root.render(<App />);

  const unload = () => root.unmount();
  if (hasJQuery()) {
    $(window).on('pagehide', unload);
  } else {
    window.addEventListener('pagehide', unload, { once: true });
  }

  console.log(`[minigal] S1 播放层已挂载 · v${VERSION} · jQuery=${hasJQuery()}`);
});
