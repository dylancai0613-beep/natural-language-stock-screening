const { test } = require('node:test');
const assert = require('node:assert/strict');
const questionnaire = require('../app/intent/questionnaire.cjs');
const intake = require('../app/intent/ai-intake.cjs');
const { createDeepSeekChat, parseEnv } = require('../app/providers/deepseek-chat.cjs');

const output = (updates = [], context = {}, unmapped = []) => JSON.stringify({ question_updates: updates, context_updates: context, unmapped_additions: unmapped });

test('首次激活应用服务端默认值，模型填写保持未确认', () => {
  const result = intake.applyModelResult(questionnaire.createExam(), '市盈率低于20倍', output([
    { metric_id: 'pe_ttm', active: true, slots: { operator: 'lt', threshold: 20 } }
  ]));
  const q = result.exam.questions.find(x => x.metric_id === 'pe_ttm');
  assert.equal(q.active, true);
  assert.equal(q.slots.basis.value, 'TTM');
  assert.equal(q.slots.basis.source, 'default');
  assert.equal(q.slots.basis.confirmed, false);
  assert.equal(q.slots.threshold.confirmed, false);
  assert.equal(q.validation, false);
});

test('模糊估值保留服务端默认20且不能归功于模型，补充日期只修改日期', () => {
  let result = intake.applyModelResult(questionnaire.createExam(), '估值低', output([
    { metric_id: 'pe_ttm', active: true, slots: { operator: 'lt', threshold: 20 } }
  ]));
  let q = result.exam.questions.find(x => x.metric_id === 'pe_ttm');
  assert.equal(q.slots.threshold.value, 20);
  assert.equal(q.slots.threshold.source, 'default');
  assert.equal(q.slots.operator.value, 'lt');
  assert.equal(q.slots.operator.source, 'default');
  assert.deepEqual(result.rejected_model_fields.sort(), ['pe_ttm.operator', 'pe_ttm.threshold']);
  result = intake.applyModelResult(result.exam, '截止2026-11-06', output([
    { metric_id: 'pe_ttm', active: true, slots: { as_of: '2026-11-06' } }
  ]));
  q = result.exam.questions.find(x => x.metric_id === 'pe_ttm');
  assert.equal(q.slots.as_of.value, '2026-11-06');
  assert.equal(q.slots.threshold.value, 20);
  assert.equal(q.slots.threshold.source, 'default');
});

test('多轮填写保留未修改槽位和原话', () => {
  let result = intake.applyModelResult(questionnaire.createExam(), '市盈率低于20倍', output([
    { metric_id: 'pe_ttm', active: true, slots: { operator: 'lt', threshold: 20 } }
  ]));
  result = intake.applyModelResult(result.exam, '数据截止2026-11-06', output([
    { metric_id: 'pe_ttm', active: true, slots: { as_of: '2026-11-06' } }
  ]));
  const q = result.exam.questions.find(x => x.metric_id === 'pe_ttm');
  assert.equal(q.slots.operator.value, 'lt');
  assert.equal(q.slots.threshold.value, 20);
  assert.equal(q.slots.as_of.value, '2026-11-06');
  assert.match(q.original_text, /市盈率低于20倍/);
  assert.match(q.original_text, /数据截止2026-11-06/);
});

test('总市值单位由服务端换算为人民币元，用户股票代码可入固定股票池', () => {
  const text = '总市值高于2万亿元，截至2026-11-06，股票代码600519.SH';
  const result = intake.applyModelResult(questionnaire.createExam(), text, output([
    { metric_id: 'market_cap_cny', active: true, slots: { operator: 'gt', threshold: 2, as_of: '2026-11-06' } }
  ], { universe: { type: 'explicit_symbols', symbols: ['600519.SH'] } }));
  const q = result.exam.questions.find(x => x.metric_id === 'market_cap_cny');
  assert.equal(q.slots.threshold.value, 2e12);
  assert.equal(result.exam.context.universe.value.symbols[0], '600519.SH');
  assert.equal(result.exam.context.universe.confirmed, false);
});

test('未映射需求不会在续填时被清空，显式解决会保留处理记录', () => {
  let result = intake.applyModelResult(questionnaire.createExam(), '市盈率低于行业平均', output([
    { metric_id: 'pe_ttm', active: true, slots: { operator: 'lt' } }
  ], {}, ['行业平均']));
  const id = result.exam.unmapped_inputs[0].id;
  result = intake.applyModelResult(result.exam, '阈值20倍', output([
    { metric_id: 'pe_ttm', active: true, slots: { threshold: 20 } }
  ]));
  assert.equal(result.exam.unmapped_inputs[0].status, 'open');
  const resolved = intake.resolveUnmappedInput(result.exam, id, '客户明确改为市盈率低于20倍');
  assert.equal(resolved.unmapped_inputs[0].status, 'resolved');
  assert.equal(resolved.unmapped_inputs[0].resolutions[0].text, '客户明确改为市盈率低于20倍');
  assert(!resolved.validation_errors.some(e => e.code === 'unmapped_intent'));
});

