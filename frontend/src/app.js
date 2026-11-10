const $ = selector => document.querySelector(selector);
const state = { sessionId: null, history: [], exam: null, sample: null, dataStatus: null, result: null, resultStale: false, conditionSig: null, busy: false };
let toastTimer;
let busy = false;

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function showToast(text) { const node = $('#toast'); node.textContent = text; node.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 2800); }
function setBusy(value) {
  state.busy = value;
  busy = value;
  $('#serviceStatus').textContent = value ? '助手正在思考…' : '选股助手已连接';
  $('#sendButton').disabled = value;
  $('#messageInput').disabled = value;
  $('#newChatButton').disabled = value;
  $('#conversation').querySelectorAll('.chat-choice').forEach(button => { button.disabled = value || Number(button.dataset.message) !== state.history.length - 1; });
}

async function api(url, options = {}) {
  const response = await fetch(url, { method: options.method || 'GET', headers: options.body === undefined ? {} : { 'content-type': 'application/json' }, body: options.body === undefined ? undefined : JSON.stringify(options.body), credentials: 'same-origin' });
  let data; try { data = await response.json(); } catch { data = { error: '服务响应无法读取' }; }
  if (!response.ok) { const error = new Error(data.error || '请求失败'); error.data = data; throw error; }
  return data;
}

function signature(exam) {
  const questions = (exam?.questions || []).filter(item => item.active).map(item => ({ metric_id: item.metric_id, slots: Object.fromEntries(Object.entries(item.slots || {}).map(([key, slot]) => [key, slot?.value ?? null])) }));
  const open = (exam?.unmapped_inputs || []).filter(item => typeof item === 'string' || item.status !== 'resolved').map(item => typeof item === 'string' ? item : item.text);
  return JSON.stringify({ questions, context: exam?.context?.universe?.value, combination: exam?.context?.combination?.value, open });
}

function update(payload, { screened = false, reset = false } = {}) {
  if (payload.exam) {
    const next = signature(payload.exam);
    if (!reset && state.conditionSig !== null && next !== state.conditionSig && state.result) state.resultStale = true;
    state.conditionSig = next; state.exam = payload.exam;
  }
  if (payload.chat_history) state.history = payload.chat_history;
  if (payload.results) { state.result = payload.results; state.resultStale = false; }
  if (reset) { state.result = null; state.resultStale = false; }
  renderChat(); renderResults();
}

function renderDataStatus() {
  const data = state.dataStatus;
  $('#dataStatus').textContent = data?.available ? `${data.provider} · ${data.data_date} · ${data.count}只` : '等待本地数据';
  $('#coverageTitle').textContent = data?.coverage?.label || state.sample?.label || '固定样本';
  $('#coverageText').textContent = data?.coverage?.note || state.sample?.coverage_note || data?.note || '仅展示已核验数据。';
}

function renderChat() {
  $('#conversation').innerHTML = state.history.map((item, index) => {
    const role = item.role === 'user' ? 'user' : 'assistant';
    const bubble = `<div class="message-row ${role}"><div class="avatar" aria-hidden="true">${role === 'user' ? '我' : '选'}</div><div class="message-content"><div class="message-bubble">${esc(item.text).replace(/\n/g, '<br>')}</div>${(item.actions || []).length ? `<div class="message-actions">${item.actions.map((action, actionIndex) => `<button type="button" class="chat-choice ${action.action === 'confirm' || action.action === 'screen' ? 'choice-primary' : ''}" ${index !== state.history.length - 1 || busy ? 'disabled' : ''} data-message="${index}" data-action-index="${actionIndex}">${esc(action.label)}</button>`).join('')}</div>` : ''}</div></div>`;
    return bubble;
  }).join('');
  $('#conversation').querySelectorAll('[data-message]').forEach(button => button.addEventListener('click', () => runChatAction(Number(button.dataset.message), Number(button.dataset.actionIndex))));
  const log = $('#conversation'); log.scrollTop = log.scrollHeight;
  $('#suggestions').hidden = state.history.some(item => item.role === 'user');
}

function badge(status) {
  const info = { pass: ['入选', 'pass'], fail: ['未入选', 'fail'], unknown: ['待核验', 'unknown'] }[status] || ['待核验', 'unknown'];
  return `<span class="result-badge result-${info[1]}">${info[0]}</span>`;
}

function operatorLabel(operator) { return ({ lt: '低于', lte: '不超过', gt: '高于', gte: '不低于', eq: '等于', between: '介于' })[operator] || operator || ''; }
function resultCondition(condition) {
  const requested = condition.requested || {};
  const meaning = requested.interpretation ? `<div class="evidence-default">${esc(requested.interpretation)} · ${requested.source === 'default' ? '产品默认' : '客户补充'}</div>` : '';
  const raw = condition.value !== undefined
    ? `<div>数据：<strong>${esc(condition.raw_value)}</strong> · 换算值 ${esc(condition.value)} ${esc(condition.unit)} · 条件 ${esc(operatorLabel(condition.operator))} ${esc(Array.isArray(condition.threshold) ? condition.threshold.join('至') : condition.threshold)} ${esc(condition.metric_id === 'pe_ttm' ? '倍' : '')}</div><div>来源字段：${esc(condition.source_field)} · 日期：${esc(condition.data_date)}</div>`
    : '';
  return `<div class="evidence-block"><div class="evidence-heading"><strong>${esc(condition.label)}</strong>${badge(condition.status)}</div><div>${esc(condition.reason)}</div>${meaning}${raw}</div>`;
}

