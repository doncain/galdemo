/**
 * minigal 本地静态服务器（S2 交付层的「实时修改」通道）
 *
 * 为什么必须有它：
 *   界面正则有两种形态——「正式」指向 CDN，给玩家用；「实时修改」指向本机，
 *   给开发用。开发时你改一行 CSS、重跑一次 build，酒馆里刷新一下就能看到效果，
 *   不用每改一次就推一次代码等 CDN 回源。
 *
 * 为什么要开 CORS：
 *   酒馆页面在 http(s)://<你的酒馆域名>，而这份产物在 http://localhost:端口，
 *   两者不同源。iframe 里的 jQuery.load() 属于跨源请求，服务端不给
 *   Access-Control-Allow-Origin，浏览器会直接把响应丢掉——表现为「什么都没发生」，
 *   console 里一行红字，第 ① 步就跑不通。
 *
 * 用法：
 *   node scripts/serve.mjs            # 默认 5173 端口
 *   node scripts/serve.mjs 6000       # 指定端口
 *
 * 改端口后别忘了同步改「minigal-界面-实时修改.json」里的 URL。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');       // 以项目根为文档根，dist/ 才在射程内
const PORT = Number(process.argv[2] || 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const CORS = {
  // 全开。仅用于本机开发，不要用在对公网开放的机器上。
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  // 开发时必须禁缓存：否则你改了产物、酒馆里看到的还是上一版，
  // 然后你会去怀疑解析器、怀疑正则、怀疑人生——其实只是浏览器缓存。
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  // 去掉查询串（?instant=1&line=3 这类调试参数不该参与找文件）
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let filePath = path.join(ROOT, urlPath);

  // 目录穿越防护：把解析后的路径重新关回 ROOT 里
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, CORS);
    res.end('forbidden');
    return;
  }

  // 目录请求 → 找 index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    console.log(`  404  ${urlPath}`);
    res.writeHead(404, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 not found: ' + urlPath);
    return;
  }

  const size = fs.statSync(filePath).size;
  res.writeHead(200, {
    ...CORS,
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': size,
  });
  fs.createReadStream(filePath).pipe(res);
  console.log(`  200  ${urlPath}  (${size}B)`);
});

server.listen(PORT, () => {
  const target = `/dist/yaoguai/minigal/index.html`;
  console.log('');
  console.log('  minigal 本地服务已启动（CORS 全开 / 禁缓存）');
  console.log('');
  console.log(`    产物地址   http://localhost:${PORT}${target}`);
  console.log(`    浏览器自测 http://localhost:${PORT}${target}?instant=1`);
  console.log('');
  console.log('  把上面的「产物地址」填进 minigal-界面-实时修改.json 的 $(\'body\').load(...)');
  console.log('  按 Ctrl+C 停止');
  console.log('');
});
