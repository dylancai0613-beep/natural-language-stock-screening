// Model-mediated tool loop for deterministic screening. No data or criteria are invented here.
const fs = require('node:fs');
const path = require('node:path');
const evaluator = require('./evaluator.cjs');

const root = path.resolve(__dirname, '../../..');
const promptFile = path.join(root, 'config', 'prompts', 'screening.md');
const MAX_TOOL_ROUNDS = 4;
const MAX_REPLY_LENGTH = 1200;
function readMetricLabels() {
  try {
    const paper = JSON.parse(fs.readFileSync(path.join(root, 'contracts', '选股意图试卷.json'), 'utf8').replace(/^\uFEFF/, ''));
    return Object.freeze(Object.fromEntries(paper.questions.map(question => [question.metric_id, question.label])));
  } catch { return Object.freeze({}); }
}
const metricLabels = readMetricLabels();
const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'get_snapshot',
      description: '读取当前已提供的本地只读真实数据快照及覆盖、日期、质量信息。无数据时如实返回不可用。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_screen',
      description: '对已确认且锁定的筛选卡片运行确定性本地评估器。不得传入股票、条件、代码或查询语句。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
    }
  }
];

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

class ScreeningConversationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ScreeningConversationError';
    this.tool_trace = details.tool_trace || [];
    this.usage = details.usage || null;
  }
}

function safeMetricValue(value, fieldName) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= 128 && !/[\r\n\u0000-\u001f]/.test(value)) return value;
  if (Array.isArray(value) && value.length <= 4 && value.every(item => typeof item === 'number' && Number.isFinite(item))) return value.slice();
  throw new ScreeningConversationError('已确认条件卡片含不支持的字段值: ' + fieldName);
}

// Keep only fields used by the evaluator. In particular, free-form original_text is not sent to the model.
function lockConfirmedExam(exam) {
  if (!exam || exam.validation !== true) throw new ScreeningConversationError('请先补充并确认当前条件。');
  if (!Array.isArray(exam.questions) || !exam.questions.some(question => question?.active === true)) {
    throw new ScreeningConversationError('已确认条件中没有可执行的筛选题目。');
  }
  if (Array.isArray(exam.unmapped_inputs) && exam.unmapped_inputs.some(item => typeof item === 'string' || item?.status !== 'resolved')) {
    throw new ScreeningConversationError('仍有未映射需求，不能开始筛选。');
  }
  const universe = exam.context?.universe;
  const combination = exam.context?.combination;
  if (universe?.confirmed !== true || combination?.confirmed !== true || !['all', 'any'].includes(combination.value)) {
    throw new ScreeningConversationError('股票范围和条件组合方式都需要先确认。');
  }
  const u = universe.value;
  if (u?.type === 'explicit_symbols') {
    if (!Array.isArray(u.symbols) || !u.symbols.length || u.symbols.some(code => typeof code !== 'string' || !/^\d{6}\.(SH|SZ|BJ)$/.test(code))) {
      throw new ScreeningConversationError('已确认股票范围格式无效。');
    }
  } else if (u?.type === 'index_constituents') {
    if (typeof u.index_code !== 'string' || !/^\d{6}\.(SH|SZ|BJ)$/.test(u.index_code)) throw new ScreeningConversationError('已确认指数范围格式无效。');
  } else throw new ScreeningConversationError('已确认股票范围类型不受支持。');

  const questions = exam.questions.map(question => {
    if (!question || typeof question.metric_id !== 'string' || !/^[a-z0-9_]{1,80}$/.test(question.metric_id) || typeof question.active !== 'boolean') {
      throw new ScreeningConversationError('已确认条件卡片结构无效。');
    }
    if (question.active && question.validation !== true) throw new ScreeningConversationError('仍有未确认或无效的筛选题目。');
    const slots = {};
    if (question.active) {
      if (!question.slots || typeof question.slots !== 'object' || Array.isArray(question.slots)) throw new ScreeningConversationError('已确认筛选题目缺少条件槽位。');
      for (const [key, entry] of Object.entries(question.slots)) {
        if (!/^[a-z0-9_]{1,80}$/.test(key) || !entry || entry.confirmed !== true || !Object.hasOwn(entry, 'value')) {
          throw new ScreeningConversationError('筛选题目的槽位尚未确认。');
        }
        if (!['default', 'user_input'].includes(entry.source)) throw new ScreeningConversationError('筛选题目的槽位来源无效。');
        slots[key] = { value: safeMetricValue(entry.value, key), source: entry.source, confirmed: true };
      }
    }
    return {
      metric_id: question.metric_id,
      label: typeof question.label === 'string' ? question.label.slice(0, 100) : undefined,
      active: question.active,
      validation: question.active ? true : question.validation === true,
      ...(question.active ? { slots } : {})
    };
  });
  const card = {
    validation: true,
    template_version: typeof exam.template_version === 'string' ? exam.template_version.slice(0, 40) : null,
    context: {
      universe: { value: clone(u), confirmed: true },
      combination: { value: combination.value, confirmed: true }
    },
    unmapped_inputs: [],
    questions
  };
  return deepFreeze(card);
}

