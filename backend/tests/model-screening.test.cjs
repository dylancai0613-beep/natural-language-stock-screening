const { test } = require('node:test');
const assert = require('node:assert/strict');
const questionnaire = require('../app/intent/questionnaire.cjs');
const { applyCustomerEdits, confirmExam } = require('../app/intent/customer-edits.cjs');
const evaluator = require('../app/screening/evaluator.cjs');
const { runScreeningConversation, explainScreeningResults, ScreeningConversationError } = require('../app/screening/model-screening.cjs');

const snapshot = evaluator.readSnapshot();

function confirmedExam({ asOf = '2026-11-09', includeUnsupported = false, includeMarketCap = false } = {}) {
  const question_updates = [
    { metric_id: 'pe_ttm', active: true, slots: { as_of: asOf } }
  ];
  if (includeMarketCap) question_updates.push({ metric_id: 'market_cap_cny', active: true, slots: { as_of: asOf, operator: 'gte', threshold: 50000000000 } });
  if (includeUnsupported) question_updates.push({
    metric_id: 'net_profit_yoy_acceleration_pp', active: true,
    slots: { as_of: asOf, report: '2025-Q4', current_quarter: '2025-Q4' }
  });
  const draft = applyCustomerEdits(questionnaire.createExam(), {
    question_updates,
    context_updates: {
      universe: { type: 'explicit_symbols', symbols: snapshot.coverage.codes },
      combination: 'all'
    }
  });
  const exam = confirmExam(draft);
  assert.equal(exam.validation, true, JSON.stringify(exam.validation_errors));
  return exam;
}

function toolCall(id, name, args = '{}') {
  return { id, type: 'function', function: { name, arguments: args } };
}

function assistantToolMessage(calls) {
  return { role: 'assistant', content: null, tool_calls: calls };
}

function jsonReply(reply, evidence_refs = ['screen:summary']) {
  return JSON.stringify({ reply, evidence_refs });
}

function toolThenFinal({ exam = confirmedExam(), data = snapshot, reply = '筛选完成，具体结果见表。', refs = ['screen:summary'], beforeFinal } = {}) {
  let calls = 0;
  const complete = async (messages, request) => {
    calls++;
    assert.equal(request.tool_choice, 'auto');
    assert.deepEqual(request.tools.map(tool => tool.function.name), ['get_snapshot', 'run_screen']);
    if (calls === 1) return {
      message: assistantToolMessage([toolCall('snap-1', 'get_snapshot'), toolCall('screen-1', 'run_screen')]),
      tool_calls: [toolCall('snap-1', 'get_snapshot'), toolCall('screen-1', 'run_screen')],
      finish_reason: 'tool_calls', model: 'mock-model',
      usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 }
    };
    assert.equal(calls, 2);
    const assistant = messages.find(message => message.role === 'assistant');
    assert.deepEqual(assistant.tool_calls.map(call => call.id), ['snap-1', 'screen-1']);
    const toolMessages = messages.filter(message => message.role === 'tool');
    assert.deepEqual(toolMessages.map(message => message.tool_call_id), ['snap-1', 'screen-1']);
    const screenResult = JSON.parse(toolMessages[1].content);
    assert.equal(screenResult.results.data_date, data?.data_date || null);
    assert.deepEqual(screenResult.results, JSON.parse(JSON.stringify(evaluator.evaluateExam(exam, { snapshot: data }))));
    beforeFinal?.(screenResult, toolMessages);
    return {
      message: { role: 'assistant', content: jsonReply(reply, refs) },
      tool_calls: [], finish_reason: 'stop', model: 'mock-model',
      usage: { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 }
    };
  };
  return { complete, getCallCount: () => calls };
}