function renderResults() {
  const result = state.result;
  if (!result) return;
  const counts = result.counts || { pass: 0, fail: 0, unknown: 0 };
  $('#resultScope').textContent = result.data_date ? `${result.data_date} · ${result.coverage?.count ?? result.rows?.length ?? 0}只样本` : '数据时点未知';
  const stale = state.resultStale ? '<div class="stale-note">以下为上次条件的结果。条件已修改，请重新确认并执行。</div>' : '';
  $('#resultSummary').innerHTML = `${stale}<div class="summary-grid"><div><span>入选</span><strong>${counts.pass}</strong></div><div><span>未入选</span><strong>${counts.fail}</strong></div><div><span>待核验</span><strong>${counts.unknown}</strong></div></div><p class="summary-caption">${esc(result.coverage?.label || '')} · ${esc(result.coverage?.note || '')}</p><p class="summary-caption">${esc(result.metadata_note || '')}</p>${result.comparison ? `<p class="comparison-note">同一快照对比：${result.comparison.changed_count}只股票的结果状态发生变化。</p>` : ''}`;
  if (!result.rows?.length) { $('#resultsBody').innerHTML = '<tr class="table-empty"><td colspan="4">当前没有覆盖内的股票代码。</td></tr>'; return; }
  $('#resultsBody').innerHTML = result.rows.map(row => {
    const passCount = row.conditions.filter(item => item.status === 'pass').length;
    return `<tr><td><strong class="stock-name">${esc(row.name)}</strong><span class="stock-code">${esc(row.thscode)}</span></td><td>${badge(row.status)}</td><td>${passCount}/${row.conditions.length} 项满足</td><td><details class="evidence-details"><summary>展开证据</summary>${row.conditions.map(resultCondition).join('')}<div class="evidence-source">数据源：iFinD · 当前本地缓存范围有限</div></details></td></tr>`;
  }).join('');
}

async function runChatAction(messageIndex, actionIndex) {
  const action = state.history[messageIndex]?.actions?.[actionIndex];
  if (!action || busy || messageIndex !== state.history.length - 1) return;
  if (action.action === 'option') return sendMessage(action.label);
  setBusy(true);
  try {
    const data = await api(`/api/sessions/${state.sessionId}/chat`, { method: 'POST', body: { action: action.action } });
    update(data);
  } catch (error) { showToast(error.message); }
  finally { setBusy(false); }
}

async function sendMessage(text) {
  const value = String(text ?? $('#messageInput').value).trim(); if (!value || busy) return;
  setBusy(true);
  try {
    const data = await api(`/api/sessions/${state.sessionId}/chat`, { method: 'POST', body: { text: value } });
    $('#messageInput').value = ''; update(data); $('#messageInput').focus();
  } catch (error) { showToast(error.message); }
  finally { setBusy(false); }
}

async function newChat() {
  if (busy) return;
  if (state.busy) return;
  setBusy(true);
  try {
  const data = await api('/api/sessions', { method: 'POST', body: {} });
  state.sessionId = data.session_id; update(data, { reset: true }); $('#messageInput').value = ''; $('#messageInput').focus();
  $('#resultSummary').innerHTML = '<div class="result-placeholder"><span class="placeholder-mark" aria-hidden="true">✳</span><strong>结果会显示在这里</strong><span>你确认条件后，助手才会运行筛选。</span></div>';
  $('#resultsBody').innerHTML = '<tr class="table-empty"><td colspan="4">等待你描述筛选想法</td></tr>'; $('#resultScope').textContent = '确认条件后执行';
  } finally { setBusy(false); }
}

async function initialize() {
  try {
    const boot = await api('/api/bootstrap'); state.sample = boot.sample_universe; state.dataStatus = boot.data_status; renderDataStatus();
    $('#serviceStatus').textContent = '选股助手已连接';
    const session = await api('/api/sessions', { method: 'POST', body: {} }); state.sessionId = session.session_id; update(session, { reset: true });
  } catch (error) { $('#serviceStatus').textContent = '服务暂不可用'; showToast(error.message); }
}

$('#messageForm').addEventListener('submit', event => { event.preventDefault(); sendMessage(); });
$('#messageInput').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } });
$('#suggestions').querySelectorAll('[data-suggestion]').forEach(button => button.addEventListener('click', () => { $('#messageInput').value = button.dataset.suggestion; $('#messageInput').focus(); }));
$('#newChatButton').addEventListener('click', () => newChat().catch(error => showToast(error.message)));

initialize();
