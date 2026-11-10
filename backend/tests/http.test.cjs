// HTTP-level regression coverage. Injected values below are test fixtures only; the app never loads them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createHttpServer } = require('../app/api/http-server.cjs');

const fixture = {
  snapshot_id: 'test-fixture-2026-11-09', status: 'usable_for_exact_date_only', data_date: '2026-11-09',
  source: { provider: 'fixture-only' }, metadata: { metadata_match: true, caveat: 'test fixture only' },
  coverage: { label: '测试夹具', note: '仅测试用', count: 3, codes: ['600036.SH', '000001.SZ', '600519.SH'] },
  items: [
    { thscode: '600036.SH', name: '测试甲', metrics: { pe_ttm: { value: 7, raw_value: '7', unit: '倍', source_field: 'fixture.pe' }, market_cap_cny: { value: 1.1e12, raw_value: '1.1万亿', unit: 'CNY', source_field: 'fixture.cap' } } },
    { thscode: '000001.SZ', name: '测试乙', metrics: { pe_ttm: { value: 5, raw_value: '5', unit: '倍', source_field: 'fixture.pe' }, market_cap_cny: { value: 2.3e11, raw_value: '2300亿', unit: 'CNY', source_field: 'fixture.cap' } } },
    { thscode: '600519.SH', name: '测试丙', metrics: { pe_ttm: { value: 22, raw_value: '22', unit: '倍', source_field: 'fixture.pe' }, market_cap_cny: { value: 1.8e12, raw_value: '1.8万亿', unit: 'CNY', source_field: 'fixture.cap' } } }
  ]
};
let mockModelCalls = 0;
function clarification(reply, updates = [], extra = {}) {
  return { reply, question_updates: updates, context_updates: {}, unmapped_additions: [], options: [], semantic_unresolved: [], unavailable_metric_ids: [], resolve_unmapped_ids: [], ...extra };
}
const mockComplete = async (messages, request = {}) => {
  mockModelCalls++;
  if (request.tools) {
    if (!messages.some(message => message.role === 'tool')) {
      const calls = ['get_snapshot', 'run_screen'].map((name, i) => ({ id: 'tool-' + i, type: 'function', function: { name, arguments: '{}' } }));
      return { message: { role: 'assistant', content: null, tool_calls: calls }, tool_calls: calls, finish_reason: 'tool_calls' };
    }
    return { message: { role: 'assistant', content: JSON.stringify({ reply: '已完成，缺数据的条件保持待核验，逐股证据见结果。', evidence_refs: ['screen:summary'] }) }, tool_calls: [], finish_reason: 'stop' };
  }
  const payload = JSON.parse(messages[1].content);
  const text = payload.current_user_message;
  let out;
  if (text.includes('经营改善、估值合理')) {
    out = clarification('估值默认市盈率低于20倍，经营先看营收增速改善，走势先看波动率。你希望调整哪方面？', [
      { metric_id: 'pe_ttm', active: true, slots: {} },
      { metric_id: 'revenue_yoy_acceleration_pp', active: true, slots: {} },
      { metric_id: 'volatility_60d_annualized_pct', active: true, slots: {} }
    ], { options: ['经营更关注利润，不是收入'], semantic_unresolved: ['经营报告期未明确'], unavailable_metric_ids: ['revenue_yoy_acceleration_pp', 'volatility_60d_annualized_pct'] });
  } else if (text.includes('更关注利润')) {
    out = clarification('利润是希望扭亏，还是增长加快？', [{ metric_id: 'revenue_yoy_acceleration_pp', active: false, slots: {} }], { options: ['利润增长加快'], semantic_unresolved: ['利润改善的定义和报告期'] });
  } else if (text.includes('利润增长加快')) {
    out = clarification('利润看2026-Q3增速较上季提高，市盈率放宽到30倍，走势仍用原来的波动率。还需要修改吗？', [
      { metric_id: 'net_profit_yoy_acceleration_pp', active: true, slots: { report: '2026-Q3', current_quarter: '2026-Q3' } },
      { metric_id: 'pe_ttm', active: true, slots: { threshold: 30 } }
    ], { unavailable_metric_ids: ['net_profit_yoy_acceleration_pp', 'volatility_60d_annualized_pct'] });
  } else if (text.includes('行业平均')) {
    out = clarification('行业平均暂不支持，要只使用固定数值吗？', [{ metric_id: 'pe_ttm', active: true, slots: {} }], { unmapped_additions: ['行业平均'], semantic_unresolved: ['如何处理行业比较'], options: ['不用行业比较'] });
  } else if (text === '不用行业比较') {
    out = clarification('保留市盈率默认，是否修改？', [], { resolve_unmapped_ids: payload.current_card.unmapped_inputs.filter(item => item.status === 'open').map(item => item.id) });
  } else if (text.includes('PB')) {
    out = clarification('当前没有市净率数据和题目，需要改用其他指标吗？', [], { unmapped_additions: [text], semantic_unresolved: ['市净率不受支持'] });
  } else if (text.includes('总市值')) {
    out = clarification('市盈率低于20倍且总市值高于100亿元，还需要改吗？', [
      { metric_id: 'pe_ttm', active: true, slots: {} },
      { metric_id: 'market_cap_cny', active: true, slots: { operator: 'gt', threshold: 100 } }
    ]);
  } else {
    out = clarification('默认市盈率低于20倍。需要修改衡量方法或阈值吗？', [{ metric_id: 'pe_ttm', active: true, slots: text.includes('6倍') ? { threshold: 6 } : {} }]);
  }
  return { content: JSON.stringify(out), model: 'local-mock', usage: { total_tokens: 20 } };
};
const scratch = path.join('D:/Codex/work', 'stock-workbench-http-test-' + randomUUID());
const server = createHttpServer({ port: 0, sessions: new Map(), strategiesDir: scratch, getSnapshot: () => fixture, complete: mockComplete, maxModelCalls: 100 });
let baseUrl;