test('模型发起快照与筛选工具调用；tool_call_id原样配对，数字与对比只来自评估器', async () => {
  const exam = confirmedExam();
  const previous = {
    snapshot_id: snapshot.snapshot_id,
    rows: snapshot.coverage.codes.map(thscode => ({ thscode, status: 'fail' }))
  };
  let calls = 0;
  const complete = async (messages, request) => {
    calls++;
    assert.deepEqual(request.tools.map(tool => tool.function.name), ['get_snapshot', 'run_screen']);
    if (calls === 1) return {
      message: assistantToolMessage([toolCall('snap-id', 'get_snapshot'), toolCall('screen-id', 'run_screen')]),
      tool_calls: [toolCall('snap-id', 'get_snapshot'), toolCall('screen-id', 'run_screen')],
      finish_reason: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
    };
    const assistant = messages.find(message => message.role === 'assistant');
    assert.deepEqual(assistant.tool_calls.map(call => call.id), ['snap-id', 'screen-id']);
    const toolMessages = messages.filter(message => message.role === 'tool');
    assert.deepEqual(toolMessages.map(message => message.tool_call_id), ['snap-id', 'screen-id']);
    const toolResult = JSON.parse(toolMessages[1].content);
    const expected = evaluator.evaluateExam(exam, { snapshot, previous });
    assert.deepEqual(toolResult.results, JSON.parse(JSON.stringify(expected)));
    assert.ok(toolResult.results.comparison);
    return {
      message: { role: 'assistant', content: jsonReply('筛选已完成，结果和同快照状态变化见表格。', ['screen:summary', 'screen:comparison']) },
      tool_calls: [], finish_reason: 'stop', usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 }
    };
  };
  const result = await runScreeningConversation({ complete, exam, snapshot, previous });
  assert.deepEqual(result.results, evaluator.evaluateExam(exam, { snapshot, previous }));
  assert.equal(result.tool_trace.length, 2);
  assert.deepEqual(result.tool_trace.map(item => item.name), ['get_snapshot', 'run_screen']);
  assert.deepEqual(result.usage, {
    calls: 2, prompt_tokens: 22, completion_tokens: 11, total_tokens: 33,
    by_call: [
      { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, model: null },
      { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, model: null }
    ]
  });
});

test('卡片未确认时不调用模型，也不执行评估器', async () => {
  const exam = confirmedExam();
  exam.validation = false;
  let called = false;
  await assert.rejects(runScreeningConversation({ complete: async () => { called = true; }, exam, snapshot }), ScreeningConversationError);
  assert.equal(called, false);
});

test('工具参数不能改股票或条件', async () => {
  const calls = [toolCall('snap-1', 'get_snapshot', '{"symbols":["600519.SH"]}')];
  const complete = async () => ({ message: assistantToolMessage(calls), tool_calls: calls, finish_reason: 'tool_calls' });
  await assert.rejects(runScreeningConversation({ complete, exam: confirmedExam(), snapshot }), /不接受参数/);
});

test('未先读快照、重复工具与未知工具请求都明确失败', async t => {
  await t.test('未先读取快照', async () => {
    const calls = [toolCall('screen-1', 'run_screen')];
    const complete = async () => ({ message: assistantToolMessage(calls), tool_calls: calls, finish_reason: 'tool_calls' });
    await assert.rejects(runScreeningConversation({ complete, exam: confirmedExam(), snapshot }), /必须先通过工具读取/);
  });
  await t.test('重复读取', async () => {
    let count = 0;
    const complete = async () => {
      count++;
      const calls = [toolCall('snap-' + count, 'get_snapshot')];
      return { message: assistantToolMessage(calls), tool_calls: calls, finish_reason: 'tool_calls' };
    };
    await assert.rejects(runScreeningConversation({ complete, exam: confirmedExam(), snapshot }), /重复请求同一工具/);
  });
  await t.test('未知工具', async () => {
    const calls = [toolCall('evil-1', 'run_sql')];
    const complete = async () => ({ message: assistantToolMessage(calls), tool_calls: calls, finish_reason: 'tool_calls' });
    await assert.rejects(runScreeningConversation({ complete, exam: confirmedExam(), snapshot }), /未授权的工具/);
  });
});

test('缺少条件日期数据及未接入指标保持unknown，不能变成模型选择结果', async () => {
  const exam = confirmedExam({ asOf: '2026-11-08', includeUnsupported: true });
  const result = await runScreeningConversation({ ...toolThenFinal({ exam, data: snapshot }), exam, snapshot });
  assert.equal(result.results.rows.every(row => row.conditions.every(condition => condition.status === 'unknown')), true);
  assert.equal(result.results.rows.every(row => row.status === 'unknown'), true);
});

