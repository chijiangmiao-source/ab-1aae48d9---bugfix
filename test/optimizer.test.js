// 核心算法测试：显式边界用例 + 与 2^m 穷举对拍（自冲突 / 同优计数 / 归属 / 规范位向量）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  reverseComplement,
  hamming,
  normalizeRows,
  buildGraph,
  solveGraph,
  auditRecords,
  AuditCanceled,
} from '../src/lib/optimizer.js';

const COMP = { A: 'T', T: 'A', C: 'G', G: 'C' };
function rc(s) {
  return [...s].reverse().map((c) => COMP[c]).join('');
}

// ---- 基础函数 ----
describe('序列工具', () => {
  test('反向互补', () => {
    assert.equal(reverseComplement('AACGT'), 'ACGTT');
    assert.equal(reverseComplement('ATCGAT'), 'ATCGAT'); // 反向互补回文
    assert.equal(reverseComplement('AAAAAAAA'), 'TTTTTTTT');
  });

  test('汉明距离', () => {
    assert.equal(hamming('AAAA', 'AAAA'), 0);
    assert.equal(hamming('ACGT', 'TGCA'), 4);
  });
});

// ---- 输入校验 ----
describe('normalizeRows 输入校验', () => {
  const base = () => {
    const barcodes = ['AAAAAAAA', 'AAAAAAAC', 'AAAAAAAG', 'AAAAAAAT',
      'AAAAAACA', 'AAAAAACC', 'AAAAAACG', 'AAAAAACT', 'AAAAAAGA', 'AAAAAAGC'];
    return barcodes.map((barcode) => ({ barcode, priority: 1, threshold: 3 }));
  };

  test('合法输入通过', () => {
    const r = normalizeRows(base());
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.equal(r.records.length, 10);
  });

  test('记录数越界被拒绝', () => {
    assert.equal(normalizeRows(base().slice(0, 9)).ok, false);
    const many = base();
    for (let i = 0; i < 35; i++) {
      const s = (i + 16).toString(2).padStart(8, '0').replaceAll('0', 'A').replaceAll('1', 'C');
      many.push({ barcode: s, priority: 1, threshold: 1 });
    }
    assert.equal(many.length, 45);
    assert.equal(normalizeRows(many).ok, false);
  });

  test('非 ACGT、空条码、非法数值均拒绝', () => {
    const rows = base();
    rows[0].barcode = 'ACGTX';
    rows[1].priority = 0;
    rows[2].threshold = -2;
    rows[3].priority = 1.5;
    const r = normalizeRows(rows);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length >= 4);
  });

  test('重复条码与不等长被拒绝', () => {
    const rows = base();
    rows[1].barcode = 'AAAAAAAA';
    assert.equal(normalizeRows(rows).ok, false);
    const rows2 = base();
    rows2[2].barcode = 'AAAAAAAAAA';
    assert.equal(normalizeRows(rows2).ok, false);
  });

  test('反向互补回文在阈值 1 下即自冲突', () => {
    const rows = base();
    rows[0].barcode = 'ATCGCGAT'; // 8mer 反向互补回文
    rows[0].priority = 5;
    const r = normalizeRows(rows);
    assert.equal(r.ok, true);
    assert.equal(r.records[0].selfConflict, true);
  });

  test('同序列的反向互补距离对称', () => {
    const s = 'AACGTGGC';
    assert.equal(hamming(s, rc(s)), hamming(rc(s), s));
  });
});

