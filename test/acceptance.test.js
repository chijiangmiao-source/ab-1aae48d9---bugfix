// 验收测试：按审计页规则生成 22 对（44 条）长度 24 的条码，
// 在 15 秒内核对完整结论；并以较小配对规模复核同优计数 / 归属 /
// 规范位向量随规模一致变化。另覆盖：运行中的审计可取消、
// 取消与旧任务迟到消息均不覆盖最近一次成功结论。
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import {
  normalizeRows,
  buildGraph,
  auditRecords,
} from '../src/lib/optimizer.js';
import { reduceSuccess } from '../src/lib/protocol.js';

const L = 24;

// 按题目规则生成 k 对（共 2k 条）：全部 X 在前、全部 Y 在后。
// Xi：24 个 A，再把零基位置 i 改为 C；Yi：复制 Xi 并把最后一位改为 G。
// 优先权均 1、距离阈值均 2。
function pairRows(k) {
  const rows = [];
  const x = [];
  for (let i = 0; i < k; i++) {
    const a = Array.from({ length: L }, () => 'A');
    a[i] = 'C';
    const seq = a.join('');
    x.push(seq);
    rows.push({ barcode: seq, priority: '1', threshold: '2' });
  }
  for (let i = 0; i < k; i++) {
    const seq = x[i].slice(0, L - 1) + 'G';
    rows.push({ barcode: seq, priority: '1', threshold: '2' });
  }
  return rows;
}

function expected(k) {
  return {
    totalPriority: BigInt(k),
    selectedCount: k,
    optimalCount: 1n << BigInt(k), // 每条匹配边二选一，共 2^k 个最优方案
    bitVector: '1'.repeat(k) + '0'.repeat(k), // 选中优先：X 全部在前 → 全选 X
  };
}

async function assertPairResult(k, { maxMs = null } = {}) {
  const rows = pairRows(k);
  assert.equal(rows.length, 2 * k);
  const parsed = normalizeRows(rows);
  assert.equal(parsed.ok, true, parsed.errors.join('; '));
  assert.equal(parsed.records.length, 2 * k);

  // 题目前提：无反向互补自冲突
  assert.ok(parsed.records.every((r) => !r.selfConflict), '不应存在自冲突记录');

  // 冲突图恰为 k 条互不相连的匹配边 Xi—Yi（eligible 顺序即输入顺序）
  const { adj } = buildGraph(parsed.records);
  for (let i = 0; i < k; i++) {
    assert.equal(adj[i], 1n << BigInt(k + i), `X${i} 只应与 Y${i} 互斥`);
    assert.equal(adj[k + i], 1n << BigInt(i), `Y${i} 只应与 X${i} 互斥`);
  }

  const t0 = Date.now();
  const res = await auditRecords(parsed.records);
  const ms = Date.now() - t0;
  const exp = expected(k);

  assert.equal(res.totalPriority, exp.totalPriority, `k=${k} 最大优先权总和`);
  assert.equal(res.selectedCount, exp.selectedCount, `k=${k} 入选记录数`);
  assert.equal(res.optimalCount, exp.optimalCount, `k=${k} 同优方案数`);
  assert.equal(res.bitVector, exp.bitVector, `k=${k} 规范位向量`);
  assert.deepEqual(Array.from(res.canonical), exp.bitVector.split('').map(Number),
    `k=${k} canonical 数组`);
  // 44 条都应判为“可选”
  assert.ok(res.status.every((s) => s === 'optional'), `k=${k} 全部记录应为可选`);
  if (maxMs !== null) {
    assert.ok(ms <= maxMs, `k=${k} 耗时 ${ms}ms 超过 ${maxMs}ms`);
  }
  return { res, ms };
}

