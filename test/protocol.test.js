// 陈旧消息防护纯函数测试。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMessage, reduceSuccess, TERMINAL_TYPES } from '../src/lib/protocol.js';

describe('classifyMessage', () => {
  test('当前任务的已知消息按类型分类', () => {
    assert.deepEqual(classifyMessage({ type: 'progress', id: 7 }, 7), { kind: 'progress', terminal: false });
    assert.deepEqual(classifyMessage({ type: 'done', id: 7 }, 7), { kind: 'done', terminal: true });
    for (const t of ['invalid', 'canceled', 'error', 'done']) {
      assert.ok(TERMINAL_TYPES.has(t));
      assert.equal(classifyMessage({ type: t, id: 1 }, 1).terminal, true);
    }
  });

  test('旧任务迟到消息一律 stale（含终止消息）', () => {
    assert.deepEqual(classifyMessage({ type: 'done', id: 6 }, 7), { kind: 'stale' });
    assert.deepEqual(classifyMessage({ type: 'canceled', id: 6 }, 7), { kind: 'stale' });
    assert.deepEqual(classifyMessage({ type: 'progress', id: 6 }, 7), { kind: 'stale' });
  });

  test('无运行任务或畸形消息为 stale', () => {
    assert.deepEqual(classifyMessage({ type: 'done', id: 1 }, null), { kind: 'stale' });
    assert.deepEqual(classifyMessage(null, 1), { kind: 'stale' });
    assert.deepEqual(classifyMessage({}, 1), { kind: 'stale' });
    assert.deepEqual(classifyMessage({ type: 'mystery', id: 1 }, 1), { kind: 'unknown', terminal: false });
  });
});

describe('reduceSuccess：成功结论不被覆盖', () => {
  const r1 = { totalPriority: '10', optimalCount: '2' };
  const r2 = { totalPriority: '20', optimalCount: '1' };

  test('当前任务的 done 更新结论', () => {
    assert.equal(reduceSuccess(null, { type: 'done', id: 5, result: r1 }, 5), r1);
    assert.equal(reduceSuccess(r1, { type: 'done', id: 6, result: r2 }, 6), r2);
  });

  test('非法输入、取消、错误均不覆盖', () => {
    for (const t of ['invalid', 'canceled', 'error']) {
      assert.equal(reduceSuccess(r1, { type: t, id: 5 }, 5), r1);
    }
  });

  test('旧任务的迟到 done/invalid/canceled 均不覆盖', () => {
    for (const t of ['done', 'invalid', 'canceled', 'error']) {
      assert.equal(reduceSuccess(r1, { type: t, id: 4, result: r2 }, 5), r1);
    }
  });

  test('progress 与无任务状态下不更新', () => {
    assert.equal(reduceSuccess(r1, { type: 'progress', id: 5, p: 0.5 }, 5), r1);
    assert.equal(reduceSuccess(r1, { type: 'done', id: 5, result: r2 }, null), r1);
  });
});
