// Three bounded, manually constructed LLM cases. Use --live to permit network calls.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const questionnaire = require('../backend/app/intent/questionnaire.cjs');
const { fillFromText } = require('../backend/app/intent/ai-intake.cjs');
const { loadConfig, createDeepSeekChat } = require('../backend/app/providers/deepseek-chat.cjs');

const outputFile = path.resolve(__dirname, '../data/runs/model-intake-check.json');
const liveMode = process.argv.includes('--live');
const mockMode = process.argv.includes('--mock');
if (liveMode && mockMode) throw new Error('一次只能选择--live或--mock');
if (!liveMode && !mockMode) {
  console.log('Dry run: no model or financial API requests. Use --mock for a local run or --live for at most 3 model requests.');
  process.exit(0);
}

const config = liveMode ? loadConfig() : { model: 'local-mock' };
const liveCall = liveMode ? createDeepSeekChat({ config, timeoutMs: 20000, maxTokens: 700 }) : null;
const mockOutputs = [
  { question_updates: [{ metric_id: 'pe_ttm', active: true, slots: {} }], context_updates: {}, unmapped_additions: [] },
  { question_updates: [{ metric_id: 'pe_ttm', active: true, slots: { operator: 'lt', threshold: 20, as_of: '2026-11-06' } }], context_updates: { universe: { type: 'explicit_symbols', symbols: ['600519.SH'] } }, unmapped_additions: [] },
  { question_updates: [{ metric_id: 'market_cap_cny', active: true, slots: { operator: 'gt', threshold: 2, as_of: '2026-11-06' } }], context_updates: { universe: { type: 'explicit_symbols', symbols: ['600519.SH'] } }, unmapped_additions: [] }
];
let mockIndex = 0;
const localMockCall = async () => ({ content: JSON.stringify(mockOutputs[mockIndex++]), model: 'local-mock', usage: null });
const call = liveCall || localMockCall;
const report = { created_at: new Date().toISOString(), mode: liveMode ? 'live' : 'mock', model: config.model, max_requests: 3, requests: [] };
const reportPath = liveMode ? outputFile : path.resolve(__dirname, '../data/runs/model-intake-mock-check.json');
let requestCount = 0;
async function boundedCall(messages) {
  if (requestCount >= 3) throw new Error('已达到本脚本3次调用上限');
  requestCount++;
  try {
    const result = await call(messages);
    report.requests.push({ status: 'success', model: result.model, usage: result.usage });
    return result;
  } catch (error) {
    report.requests.push({ status: 'failed', error: error.message });
    throw error;
  }
}

async function main() {
  let exam = questionnaire.createExam();
  const first = await fillFromText({ userText: '估值低的股票', exam, complete: boundedCall });
  exam = first.exam;
  const fuzzyPe = exam.questions.find(q => q.metric_id === 'pe_ttm');
  assert.equal(fuzzyPe?.active, true, '模糊估值场景必须实际选择市盈率题');
  assert.equal(fuzzyPe?.slots.threshold.value, 20, '模糊估值采用后台预写默认20倍');
  assert.equal(fuzzyPe?.slots.threshold.source, 'default', '产品默认不得冒充模型或客户原话');
  assert.equal(fuzzyPe?.slots.operator.value, 'lt');
  assert.equal(fuzzyPe?.slots.operator.source, 'default');
  report.requests[0].scenario = 'ambiguous_valuation_uses_server_default';
  report.requests[0].validation = exam.validation;
  report.requests[0].pe_threshold_default = 20;
  report.requests[0].pe_threshold_source = fuzzyPe?.slots.threshold.source;
  console.log('1/3 ambiguous valuation: server default PE<20 source=default; exam validation=' + exam.validation);

  const second = await fillFromText({
    userText: '继续筛选市盈率低于20倍、截至2026-11-06，股票代码600519.SH', exam, complete: boundedCall
  });
  exam = second.exam;
  const pe = exam.questions.find(q => q.metric_id === 'pe_ttm');
  assert.equal(pe?.slots.threshold.value, 20, '续填应应用本轮明确阈值');
  assert.equal(pe?.slots.as_of.value, '2026-11-06', '续填应应用明确日期');
  assert.equal(pe?.slots.basis.value, 'TTM', '首次激活时应应用预写默认口径');
  assert.equal(pe?.slots.basis.source, 'default');
  assert.equal(exam.context.universe.value?.symbols?.[0], '600519.SH', '股票池应只取原话明确代码');
  assert.equal(exam.validation, false, '模型填空不得代替客户确认');
  assert.equal(pe?.slots.threshold.confirmed, false);
  const followupExam = exam;
  report.requests[1].scenario = 'followup_applies_to_existing_exam';
  report.requests[1].validation = exam.validation;
  report.requests[1].preserved_prior_selection = pe.active;
  report.requests[1].threshold = pe.slots.threshold.value;
  report.requests[1].as_of = pe.slots.as_of.value;
  console.log('2/3 follow-up: PE threshold/date applied to existing exam; validation=' + exam.validation);

  const capText = '总市值高于2万亿元，截至2026-11-06，股票代码600519.SH';
  const capResult = await fillFromText({ userText: capText, exam: questionnaire.createExam(), complete: boundedCall });
  const cap = capResult.exam.questions.find(q => q.metric_id === 'market_cap_cny');
  assert.equal(cap?.slots.threshold.value, 2e12, '市值单位应归一为CNY');
  report.requests[2].scenario = 'market_cap_unit_normalized_to_cny';
  report.requests[2].validation = capResult.exam.validation;
  report.requests[2].threshold_cny = cap.slots.threshold.value;
  console.log('3/3 market cap: threshold normalized to CNY ' + cap.slots.threshold.value + '; validation=' + capResult.exam.validation);

  // Local-only simulation of a customer confirmation; this does not alter any live model result.
  const simulated = structuredClone(followupExam);
  const simulatedPe = simulated.questions.find(q => q.metric_id === 'pe_ttm');
  Object.assign(simulatedPe, questionnaire.confirmSlots(simulatedPe, Object.keys(simulatedPe.slots)));
  simulated.context.universe.confirmed = true;
  simulated.context.combination.confirmed = true;
  const simulatedResult = questionnaire.validateExam(simulated);
  assert.equal(simulatedResult.validation, true, '显式模拟客户确认后整张试卷应通过');
  report.simulated_confirmation = { status: 'passed', validation: true, note: '本地模拟客户确认，未增加模型或金融API请求' };
  console.log('local confirmation simulation: validation=true (no additional API request)');
}

main().catch(error => {
  report.failure = error.message;
  console.error('Model intake verification failed: ' + error.message);
  process.exitCode = 1;
}).finally(() => {
  report.request_count = requestCount;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log('Private summary written to ' + path.relative(path.resolve(__dirname, '..'), reportPath) + ' (no prompt, answer text, or key).');
});
