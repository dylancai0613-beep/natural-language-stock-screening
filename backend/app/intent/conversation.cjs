// Product-specific conversation protocol: DeepSeek proposes language and fixed-card
// patches; this module validates every field and leaves confirmation to the customer.
const fs = require('node:fs');
const path = require('node:path');
const intake = require('./ai-intake.cjs');
const questionnaire = require('./questionnaire.cjs');
const { resolveUnmappedInput } = intake;

const root = path.resolve(__dirname, '../../..');
const capabilities = JSON.parse(fs.readFileSync(path.join(root, 'docs/data-capabilities.json'), 'utf8'));
const paper = JSON.parse(fs.readFileSync(path.join(root, 'contracts/选股意图试卷.json'), 'utf8'));
const metricById = new Map(paper.questions.map(item => {
  const contract = JSON.parse(fs.readFileSync(path.resolve(root, 'contracts', item.template), 'utf8'));
  const metrics = JSON.parse(fs.readFileSync(path.resolve(root, 'contracts', contract.metric_file), 'utf8'));
  return [item.metric_id, { item, contract, metrics }];
}));
const EXECUTABLE_IDS = new Set(capabilities.current_delivery?.executable_metrics || ['pe_ttm', 'market_cap_cny']);
const clone = value => JSON.parse(JSON.stringify(value));

function assertKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + '必须是对象');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(label + '包含未允许字段: ' + key);
}

function publicCatalog() {
  return paper.questions.map(({ metric_id }) => {
    const entry = metricById.get(metric_id);
    return {
      metric_id,
      label: entry.item.label,
      category: entry.item.category,
      slots: entry.contract.slot_definitions,
      meaning: entry.metrics.formula,
      default_interpretation: entry.metrics.default_interpretation || null,
      enabled_for_screening: entry.metrics.enabled_for_screening === true,
      availability: entry.metrics.availability || 'unknown'
    };
  });
}

function compactCard(exam) {
  return {
    context: Object.fromEntries(Object.entries(exam.context || {}).map(([key, item]) => [key, item?.value ?? null])),
    context_sources: Object.fromEntries(Object.entries(exam.context || {}).map(([key, item]) => [key, item?.source || null])),
    questions: (exam.questions || []).filter(question => question.active).map(question => ({
      metric_id: question.metric_id,
      label: metricById.get(question.metric_id)?.item.label || question.metric_id,
      slots: Object.fromEntries(Object.entries(question.slots || {}).map(([key, slot]) => [key, { value: slot?.value ?? null, source: slot?.source || null }]))
    })),
    unmapped_inputs: (exam.unmapped_inputs || []).map(item => typeof item === 'string' ? { text: item, status: 'open' } : ({ id: item.id, text: item.text, status: item.status, resolutions: item.resolutions || [] })),
    validation: questionnaire.validateExam(exam).validation,
    validation_issues: (questionnaire.validateExam(exam).validation_errors || []).map(error => ({ metric_id: error.metric_id, slot: error.slot, code: error.code, message: error.message }))
  };
}

function buildClarifyMessages({ history = [], userText, exam, dataStatus = {}, validationFeedback = null }) {
  if (typeof userText !== 'string' || !userText.trim()) throw new Error('请先发送一条消息');
  const system = fs.readFileSync(path.join(root, 'config/prompts/chat-clarify.md'), 'utf8');
  const priorTurns = history.filter(item => ['user', 'assistant'].includes(item.role) && typeof item.text === 'string').slice(-12).map(item => ({
    role: item.role,
    content: `${item.text}${item.role === 'assistant' && item.options?.length ? '\n可选择的回复：' + item.options.join('；') : ''}`.slice(0, 1400)
  }));
  const payload = {
    current_user_message: userText,
    ...(validationFeedback ? { validation_feedback: validationFeedback } : {}),
    recent_conversation: priorTurns,
    fixed_metric_catalog: publicCatalog(),
    current_card: compactCard(exam),
    data_capabilities: {
      provider: dataStatus.provider || capabilities.current_delivery?.source || null,
      data_date: dataStatus.data_date || capabilities.current_delivery?.snapshot_date || null,
      sample_count: dataStatus.count || 0,
      coverage: dataStatus.coverage || null,
      executable_metrics: [...EXECUTABLE_IDS],
      caveat: dataStatus.caveat || capabilities.current_delivery?.caveat || null,
      unavailable_metrics: paper.questions.map(item => item.metric_id).filter(id => !EXECUTABLE_IDS.has(id))
    }
  };
  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(payload) }
  ];
}

