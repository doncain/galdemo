import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT = 'minigal';
const distDir = resolve(process.cwd(), 'dist/yaoguai', PROJECT);
const shellPath = resolve(process.cwd(), 'src/yaoguai', PROJECT, 'index.html');
const jsPath = resolve(distDir, 'index.js');
const outPath = resolve(distDir, 'index.html');

const shell = readFileSync(shellPath, 'utf8');
const js = readFileSync(jsPath, 'utf8');

const count = (hay, needle) => hay.split(needle).length - 1;
const checks = [];
const check = (label, pass, detail) => checks.push({ label, pass, detail });

// —— 空壳自检：骨架 HTML 必须干净（无内联 JS、无外部资源、有唯一挂载点）——
check('空壳无内联 <script>', count(shell, '<script') === 0, `实际 ${count(shell, '<script')} 处`);
check('空壳有唯一 </body>', count(shell, '</body>') === 1, `实际 ${count(shell, '</body>')} 处`);
check('空壳含挂载点 #root', shell.includes('<div id="root"></div>'), '');
check('空壳以 </html> 收尾', shell.trimEnd().endsWith('</html>'), '');

// —— 内联：把 bundle 灌进 </body> 之前（只此一处，位置确定）——
// 必须用函数式替换：字符串式替换会把 bundle 里的 $&、$'、$1 当特殊模式解释并破坏代码
const out = shell.replace('</body>', () => `<script>\n${js}\n</script>\n</body>`);
writeFileSync(outPath, out, 'utf8');

// —— 产物自检 ——
const back = readFileSync(outPath, 'utf8');
const bytes = Buffer.byteLength(out, 'utf8');
const backBytes = Buffer.byteLength(back, 'utf8');

check('产物体积未变化（无截断）', backBytes === bytes, `写 ${bytes} B / 读回 ${backBytes} B`);
check('产物以 </html> 收尾', back.trimEnd().endsWith('</html>'), '');
check('bundle 原文完整内联', back.includes(js), `bundle ${(Buffer.byteLength(js, 'utf8') / 1024).toFixed(1)} KB`);
// 阶段探针：跟随当前能力更新，证明打进去的是「本阶段的真实应用代码」而非空壳。
// 注意形态：JSX 属性经 minifier 编译后是 "data-minigal":"progress"（冒号），
// 不是 HTML 的 data-minigal="progress"。此处断言的是 bundle 内形态。
const STAGE_MARKERS = ['"data-minigal":"progress"', 'gal-textbox', 'gal-option'];
check('产物含应用真实代码', STAGE_MARKERS.every((m) => back.includes(m)), STAGE_MARKERS.join(' + '));

// 注：不能用裸子串统计 </body> / <script> 判完整性——bundle 内部的 React DOM 代码
// 自带这些字符串，计数必然 > 1。只有"外部资源引用"是对内容免疫的。
const externalRefs = [...back.matchAll(/<(?:script|link)[^>]*\ssrc="[^"]*"/g)];
check('产物零外部资源引用', externalRefs.length === 0, externalRefs.map((m) => m[0]).join(' ') || '无');

for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.label}${c.detail ? '  — ' + c.detail : ''}`);
}

const failed = checks.filter((c) => !c.pass);
if (failed.length) {
  throw new Error(`产物完整性自检未通过（${failed.length} 项）`);
}

// 单文件交付：删掉中间产物 index.js，避免 dist 出现第二个可加载文件
rmSync(jsPath, { force: true });
console.log(`\n[inline] dist/yaoguai/${PROJECT}/index.html  ${(bytes / 1024).toFixed(1)} KB — 单文件就绪`);