function cardForModel(exam) {
  return {
    template_version: exam.template_version,
    context: { universe: { value: exam.context.universe.value }, combination: { value: exam.context.combination.value } },
    questions: exam.questions.map(question => ({
      metric_id: question.metric_id,
      label: metricLabels[question.metric_id] || question.label || question.metric_id,
      active: question.active,
      ...(question.active ? { slots: Object.fromEntries(Object.entries(question.slots).map(([key, entry]) => [key, { value: entry.value }])) } : {})
    }))
  };
}

function snapshotSummary(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { available: false, status: 'unavailable', provider: null, snapshot_id: null, data_date: null, coverage: null, quality: { metadata_match: false, note: '没有本地真实数据快照。' }, items: [] };
  }
  const items = Array.isArray(snapshot.items) ? snapshot.items.map(item => ({
    thscode: item.thscode,
    name: item.name,
    data_date: item.data_date || snapshot.data_date || null,
    metrics: Object.fromEntries(Object.entries(item.metrics || {}).map(([metricId, metric]) => [metricId, {
      value: Number.isFinite(metric?.value) ? metric.value : null,
      raw_value: typeof metric?.raw_value === 'string' ? metric.raw_value : null,
      unit: metric?.unit || null,
      source_field: metric?.source_field || null
    }]))
  })) : [];
  return {
    available: snapshot.status === 'usable_for_exact_date_only' && items.length > 0,
    status: snapshot.status || 'unavailable',
    provider: snapshot.source?.provider || null,
    snapshot_id: snapshot.snapshot_id || null,
    data_date: snapshot.data_date || null,
    coverage: snapshot.coverage ? clone(snapshot.coverage) : null,
    quality: {
      metadata_match: snapshot.metadata?.metadata_match === true,
      note: snapshot.metadata?.caveat || '没有可用的数据质量说明。'
    },
    items
  };
}

function evidenceRefs(results) {
  const refs = ['screen:summary', 'screen:coverage', 'screen:date', 'screen:criteria'];
  for (const row of results.rows || []) {
    refs.push('screen:row:' + row.thscode);
    for (const condition of row.conditions || []) refs.push('screen:condition:' + row.thscode + ':' + condition.metric_id);
  }
  if (results.comparison) refs.push('screen:comparison');
  return refs;
}

function sanitizedPrevious(previous) {
  if (!previous || typeof previous !== 'object' || typeof previous.snapshot_id !== 'string' || !Array.isArray(previous.rows)) return null;
  return {
    snapshot_id: previous.snapshot_id,
    rows: previous.rows.filter(row => row && typeof row.thscode === 'string' && ['pass', 'fail', 'unknown'].includes(row.status))
      .map(row => ({ thscode: row.thscode, status: row.status }))
  };
}

function parseToolArguments(call) {
  const raw = call?.function?.arguments;
  if (typeof raw !== 'string') throw new ScreeningConversationError('模型工具参数格式无效。');
  let args;
  try { args = JSON.parse(raw); } catch { throw new ScreeningConversationError('模型工具参数不是有效JSON。'); }
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 0) {
    throw new ScreeningConversationError('筛选工具不接受参数；条件只能来自已确认卡片。');
  }
  return args;
}

function buildUsage() {
  const calls = [];
  function add(usage, model) {
    const entry = { prompt_tokens: null, completion_tokens: null, total_tokens: null, model: typeof model === 'string' ? model.slice(0, 100) : null };
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
      if (Number.isFinite(usage?.[key]) && usage[key] >= 0) entry[key] = usage[key];
    }
    calls.push(entry);
  }
  function summary() {
    const total = key => {
      const values = calls.map(call => call[key]).filter(Number.isFinite);
      return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
    };
    return { calls: calls.length, prompt_tokens: total('prompt_tokens'), completion_tokens: total('completion_tokens'), total_tokens: total('total_tokens'), by_call: calls.map(call => ({ ...call })) };
  }
  return { add, summary };
}