before(async () => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(scratch); const workRoot = path.resolve('D:/Codex/work') + path.sep;
  if (resolved.startsWith(workRoot) && fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
});

async function call(route, method = 'GET', body, extraHeaders = {}) {
  const response = await fetch(baseUrl + route, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extraHeaders }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  let data; try { data = await response.json(); } catch { data = null; }
  return { response, data };
}

async function newSession() {
  const { response, data } = await call('/api/sessions', 'POST', {});
  assert.equal(response.status, 201);
  return data.session_id;
}

test('本机提供页面、目录、数据状态和会话', async () => {
  const page = await fetch(baseUrl + '/');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /选股助手/);
  assert.doesNotMatch(html, /id="(?:saveButton|strategySelect|saveDialog)"/);
  assert.match(html, /aria-label="发送消息"/);
  assert.match(html, /aria-hidden="true">↑/);
  assert.doesNotMatch(html, /metricSelect|universeInput|combinationInput|question-card/);
  const { response, data } = await call('/api/bootstrap');
  assert.equal(response.status, 200);
  assert.equal(data.catalog.length, 12);
  assert.equal(data.data_status.count, 3);
  assert.equal(data.data_status.data_date, '2026-11-09');
  assert.equal((await call('/api/health')).data.ok, true);
});

