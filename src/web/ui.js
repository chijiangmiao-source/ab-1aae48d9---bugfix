// 页面逻辑：录入、任务派发（Web Worker）、结论快照与陈旧消息防护。
import { reverseComplement, hamming } from '../lib/optimizer.js';
import { classifyMessage, reduceSuccess } from '../lib/protocol.js';

const MIN_ROWS = 10;
const MAX_ROWS = 44;

const body = document.getElementById('input-body');
const rowCount = document.getElementById('row-count');
const btnAdd = document.getElementById('btn-add');
const btnDemo = document.getElementById('btn-demo');
const btnClear = document.getElementById('btn-clear');
const btnAudit = document.getElementById('btn-audit');
const btnCancel = document.getElementById('btn-cancel');
const errorsBox = document.getElementById('form-errors');
const noticeBox = document.getElementById('notice');
const progressWrap = document.getElementById('progress-wrap');
const progressBar = document.getElementById('progress-bar');
const progressLabel = document.getElementById('progress-label');
const resultPanel = document.getElementById('result-panel');
const resultBody = document.getElementById('result-body');

// ---- Worker 与任务状态 ----
let worker = null;
let jobSeq = 0;                 // 每次启动审计递增
let runningJobId = null;        // 最近一次启动（含已结束）的任务 id
let jobRows = null;             // 当前任务派发时的录入快照（done 时以此渲染）
// 最近一次成功结论的不可变快照：任何非法输入/取消/迟到消息都不得覆盖
let lastSuccess = null;

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (event) => {
    const msg = event.data || {};
    // 旧任务迟到消息：直接丢弃，不触碰任何状态
    const { kind, terminal } = classifyMessage(msg, runningJobId);
    if (kind === 'stale' || kind === 'unknown') return;

    if (!terminal) {
      if (kind === 'progress') progressBar.style.width = `${Math.round(msg.p * 100)}%`;
      return;
    }

    finishRun();

    if (kind === 'done') {
      // reduceSuccess 保证：只有当前任务的 done 才更新结论；
      // invalid/canceled/error 与旧任务迟到消息均保留既有结论（由 protocol 单测覆盖）。
      const prev = lastSuccess ? lastSuccess.result : null;
      lastSuccess = { rows: jobRows, result: reduceSuccess(prev, msg, runningJobId) };
      jobRows = null;
      hideNotice();
      renderSuccess(lastSuccess);
    } else if (kind === 'invalid') {
      jobRows = null;
      showErrors(msg.errors);
      showNotice('输入校验未通过，已保留最近一次成功结论（如有）。');
    } else if (kind === 'canceled') {
      jobRows = null;
      showNotice('审计已取消，已保留最近一次成功结论（如有）。');
    } else if (kind === 'error') {
      jobRows = null;
      showErrors([`计算过程中发生错误：${msg.message}`]);
    }
  };
  worker.onerror = (event) => {
    showErrors([`Worker 错误：${event.message || '未知错误'}`]);
    finishRun();
    // 致命错误后销毁实例，下次启动审计时重建
    worker = null;
  };
  return worker;
}

