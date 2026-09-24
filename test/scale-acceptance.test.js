// 产品规模验收：按审计页规则生成 22 个互斥对（X0..X21 / Y0..Y21，长度 24），
// 核对 44 条（规模上限）在 15 秒内返回完整结论；再以多个较小配对规模复核
// 同优计数、归属与规范位向量随规模一致变化；并确认运行中可取消、
// 取消/旧任务迟到消息不覆盖最近一次成功结论。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import {
  normalizeRows,
  auditRecords,
  solveGraph,
  buildGraph,
  connectedComponents,
  AuditCanceled,
} from '../src/lib/optimizer.js';
import { classifyMessage, reduceSuccess } from '../src/lib/protocol.js';

const L = 24;

// 严格按题目规则生成：
//   Xi：24 个 A，将左起零基位置 i 改为 C（i = 0..pairs-1）
//   Yi：复制对应 Xi，将最后一位（零基位置 23）改为 G
// 录入顺序：全部 X 在前、全部 Y 在后；优先权均为 1、距离阈值均为 2。
function makePairRows(pairs) {
  const xs = [];
  for (let i = 0; i < pairs; i++) {
    const chars = 'A'.repeat(L).split('');
    chars[i] = 'C';
    xs.push(chars.join(''));
  }
  const rows = xs.map((x) => ({ barcode: x, priority: '1', threshold: '2' }));
  for (const x of xs) {
    const y = x.slice(0, L - 1) + 'G';
    rows.push({ barcode: y, priority: '1', threshold: '2' });
  }
  return rows;
}

// 规模为 pairs 时的期望结论
function expected(pairs) {
  return {
    totalPriority: BigInt(pairs),
    selectedCount: pairs,
    optimalCount: 1n << BigInt(pairs), // 每对二选一，互相独立 => 2^pairs
    bitVector: '1'.repeat(pairs) + '0'.repeat(pairs),
  };
}

describe('产品规模验收（22 个互斥对 / 44 条，长度 24）', () => {
  test('录入数据构造正确：44 条唯一 24mer，无自冲突，冲突图恰为 22 条孤立边', () => {
    const rows = makePairRows(22);
    assert.equal(rows.length, 44);
    const parsed = normalizeRows(rows);
    assert.equal(parsed.ok, true, parsed.errors.join('; '));
    assert.equal(parsed.records.length, 44);
    assert.ok(parsed.records.every((r) => r.seq.length === 24));
    assert.equal(new Set(parsed.records.map((r) => r.seq)).size, 44);
    assert.equal(parsed.records.filter((r) => r.selfConflict).length, 0);

    const { adj } = buildGraph(parsed.records);
    // 每条顶点恰好与一个顶点相邻：Xi 只冲突 Yi，跨编号互不冲突
    const deg = adj.map((m) => {
      let d = 0;
      let b = m;
      while (b) { b &= b - 1n; d++; }
      return d;
    });
    assert.ok(deg.every((d) => d === 1), `度数分布异常：${JSON.stringify(deg)}`);
    const comps = connectedComponents(parsed.records.map(() => 1n), adj);
    assert.equal(comps.length, 22);
    assert.ok(comps.every((c) => c.length === 2));
  });

  test('44 条在 15 秒内返回完整且正确的结论', async () => {
    const parsed = normalizeRows(makePairRows(22));
    assert.equal(parsed.ok, true);

    const t0 = Date.now();
    const res = await auditRecords(parsed.records);
    const elapsed = Date.now() - t0;

    const exp = expected(22);
    assert.equal(res.totalPriority, exp.totalPriority);       // 最大优先权总和 22
    assert.equal(res.selectedCount, exp.selectedCount);       // 入选记录数 22
    assert.equal(res.optimalCount, exp.optimalCount);         // 同优方案数 4194304
    assert.equal(res.optimalCount, 4194304n);
    assert.equal(res.bitVector, exp.bitVector);               // 22 个 1 后接 22 个 0
    assert.equal(res.bitVector.length, 44);
    assert.ok(res.status.every((s) => s === 'optional'));     // 44 条均为“可选”
    assert.ok(res.canonical.every((v, i) => v === (i < 22 ? 1 : 0)));
    assert.deepEqual(res.selectedIndices, [...Array(22).keys()]);

    assert.ok(
      elapsed < 15000,
      `产品规模审计应在 15 秒内完成，实际耗时 ${elapsed}ms`,
    );
  });

  test('Worker 端到端：done 消息携带序列化后的完整正确结论', async () => {
    const w = new Worker(new URL('../src/web/worker.js', import.meta.url));
    try {
      w.postMessage({ type: 'audit', id: 1, rows: makePairRows(22) });
      const msg = await Promise.race([
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Worker 15 秒内未返回结论')), 15000);
          w.on('message', (m) => {
            if (m.type === 'done' || m.type === 'error' || m.type === 'invalid') {
              clearTimeout(timer);
              resolve(m);
            }
          });
        }),
      ]);
      assert.equal(msg.type, 'done');
      assert.equal(msg.id, 1);
      assert.equal(msg.result.totalPriority, '22');
      assert.equal(msg.result.optimalCount, '4194304');
      assert.equal(msg.result.selectedCount, 22);
      assert.equal(msg.result.bitVector, '1'.repeat(22) + '0'.repeat(22));
      assert.ok(msg.result.status.length === 44);
      assert.ok(msg.result.status.every((s) => s === 'optional'));
    } finally {
      await w.terminate();
    }
  });
});

