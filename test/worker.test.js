// Worker 集成测试（Node worker_threads 复用同一 worker.js）：
// 成功 / 非法输入 / 取消 / 旧任务迟到消息不得冒充最近任务。
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

const WORKER_URL = new URL('../src/web/worker.js', import.meta.url);

function makeRows(n, { threshold = 1, palindromeFree = true } = {}) {
  const alpha = 'ACGT';
  let seed = 987654321 ^ (n * 2654435761);
  const rand = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) | 0;
    return ((seed >>> 0) % 100000) / 100000;
  };
  const rc = (s) => ({ A: 'T', T: 'A', C: 'G', G: 'C' });
  const revcomp = (s) => [...s].reverse().map((c) => rc(s)[c]).join('');
  const used = new Set();
  const rows = [];
  while (rows.length < n) {
    let s = '';
    for (let i = 0; i < 8; i++) s += alpha[Math.floor(rand() * 4)];
    if (used.has(s)) continue;
    if (palindromeFree && revcomp(s) === s) continue;
    used.add(s);
    rows.push({ barcode: s, priority: String(1 + Math.floor(rand() * 9)), threshold: String(threshold) });
  }
  return rows;
}

function spawnWorker() {
  const w = new Worker(WORKER_URL);
  const nextTerminal = (ms = 20000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 Worker 消息超时')), ms);
      const onMsg = (msg) => {
        if (msg.type === 'progress') return;
        clearTimeout(timer);
        w.off('message', onMsg);
        resolve(msg);
      };
      w.on('message', onMsg);
      w.on('error', reject);
    });
  const collectUntil = async (predicate, ms = 20000) => {
    const got = [];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('收集 Worker 消息超时')), ms);
      const onMsg = (msg) => {
        got.push(msg);
        if (predicate(msg, got)) {
          clearTimeout(timer);
          w.off('message', onMsg);
          resolve(got);
        }
      };
      w.on('message', onMsg);
      w.on('error', reject);
    });
  };
  return { w, done: nextTerminal, collectUntil };
}

describe('Worker 集成', () => {
  const workers = [];
  after(async () => {
    await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
  });

  test('合法任务返回 done：字段齐全且大整数为十进制字符串', async () => {
    const { w, done } = spawnWorker();
    workers.push(w);
    w.postMessage({ type: 'audit', id: 1, rows: makeRows(10) });
    const msg = await done();
    assert.equal(msg.type, 'done');
    assert.equal(msg.id, 1);
    const r = msg.result;
    assert.equal(typeof r.totalPriority, 'string');
    assert.equal(typeof r.optimalCount, 'string');
    assert.ok(/^\d+$/.test(r.totalPriority));
    assert.ok(/^\d+$/.test(r.optimalCount));
    assert.ok(BigInt(r.optimalCount) >= 1n);
    assert.equal(r.status.length, 10);
    assert.equal(r.canonical.length, 10);
    assert.equal(r.bitVector.length, 10);
    assert.ok(r.status.every((s) => ['mandatory', 'optional', 'never'].includes(s)));
    assert.equal(r.selectedCount, r.canonical.filter(Boolean).length);
  });

  test('非法输入返回 invalid 且不含 result', async () => {
    const { w, done } = spawnWorker();
    workers.push(w);
    const rows = makeRows(10);
    rows[3].barcode = 'ZZZZZZZZ';
    w.postMessage({ type: 'audit', id: 2, rows });
    const msg = await done();
    assert.equal(msg.type, 'invalid');
    assert.equal(msg.id, 2);
    assert.ok(Array.isArray(msg.errors) && msg.errors.length >= 1);
  });

  test('记录数不足 10 条返回 invalid', async () => {
    const { w, done } = spawnWorker();
    workers.push(w);
    w.postMessage({ type: 'audit', id: 3, rows: makeRows(9) });
    const msg = await done();
    assert.equal(msg.type, 'invalid');
    assert.match(msg.errors.join(';'), /10/);
  });

  test('取消正在运行的 44 条任务返回 canceled', async () => {
    const { w, collectUntil } = spawnWorker();
    workers.push(w);
    // 无边图（阈值 1 且随机序列极少冲突）仍需完整 DP/枚举，足够等到取消
    w.postMessage({ type: 'audit', id: 4, rows: makeRows(44, { threshold: 1 }) });
    setImmediate(() => w.postMessage({ type: 'cancel', id: 4 }));
    const got = await collectUntil((msg) => msg.type === 'canceled' || msg.type === 'done');
    const terminal = got.find((m) => ['canceled', 'done'].includes(m.type));
    assert.equal(terminal.type, 'canceled');
    assert.equal(terminal.id, 4);
  });

  test('旧任务迟到消息不会覆盖新任务：先派重任务再派轻任务，只接受新 id 的 done', async () => {
    const { w, collectUntil } = spawnWorker();
    workers.push(w);
    w.postMessage({ type: 'audit', id: 100, rows: makeRows(44) });
    // 稍候派发新任务，确保旧任务已开始
    await new Promise((r) => setTimeout(r, 2));
    w.postMessage({ type: 'audit', id: 101, rows: makeRows(10) });
    const got = await collectUntil((msg) => msg.type === 'done' && msg.id === 101);
    assert.ok(got.some((m) => m.type === 'done' && m.id === 101));
    // 旧任务即便迟到，也绝不允许携带 done
    assert.ok(!got.some((m) => m.type === 'done' && m.id === 100));
  });
});