test('无证据解释连续失败不能抹掉真实结果，也不展示错误数字', async () => {
  let calls = 0;
  const complete = async () => {
    calls++;
    if (calls === 1) {
      const tool_calls = [toolCall('snap', 'get_snapshot'), toolCall('screen', 'run_screen')];
      return { message: assistantToolMessage(tool_calls), tool_calls };
    }
    return { message: { role: 'assistant', content: jsonReply('共有999只股票通过。') } };
  };
  const result = await runScreeningConversation({ complete, exam: confirmedExam(), snapshot });
  assert.equal(calls, 3, '只尝试一次解释纠正');
  assert.deepEqual(result.results, evaluator.evaluateExam(confirmedExam(), { snapshot }));
  assert.equal(result.reply, null); assert.equal(result.explanation.status, 'unavailable');
});

test('没有模型发起run_screen时，不能伪称筛选成功', async () => {
  const complete = async () => ({ message: { role: 'assistant', content: jsonReply('筛选已完成。') }, tool_calls: [], finish_reason: 'stop' });
  await assert.rejects(runScreeningConversation({ complete, exam: confirmedExam(), snapshot }), /未通过run_screen/);
});



test('市值50,000,000,000元可解释成500亿元且报告期引用条件证据', async () => {
  const exam = confirmedExam({ includeMarketCap: true, includeUnsupported: true });
  const flow = toolThenFinal({ exam, reply: '总市值下限500.00亿元，报告期2025-Q4，缺数据的项目保持待核验。', refs: ['screen:summary', 'screen:criteria'] });
  const result = await runScreeningConversation({ ...flow, exam, snapshot });
  assert.equal(result.explanation.status, 'verified'); assert.equal(flow.getCallCount(), 2);
  assert.match(result.reply, /500.00亿元/);
});

test('模型只修复解释，不能为修复重新调用筛选工具', async () => {
  const exam = confirmedExam({ includeMarketCap: true }); let calls = 0;
  const complete = async messages => {
    calls++;
    if (calls === 1) { const tool_calls = [toolCall('snap', 'get_snapshot'), toolCall('screen', 'run_screen')]; return { message: assistantToolMessage(tool_calls), tool_calls }; }
    if (calls === 2) return { message: { role: 'assistant', content: jsonReply('999只股票通过。') } };
    assert.equal(calls, 3); assert.match(messages.at(-1).content, /explanation_feedback/);
    return { message: { role: 'assistant', content: jsonReply('总市值不低于500亿元，逐项证据见结果。', ['screen:summary', 'screen:criteria']) } };
  };
  const result = await runScreeningConversation({ complete, exam, snapshot });
  assert.equal(result.explanation.status, 'verified'); assert.equal(result.tool_trace.length, 2); assert.equal(calls, 3);
});

test('解释请求超时保留已完成结果，未执行筛选前的失败仍明确失败', async () => {
  let calls = 0;
  const complete = async () => { calls++; if (calls > 1) throw Error('LLM请求超时'); const tool_calls = [toolCall('snap', 'get_snapshot'), toolCall('screen', 'run_screen')]; return { message: assistantToolMessage(tool_calls), tool_calls }; };
  const result = await runScreeningConversation({ complete, exam: confirmedExam(), snapshot });
  assert.equal(result.reply, null); assert.equal(result.results.rows.length, 3); assert.equal(result.explanation.status, 'unavailable');
  await assert.rejects(runScreeningConversation({ complete: async () => { throw Error('LLM请求超时'); }, exam: confirmedExam(), snapshot }), /超时/);
});

test('单独重试解释仅调用一次模型并复用相同结果，不调用工具', async () => {
  const results = evaluator.evaluateExam(confirmedExam({ includeMarketCap: true }), { snapshot }); let calls = 0;
  const result = await explainScreeningResults({ results, complete: async (messages, request) => {
    calls++; assert.equal(request.tools, undefined);
    assert.deepEqual(JSON.parse(messages[1].content).results, JSON.parse(JSON.stringify(results)));
    return { content: jsonReply('总市值条件为不低于500亿元。', ['screen:summary', 'screen:criteria']) };
  } });
  assert.equal(calls, 1); assert.equal(result.results, results); assert.equal(result.explanation.status, 'verified'); assert.equal(result.tool_trace.length, 0);
});