test('每轮模型自然问答替换经营指标并保留其他条件，确认后模型工具筛选', async () => {
  const id = await newSession(); const url = `/api/sessions/${id}/chat`; const before = mockModelCalls;
  let reply = await call(url, 'POST', { text: '请查找经营改善、估值合理、走势相对稳定的股票' });
  assert.equal(reply.response.status, 200, JSON.stringify(reply.data));
  assert.equal(reply.data.stage, 'clarifying');
  let pe = reply.data.exam.questions.find(item => item.metric_id === 'pe_ttm');
  assert.equal(pe.slots.threshold.value, 20); assert.equal(pe.slots.threshold.source, 'default');
  assert.equal(pe.slots.as_of.value, '2026-11-09');
  assert.match(reply.data.chat_history.at(-1).text, /调整/);
  assert.equal(reply.data.chat_history.at(-1).actions[0].action, 'option');
  reply = await call(url, 'POST', { text: '经营更关注利润，不是收入' });
  assert.equal(reply.response.status, 200, JSON.stringify(reply.data));
  assert.equal(reply.data.exam.questions.find(item => item.metric_id === 'revenue_yoy_acceleration_pp').active, false);
  assert.match(reply.data.chat_history.at(-1).text, /扭亏/);
  reply = await call(url, 'POST', { text: '利润增长加快，用2026-Q3，PE放宽到30倍' });
  assert.equal(reply.response.status, 200, JSON.stringify(reply.data));
  assert.equal(reply.data.stage, 'ready');
  assert.deepEqual(reply.data.exam.questions.filter(item => item.active).map(item => item.metric_id).sort(), ['net_profit_yoy_acceleration_pp', 'pe_ttm', 'volatility_60d_annualized_pct'].sort());
  pe = reply.data.exam.questions.find(item => item.metric_id === 'pe_ttm');
  assert.equal(pe.slots.threshold.value, 30); assert.equal(pe.slots.threshold.source, 'user_input');
  assert.equal(mockModelCalls - before, 3);
  assert.equal((await call(url, 'POST', { action: 'screen' })).response.status, 422);
  assert.equal((await call(url, 'POST', { action: 'confirm' })).data.exam.validation, true);
  reply = await call(url, 'POST', { action: 'screen' });
  assert.equal(reply.response.status, 200, JSON.stringify(reply.data));
  assert.deepEqual(reply.data.results.counts, { pass: 0, fail: 0, unknown: 3 });
  assert.deepEqual(reply.data.tool_trace.map(item => item.name), ['get_snapshot', 'run_screen']);
  assert.equal(mockModelCalls - before, 5);
});

test('已完成筛选的会话继续修改也调用模型，结果更新保留同快照比较', async () => {
  const id = await newSession(); const url = `/api/sessions/${id}/chat`;
  await call(url, 'POST', { text: '找估值合理的股票' });
  await call(url, 'POST', { action: 'confirm' });
  let reply = await call(url, 'POST', { action: 'screen' });
  assert.deepEqual(reply.data.results.counts, { pass: 2, fail: 1, unknown: 0 });
  const before = mockModelCalls;
  reply = await call(url, 'POST', { text: '放宽不需要了，PE改成低于6倍' });
  assert.equal(mockModelCalls, before + 1);
  assert.equal(reply.data.exam.validation, false);
  await call(url, 'POST', { action: 'confirm' });
  reply = await call(url, 'POST', { action: 'screen' });
  assert.deepEqual(reply.data.results.counts, { pass: 1, fail: 2, unknown: 0 });
  assert.equal(reply.data.results.comparison.changed_count, 1);
});

test('复合条件的模型回复和实际市值换算一致', async () => {
  const id = await newSession();
  const reply = await call(`/api/sessions/${id}/chat`, 'POST', { text: '市盈率低于20倍且总市值高于100亿' });
  assert.equal(reply.response.status, 200, JSON.stringify(reply.data));
  assert.equal(reply.data.exam.questions.find(item => item.metric_id === 'market_cap_cny').slots.threshold.value, 1e10);
  assert.match(reply.data.chat_history.at(-1).text, /总市值/);
});

test('未映射需求由模型基于自然回答处理原始ID，未答复前不能确认', async () => {
  const id = await newSession(); const url = `/api/sessions/${id}/chat`;
  let reply = await call(url, 'POST', { text: 'PE低于行业平均' });
  assert.equal(reply.data.exam.unmapped_inputs[0].status, 'open');
  assert.equal((await call(url, 'POST', { action: 'confirm' })).response.status, 409);
  reply = await call(url, 'POST', { text: '不用行业比较' });
  assert.equal(reply.data.exam.unmapped_inputs[0].status, 'resolved');
  assert.equal(reply.data.stage, 'ready');
  assert.ok(reply.data.exam.unmapped_inputs[0].resolutions.length);
});