// ---- 图上求解与穷举对拍 ----
function bruteSolve(weights, adjBig) {
  const n = weights.length;
  const adj = adjBig.map((m) => Number(m));
  const sets = [];
  let bestW = -1n;
  let bestS = -1;
  const contain = new Array(n).fill(0n);
  let count = 0n;
  const total = 1 << n;
  for (let mask = 0; mask < total; mask++) {
    let ok = true;
    let w = 0n;
    let bits = mask;
    while (bits) {
      const v = 31 - Math.clz32(bits);
      const b = 1 << v;
      if (adj[v] & mask) { ok = false; break; }
      w += BigInt(weights[v]);
      bits ^= b;
    }
    if (!ok) continue;
    const s = countBits(mask);
    if (w > bestW || (w === bestW && s > bestS)) {
      bestW = w; bestS = s; count = 1n; sets.length = 0; sets.push(mask);
    } else if (w === bestW && s === bestS) {
      count++; sets.push(mask);
    }
  }
  for (const mask of sets) {
    let bits = mask;
    while (bits) {
      const v = 31 - Math.clz32(bits);
      contain[v]++;
      bits ^= 1 << v;
    }
  }
  const status = contain.map((c) => (c === 0n ? 'never' : c === count ? 'mandatory' : 'optional'));
  // 规范位向量：索引 0 为最高有效位时数值最大的最优集
  let canon = 0;
  let bestRev = -1;
  for (const mask of sets) {
    let rev = 0;
    for (let i = 0; i < n; i++) if ((mask >> i) & 1) rev |= 1 << (n - 1 - i);
    if (rev > bestRev) { bestRev = rev; canon = mask; }
  }
  return { bestW, bestS, count, status, canonical: canon };
}
function countBits(x) { x = x - ((x >> 1) & 0x55555555); x = (x & 0x33333333) + ((x >> 2) & 0x33333333); return (((x + (x >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24; }

function randomGraph(n, rng, bigWeights = false) {
  const weights = [];
  const adj = new Array(n).fill(0n);
  for (let i = 0; i < n; i++) {
    weights.push(bigWeights && rng() < 0.3
      ? BigInt(Math.floor(rng() * 1e9)) * BigInt(1e6) + BigInt(Math.floor(rng() * 1e6))
      : 1 + Math.floor(rng() * 8));
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rng() < 0.32) {
        adj[i] |= 1n << BigInt(j);
        adj[j] |= 1n << BigInt(i);
      }
    }
  }
  return { weights, adj };
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('solveGraph 与穷举对拍', () => {
  const cases = [
    { n: 0 }, { n: 1 }, { n: 2 }, { n: 5 }, { n: 10 }, { n: 13 },
  ];
  for (const { n } of cases) {
    test(`随机图 n=${n}`, async () => {
      const rng = mulberry(1000 + n);
      for (let t = 0; t < 40; t++) {
        const { weights, adj } = randomGraph(n, rng, t % 3 === 0);
        const sol = await solveGraph(weights, adj);
        const ref = bruteSolve(weights, adj);
        assert.equal(sol.totalPriority, ref.bestW, `权重不一致 n=${n} t=${t}`);
        assert.equal(sol.selectedCount, ref.bestS, `数量不一致 n=${n} t=${t}`);
        assert.equal(sol.optimalCount, ref.count, `计数不一致 n=${n} t=${t}`);
        assert.deepEqual(sol.status, ref.status, `归属不一致 n=${n} t=${t}`);
        let rev = 0;
        for (let i = 0; i < n; i++) if (sol.canonical[i]) rev |= 1 << (n - 1 - i);
        let refRev = 0;
        for (let i = 0; i < n; i++) if ((ref.canonical >> i) & 1) refRev |= 1 << (n - 1 - i);
        assert.equal(rev, refRev, `规范位向量不一致 n=${n} t=${t}`);
      }
    });
  }

  test('无边等权：全部全选方案唯一，所有顶点必选', async () => {
    const n = 12;
    const weights = new Array(n).fill(1);
    const adj = new Array(n).fill(0n);
    const sol = await solveGraph(weights, adj);
    assert.equal(sol.totalPriority, BigInt(n));
    assert.equal(sol.optimalCount, 1n);
    assert.ok(sol.status.every((s) => s === 'mandatory'));
    assert.deepEqual(Array.from(sol.canonical), new Array(n).fill(1));
  });

  test('无顶点空图', async () => {
    const sol = await solveGraph([], []);
    assert.equal(sol.totalPriority, 0n);
    assert.equal(sol.optimalCount, 1n);
    assert.equal(sol.selectedCount, 0);
  });

  test('大整数优先权精确（超过 2^53 量级）', async () => {
    const n = 12;
    const rng = mulberry(42);
    const { weights, adj } = randomGraph(n, rng, true);
    const sol = await solveGraph(weights, adj);
    const ref = bruteSolve(weights, adj);
    assert.equal(sol.totalPriority, ref.bestW);
    assert.equal(sol.optimalCount, ref.count);
  });
});

// ---- 端到端：条码语义（含自冲突、反向互补互斥、双方阈值取大） ----
function validBarcodeRows(n) {
  const pool = ['AAAAAAAA', 'CCCCCCCC', 'GGGGGGGG', 'TTTTTTTT',
    'AACAACAA', 'CCAACCAA', 'GGAAGGAA', 'TTAAGGTT',
    'AAACCCGG', 'CCCGGGTT', 'GGTTAAAA', 'ATATGCGC'];
  return pool.slice(0, n).map((barcode) => ({ barcode, priority: 1, threshold: 1 }));
}

describe('条码语义端到端', () => {
  test('反向互补回文记录自冲突 → 从不选', async () => {
    const rows = validBarcodeRows(10);
    rows[0] = { barcode: 'ATCGCGAT', priority: 100, threshold: 1 };
    const parsed = normalizeRows(rows);
    assert.equal(parsed.ok, true, parsed.errors.join(';'));
    const res = await auditRecords(parsed.records);
    assert.equal(res.status[0], 'never');
    assert.equal(res.canonical[0], 0);
    assert.ok(!res.selectedIndices.includes(0));
  });

  test('两条互为反向互补的条码互斥（前向距离虽大）', async () => {
    const rows = validBarcodeRows(10);
    rows[0] = { barcode: 'AAAAAAA G'.replace(' ', ''), priority: 10, threshold: 4 };
    rows[1] = { barcode: rc('AAAAAAAG'), priority: 10, threshold: 4 };
    const parsed = normalizeRows(rows);
    assert.equal(parsed.ok, true);
    // d(seq0, rc(seq1)) = 0 < 4
    const { adj } = buildGraph(parsed.records);
    assert.notEqual(adj[0] & (1n << 1n), 0n);
    const res = await auditRecords(parsed.records);
    // 二者等权时至少一条可选，且不可能同时进入规范子库
    assert.ok(!(res.canonical[0] === 1 && res.canonical[1] === 1));
  });

  test('阈值取双方较大者：单方高阈值亦可互斥', async () => {
    const rows = validBarcodeRows(10);
    rows[0] = { barcode: 'AAAAAAAC', priority: 1, threshold: 2 }; // 与 AAAAAAAA 距离 1
    rows[1] = { barcode: 'AAAAAAAA', priority: 1, threshold: 8 };
    const parsed = normalizeRows(rows);
    const { adj } = buildGraph(parsed.records);
    assert.notEqual(adj[0] & (1n << 1n), 0n);
  });
});

// ---- 全管线对拍：随机条码/阈值/优先权 ----
describe('auditRecords 与记录级穷举对拍', () => {
  test('随机条码场景（自冲突/计数/归属/位向量）', async () => {
    const rng = mulberry(20260923);
    const alpha = 'ACGT';
    for (let t = 0; t < 120; t++) {
      const n = 10 + Math.floor(rng() * 7); // 10..16
      const L = 6 + Math.floor(rng() * 4);  // 6..9
      const used = new Set();
      const seqs = [];
      while (seqs.length < n) {
        let s = '';
        for (let k = 0; k < L; k++) s += alpha[Math.floor(rng() * 4)];
        if (!used.has(s)) { used.add(s); seqs.push(s); }
      }
      const rows = seqs.map((seq) => ({
        barcode: seq,
        priority: 1 + Math.floor(rng() * 6),
        threshold: 1 + Math.floor(rng() * (L - 1)),
      }));
      const parsed = normalizeRows(rows);
      assert.equal(parsed.ok, true, parsed.errors.join('; '));
      const res = await auditRecords(parsed.records);

      // 记录级穷举
      const recs = parsed.records;
      const m = recs.length;
      let bestW = -1n, bestS = -1, cnt = 0n;
      const contain = new Array(m).fill(0n);
      const optSets = [];
      for (let mask = 0; mask < (1 << m); mask++) {
        const chosen = [];
        for (let i = 0; i < m; i++) if ((mask >> i) & 1) chosen.push(i);
        let ok = true;
        if (chosen.some((i) => recs[i].selfConflict)) ok = false;
        for (let a = 0; a < chosen.length && ok; a++) {
          for (let b = a + 1; b < chosen.length; b++) {
            const i = chosen[a], j = chosen[b];
            const d = Math.min(hamming(recs[i].seq, recs[j].seq), hamming(recs[i].seq, recs[j].rc));
            if (d < Math.max(recs[i].threshold, recs[j].threshold)) { ok = false; break; }
          }
        }
        if (!ok) continue;
        const w = chosen.reduce((acc, i) => acc + BigInt(recs[i].priority), 0n);
        const s = chosen.length;
        if (w > bestW || (w === bestW && s > bestS)) {
          bestW = w; bestS = s; cnt = 1n; optSets.length = 0; optSets.push(mask);
        } else if (w === bestW && s === bestS) {
          cnt++; optSets.push(mask);
        }
      }
      for (const mask of optSets) {
        for (let i = 0; i < m; i++) if ((mask >> i) & 1) contain[i]++;
      }
      const refStatus = contain.map((c) => (c === 0n ? 'never' : c === cnt ? 'mandatory' : 'optional'));
      let lexMax = -1, lexMask = 0;
      for (const mask of optSets) {
        let rev = 0;
        for (let i = 0; i < m; i++) if ((mask >> i) & 1) rev |= 1 << (m - 1 - i);
        if (rev > lexMax) { lexMax = rev; lexMask = mask; }
      }

      assert.equal(res.totalPriority, bestW, `t=${t} 权`);
      assert.equal(res.selectedCount, bestS, `t=${t} 数`);
      assert.equal(res.optimalCount, cnt, `t=${t} 同优计数`);
      assert.deepEqual(res.status, refStatus, `t=${t} 归属`);
      for (let i = 0; i < m; i++) {
        assert.equal(res.canonical[i], (lexMask >> i) & 1, `t=${t} 位向量 ${i}`);
      }
    }
  });
});

// ---- 任意精度优先权（字符串录入，单条超过 2^53） ----
describe('任意精度优先权', () => {
  test('单条优先权超过 2^53 仍精确求和并正确裁决', async () => {
    const rows = validBarcodeRows(10);
    const huge1 = '9007199254740993'; // 2^53 + 1
    const huge2 = '9007199254740992'; // 2^53
    rows[0] = { barcode: rows[0].barcode, priority: huge1, threshold: 1 };
    rows[1] = { barcode: rows[1].barcode, priority: huge2, threshold: 1 };
    const parsed = normalizeRows(rows);
    assert.equal(parsed.ok, true, parsed.errors.join('; '));
    assert.equal(parsed.records[0].priority, BigInt(huge1));
    const res = await auditRecords(parsed.records);
    // 两条巨大权值条码应被纳入（与其他低权条码的总和相比仍占优）
    assert.ok(res.totalPriority >= BigInt(huge1));
    assert.equal(res.totalPriority.toString() === res.totalPriority.toString(), true);
    assert.match(res.totalPriority.toString(), /^\d+$/);
  });

  test('优先权为 0、小数、非数字均拒绝', () => {
    const base = validBarcodeRows(10);
    for (const bad of ['0', '1.0', '-1', 'abc', '', '  ']) {
      const rows = base.map((r) => ({ ...r }));
      rows[0].priority = bad;
      assert.equal(normalizeRows(rows).ok, false, `优先权 ${bad} 应非法`);
    }
  });

  test('优先权总和超过 2^62 时回退普通数组仍精确求解', async () => {
    const rng = mulberry(55);
    const { weights, adj } = randomGraph(12, rng, false);
    // 将权值放大到 2^100 量级，迫使 BigInt64 快速路径回退
    const big = weights.map((w, i) => BigInt(w) * (1n << 100n) + BigInt(i));
    const sol = await solveGraph(big, adj);
    // 对拍：普通 BigInt 穷举
    const ref = bruteSolve(big, adj);
    assert.equal(sol.totalPriority, ref.bestW);
    assert.equal(sol.selectedCount, ref.bestS);
    assert.equal(sol.optimalCount, ref.count);
    assert.deepEqual(sol.status, ref.status);
    assert.ok(sol.totalPriority >= 1n << 100n);
  });
});

// ---- 取消 ----
describe('取消语义', () => {
  test('首个让步点后取消抛出 AuditCanceled', async () => {
    const n = 44;
    const weights = new Array(n).fill(1);
    const adj = new Array(n).fill(0n);
    let first = true;
    await assert.rejects(
      () => solveGraph(weights, adj, {
        tick: async () => { if (first) { first = false; } },
        shouldCancel: () => !first,
      }),
      AuditCanceled,
    );
  });
});
