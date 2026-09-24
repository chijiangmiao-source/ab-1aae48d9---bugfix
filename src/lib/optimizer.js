// 条码子库审计核心算法（无 DOM 依赖，可在 Node 与 Web Worker 中运行）
//
// 互斥判定：两条记录在 (正向, 正向)、(正向, 反向互补) 等全部组合下的
// 最小汉明距离，低于任一方阈值（取双方阈值较大值，更保守）即互斥。
// 自身反向互补距离不足阈值的记录直接丧失入选资格。
//
// 求解：最大权独立集（优先权和最大，平局再比记录数）。n <= 44，使用
// MITM（折半枚举，每半 <= 22）+ 子集最优 DP，精确计数全部双层最优方案，
// 并据全部最优方案把每条记录判定为 mandatory / optional / never，
// 规范结果按输入次序“选中优先（位向量 1 优先）”逐位裁决。

export class AuditCanceled extends Error {
  constructor() {
    super('AUDIT_CANCELED');
    this.name = 'AuditCanceled';
  }
}

const COMPLEMENT = { A: 'T', T: 'A', C: 'G', G: 'C' };

export function reverseComplement(seq) {
  let out = '';
  for (let i = seq.length - 1; i >= 0; i--) out += COMPLEMENT[seq[i]];
  return out;
}

export function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

// 规范化并校验录入。rows: [{ barcode: string, priority: number|string, threshold: number|string }]
// 优先权按十进制数字串直接转 BigInt，单条即使超过 2^53 也不丢精度；
// 阈值只需与（很小的）汉明距离比较，要求为安全正整数。
const POS_INT_RE = /^\d+$/;

export function normalizeRows(rows) {
  const errors = [];
  if (!Array.isArray(rows)) {
    return { ok: false, errors: ['录入内容无效。'], records: [] };
  }
  const n = rows.length;
  if (n < 10 || n > 44) {
    errors.push(`记录数必须为 10 至 44 条，当前为 ${n} 条。`);
  }

  const records = [];
  const seen = new Map();
  let expectedLen = null;

  rows.forEach((row, idx) => {
    const label = `第 ${idx + 1} 条`;
    const seq = String(row?.barcode ?? '').trim().toUpperCase();
    const seqOk = /^[ACGT]+$/.test(seq);
    if (!seqOk) errors.push(`${label}：条码必须为非空且仅含 A/C/G/T 的等长序列。`);

    const priorityStr = String(row?.priority ?? '').trim();
    const priorityOk = POS_INT_RE.test(priorityStr) && BigInt(priorityStr) >= 1n;
    if (!priorityOk) errors.push(`${label}：优先权必须为正整数。`);

    const thresholdStr = String(row?.threshold ?? '').trim();
    let threshold = NaN;
    const thresholdOk = POS_INT_RE.test(thresholdStr)
      && Number.isSafeInteger(threshold = Number(thresholdStr)) && threshold >= 1;
    if (!thresholdOk) errors.push(`${label}：距离阈值必须为正整数。`);

    if (seqOk) {
      if (expectedLen === null) {
        expectedLen = seq.length;
      } else if (seq.length !== expectedLen) {
        errors.push(`${label}：所有条码必须等长（首条长度为 ${expectedLen}）。`);
      }
      if (seen.has(seq)) {
        errors.push(`${label}：条码 ${seq} 与第 ${seen.get(seq) + 1} 条重复，标识必须唯一。`);
      } else {
        seen.set(seq, idx);
      }
    }

    if (seqOk && thresholdOk) {
      const rc = reverseComplement(seq);
      records.push({
        index: idx,
        seq,
        rc,
        priority: priorityOk ? BigInt(priorityStr) : 1n,
        threshold,
        // 自身反向互补距离不足：硬性丧失资格
        selfConflict: hamming(seq, rc) < threshold,
      });
    }
  });

  return { ok: errors.length === 0, errors, records: errors.length === 0 ? records : [] };
}

