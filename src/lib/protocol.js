// Worker 消息协议与陈旧消息判定（纯函数，便于在 Node 中单测）。
export const MESSAGE_TYPES = Object.freeze({
  PROGRESS: 'progress',
  DONE: 'done',
  INVALID: 'invalid',
  CANCELED: 'canceled',
  ERROR: 'error',
});

export const TERMINAL_TYPES = new Set(['done', 'invalid', 'canceled', 'error']);
const KNOWN_TYPES = new Set(['progress', ...TERMINAL_TYPES]);

// 判定消息是否属于当前任务。旧任务的迟到消息（含终止消息）一律视为 stale。
export function classifyMessage(msg, currentJobId) {
  if (!msg || typeof msg !== 'object' || msg.id !== currentJobId || currentJobId === null) {
    return { kind: 'stale' };
  }
  return { kind: KNOWN_TYPES.has(msg.type) ? msg.type : 'unknown', terminal: TERMINAL_TYPES.has(msg.type) };
}

// 结论归约：只有“当前任务”的 done 才会更新最近一次成功结论；
// 非法输入、取消、错误与旧任务迟到消息一律保留既有结论。
export function reduceSuccess(current, msg, currentJobId) {
  const { kind } = classifyMessage(msg, currentJobId);
  return kind === 'done' ? msg.result : current;
}