test('PB没有固定题目时由模型说明并阻断，不伪造条件', async () => {
  const id = await newSession();
  const result = await call(`/api/sessions/${id}/chat`, 'POST', { text: '用PB市净率低于2倍' });
  assert.equal(result.response.status, 200);
  assert.match(result.data.chat_history.at(-1).text, /没有市净率/);
  assert.equal(result.data.exam.questions.some(question => question.active), false);
  assert.equal(result.data.stage, 'clarifying');
});

test('编辑→确认→PE/市值筛选→同快照改阈值对比→保存载入', async () => {
  const id = await newSession(); const url = `/api/sessions/${id}`;
  const codes = ['600036.SH', '000001.SZ', '600519.SH'];
  let answer = await call(url + '/answers', 'PATCH', {
    question_updates: [
      { metric_id: 'pe_ttm', active: true, slots: { operator: 'lt', threshold: 15, as_of: '2026-11-09' } },
      { metric_id: 'market_cap_cny', active: true, slots: { operator: 'gt', threshold: 1e12, as_of: '2026-11-09' } }
    ], context_updates: { universe: { type: 'explicit_symbols', symbols: codes }, combination: 'all' }
  });
  assert.equal(answer.response.status, 200);
  let confirmed = await call(url + '/confirm', 'POST', {});
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.data.validation, true);
  let screened = await call(url + '/screen', 'POST', {});
  assert.equal(screened.response.status, 200);
  assert.deepEqual(screened.data.results.counts, { pass: 1, fail: 2, unknown: 0 });
  assert.equal(screened.data.results.rows[0].conditions[0].source_field, 'fixture.pe');

  answer = await call(url + '/answers', 'PATCH', { question_updates: [{ metric_id: 'pe_ttm', active: true, slots: { threshold: 25 } }], context_updates: {} });
  assert.equal(answer.response.status, 200);
  confirmed = await call(url + '/confirm', 'POST', {});
  assert.equal(confirmed.data.validation, true);
  screened = await call(url + '/screen', 'POST', {});
  assert.equal(screened.data.results.comparison.same_snapshot, true);
  assert.equal(screened.data.results.comparison.changed_count, 1);

  const saved = await call(url + '/save', 'POST', { name: '验收测试策略' });
  assert.equal(saved.response.status, 201);
  assert.equal((await call('/api/strategies')).data.strategies.length, 1);
  const secondId = await newSession();
  const loaded = await call(`/api/sessions/${secondId}/load`, 'POST', { id: saved.data.strategy.id });
  assert.equal(loaded.response.status, 200);
  assert.equal(loaded.data.exam.questions.find(q => q.metric_id === 'pe_ttm').active, true);
});

test('无效答案、未确认执行、未知槽位和未支持指数明确失败', async () => {
  const id = await newSession(); const url = `/api/sessions/${id}`;
  const noConfirm = await call(url + '/screen', 'POST', {});
  assert.equal(noConfirm.response.status, 422);
  const badSlot = await call(url + '/answers', 'PATCH', { question_updates: [{ metric_id: 'pe_ttm', active: true, slots: { invented: 1 } }], context_updates: {} });
  assert.equal(badSlot.response.status, 400);
  const edit = await call(url + '/answers', 'PATCH', {
    question_updates: [{ metric_id: 'pe_ttm', active: true, slots: { operator: 'lt', threshold: 15, as_of: '2026-11-09' } }],
    context_updates: { universe: { type: 'index_constituents', index_code: '000300.SH' }, combination: 'all' }
  });
  assert.equal(edit.response.status, 200);
  assert.equal((await call(url + '/confirm', 'POST', {})).data.validation, true);
  const unsupported = await call(url + '/screen', 'POST', {});
  assert.equal(unsupported.response.status, 422);
  assert.match(unsupported.data.error, /没有指数成分数据/);
});

test('API拒绝跨站Origin、非JSON和超大请求体', async () => {
  const crossSite = await call('/api/bootstrap', 'GET', undefined, { origin: 'https://evil.example' });
  assert.equal(crossSite.response.status, 403);
  const sessionId = await newSession();
  const wrongType = await call(`/api/sessions/${sessionId}/confirm`, 'POST', '{}', { 'content-type': 'text/plain' });
  assert.equal(wrongType.response.status, 415);
  const tooLarge = await call(`/api/sessions/${sessionId}/answers`, 'PATCH', ' '.repeat(17000), { 'content-type': 'application/json' });
  assert.equal(tooLarge.response.status, 413);
});