function parseClarifyResponse(content) {
  if (typeof content !== 'string' || !content.trim() || content.length > 16000) throw new Error('模型澄清回复为空或超过长度限制');
  let value;
  try { value = JSON.parse(content); } catch { throw new Error('模型澄清回复不是有效JSON'); }
  assertKeys(value, ['reply', 'question_updates', 'context_updates', 'unmapped_additions', 'options', 'semantic_unresolved', 'unavailable_metric_ids', 'resolve_unmapped_ids'], '模型澄清回复');
  if (typeof value.reply !== 'string' || !value.reply.trim() || value.reply.length > 1600) throw new Error('模型澄清回复缺少有效自然语言回复');
  if (!Array.isArray(value.question_updates) || !Array.isArray(value.unmapped_additions)) throw new Error('模型澄清回复缺少题目更新或未映射列表');
  if (!value.context_updates || typeof value.context_updates !== 'object' || Array.isArray(value.context_updates)) throw new Error('模型澄清回复缺少context更新');
  if (!Array.isArray(value.options) || value.options.length > 5 || value.options.some(option => typeof option !== 'string' || !option.trim() || option.length > 100)) throw new Error('模型选项格式不正确');
  for (const key of ['semantic_unresolved', 'unavailable_metric_ids', 'resolve_unmapped_ids']) {
    if (!Array.isArray(value[key])) throw new Error('模型澄清回复缺少' + key);
  }
  if (value.semantic_unresolved.some(item => typeof item !== 'string' || !item.trim() || item.length > 240)) throw new Error('未解决语义的记录格式不正确');
  if (value.unavailable_metric_ids.some(id => typeof id !== 'string' || !metricById.has(id))) throw new Error('模型引用了未知不可用指标');
  if (value.resolve_unmapped_ids.some(id => typeof id !== 'string' || id.length > 100)) throw new Error('模型解决记录格式不正确');
  // Reuse the existing fixed-question whitelist parser. It rejects validation,
  // confirmed, source, card definitions, and unknown slot names.
  // Compatibility for models copying the read-only context envelope. Only its
  // value is an answer; source/confirmed metadata can never authorize anything.
  for (const key of ['universe', 'combination']) {
    const entry = value.context_updates[key];
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && Object.hasOwn(entry, 'value') && Object.keys(entry).every(name => ['value', 'source', 'confirmed'].includes(name))) value.context_updates[key] = entry.value;
  }
  intake.parseModelJson(JSON.stringify({ question_updates: value.question_updates, context_updates: value.context_updates, unmapped_additions: value.unmapped_additions }));
  return value;
}

