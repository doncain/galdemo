// minigal · TypingText（S1）
//
// ═══ 本 skill 最重的一条铁律（§12 红线 2）═══
// 打字机绝不放主画面组件。
//
// 为什么：打字进度若是播放屏的 state，每吐出一个字都会重渲染整棵画面树
// （立绘、背景、文本框）。S3 加上立绘和 CG 之后，这会直接卡到没法玩。
//
// 正解就是本文件：打字进度是「这个子组件内部」的 state，
// 父组件对逐字吐字零感知；父组件只在「开始打字 / 打完」两个时刻收到通知。
//
// 为了让 memo 真正生效，父组件回调必须是稳定引用（用 useCallback / 直接传 setState）。

import React, { useCallback, useEffect, useState } from 'react';
import type { LineType } from '../core/scriptProtocol';

interface TypingTextProps {
  /** 整行全文 */
  text: string;
  /** 每字毫秒；0 = 瞬发 */
  speedMs: number;
  lineType: LineType;
  /** 旁白越界标记（只影响样式，不影响打字逻辑） */
  suspect?: boolean;
  /** 只在「开始打字 / 打完」两个时刻回调，不是每帧 */
  onTypingStateChange?: (typing: boolean) => void;
  /** 置 true = 立即补全整行 */
  skipRef: React.MutableRefObject<boolean>;
}

export const TypingText = React.memo(function TypingText({
  text,
  speedMs,
  lineType,
  suspect,
  onTypingStateChange,
  skipRef,
}: TypingTextProps) {
  const [shown, setShown] = useState('');
  const [typing, setTyping] = useState(false);

  const notify = useCallback(
    (next: boolean) => {
      setTyping(next);
      onTypingStateChange?.(next);
    },
    [onTypingStateChange],
  );

  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    skipRef.current = false;

    // 速度档 0 = 瞬发
    if (speedMs <= 0) {
      setShown(text);
      notify(false);
      return;
    }

    setShown('');
    notify(true);

    let i = 0;
    let last = performance.now();

    // requestAnimationFrame + 时间累积（非 setInterval）
    const tick = (now: number) => {
      if (cancelled) return;
      if (skipRef.current) {
        setShown(text);
        notify(false);
        return;
      }
      if (now - last < speedMs) {
        raf = requestAnimationFrame(tick);
        return;
      }
      last = now;
      if (i < text.length) {
        i += 1;
        setShown(text.slice(0, i));
        raf = requestAnimationFrame(tick);
      } else {
        notify(false);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [text, speedMs, skipRef, notify]);

  return (
    <div className={'gal-text ' + lineType + (suspect ? ' gal-text-suspect' : '')}>
      {shown}
      {typing && <span className="gal-cursor">▍</span>}
    </div>
  );
});