async function isolatedServer(t, complete, maxModelCalls = 10, extra = {}) {
  const local = createHttpServer({ port: 0, sessions: new Map(), complete, maxModelCalls, getSnapshot: () => fixture, ...extra });
  await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => local.close(resolve)));
  const base = 'http://127.0.0.1:' + local.address().port;
  const request = async (route, body) => { const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
  const session = await request('/api/sessions', {});
  return { request, route: '/api/sessions/' + session.data.session_id };
}

test('同会话并发消息拒绝且不重复调用模型', async t => {
  let release, entered; const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; }); let calls = 0;
  const { request, route } = await isolatedServer(t, async () => { calls++; entered(); await gate; return { content: JSON.stringify(clarification('需要修改吗？', [{ metric_id: 'pe_ttm', active: true, slots: {} }])) }; });
  const pending = request(route + '/chat', { text: '估值合理' }); await started;
  const duplicate = await request(route + '/chat', { text: '估值合理' });
  release(); assert.equal(duplicate.status, 409); assert.equal((await pending).status, 200); assert.equal(calls, 1);
});

test('模型无效补丁使整个回合回滚，不保存伪造回复', async t => {
  const { request, route } = await isolatedServer(t, async () => ({ content: JSON.stringify({ ...clarification('已经成功'), validation: true }) }));
  const before = (await request(route)).data;
  const failed = await request(route + '/chat', { text: '估值合理' });
  assert.equal(failed.status, 502);
  const after = (await request(route)).data;
  assert.deepEqual(after.exam, before.exam); assert.deepEqual(after.chat_history, before.chat_history);
});

test('每进程额度包含普通回合，耗尽后不调用模型且新会话不能绕过', async t => {
  let calls = 0;
  const { request, route } = await isolatedServer(t, async () => { calls++; return { content: JSON.stringify(clarification('需要修改吗？', [{ metric_id: 'pe_ttm', active: true, slots: {} }])) }; }, 1);
  assert.equal((await request(route + '/chat', { text: '估值合理' })).status, 200);
  const next = await request('/api/sessions', {});
  assert.equal((await request('/api/sessions/' + next.data.session_id + '/chat', { text: '估值合理' })).status, 429);
  assert.equal(calls, 1);
});

test('模型声称改成用户没说过的数字时不能静默采用或展示成功', async t => {
  const { request, route } = await isolatedServer(t, async () => ({ content: JSON.stringify(clarification('已改成999倍', [{ metric_id: 'pe_ttm', active: true, slots: { threshold: 999 } }])) }));
  const failed = await request(route + '/chat', { text: '市盈率低于30倍' });
  assert.equal(failed.status, 502);
  const after = (await request(route)).data;
  assert.equal(after.exam.questions.some(item => item.active), false);
  assert.equal(after.chat_history.length, 1);
});


test('原话校验拒绝时仅一次模型纠正，反馈供模型处理且费用计入限额', async t => {
  let calls = 0;
  const { request, route } = await isolatedServer(t, async messages => {
    calls++; const payload = JSON.parse(messages[1].content);
    if (calls === 1) return { content: JSON.stringify(clarification('错误候选，不应展示', [
      { metric_id: 'market_cap_cny', active: true, slots: { operator: 'gt', threshold: 999 } }
    ])), usage: { total_tokens: 10 } };
    assert.equal(calls, 2); assert.ok(payload.validation_feedback.errors.length);
    assert.equal(payload.current_card.questions.length, 0, '失败草稿未污染重试上下文');
    return { content: JSON.stringify(clarification('总市值不低于500亿元，还要调整吗？', [
      { metric_id: 'market_cap_cny', active: true, slots: { operator: 'gte', threshold: 50000000000 } }
    ])), usage: { total_tokens: 15 } };
  });
  const result = await request(route + '/chat', { text: '市值下限500亿元' });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(calls, 2); assert.equal(result.data.model_usage.total_tokens, 25);
  assert.equal(result.data.model_calls_remaining, 8);
  assert.equal(result.data.exam.questions.find(item => item.metric_id === 'market_cap_cny').slots.threshold.value, 50000000000);
  assert.equal(result.data.chat_history.some(item => item.text === '错误候选，不应展示'), false);
});


