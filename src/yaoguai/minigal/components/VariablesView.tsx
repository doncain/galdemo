import React from 'react';
import { readStatDataWithSource } from '../core/tavernOps';

/**
 * 变量面板（S5）。
 *
 * ── 为什么默认不渲染 ──────────────────────────────────────────
 * 与探针面板同理：验收脚本大量依赖「页面可见文本」，而这里一开就是
 * 一大段 JSON（含引号与括号）。常驻的话会污染那些断言，且失败信息
 * 看起来跟变量毫无关系，极难定位。所以：关着的时候**什么都不进 DOM**。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────
 * 调剧情时得能看见 stat_data 长什么样。酒馆自带的变量界面看的是
 * 「此刻的变量」，看不到「某一楼的快照」—— 而重roll 恰恰围绕
 * 「某一楼的快照」工作（坑 21：要以该楼旧变量为基线重算）。
 *
 * ── 一条重要的诚实性要求 ──────────────────────────────────────
 * 面板会**如实标注数据来源**。因为「没装 MVU 时退一步显示聊天变量」
 * 是合理的，但把「此刻的聊天变量」标成「第 17 楼的快照」就成了撒谎：
 * 界面看起来完全正常、数值也是真的，只是回答的不是你问的问题。
 * 这类错误比崩溃难查得多。
 *
 * ── 它不做什么 ────────────────────────────────────────────────
 * 只读，绝不写。也不做业务判定 —— 那是 tavernOps 的事。
 */
export function VariablesView({
  floorId,
  open,
  onClose,
}: {
  floorId: number | null;
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;

  // 始终允许回退到聊天变量，但**必须**按 source 如实标注（见上）
  const reading = readStatDataWithSource(floorId ?? undefined, true);
  const where =
    reading.source === 'floor'
      ? `第 ${floorId} 楼的快照`
      : reading.source === 'chat'
        ? '聊天变量（当前值，不是某楼快照）'
        : '读取来源';

  return (
    <div className="gal-varsview" data-minigal="vars-panel" data-vars-source={reading.source}
      onClick={(e) => e.stopPropagation()}>
      <div className="gal-varsview-head">
        <strong>变量 stat_data</strong>
        <span className="gal-varsview-where" data-minigal="vars-where">
          {where}
        </span>
        <button type="button" onClick={onClose} data-minigal="vars-close">
          关闭
        </button>
      </div>

      {reading.data ? (
        <pre className="gal-varsview-body" data-minigal="vars-body">
          {JSON.stringify(reading.data, null, 2)}
        </pre>
      ) : (
        <div className="gal-varsview-empty" data-minigal="vars-empty">
          没有读到变量。这通常说明这个聊天没有装 MVU 框架脚本，或者对应楼层还没有变量。
          界面其它功能不受影响 —— 变量是可选依赖。
        </div>
      )}
    </div>
  );
}
