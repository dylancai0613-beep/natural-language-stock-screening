// Small product-specific chat flow for fixed screening intent. Known defaults
// and choices are handled locally; only free-form requests use the LLM adapter.
const fs = require('node:fs');
const path = require('node:path');
const questionnaire = require('./questionnaire.cjs');
const { confirmExam } = require('./customer-edits.cjs');
const root = path.resolve(__dirname, '../../..');
const sample = JSON.parse(fs.readFileSync(path.join(root, 'config/sample-universe.json'), 'utf8'));
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const interpretations = {
  revenue_yoy_acceleration_pp: readJson('config/metrics/单季度营收同比增速改善.json').default_interpretation,
  volatility_60d_annualized_pct: readJson('config/metrics/60日年化波动率.json').default_interpretation
};

function message(text, actions = []) { return { role: 'assistant', text, actions }; }
function addAssistant(state, text, actions = []) { const item = message(text, actions); state.chat_history.push(item); return item; }
function addUser(state, text) { state.chat_history.push({ role: 'user', text }); }
function action(label, value) { return { action: 'choice', value, label }; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function conditionPhraseIds(text) {
  const found = [];
  if (/经营改善|经营向好|业绩改善|营收改善/.test(text)) found.push('revenue_yoy_acceleration_pp');
  if (/走势(?:相对)?稳定|波动(?:较低|小|不大)|股价稳定/.test(text)) found.push('volatility_60d_annualized_pct');
  return found;
}

function createPendingCondition(metricId, originalText) {
  const config = interpretations[metricId];
  const labelById = { revenue_yoy_acceleration_pp: '经营改善', volatility_60d_annualized_pct: '走势稳定' };
  return {
    id: metricId,
    metric_id: metricId,
    label: labelById[metricId] || config.label || metricId,
    interpretation: config.short_description || config.description,
    operator: config.operator,
    threshold: config.threshold,
    unit: config.unit,
    source: 'default',
    original_text: originalText,
    status: 'pending_data',
    resolution: null
  };
}

function addUnmapped(exam, condition) {
  const id = 'chat-' + condition.metric_id;
  if (!(exam.unmapped_inputs || []).some(item => item.id === id)) {
    exam.unmapped_inputs.push({ id, text: condition.original_text, status: 'open', added_in_turn: exam.turn_count || 1, resolutions: [] });
  }
}

function parseExplicitPe(text, defaultThreshold = 20) {
  const dateFree = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
  const match = dateFree.match(/(?:放宽到|放宽至|调整到|调整为|改到|改为|改成|设为|低于|小于|不超过|不高于|大于|高于|超过|至少|不少于|≤|≥|<|>)\s*(-?\d+(?:\.\d+)?)\s*(?:倍)?/);
  if (!match) return { threshold: defaultThreshold, operator: 'lt', explicit: false };
  const token = match[0];
  let operator = 'lt';
  if (/不超过|不高于|至少|不少于|≤|≥/.test(token)) operator = /至少|不少于|≥/.test(token) ? 'gte' : 'lte';
  else if (/大于|高于|超过|>/.test(token) && !/不高于/.test(token)) operator = 'gt';
  return { threshold: Number(match[1]), operator, explicit: true };
}

function fillPeDefault(state, text, dataDate) {
  const exam = state.exam;
  const item = exam.questions.find(question => question.metric_id === 'pe_ttm');
  const next = questionnaire.createQuestion('pe_ttm');
  const parsed = parseExplicitPe(text, next.slots.threshold.value);
  if (parsed.explicit) {
    next.slots.operator = { value: parsed.operator, source: 'user_input', confirmed: false };
    next.slots.threshold = { value: parsed.threshold, source: 'user_input', confirmed: false };
  }
  const explicitDate = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  next.slots.as_of = { value: explicitDate || dataDate, source: explicitDate ? 'user_input' : 'default', confirmed: false };
  next.original_text = text;
  item.active = true;
  Object.assign(item, next);
  exam.context.universe = { value: { type: 'explicit_symbols', symbols: sample.symbols.map(symbol => symbol.thscode) }, source: 'default', confirmed: false };
  exam.context.combination = { value: 'all', source: 'default', confirmed: false };
  return parsed;
}

function clearOpenChoiceRecords(exam, records, resolution) {
  for (const condition of records) {
    const item = exam.unmapped_inputs.find(entry => entry.status !== 'resolved' && (
      entry.id === 'chat-' + condition.metric_id || entry.id === condition.id ||
      entry.text === condition.original_text || entry.text === condition.label
    ));
    if (item) {
      item.status = 'resolved';
      item.resolutions.push({ text: resolution, turn: exam.turn_count || 1 });
    }
  }
  return questionnaire.validateExam(exam);
}

function explainReady(state, dataDate) {
  const labelById = { pe_ttm: 'PE TTM', market_cap_cny: '总市值', revenue_yoy_pct: '营业收入同比增长率', net_profit_yoy_pct: '净利润同比增长率', roe_weighted_pct: '加权净资产收益率', gross_margin_pct: '销售毛利率', debt_assets_pct: '资产负债率', revenue_yoy_acceleration_pp: '单季度营收同比增速改善', volatility_60d_annualized_pct: '60日年化波动率', max_drawdown_60d_pct: '60日最大回撤幅度' };
  const units = { pe_ttm: '倍', market_cap_cny: '元', revenue_yoy_pct: '%', net_profit_yoy_pct: '%', roe_weighted_pct: '%', gross_margin_pct: '%', debt_assets_pct: '%', revenue_yoy_acceleration_pp: '个百分点', volatility_60d_annualized_pct: '%', max_drawdown_60d_pct: '%' };
  const operators = { lt: '低于', lte: '不超过', gt: '高于', gte: '不低于', eq: '等于', between: '介于' };
  const active = state.exam.questions.filter(question => question.active);
  const conditions = active.map(question => {
    const threshold = question.slots.threshold?.value;
    const operator = operators[question.slots.operator?.value];
    const formatted = Array.isArray(threshold) ? threshold.join('至') : threshold;
    const value = threshold !== null && threshold !== undefined && operator ? ` ${operator} ${formatted}${units[question.metric_id] || ''}` : '';
    return `${labelById[question.metric_id] || '筛选条件'}${value}`;
  });
  const pe = active.find(question => question.metric_id === 'pe_ttm');
  const asOf = active.map(question => question.slots.as_of?.value).find(Boolean) || dataDate;
  const count = state.exam.context?.universe?.value?.symbols?.length || sample.symbols.length;
  const deferred = state.deferred_conditions.length
    ? `另有${state.deferred_conditions.map(item => item.label).join('、')}，按你的选择保留为待核验条件；当前没有可用真实数据，不会用虚构数值判断。`
    : state.excluded_conditions.length
      ? `你已选择本次只按市盈率筛选；${state.excluded_conditions.map(item => item.label).join('、')}已记录为暂不纳入。`
      : '';
  const sourceHint = pe ? `（${pe.slots.threshold?.source === 'default' ? '默认' : '按你的补充'}）` : '';
  const text = `当前条件：${conditions.join('；') || '待补充'}${sourceHint}；数据日期 ${asOf || '未定'}；使用${count}只本地样本。${deferred}`;
  return addAssistant(state, text, [{ action: 'confirm', label: '确认以上条件' }]);
}

function applyScopeChoice(state, value, dataDate) {
  const pending = state.pending_conditions || [];
  if (value === 'keep_all') {
    state.deferred_conditions = pending.map(item => ({ ...clone(item), status: 'pending_data', resolution: '客户选择保留并查看待核验' }));
    state.excluded_conditions = [];
    state.exam = clearOpenChoiceRecords(state.exam, pending, '客户选择保留为待核验条件，继续筛选。');
    state.pending_conditions = [];
    state.stage = 'ready';
    explainReady(state, dataDate);
    return;
  }
  if (value === 'valuation_only') {
    state.excluded_conditions = pending.map(item => ({ ...clone(item), status: 'excluded_by_customer', resolution: '客户选择本次仅按估值试筛' }));
    state.deferred_conditions = [];
    state.exam = clearOpenChoiceRecords(state.exam, pending, '客户明确选择仅按估值条件试筛，本次暂不纳入该要求。');
    state.pending_conditions = [];
    state.stage = 'ready';
    explainReady(state, dataDate);
    return;
  }
}

function askScope(state) {
  state.stage = 'choose_scope';
  const meanings = state.pending_conditions.map(item => `${item.label}按“${item.interpretation}”理解`).join('；');
  const pe = state.exam.questions.find(question => question.metric_id === 'pe_ttm');
  const threshold = pe.slots.threshold?.value ?? 20;
  const operator = pe.slots.operator?.value || 'lt';
  const op = { lt: '低于', lte: '不超过', gt: '高于', gte: '不低于', eq: '等于' }[operator] || '低于';
  const prefix = `估值先按PE TTM ${op}${threshold}倍`;
  const text = state.pending_conditions.length
    ? `${prefix}；${meanings}。其中${state.pending_conditions.map(item => item.label).join('、')}暂缺数据。你希望保留待核验，还是先按估值试筛？`
    : `${prefix}，数据日期 ${pe.slots.as_of?.value || '使用本地快照日期'}。请确认后我再筛选。`;
  const choices = [action('保留全部条件并查看待核验', 'keep_all'), action('仅按估值条件试筛', 'valuation_only'), action('了解市净率 PB', 'pb_info')];
  addAssistant(state, text, choices);
}

function applyNaturalThresholdEdit(state, text, dataDate) {
  if (/总市值|市值|市净率|\bPB\b/i.test(text)) return false;
  if (!/(市盈率|\bPE\b|P\/E|估值|放宽|调整|改到|改为|改成|阈值|设为|低于|小于|大于|高于|超过|不超过|不高于|至少|不少于|≤|≥|<|>)/i.test(text)) return false;
  const q = state.exam.questions.find(question => question.metric_id === 'pe_ttm');
  const valueMatch = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ').match(/(?:放宽到|放宽至|调整到|调整为|改到|改为|改成|设为|阈值(?:为|到)?|低于|小于|不超过|不高于|大于|高于|超过|至少|不少于|≤|≥|<|>)\s*(-?\d+(?:\.\d+)?)/);
  if (!valueMatch || !q?.active) return false;
  const parsed = parseExplicitPe(text, Number(valueMatch[1]));
  q.slots.threshold = { value: parsed.threshold, source: 'user_input', confirmed: false };
  if (parsed.explicit) q.slots.operator = { value: parsed.operator, source: 'user_input', confirmed: false };
  q.original_text = [q.original_text, text].filter(Boolean).join('\n');
  state.exam = questionnaire.validateExam(state.exam);
  if (state.stage === 'choose_scope') askScope(state);
  else { state.stage = 'ready'; explainReady(state, dataDate); }
  return true;
}

function isValuationIntent(text) { return /市盈率|PE|P\/E|估值合理|估值适中|估值低|低估值|估值/.test(text); }

function startIntent(state, text, dataDate) {
  state.original_request = text;
  if (/市净率|\bPB\b|P\/B/i.test(text) && !/市盈率|\bPE\b|P\/E/i.test(text)) {
    state.stage = 'pb_unsupported';
    addAssistant(state, '市净率（PB）目前没有加入可筛选指标，现有缓存也没有PB数据，因此我不能生成PB结果。可以改用预设市盈率条件，或结束本次对话。', [action('改用市盈率（默认低于20倍）', 'use_pe'), action('暂不筛选', 'cancel')]);
    return true;
  }
  // Let the existing fixed-question model filler handle multi-metric or exact
  // numeric requests rather than consuming only the PE portion.
  if (/总市值|市值|净利润|毛利率|负债率|净资产收益率|\bROE\b|\bPB\b|市净率|(?:营收|收入|波动|回撤).{0,12}(?:低于|高于|超过|不超过|大于|小于|\d+%)|(?:行业|同行).{0,8}(?:平均|中位数|百分位)|历史相对/i.test(text)) return false;
  if (!isValuationIntent(text)) return false;
  const parsed = fillPeDefault(state, text, dataDate);
  const ids = conditionPhraseIds(text);
  state.pending_conditions = ids.map(id => createPendingCondition(id, text));
  for (const condition of state.pending_conditions) addUnmapped(state.exam, condition);
  state.exam.turn_count = (state.exam.turn_count || 0) + 1;
  state.exam = questionnaire.validateExam(state.exam);
  if (parsed.explicit) {
    // The user supplied a numeric threshold; the product default is still used for other slots.
  }
  if (state.pending_conditions.length) askScope(state);
  else {
    state.stage = 'ready';
    explainReady(state, dataDate);
  }
  return true;
}

function handleChoice(state, value, dataDate) {
  if (value === 'keep_all' || value === 'valuation_only') return applyScopeChoice(state, value, dataDate);
  if (value === 'pb_info') {
    addAssistant(state, 'PB的指标定义与真实数据尚未接入，不能作为筛选条件。你可以继续用市盈率默认条件，或明确选择只保留估值解释并把经营/走势要求暂缓。', [action('仍按市盈率继续', 'use_pe'), action('结束本次筛选', 'cancel')]);
    return;
  }
  if (value === 'use_pe') {
    if (!state.exam.questions.find(question => question.metric_id === 'pe_ttm').active) fillPeDefault(state, state.original_request || '市盈率估值合理', dataDate);
    if (state.pending_conditions?.length) { askScope(state); return; }
    state.stage = 'ready'; explainReady(state, dataDate); return;
  }
  if (value === 'cancel') { state.stage = 'cancelled'; addAssistant(state, '已暂停本次筛选；没有生成PB或其他未接入指标的结果。你可以重新描述需求开始新会话。'); }
}

function friendlyValidation(exam) {
  const errors = exam.validation_errors || [];
  if (!exam.questions.some(question => question.active)) return '我还没能把这句话对应到可用筛选条件。你可以试试描述市盈率，例如“估值合理”或“PE低于20倍”。';
  const missing = errors.filter(error => error.code === 'missing');
  if (missing.length) return `这条需求还缺少${[...new Set(missing.map(error => error.question || error.message))].join('、')}。你可以直接在聊天中补充，或选择一个清楚的默认解释。`;
  if (errors.some(error => error.code === 'unmapped_intent')) return '还有一项需求暂时没有已接入的数据。请明确选择保留为待核验，或本次只筛可用条件。';
  return '我已整理出条件，请在聊天中补充或确认；未确认前不会开始筛选。';
}

module.exports = { startIntent, handleChoice, applyNaturalThresholdEdit, askScope, explainReady, friendlyValidation, conditionPhraseIds, createPendingCondition };
