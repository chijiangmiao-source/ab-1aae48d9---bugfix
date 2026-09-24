// Web Worker：在后台线程执行审计，避免阻塞页面。
// 协议（均以 id 关联任务，主线程据此丢弃旧任务的迟到消息）：
//   主线程 -> Worker: { type: 'audit', id, rows } / { type: 'cancel', id }
//   Worker -> 主线程:
//     { type: 'progress', id, p }
//     { type: 'invalid',  id, errors }
//     { type: 'done',     id, result }   result 中 BigInt 已序列化为字符串
//     { type: 'canceled', id }
//     { type: 'error',    id, message }
import { normalizeRows, auditRecords, AuditCanceled } from '../lib/optimizer.js';

// 不使用顶层 await，初始化放入 IIFE；浏览器走 self，Node worker_threads 仅用于测试。
(async () => {
  let post;
  let setHandler;
  if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
    post = (msg) => self.postMessage(msg);
    setHandler = (fn) => { self.onmessage = (e) => fn(e.data); };
  } else {
    const { parentPort } = await import('node:worker_threads');
    post = (msg) => parentPort.postMessage(msg);
    setHandler = (fn) => parentPort.on('message', fn);
  }

  let currentId = null;
  let cancelRequested = false;

  setHandler((msg) => {
    msg = msg || {};

    if (msg.type === 'cancel') {
      if (msg.id === currentId) cancelRequested = true;
      return;
    }

    if (msg.type !== 'audit') return;

    // 新任务取代旧任务：旧 runAudit 会在最近让步点自行中止
    currentId = msg.id;
    cancelRequested = false;
    runAudit(msg.id, msg.rows);
  });

  // 让步到事件循环：使排队中的 cancel 消息可被处理（scheduler.yield 或 setTimeout）
  const yieldToLoop = () =>
    new Promise((resolve) => {
      if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
        scheduler.yield().then(resolve);
      } else {
        setTimeout(resolve, 0);
      }
    });

  async function runAudit(id, rows) {
    const parsed = normalizeRows(rows);
    if (!parsed.ok) {
      post({ type: 'invalid', id, errors: parsed.errors });
      return;
    }

    try {
      const result = await auditRecords(parsed.records, {
        // 显式取消，或被更新的任务取代，均中止（迟到结果带旧 id 会被主线程丢弃）
        shouldCancel: () => cancelRequested || currentId !== id,
        tick: yieldToLoop,
        onProgress: (p) => {
          post({ type: 'progress', id, p });
        },
      });
      post({
        type: 'done',
        id,
        result: {
          ...result,
          // 任意精度整数跨线程边界以十进制字符串传递
          totalPriority: result.totalPriority.toString(),
          optimalCount: result.optimalCount.toString(),
        },
      });
    } catch (err) {
      if (err instanceof AuditCanceled) {
        post({ type: 'canceled', id });
      } else {
        post({ type: 'error', id, message: (err && err.message) || String(err) });
      }
    }
  }
})();