test('自然比较词和相同股票池重排不触发误拦或二次调用', async t => {
  let calls = 0;
  const { request, route } = await isolatedServer(t, async () => {
    calls++;
    return { content: JSON.stringify(clarification('市值按不低于500亿元理解，是否需要修改？', [
      { metric_id: 'market_cap_cny', active: true, slots: { operator: 'gte', threshold: 50000000000 } }
    ], { context_updates: { universe: { type: 'explicit_symbols', symbols: ['600036.SH', '000001.SZ', '600519.SH'] } } })) };
  });
  const result = await request(route + '/chat', { text: '市值比较高，500亿元以上，用原来的样本' });
  assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(calls, 1);
  const cap = result.data.exam.questions.find(item => item.metric_id === 'market_cap_cny');
  assert.equal(cap.slots.operator.value, 'gte'); assert.equal(cap.slots.threshold.value, 50000000000);
});


test('解释失败仍返回结果与单独重试入口，重试不重新筛选且条件变动后拒绝旧解释', async t => {
  let modelCalls = 0, runs = 0;
  const { request, route } = await isolatedServer(t, async messages => {
    modelCalls++; const payload = JSON.parse(messages[1].content);
    if (payload.results) return { content: JSON.stringify({ reply: '筛选已完成，详见逐项证据。', evidence_refs: ['screen:summary'] }) };
    return { content: JSON.stringify(clarification('市盈率条件已明确，是否确认？', [{ metric_id: 'pe_ttm', active: true, slots: payload.current_user_message.includes('6倍') ? { threshold: 6 } : {} }])) };
  }, 10, { runScreeningConversation: async ({ exam }) => {
    runs++; const results = require('../app/screening/evaluator.cjs').evaluateExam(exam, { snapshot: fixture });
    return { results, reply: null, explanation: { status: 'unavailable' }, tool_trace: [] };
  } });
  await request(route + '/chat', { text: '估值合理' }); await request(route + '/chat', { action: 'confirm' });
  const screened = await request(route + '/chat', { action: 'screen' });
  assert.equal(screened.status, 200); assert.deepEqual(screened.data.results.counts, { pass: 2, fail: 1, unknown: 0 });
  assert.equal(screened.data.chat_history.at(-1).actions[0].action, 'explain');
  const retried = await request(route + '/chat', { action: 'explain' });
  assert.equal(retried.status, 200); assert.equal(runs, 1); assert.equal(modelCalls, 2);
  assert.equal(retried.data.explanation.status, 'verified'); assert.deepEqual(retried.data.results, screened.data.results);
  await request(route + '/chat', { text: '改成6倍' });
  assert.equal((await request(route + '/chat', { action: 'explain' })).status, 422);
});


test('模型复制只读context包装时仅取值，元信息绝不能代替客户确认', async t => {
  let calls = 0;
  const { request, route } = await isolatedServer(t, async () => { calls++; return { content: JSON.stringify(clarification('默认条件是否需要修改？', [{ metric_id: 'pe_ttm', active: true, slots: {} }], { context_updates: {
    combination: { value: 'all', source: 'user_input', confirmed: true },
    universe: { value: { type: 'explicit_symbols', symbols: ['600519.SH', '000001.SZ', '600036.SH'] }, source: 'user_input', confirmed: true }
  } })) }; });
  const result = await request(route + '/chat', { text: '估值合理，用当前样本' });
  assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(calls, 1);
  assert.equal(result.data.exam.context.combination.confirmed, false); assert.equal(result.data.exam.context.universe.confirmed, false);
  assert.equal(result.data.exam.context.universe.source, 'default'); assert.equal(result.data.exam.validation, false);
  assert.equal((await request(route + '/chat', { action: 'screen' })).status, 422);
});