test('伪造validation、确认状态、题目或槽位会拒绝', () => {
  assert.throws(() => intake.applyModelResult(questionnaire.createExam(), 'x', '{"question_updates":[],"context_updates":{},"unmapped_additions":[],"validation":true}'), /未允许字段/);
  assert.throws(() => intake.applyModelResult(questionnaire.createExam(), 'x', output([
    { metric_id: 'pe_ttm', active: true, confirmed: true, slots: {} }
  ])), /未允许字段/);
  assert.throws(() => intake.applyModelResult(questionnaire.createExam(), 'x', output([
    { metric_id: 'industry_pe_percentile', active: true, slots: {} }
  ])), /未知题目/);
  assert.throws(() => intake.applyModelResult(questionnaire.createExam(), 'x', output([
    { metric_id: 'pe_ttm', active: true, slots: { validation: true } }
  ])), /未允许字段/);
  assert.throws(() => intake.applyModelResult(questionnaire.createExam(), 'x', '{bad'), /无效JSON/);
});

test('DeepSeek适配器发送JSON模式、禁用thinking、限长并返回tokens', async () => {
  let request;
  const complete = createDeepSeekChat({
    config: { apiKey: 'unit-test-secret', baseUrl: 'https://api.example.test', model: 'deepseek-flash' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }) };
    }
  });
  const result = await complete([{ role: 'user', content: '{}' }]);
  assert.equal(request.url, 'https://api.example.test/chat/completions');
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.max_tokens, 1800);
  assert.deepEqual(result.usage, { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });
  assert.equal(request.options.headers.authorization, 'Bearer unit-test-secret');
});

test('DeepSeek适配器拒绝截断JSON且错误不回显密钥', async () => {
  const complete = createDeepSeekChat({
    config: { apiKey: 'secret-marker', baseUrl: 'https://api.example.test', model: 'deepseek-flash' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }) })
  });
  await assert.rejects(complete([]), error => error.message.includes('长度上限') && !error.message.includes('secret-marker'));
  assert.deepEqual(parseEnv('LLM_API_KEY="abc"\nLLM_BASE_URL=https://api.example.test\nLLM_MODEL=deepseek-flash'), {
    LLM_API_KEY: 'abc', LLM_BASE_URL: 'https://api.example.test', LLM_MODEL: 'deepseek-flash'
  });
});

test('DeepSeek适配器对鉴权错误、空内容和body读取超时明确失败', async () => {
  const config = { apiKey: 'secret-marker', baseUrl: 'https://api.example.test', model: 'deepseek-flash' };
  const unauthorized = createDeepSeekChat({ config, fetchImpl: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(unauthorized([]), /HTTP错误 401/);
  const empty = createDeepSeekChat({ config, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '  ' } }] }) }) });
  await assert.rejects(empty([]), /内容为空/);
  const slowBody = createDeepSeekChat({
    config, timeoutMs: 10,
    fetchImpl: async () => ({ ok: true, json: async () => await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ choices: [{ message: { content: '{}' } }] }), 50);
      setTimeout(() => { clearTimeout(timer); reject(new Error('body aborted')); }, 15);
    }) })
  });
  await assert.rejects(slowBody([]), /超时/);
});


test('截图选项：报告期和市值下限兼容原数500亿及已换算50000000000元', () => {
  for (const threshold of [500, 50000000000]) {
    const result = intake.applyModelResult(questionnaire.createExam(), '报告期用2025-Q4，市值下限500亿元', output([
      { metric_id: 'market_cap_cny', active: true, slots: { operator: 'gte', threshold } },
      { metric_id: 'revenue_yoy_acceleration_pp', active: true, slots: { report: '2025-Q4', current_quarter: '2025-Q4' } }
    ]));
    assert.deepEqual(result.rejected_model_fields, []);
    const cap = result.exam.questions.find(item => item.metric_id === 'market_cap_cny');
    assert.equal(cap.slots.operator.value, 'gte'); assert.equal(cap.slots.threshold.value, 50000000000);
    assert.equal(cap.slots.threshold.source, 'user_input'); assert.equal(cap.slots.threshold.confirmed, false);
  }
});

test('金额不能借用报告年份或其他指标的倍数，单位不可虚构', () => {
  for (const threshold of [999, 2025, 20]) {
    const result = intake.applyModelResult(questionnaire.createExam(), '报告期2025-Q4，PE低于20倍，市值下限500亿元', output([
      { metric_id: 'market_cap_cny', active: true, slots: { operator: 'gte', threshold } }
    ]));
    assert.ok(result.rejected_model_fields.includes('market_cap_cny.threshold'));
  }
  const result = intake.applyModelResult(questionnaire.createExam(), '市值下限500', output([{ metric_id: 'market_cap_cny', active: true, slots: { threshold: 50000000000 } }]));
  assert.ok(result.rejected_model_fields.includes('market_cap_cny.threshold'));
});

test('中文明确季度与日期可归一，上限和下限包含边界', () => {
  const result = intake.applyModelResult(questionnaire.createExam(), '截至2026年11月9日，2025年第四季度，市值上限1000亿元', output([
    { metric_id: 'market_cap_cny', active: true, slots: { operator: 'lte', threshold: 100000000000, as_of: '2026-11-09' } },
    { metric_id: 'revenue_yoy_acceleration_pp', active: true, slots: { report: '2025-Q4', current_quarter: '2025-Q4' } }
  ]));
  assert.deepEqual(result.rejected_model_fields, []);
  assert.equal(result.exam.questions.find(item => item.metric_id === 'market_cap_cny').slots.operator.value, 'lte');
});
