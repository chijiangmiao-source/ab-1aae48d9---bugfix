// 零依赖静态文件服务器：提供页面并暴露 /healthz 健康检查路径。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..');
const WEB_ROOT = join(SRC_ROOT, 'web');
// 页面/Worker 通过相对路径 ../lib/*.js 引用核心库，需要把 /lib/ 映射到 src/lib
const ALIASES = new Map([['/lib/', join(SRC_ROOT, 'lib')]]);
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/healthz' || pathname === '/health') {
    sendJson(res, 200, { status: 'ok', uptime: Math.round(process.uptime()) });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';

  let root = WEB_ROOT;
  for (const [prefix, target] of ALIASES) {
    if (rel.startsWith(prefix)) {
      root = target;
      rel = rel.slice(prefix.length - 1); // 保留开头的 '/'
      break;
    }
  }

  const filePath = normalize(join(root, rel));
  // 必须严格位于根目录内（避免同前缀目录绕过）
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }

  try {
    const data = await readFile(filePath);
    const type = MIME[extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[web] listening on http://${HOST}:${PORT} (health: /healthz)`);
});

function shutdown(sig) {
  console.log(`[web] received ${sig}, shutting down`);
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