function applyClarifyResponse({ state, userText, content, dataDate, dataStatus }) {
  const response = parseClarifyResponse(content);
  const oldExam = state.exam;
  const applied = intake.applyModelResult(state.exam, userText, {
    question_updates: response.question_updates,
    context_updates: response.context_updates,
    unmapped_additions: response.unmapped_additions
  });
  let exam = applied.exam;
  // Comparison meaning is interpreted by the model, not an exact-word matcher.
  // The fixed choice whitelist and customer's later confirmation still apply.
  for (const update of response.question_updates.filter(item => item.active)) {
    const operator = update.slots.operator;
    const choices = metricById.get(update.metric_id).contract.slot_definitions.operator?.options || [];
    const field = update.metric_id + '.operator';
    if (operator !== undefined && choices.includes(operator) && applied.rejected_model_fields.includes(field)) {
      const question = exam.questions.find(item => item.metric_id === update.metric_id);
      if (question.slots.operator.value !== operator) question.slots.operator = { value: operator, source: 'user_input', confirmed: false };
      applied.rejected_model_fields = applied.rejected_model_fields.filter(item => item !== field);
    }
  }
  // Natural-language intent is the model's responsibility. The server restricts
  // operations to existing fixed questions and records the customer's source turn.
  for (const update of response.question_updates.filter(item => !item.active)) {
    const question = exam.questions.find(item => item.metric_id === update.metric_id);
    if (oldExam.questions.find(item => item.metric_id === update.metric_id)?.active) {
      question.active = false;
      applied.rejected_model_fields = applied.rejected_model_fields.filter(key => key !== update.metric_id + '.active');
      state.condition_audit = [...(state.condition_audit || []), { metric_id: update.metric_id, action: 'deactivate', user_text: userText, turn: exam.turn_count }];
    }
  }
  for (const id of response.resolve_unmapped_ids) {
    exam = resolveUnmappedInput(exam, id, '客户本轮回复：' + userText);
  }
  if (dataDate) {
    for (const question of exam.questions) {
      if (question.active && question.slots.as_of && !question.slots.as_of.value) question.slots.as_of = { value: dataDate, source: 'default', confirmed: false };
    }
    exam = questionnaire.validateExam(exam);
  }
  const failedFields = applied.rejected_model_fields.filter(field => {
    const dot = field.lastIndexOf('.');
    const id = field.slice(0, dot), key = field.slice(dot + 1);
    const proposed = id === 'context' ? response.context_updates[key] : response.question_updates.find(item => item.metric_id === id)?.slots[key];
    const actual = id === 'context' ? exam.context[key]?.value : exam.questions.find(item => item.metric_id === id)?.slots[key]?.value;
    if (field === 'context.universe' && proposed?.type === 'explicit_symbols' && actual?.type === 'explicit_symbols') {
      return JSON.stringify([...new Set(proposed.symbols || [])].sort()) !== JSON.stringify([...new Set(actual.symbols || [])].sort());
    }
    return proposed === undefined || JSON.stringify(proposed) !== JSON.stringify(actual);
  });
  if (failedFields.length) {
    const error = new Error('这轮条件还没有处理成功，已保留原条件，请稍后再试。');
    error.code = 'INTENT_PATCH_REJECTED';
    error.validationFeedback = failedFields.map(field => {
      const dot = field.lastIndexOf('.'), id = field.slice(0, dot), key = field.slice(dot + 1);
      return { field, label: metricById.get(id)?.contract.slot_definitions[key]?.label || field,
        message: id === 'context' ? 'context_updates中combination只能是all或any裸字符串，universe只能是type和symbols/index_code的裸对象，不要复制value/source/confirmed包装。当前股票池或组合未变则直接省略该字段。' : '该字段未通过原话依据或单位校验。只修改客户本轮提到的字段；总市值用元或原始金额，不能省略单位依据；下限是不低于，上限是不超过；没有明确值就保留并追问。' };
    });
    throw error;
  }
  state.exam = exam;
  state.semantic_unresolved = response.semantic_unresolved;
  state.unavailable_conditions = exam.questions.filter(question => question.active && !EXECUTABLE_IDS.has(question.metric_id)).map(question => ({ metric_id: question.metric_id, label: metricById.get(question.metric_id).item.label, status: 'data_unavailable' }));
  state.last_options = response.options;
  state.stage = 'clarifying';
  return { ...response, exam, rejected_model_fields: applied.rejected_model_fields, dataStatus };
}

function canConfirmIntent(state) {
  const exam = questionnaire.validateExam(state.exam);
  const openUnmapped = (exam.unmapped_inputs || []).some(item => typeof item === 'string' || item.status !== 'resolved');
  const blocking = (exam.validation_errors || []).filter(error => !['unconfirmed', 'universe_required', 'combination_required'].includes(error.code));
  return { ready: !!exam.questions?.some(question => question.active) && !!exam.context?.universe?.value && !!exam.context?.combination?.value && !openUnmapped && !(state.semantic_unresolved || []).length && blocking.length === 0, exam, blocking };
}

module.exports = { buildClarifyMessages, parseClarifyResponse, applyClarifyResponse, canConfirmIntent, publicCatalog, compactCard, EXECUTABLE_IDS };