// 依据记录构建合格顶点上的冲突图。adj[i] 为 BigInt 位掩码（n <= 44）。
export function buildGraph(records) {
  const eligible = records.filter((r) => !r.selfConflict).map((r) => r.index);
  const m = eligible.length;
  const weights = new Array(m);
  const adj = new Array(m).fill(0n);

  for (let a = 0; a < m; a++) weights[a] = records[eligible[a]].priority;

  for (let a = 0; a < m; a++) {
    for (let b = a + 1; b < m; b++) {
      const ra = records[eligible[a]];
      const rb = records[eligible[b]];
      // d(rc(a), rc(b)) == d(a, b)，d(rc(a), b) == d(a, rc(b))，故只需两项
      const d = Math.min(hamming(ra.seq, rb.seq), hamming(ra.seq, rb.rc));
      if (d < Math.max(ra.threshold, rb.threshold)) {
        adj[a] |= 1n << BigInt(b);
        adj[b] |= 1n << BigInt(a);
      }
    }
  }
  return { eligible, weights, adj };
}

function better(w1, s1, w2, s2) {
  // w 为 BigInt（优先权和可达 44 * 2^53 量级，不能用浮点）
  if (w1 !== w2) return w1 > w2 ? 1 : -1;
  if (s1 !== s2) return s1 > s2 ? 1 : -1;
  return 0;
}