describe('较小配对规模复核：计数 / 归属 / 规范位向量随规模一致变化', () => {
  // 5..13 对（10..26 条）均满足录入下限 10；另含 21 对（42 条）贴近上限
  for (const pairs of [5, 8, 11, 13, 21]) {
    test(`pairs=${pairs}（${pairs * 2} 条）：2^${pairs}=${2 ** pairs} 个同优方案，全部可选，规范位向量前半全 1`, async () => {
      const parsed = normalizeRows(makePairRows(pairs));
      assert.equal(parsed.ok, true, parsed.errors.join('; '));
      const res = await auditRecords(parsed.records);
      const exp = expected(pairs);
      assert.equal(res.totalPriority, exp.totalPriority, `pairs=${pairs} 权和`);
      assert.equal(res.selectedCount, exp.selectedCount, `pairs=${pairs} 记录数`);
      assert.equal(res.optimalCount, exp.optimalCount, `pairs=${pairs} 同优计数`);
      assert.equal(res.optimalCount, BigInt(2 ** pairs));
      assert.equal(res.bitVector, exp.bitVector, `pairs=${pairs} 位向量`);
      assert.equal(res.bitVector.length, pairs * 2);
      assert.ok(res.status.every((s) => s === 'optional'), `pairs=${pairs} 归属应全为可选`);
      assert.deepEqual(
        res.selectedIndices,
        [...Array(pairs).keys()],
        `pairs=${pairs} 规范结果应选中全部 X`,
      );
    });
  }

  test('规模每增加一对，同优方案数翻倍且权和/记录数各加 1', async () => {
    let prev = null;
    for (const pairs of [5, 6, 7, 8]) {
      const res = await auditRecords(normalizeRows(makePairRows(pairs)).records);
      if (prev) {
        assert.equal(res.optimalCount, prev.optimalCount * 2n);
        assert.equal(res.totalPriority, prev.totalPriority + 1n);
        assert.equal(res.selectedCount, prev.selectedCount + 1);
      }
      prev = res;
    }
  });
});

describe('产品规模数据上的取消语义', () => {
  test('运行中的 44 条审计在分量边界响应取消（抛出 AuditCanceled）', async () => {
    const parsed = normalizeRows(makePairRows(22));
    const { weights, adj } = buildGraph(parsed.records);
    let sawProgress = false;
    await assert.rejects(
      () => solveGraph(weights, adj, {
        tick: async () => {},
        onProgress: (p) => { if (p > 0) sawProgress = true; },
        // 首次进度后请求取消：22 个分量的下一边界让步点即应中止
        shouldCancel: () => sawProgress,
      }),
      AuditCanceled,
    );
  });
});

describe('取消与旧任务迟到消息不覆盖最近一次成功结论', () => {
  test('成功结论之后：当前任务 canceled 与旧任务迟到 done/invalid 均被保留策略挡住', () => {
    const r1 = { totalPriority: '22', optimalCount: '4194304', bitVector: '1'.repeat(22) + '0'.repeat(22) };
    const stale = { totalPriority: '999', optimalCount: '1' };

    // 当前任务 id=2 已成功
    let current = reduceSuccess(null, { type: 'done', id: 2, result: r1 }, 2);
    assert.equal(current, r1);

    // 同任务的取消消息不覆盖
    assert.equal(classifyMessage({ type: 'canceled', id: 2 }, 2).kind, 'canceled');
    current = reduceSuccess(current, { type: 'canceled', id: 2 }, 2);
    assert.equal(current, r1);

    // 旧任务 id=1 的迟到 done（携带伪造结论）不覆盖
    assert.equal(classifyMessage({ type: 'done', id: 1, result: stale }, 2).kind, 'stale');
    current = reduceSuccess(current, { type: 'done', id: 1, result: stale }, 2);
    assert.equal(current, r1);

    // 旧任务迟到 invalid/error/progress 不覆盖
    for (const t of ['invalid', 'error', 'progress']) {
      current = reduceSuccess(current, { type: t, id: 1, result: stale }, 2);
      assert.equal(current, r1, `旧任务 ${t} 不应覆盖成功结论`);
    }

    // 新任务 id=3 的成功结论正常更新
    const r3 = { totalPriority: '5', optimalCount: '32' };
    current = reduceSuccess(current, { type: 'done', id: 3, result: r3 }, 3);
    assert.equal(current, r3);
  });
});