function numericEvidence(results) {
  const refsByNumber = new Map();
  const numberKey = token => String(Number(String(token).replaceAll(',', '')));
  const refsByDate = new Map();
  const addDate = (date, refs) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    if (!refsByDate.has(date)) refsByDate.set(date, new Set());
    for (const ref of refs) refsByDate.get(date).add(ref);
  };
  const add = (value, refs) => {
    const tokens = String(value).match(/\d[\d,]*(?:\.\d+)?/g) || [];
    for (const token of tokens) {
      const key = numberKey(token);
      if (!refsByNumber.has(key)) refsByNumber.set(key, new Set());
      for (const ref of refs) refsByNumber.get(key).add(ref);
    }
  };
  const walk = (value, refs) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      add(String(value), refs);
      if (Number.isInteger(value)) add(value.toLocaleString('en-US'), refs);
    } else if (typeof value === 'string') {
      add(value, refs);
      for (const match of value.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) addDate(match[0], refs);
    }
    else if (Array.isArray(value)) for (const item of value) walk(item, refs);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item, refs);
  };
  add(results.data_date || '', ['screen:date']);
  if (results.data_date) addDate(results.data_date, ['screen:date']);
  for (const count of Object.values(results.counts || {})) add(count, ['screen:summary']);
  add(results.coverage?.count, ['screen:coverage']);
  for (const row of results.rows || []) {
    const rowRef = 'screen:row:' + row.thscode;
    add(row.thscode, [rowRef]);
    add(row.name, [rowRef]);
    for (const condition of row.conditions || []) {
      const conditionRef = 'screen:condition:' + row.thscode + ':' + condition.metric_id;
      walk(condition, [conditionRef, rowRef]);
      walk(condition.requested || {}, ['screen:criteria']);
      if (condition.threshold !== undefined) walk(condition.threshold, ['screen:criteria']);
      if (condition.metric_id === 'market_cap_cny') {
        const addMoney = (value, refs) => {
          if (Array.isArray(value)) { value.forEach(item => addMoney(item, refs)); return; }
          if (!Number.isFinite(value)) return;
          for (const factor of [1, 1e4, 1e8, 1e12]) add(Number((value / factor).toPrecision(15)), refs);
        };
        addMoney(condition.value, [conditionRef, rowRef]);
        addMoney(condition.threshold ?? condition.requested?.threshold?.value, [conditionRef, rowRef, 'screen:criteria']);
      }
    }
  }
  if (results.comparison) walk(results.comparison, ['screen:comparison']);
  return { refsByNumber, refsByDate };
}

function parseFinalAnswer(content, allowedRefs, results) {
  let answer;
  try { answer = JSON.parse(content); } catch { throw new ScreeningConversationError('模型筛选解释不是有效JSON，未返回结果。'); }
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || Object.keys(answer).some(key => !['reply', 'evidence_refs'].includes(key))) {
    throw new ScreeningConversationError('模型筛选解释字段不符合约定，未返回结果。');
  }
  if (typeof answer.reply !== 'string' || !answer.reply.trim() || answer.reply.length > MAX_REPLY_LENGTH || !Array.isArray(answer.evidence_refs)) {
    throw new ScreeningConversationError('模型筛选解释缺少回复或证据引用，未返回结果。');
  }
  if (answer.evidence_refs.length === 0 || answer.evidence_refs.some(ref => typeof ref !== 'string' || !allowedRefs.has(ref))) {
    throw new ScreeningConversationError('模型筛选解释引用了不存在的证据，未返回结果。');
  }
  // Numeric and per-company decision claims belong to the deterministic result table, not generated prose.
  const numeric = numericEvidence(results);
  const dates = [...answer.reply.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(match => match[0]);
  for (const date of dates) {
    const refs = numeric.refsByDate.get(date);
    if (!refs || !answer.evidence_refs.some(ref => refs.has(ref))) {
      throw new ScreeningConversationError('模型回复包含未由筛选结果支持的日期，未返回结果。');
    }
  }
  const withoutDates = answer.reply.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '');
  for (const match of withoutDates.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const refs = numeric.refsByNumber.get(String(Number(match[0].replaceAll(',', ''))));
    if (!refs || !answer.evidence_refs.some(ref => refs.has(ref))) {
      throw new ScreeningConversationError('模型回复包含未由评估结果支持的数值或缺少对应证据引用，未返回结果。');
    }
  }
  for (const row of results.rows || []) {
    if (row.name && answer.reply.includes(row.name) && !answer.evidence_refs.includes('screen:row:' + row.thscode)) {
      throw new ScreeningConversationError('模型回复提及股票但未引用对应行证据，未返回结果。');
    }
    if (answer.reply.includes(row.thscode) && !answer.evidence_refs.includes('screen:row:' + row.thscode)) {
      throw new ScreeningConversationError('模型回复提及股票代码但未引用对应行证据，未返回结果。');
    }
  }
  return { reply: answer.reply.trim(), evidence_refs: answer.evidence_refs };
}