// 在冲突图上求双层最优独立集。
// weights: 正整数权值数组；adj: BigInt 邻接掩码数组。
// opts.shouldCancel(): 返回 true 时抛出 AuditCanceled
// opts.onProgress(p): 0..1 进度回调
// opts.tick(): 周期性 await 的异步让步点（Worker 借此让取消消息进入事件循环）；
//              其抛出的异常会原样传播
export async function solveGraph(weights, adj, opts = {}) {
  const shouldCancel = opts.shouldCancel ?? (() => false);
  const onProgress = opts.onProgress ?? (() => {});
  const tick = opts.tick ?? null;
  const n = weights.length;

  const status = new Array(n).fill('never');
  if (n === 0) {
    return {
      totalPriority: 0n,
      selectedCount: 0,
      optimalCount: 1n,
      canonical: new Uint8Array(0),
      status,
    };
  }

  // 折半：两半均不超过 22
  const n1 = Math.ceil(n / 2); // <= 22
  const n2 = n - n1;
  const fullABig = (1n << BigInt(n1)) - 1n;

  // 权值数组：优先权总和可超 int64（任意正整数），安全时走 BigInt64Array
  // 快速路径，溢出时回退到普通 BigInt 数组（结果代码完全一致）。
  let totalMax = 0n;
  for (const w of weights) totalMax += BigInt(w);
  const makeW = (len) =>
    totalMax < (1n << 62n)
      ? new BigInt64Array(len)
      : new Array(len).fill(0n);

  const na = new Int32Array(n1); // A 内部邻接（Number 位掩码）
  const wA = makeW(n1);
  for (let v = 0; v < n1; v++) {
    wA[v] = BigInt(weights[v]);
    na[v] = Number(adj[v] & fullABig);
  }

  const nb = new Int32Array(n2); // B 内部邻接（局部位掩码）
  const cross = new Uint32Array(n2); // B 顶点在 A 中的邻居
  const wB = makeW(n2);
  for (let u = 0; u < n2; u++) {
    const gi = n1 + u;
    wB[u] = BigInt(weights[gi]);
    cross[u] = Number(adj[gi] & fullABig);
    let m = 0;
    const bbits = adj[gi] >> BigInt(n1);
    for (let v = 0; v < n2; v++) if ((bbits >> BigInt(v)) & 1n) m |= 1 << v;
    nb[u] = m;
  }

  // ---------- A 侧子集 DP：g[mask] = mask 内（权, 数）双层最优独立集 ----------
  async function scanAllowedA(allowed) {
    let bestWeight = -1n;
    let bestSize = -1;
    let count = 0n;
    let contain = new Array(n1).fill(0n);
    let visits = 0;

    for (let candidate = allowed; ; candidate = (candidate - 1) & allowed) {
      let independent = true;
      let weight = 0n;
      let size = 0;
      let bits = candidate;
      while (bits) {
        const v = 31 - Math.clz32(bits);
        const bit = 1 << v;
        if (na[v] & candidate) {
          independent = false;
          break;
        }
        weight += wA[v];
        size++;
        bits ^= bit;
      }

      if (independent) {
        const cmp = better(weight, size, bestWeight, bestSize);
        if (cmp > 0) {
          bestWeight = weight;
          bestSize = size;
          count = 1n;
          contain = new Array(n1).fill(0n);
          for (let v = 0; v < n1; v++) if (candidate & (1 << v)) contain[v] = 1n;
        } else if (cmp === 0) {
          count++;
          for (let v = 0; v < n1; v++) if (candidate & (1 << v)) contain[v]++;
        }
      }

      if (candidate === 0) break;
      visits++;
      if ((visits & 0xffff) === 0) {
        if (tick) await tick();
        if (shouldCancel()) throw new AuditCanceled();
      }
    }

    return { weight: bestWeight, size: bestSize, count, contain };
  }

  // ---------- B 侧：显式栈枚举全部独立集（按批让出事件循环，响应取消） ----------
  const cap = n2 === 0 ? 1 : 1 << n2;
  const yMask = new Uint32Array(cap);
  const yForb = new Uint32Array(cap); // 该集合在 A 中封锁的顶点
  const yW = makeW(cap);
  const yS = new Uint8Array(cap);
  let K = 0;

  // 显式 DFS：栈上最多保留“每层一个左兄弟 + 当前路径”，深度上界 2*n2+2
  const stackCap = 2 * n2 + 4;
  const sI = new Int32Array(stackCap);
  const sMask = new Uint32Array(stackCap);
  const sW = makeW(stackCap);
  const sS = new Int32Array(stackCap);
  const sForb = new Uint32Array(stackCap);
  const sBlock = new Uint32Array(stackCap);
  let top = 0;
  sI[top] = 0; top++; // 根帧

  let nodes = 0;
  const BATCH = 1 << 16;
  while (top > 0) {
    for (let budget = BATCH; budget-- > 0 && top > 0; ) {
      top--;
      const i = sI[top];
      const mask = sMask[top];
      const w = sW[top];
      const s = sS[top];
      const forb = sForb[top];
      const blocked = sBlock[top];
      nodes++;

      if (i === n2) {
        yMask[K] = mask;
        yForb[K] = forb;
        yW[K] = w;
        yS[K] = s;
        K++;
        continue;
      }

      // 排除 i（先入栈）
      sI[top] = i + 1; sMask[top] = mask; sW[top] = w;
      sS[top] = s; sForb[top] = forb; sBlock[top] = blocked;
      top++;

      // 选 i（与已选 B 顶点不相邻时；后入栈先处理，顺序不影响结果）
      const bit = 1 << i;
      if (!(blocked & bit)) {
        sI[top] = i + 1; sMask[top] = mask | bit; sW[top] = w + wB[i];
        sS[top] = s + 1; sForb[top] = forb | cross[i]; sBlock[top] = blocked | nb[i];
        top++;
      }
    }

    if (top > 0) {
      onProgress(Math.min(0.99, nodes / (2 * cap)));
      if (tick) await tick();
      if (shouldCancel()) throw new AuditCanceled();
    }
  }
  onProgress(1);

  const fullA = n1 === 0 ? 0 : (1 << n1) - 1;

  // ---------- 第一遍扫描：确定全局双层最优 (bestW, bestS) ----------
  let bestW = -1n;
  let bestS = -1;
  for (let k = 0; k < K; k++) {
    const m = fullA & ~yForb[k];
    const a = await scanAllowedA(m);
    const W = yW[k] + a.weight;
    const S = yS[k] + a.size;
    if (better(W, S, bestW, bestS) > 0) {
      bestW = W;
      bestS = S;
    }
  }

  // ---------- 第二遍：任意精度计数 + 各顶点出现在最优方案中的次数 ----------
  let total = 0n;
  const containA = new Array(n1).fill(0n);
  const containB = new Array(n2).fill(0n);
  for (let k = 0; k < K; k++) {
    if ((k & 0xffff) === 0) {
      if (tick) await tick();
      if (shouldCancel()) throw new AuditCanceled();
    }
    const m = fullA & ~yForb[k];
    const a = await scanAllowedA(m);
    const W = yW[k] + a.weight;
    const S = yS[k] + a.size;
    if (W !== bestW || S !== bestS) continue;
    const cnt = a.count;
    total += cnt;

    // B 顶点：随 Y 直接计入
    let bits = yMask[k];
    while (bits) {
      const b = 31 - Math.clz32(bits);
      containB[b] += cnt;
      bits ^= 1 << b;
    }

    // A 顶点：在固定 Y 下，统计取到 g[m] 且包含 v 的 A 最优集数量
    for (let v = 0; v < n1; v++) {
      containA[v] += a.contain[v];
    }
  }

  for (let v = 0; v < n1; v++) {
    status[v] = containA[v] === 0n ? 'never' : containA[v] === total ? 'mandatory' : 'optional';
  }
  for (let u = 0; u < n2; u++) {
    status[n1 + u] = containB[u] === 0n ? 'never' : containB[u] === total ? 'mandatory' : 'optional';
  }

  // ---------- 规范位向量：输入次序下“选中优先”的逐位贪心 ----------
  // 按输入次序逐位裁决：某位能取 1（存在与此前裁决相容的最优方案）则取 1，
  // 否则取 0。结果是所有最优位向量中字典序最大者（1 优先的规范代表）。
  let pa = 0, qa = 0, pb = 0, qb = 0;
  const chosen = new Uint8Array(n);

  async function existsOptimal() {
    let block = 0;
    let wpa = 0n;
    let spa = 0;
    let bits = pa;
    while (bits) {
      const v = 31 - Math.clz32(bits);
      block |= na[v];
      wpa += wA[v];
      spa++;
      bits ^= 1 << v;
    }
    if (pa & block) return false; // 强制选中集合内部冲突
    const allowed = fullA & ~qa & ~pa & ~block;
    for (let k = 0; k < K; k++) {
      if ((k & 0xffff) === 0) {
        if (tick) await tick();
        if (shouldCancel()) throw new AuditCanceled();
      }
      const ym = yMask[k];
      if ((ym & pb) !== pb) continue;
      if (ym & qb) continue;
      if (yForb[k] & pa) continue;
      const m = allowed & ~yForb[k];
      const a = await scanAllowedA(m);
      if (yW[k] + wpa + a.weight === bestW && yS[k] + spa + a.size === bestS) {
        return true;
      }
    }
    return false;
  }

  for (let v = 0; v < n; v++) {
    if (shouldCancel()) throw new AuditCanceled();
    if (v < n1) {
      pa |= 1 << v;
      if (await existsOptimal()) {
        chosen[v] = 1;
      } else {
        pa ^= 1 << v;
        qa |= 1 << v;
      }
    } else {
      const u = v - n1;
      pb |= 1 << u;
      if (await existsOptimal()) {
        chosen[v] = 1;
      } else {
        pb ^= 1 << u;
        qb |= 1 << u;
      }
    }
  }

  return {
    totalPriority: bestW,
    selectedCount: bestS,
    optimalCount: total,
    canonical: chosen,
    status,
  };
}

// 对校验通过的 records 执行完整审计，返回按原始录入顺序排列的结果。
export async function auditRecords(records, opts = {}) {
  const { eligible, weights, adj } = buildGraph(records);
  const sol = await solveGraph(weights, adj, opts);

  const n = records.length;
  const canonical = new Uint8Array(n);
  const status = new Array(n).fill('never');
  const selectedIndices = [];
  for (let li = 0; li < eligible.length; li++) {
    const gi = eligible[li];
    canonical[gi] = sol.canonical[li];
    status[gi] = sol.status[li];
    if (sol.canonical[li]) selectedIndices.push(gi);
  }

  return {
    totalPriority: sol.totalPriority,
    selectedCount: sol.selectedCount,
    optimalCount: sol.optimalCount,
    canonical,
    status,
    selectedIndices,
    eligible,
    bitVector: Array.from(canonical).join(''),
  };
}