describe('验收：22 对（44 条）产品规模上限场景', () => {
  test('15 秒内返回完整正确结论', async () => {
    const { ms } = await assertPairResult(22, { maxMs: 15000 });
    process.stdout.write(`\n  k=22（44 条）审计耗时 ${ms}ms\n`);
  });

  test('关键数值精确：权 22 / 数 22 / 同优 4194304 / 位向量 22 个 1 后 22 个 0', async () => {
    const parsed = normalizeRows(pairRows(22));
    const res = await auditRecords(parsed.records);
    assert.equal(res.totalPriority.toString(), '22');
    assert.equal(res.selectedCount, 22);
    assert.equal(res.optimalCount.toString(), '4194304'); // 2^22
    assert.equal(res.bitVector, '1'.repeat(22) + '0'.repeat(22));
  });
});

describe('验收：较小配对规模复核随规模一致变化', () => {
  // 10 条下限、16 条中间规模两档
  for (const k of [5, 8]) {
    test(`k=${k}（${2 * k} 条）：权/数=${k}，同优=2^${k}，位向量=${'1'.repeat(k)}|${'0'.repeat(k)}`,
      async () => {
        await assertPairResult(k);
      });
  }

  test('同优计数随 k 指数增长：2^5、2^8、2^22 一致', async () => {
    for (const [k, pow] of [[5, 5], [8, 8], [22, 22]]) {
      const parsed = normalizeRows(pairRows(k));
      const res = await auditRecords(parsed.records);
      assert.equal(res.optimalCount, 1n << BigInt(pow));
    }
  });
});

// ---- Worker 层：可取消 + 取消/迟到消息不覆盖最近成功 ----
const WORKER_URL = new URL('../src/web/worker.js', import.meta.url);

function spawnWorker() {
  const w = new Worker(WORKER_URL);
  const waitMsg = (pred, ms = 20000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 Worker 消息超时')), ms);
      const onMsg = (msg) => {
        if (pred(msg)) {
          clearTimeout(timer);
          w.off('message', onMsg);
          resolve(msg);
        }
      };
      w.on('message', onMsg);
      w.on('error', reject);
    });
  return { w, waitMsg };
}

describe('验收：运行中的 44 条审计可取消', () => {
  const workers = [];
  after(async () => {
    await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
  });

  test('派发 44 条后立即取消，收到当前 id 的 canceled', async () => {
    const { w, waitMsg } = spawnWorker();
    workers.push(w);
    w.postMessage({ type: 'audit', id: 900, rows: pairRows(22) });
    setImmediate(() => w.postMessage({ type: 'cancel', id: 900 }));
    const msg = await waitMsg((m) => m.id === 900
      && ['canceled', 'done', 'error'].includes(m.type));
    assert.equal(msg.type, 'canceled');
  });

  test('取消后再跑的小任务成功；旧任务迟到 done 与 canceled 均不覆盖', async () => {
    const { w, waitMsg } = spawnWorker();
    workers.push(w);
    // 先取得一次成功结论
    w.postMessage({ type: 'audit', id: 901, rows: pairRows(5) });
    const ok1 = await waitMsg((m) => m.type === 'done' && m.id === 901);
    assert.equal(ok1.result.optimalCount, '32'); // 2^5
    let last = ok1.result;

    // 启动 44 条重任务并取消
    w.postMessage({ type: 'audit', id: 902, rows: pairRows(22) });
    setImmediate(() => w.postMessage({ type: 'cancel', id: 902 }));
    const canceled = await waitMsg((m) => m.type === 'canceled' && m.id === 902);
    assert.ok(canceled);

    // canceled 不覆盖最近成功
    last = reduceSuccess(last, canceled, 902);
    assert.equal(last, ok1.result);

    // 旧任务 902 的迟到 done（即便发生）也不得覆盖
    const staleDone = {
      type: 'done',
      id: 902,
      result: { totalPriority: '22', optimalCount: '4194304' },
    };
    const currentJobId = null; // 取消后已无运行任务
    assert.equal(reduceSuccess(last, staleDone, currentJobId), last);

    // 新任务成功后才更新结论
    w.postMessage({ type: 'audit', id: 903, rows: pairRows(8) });
    const ok3 = await waitMsg((m) => m.type === 'done' && m.id === 903);
    last = reduceSuccess(last, ok3, 903);
    assert.equal(last.optimalCount, '256'); // 2^8
  });
});
