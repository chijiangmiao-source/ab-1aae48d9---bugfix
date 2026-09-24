// verify：一次性核验流水线，以退出码报告成败。
//  阶段 1 代码测试：node --test test/（其中已重点核对反向互补自冲突、
//                   任意精度同优计数与必选/可选/从不选归属边界）
//  阶段 2 构建检查：对所有 JS 做语法检查（node --check），并校验页面资源引用
//  阶段 3 HTTP 冒烟：/healthz 与全部页面/脚本资源可达、类型正确、404 行为正常
//
// 用法：
//   node scripts/verify.mjs                     # 本地自动拉起服务器后冒烟
//   BASE_URL=http://web:8080 node scripts/verify.mjs   # 容器内指向已就绪服务
import { spawn } from 'node:child_process';
import { readdir, readFile, access } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = process.env.BASE_URL || '';
const PORT = process.env.PORT || '8080';

let failures = 0;
function step(name) {
  process.stdout.write(`\n=== ${name} ===\n`);
}
function ok(msg) {
  process.stdout.write(`  ✔ ${msg}\n`);
}
function fail(msg) {
  failures++;
  process.stderr.write(`  [FAIL] ${msg}\n`);
}

async function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
    child.on('close', (code) => resolve(code));
  });
}

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      await walk(p, out);
    } else if (extname(e.name) === '.js' || extname(e.name) === '.mjs') {
      out.push(p);
    }
  }
  return out;
}

// ---- 阶段 1：代码测试 ----
step('阶段 1/3：代码测试（node --test）');
const testCode = await run(process.execPath, ['--test', 'test/']);
if (testCode !== 0) {
  fail(`代码测试失败（退出码 ${testCode}）`);
} else {
  ok('全部测试通过');
}

// ---- 阶段 2：构建检查 ----
step('阶段 2/3：构建检查（语法 + 资源引用）');
const jsFiles = await walk(join(ROOT, 'src'));
jsFiles.push(...(await walk(join(ROOT, 'scripts'))));
let syntaxBad = 0;
for (const f of jsFiles) {
  const code = await run(process.execPath, ['--check', f]);
  if (code !== 0) {
    syntaxBad++;
    fail(`语法检查未通过：${f.replace(ROOT + '/', '')}`);
  }
}
if (syntaxBad === 0) ok(`${jsFiles.length} 个 JS 文件语法检查通过`);

// 页面引用的资源必须真实存在（浏览器中由静态服务器 /lib/ 别名提供）
const html = await readFile(join(ROOT, 'src/web/index.html'), 'utf8');
const requiredAssets = ['/styles.css', '/ui.js'];
for (const asset of requiredAssets) {
  const local = join(ROOT, 'src/web', asset);
  try {
    await access(local);
    ok(`页面资源存在：${asset}`);
  } catch {
    fail(`页面引用缺失：${asset}`);
  }
}
for (const rel of ['../lib/optimizer.js', '../lib/protocol.js']) {
  const local = join(ROOT, 'src/web', rel);
  try {
    await access(local);
    ok(`模块资源存在：src/lib/${rel.split('/').pop()}`);
  } catch {
    fail(`模块引用缺失：${rel}`);
  }
}
if (html.includes('<title>') && html.includes('/ui.js') && html.includes('/styles.css')) {
  ok('index.html 结构与资源引用完整');
} else {
  fail('index.html 结构或资源引用不完整');
}

// ---- 阶段 3：HTTP 冒烟 ----
step('阶段 3/3：HTTP 冒烟');

let serverProc = null;
let base = BASE_URL;
if (!base) {
  process.stdout.write('  未提供 BASE_URL，本地拉起静态服务器…\n');
  serverProc = spawn(process.execPath, [join(ROOT, 'src/server/server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  base = `http://127.0.0.1:${PORT}`;
}

const waitFor = async (url, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw lastErr;
};

async function smoke() {
  await waitFor(`${base}/healthz`);
  ok('服务已就绪');

  const health = await fetch(`${base}/healthz`);
  if (health.status !== 200) return fail(`/healthz 状态码 ${health.status}`);
  const body = await health.json();
  if (body.status !== 'ok') return fail(`/healthz 正文异常：${JSON.stringify(body)}`);
  ok('/healthz 返回 200 {status:"ok"}');

  const checks = [
    { path: '/', expect: /条码子库审计/, type: 'text/html', name: '首页 /' },
    { path: '/styles.css', expect: /progress-bar/, type: 'text/css', name: '样式 /styles.css' },
    { path: '/ui.js', expect: /ensureWorker/, type: 'text/javascript', name: '页面脚本 /ui.js' },
    { path: '/worker.js', expect: /runAudit/, type: 'text/javascript', name: 'Worker /worker.js' },
    { path: '/lib/optimizer.js', expect: /solveGraph/, type: 'text/javascript', name: '核心库 /lib/optimizer.js' },
    { path: '/lib/protocol.js', expect: /classifyMessage/, type: 'text/javascript', name: '协议库 /lib/protocol.js' },
  ];
  for (const c of checks) {
    const res = await fetch(`${base}${c.path}`);
    if (res.status !== 200) { fail(`${c.name} 状态码 ${res.status}`); continue; }
    const text = await res.text();
    if (!c.expect.test(text)) { fail(`${c.name} 正文不符合预期`); continue; }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes(c.type)) { fail(`${c.name} Content-Type 异常：${ct}`); continue; }
    ok(`${c.name} 200 且内容/类型正确`);
  }

  const missing = await fetch(`${base}/definitely-missing`);
  if (missing.status === 404) ok('不存在路径返回 404');
  else fail(`不存在路径应返回 404，实际 ${missing.status}`);

  // 目录穿越防护
  const traversal = await fetch(`${base}/..%2f..%2fpackage.json`);
  if (traversal.status === 403 || traversal.status === 404) ok('路径穿越被拦截');
  else fail(`路径穿越防护异常：${traversal.status}`);
}

try {
  // 测试阶段即便失败也继续构建/冒烟（能收集更多信息），但最终退出码反映成败
  if (testCode === 0) {
    await smoke();
  } else {
    process.stdout.write('  因测试失败，跳过 HTTP 冒烟。\n');
  }
} catch (err) {
  fail(`HTTP 冒烟异常：${err && err.message ? err.message : err}`);
} finally {
  if (serverProc) serverProc.kill('SIGTERM');
}

process.stdout.write('\n');
if (failures > 0) {
  process.stderr.write(`VERIFY 失败：${failures} 项检查未通过。\n`);
  process.exit(1);
}
process.stdout.write('VERIFY 成功：测试、构建检查与 HTTP 冒烟全部通过。\n');
process.exit(0);