async function runScreeningConversation({ complete, exam, snapshot, previous = null, maxRounds = MAX_TOOL_ROUNDS } = {}) {
  const trace = [];
  const usage = buildUsage();
  const fail = message => { throw new ScreeningConversationError(message, { tool_trace: trace.map(clone), usage: usage.summary() }); };
  if (typeof complete !== 'function') fail('缺少模型调用函数，无法开始筛选。');
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_TOOL_ROUNDS) fail('模型工具调用轮数必须为1到4轮。');

  let lockedExam;
  try { lockedExam = lockConfirmedExam(exam); }
  catch (error) { fail(error.message); }
  const actualSnapshot = snapshot === undefined ? evaluator.readSnapshot() : snapshot;
  const safePrevious = sanitizedPrevious(previous);
  const systemPrompt = fs.readFileSync(promptFile, 'utf8').trim();
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: JSON.stringify({ task: '根据这份已经确认的筛选卡片执行本地筛选，并解释结果。卡片只读，不得改变。', confirmed_exam: cardForModel(lockedExam) }) }
  ];
  const requestedIds = new Set();
  const allowedRefs = new Set();
  const seenCallIds = new Set();
  let snapshotRead = false;
  let results = null;
  let explanationRepairUsed = false;

  try {
    for (let round = 0; round < maxRounds; round++) {
      let completion;
      try {
        completion = await complete(clone(messages), { tools: clone(toolDefinitions), tool_choice: 'auto', max_tokens: 1100 });
      } catch (error) {
        fail(error?.message || '模型请求失败。');
      }
      usage.add(completion?.usage, completion?.model);
      const assistantMessage = completion?.message;
      if (!assistantMessage || assistantMessage.role !== 'assistant' || (assistantMessage.content !== null && typeof assistantMessage.content !== 'string')) {
        fail('模型没有返回有效的assistant消息。');
      }
      const messageCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
      const responseCalls = Array.isArray(completion.tool_calls) ? completion.tool_calls : [];
      if (messageCalls.length && responseCalls.length && JSON.stringify(messageCalls) !== JSON.stringify(responseCalls)) fail('模型工具调用响应不一致。');
      const calls = messageCalls.length ? messageCalls : responseCalls;
      if (completion.finish_reason === 'tool_calls' && calls.length === 0) fail('模型声明工具调用但没有提供调用内容。');

      if (calls.length) {
        messages.push(assistantMessage); // Preserve the provider's assistant tool-call message exactly.
        for (const call of calls) {
          const id = call?.id;
          const name = call?.function?.name;
          if (typeof id !== 'string' || !id || id.length > 200 || seenCallIds.has(id)) {
            trace.push({ name: typeof name === 'string' ? name.slice(0, 80) : null, arguments: null, status: 'rejected' });
            fail('模型工具调用ID无效或重复，已停止筛选。');
          }
          seenCallIds.add(id);
          if (name !== 'get_snapshot' && name !== 'run_screen') {
            trace.push({ name: typeof name === 'string' ? name.slice(0, 80) : null, arguments: null, status: 'unsupported_tool' });
            fail('模型请求了未授权的工具，已停止筛选。');
          }
          let args;
          try { args = parseToolArguments(call); }
          catch (error) {
            trace.push({ name, arguments: null, status: 'rejected' });
            fail(error.message);
          }
          if (requestedIds.has(name)) {
            trace.push({ name, arguments: args, status: 'repeated_call' });
            fail('模型重复请求同一工具，已停止筛选。');
          }
          if (name === 'run_screen' && !snapshotRead) {
            trace.push({ name, arguments: args, status: 'out_of_order' });
            fail('执行筛选前必须先通过工具读取本地快照，已停止筛选。');
          }
          requestedIds.add(name);
          let toolResult;
          if (name === 'get_snapshot') {
            snapshotRead = true;
            toolResult = snapshotSummary(actualSnapshot);
            for (const ref of ['snapshot:summary', 'snapshot:coverage', 'snapshot:date', 'snapshot:quality']) allowedRefs.add(ref);
            trace.push({ name, arguments: args, status: toolResult.available ? 'ok' : 'unavailable' });
          } else {
            try {
              results = evaluator.evaluateExam(lockedExam, { snapshot: actualSnapshot, previous: safePrevious });
            } catch (error) {
              trace.push({ name, arguments: args, status: 'error' });
              fail(error?.message || '本地评估器执行失败，未返回筛选结果。');
            }
            const refs = evidenceRefs(results);
            refs.forEach(ref => allowedRefs.add(ref));
            toolResult = { results, evidence_refs: refs };
            trace.push({ name, arguments: args, status: 'ok' });
          }
          messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(toolResult) });
        }
        continue;
      }

      if (!results || !requestedIds.has('run_screen')) fail('模型未通过run_screen工具执行确定性筛选，不能返回结果。');
      if (typeof assistantMessage.content !== 'string' || !assistantMessage.content.trim()) fail('模型没有返回筛选解释，未返回结果。');
      let finalAnswer;
      try { finalAnswer = parseFinalAnswer(assistantMessage.content, allowedRefs, results); }
      catch (error) {
        if (!explanationRepairUsed && round + 1 < maxRounds) {
          explanationRepairUsed = true;
          messages.push(assistantMessage, { role: 'user', content: JSON.stringify({ explanation_feedback: error.message, instruction: '筛选已经成功，不要再次调用工具，不要改变结果。仅修正解释中的数值格式和证据引用；金额可精确换算元/万元/亿元/万亿元，其他指标保留原始精度。整体条件可引用screen:criteria，股票要引用对应行，计数引用screen:summary。只返回reply和evidence_refs的JSON。' }) });
          continue;
        }
        fail(error.message);
      }
      return { results, reply: finalAnswer.reply, explanation: { status: 'verified', evidence_refs: finalAnswer.evidence_refs }, tool_trace: trace, usage: usage.summary() };
    }
    fail('模型在允许的工具调用轮数内未完成筛选与解释。');
  } catch (error) {
    // A language/protocol failure after the real evaluator ran cannot erase its result.
    if (results && requestedIds.has('run_screen')) return { results, reply: null, explanation: { status: 'unavailable', retryable: true }, tool_trace: trace, usage: usage.summary() };
    if (error instanceof ScreeningConversationError) {
      if (!error.tool_trace.length) error.tool_trace = trace.map(clone);
      if (!error.usage) error.usage = usage.summary();
      throw error;
    }
    throw new ScreeningConversationError(error?.message || '筛选对话失败。', { tool_trace: trace.map(clone), usage: usage.summary() });
  }
}