// ---- 录入表格 ----
function createRow(barcode = '', priority = '', threshold = '') {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="col-idx idx-cell"></td>
    <td><input class="cell-input f-barcode" inputmode="text" spellcheck="false" autocomplete="off" placeholder="如 AACGTGTA"></td>
    <td class="col-num"><input class="cell-input f-priority" inputmode="numeric" autocomplete="off"></td>
    <td class="col-num"><input class="cell-input f-threshold" inputmode="numeric" autocomplete="off"></td>
    <td class="col-op"><button type="button" class="btn btn-ghost f-del">删除</button></td>`;
  tr.querySelector('.f-barcode').value = barcode;
  tr.querySelector('.f-priority').value = priority;
  tr.querySelector('.f-threshold').value = threshold;
  tr.querySelector('.f-del').addEventListener('click', () => {
    if (body.children.length <= MIN_ROWS) {
      showNotice(`至少需要保留 ${MIN_ROWS} 条记录。`);
      return;
    }
    tr.remove();
    refreshIndex();
  });
  return tr;
}

function refreshIndex() {
  [...body.children].forEach((tr, i) => {
    tr.querySelector('.idx-cell').textContent = i + 1;
  });
  rowCount.textContent = `共 ${body.children.length} 条（允许 ${MIN_ROWS}–${MAX_ROWS} 条）`;
  btnAdd.disabled = body.children.length >= MAX_ROWS;
}

function readRows() {
  return [...body.querySelectorAll('tr')].map((tr) => ({
    barcode: tr.querySelector('.f-barcode').value,
    priority: tr.querySelector('.f-priority').value,
    threshold: tr.querySelector('.f-threshold').value,
  }));
}

function loadRows(rows) {
  body.innerHTML = '';
  rows.forEach((r) => body.appendChild(createRow(r.barcode, r.priority, r.threshold)));
  refreshIndex();
}

btnAdd.addEventListener('click', () => {
  if (body.children.length >= MAX_ROWS) return;
  body.appendChild(createRow());
  refreshIndex();
});

btnClear.addEventListener('click', () => {
  loadRows(Array.from({ length: MIN_ROWS }, () => ({})));
  hideErrors();
  hideNotice();
});

// 确定性示例（线性同余生成），含反向互补自冲突与互斥关系
function demoRows() {
  let seed = 20260923;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const alphabet = 'ACGT';
  const rows = [];
  const used = new Set();
  const n = 20;
  for (let i = 0; i < n; i++) {
    let seq;
    do {
      seq = '';
      for (let j = 0; j < 8; j++) seq += alphabet[Math.floor(rand() * 4)];
    } while (used.has(seq));
    used.add(seq);
    rows.push({
      barcode: seq,
      priority: String(1 + Math.floor(rand() * 10)),
      threshold: String(2 + Math.floor(rand() * 3)), // 2..4
    });
  }
  return rows;
}

btnDemo.addEventListener('click', () => {
  loadRows(demoRows());
  hideErrors();
  hideNotice();
});

// ---- 审计启停 ----
function setRunning(running) {
  btnAudit.disabled = running;
  btnCancel.disabled = !running;
  btnAdd.disabled = running || body.children.length >= MAX_ROWS;
  btnDemo.disabled = running;
  btnClear.disabled = running;
  body.querySelectorAll('input, .f-del').forEach((el) => { el.disabled = running; });
  progressWrap.hidden = !running;
  if (!running) progressBar.style.width = '0%';
  else progressLabel.textContent = '计算中…';
}

function finishRun() {
  runningJobId = null;
  setRunning(false);
}

btnAudit.addEventListener('click', () => {
  hideErrors();
  hideNotice();
  runningJobId = ++jobSeq;
  jobRows = readRows();
  setRunning(true);
  progressBar.style.width = '2%';
  ensureWorker().postMessage({ type: 'audit', id: runningJobId, rows: jobRows });
});

btnCancel.addEventListener('click', () => {
  if (runningJobId === null) return;
  progressLabel.textContent = '正在取消…';
  worker.postMessage({ type: 'cancel', id: runningJobId });
});

// ---- 提示与结论渲染 ----
function showErrors(errors) {
  errorsBox.hidden = false;
  errorsBox.innerHTML = '<ul></ul>';
  const ul = errorsBox.querySelector('ul');
  errors.forEach((e) => {
    const li = document.createElement('li');
    li.textContent = e;
    ul.appendChild(li);
  });
}
function hideErrors() { errorsBox.hidden = true; errorsBox.innerHTML = ''; }
function showNotice(text) { noticeBox.hidden = false; noticeBox.textContent = text; }
function hideNotice() { noticeBox.hidden = true; noticeBox.textContent = ''; }

const STATUS_TEXT = { mandatory: '必选', optional: '可选', never: '从不选' };
const STATUS_TAG = { mandatory: 'tag-mandatory', optional: 'tag-optional', never: 'tag-never' };

function renderSuccess(snapshot) {
  const { rows, result } = snapshot;
  resultPanel.hidden = false;
  document.getElementById('r-priority').textContent = result.totalPriority;
  document.getElementById('r-count').textContent = String(result.selectedCount);
  document.getElementById('r-optcount').textContent = result.optimalCount;
  document.getElementById('r-bitvector').textContent = result.bitVector;

  resultBody.innerHTML = '';
  rows.forEach((row, i) => {
    const seq = String(row.barcode).trim().toUpperCase();
    const rc = /^[ACGT]+$/.test(seq) ? reverseComplement(seq) : '—';
    const selfD = rc === '—' ? '—' : hamming(seq, rc);
    const selfBad = rc !== '—' && Number(row.threshold) >= 1 && selfD < Number(row.threshold);
    const st = result.status[i] || 'never';
    const picked = result.canonical[i] === 1;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-idx">${i + 1}</td>
      <td class="mono"></td>
      <td class="mono"></td>
      <td class="col-num mono"></td>
      <td class="col-num mono"></td>
      <td class="col-num mono self-dist"></td>
      <td><span class="tag ${STATUS_TAG[st]}">${STATUS_TEXT[st]}</span></td>
      <td class="included ${picked ? 'included-yes' : 'included-no'}">${picked ? '✔ 选中' : '—'}</td>`;
    const tds = tr.querySelectorAll('td.mono');
    tds[0].textContent = seq;
    tds[1].textContent = rc;
    tds[2].textContent = row.priority;
    tds[3].textContent = row.threshold;
    const sdCell = tr.querySelector('.self-dist');
    sdCell.textContent = selfD;
    if (selfBad) sdCell.classList.add('self-bad');
    resultBody.appendChild(tr);
  });

  resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 初始 10 个空行
loadRows(Array.from({ length: MIN_ROWS }, () => ({})));