async function explainScreeningResults({ complete, results }) {
  if (typeof complete !== 'function' || !results || !Array.isArray(results.rows) || !results.counts) throw new ScreeningConversationError('没有可解释的筛选结果。');
  const usage = buildUsage();
  try {
    const messages = [
      { role: 'system', content: fs.readFileSync(path.join(root, 'config/prompts/explanation.md'), 'utf8') },
      { role: 'user', content: JSON.stringify({ results, evidence_refs: evidenceRefs(results) }) }
    ];
    const response = await complete(messages, { max_tokens: 1100 });
    usage.add(response.usage, response.model);
    const answer = parseFinalAnswer(response.content ?? response.message?.content, new Set(evidenceRefs(results)), results);
    return { results, reply: answer.reply, explanation: { status: 'verified', evidence_refs: answer.evidence_refs }, tool_trace: [], usage: usage.summary() };
  } catch {
    return { results, reply: null, explanation: { status: 'unavailable', retryable: true }, tool_trace: [], usage: usage.summary() };
  }
}

module.exports = {
  runScreeningConversation,
  explainScreeningResults,
  lockConfirmedExam,
  snapshotSummary,
  evidenceRefs,
  ScreeningConversationError,
  buildToolDefinitions: () => clone(toolDefinitions)
};
