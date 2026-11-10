// Apply customer edits through the fixed questionnaire's slot allowlist.
const fs = require('node:fs');
const path = require('node:path');
const questionnaire = require('./questionnaire.cjs');
const root = path.resolve(__dirname, '../../..');
const paper = JSON.parse(fs.readFileSync(path.join(root, 'contracts/选股意图试卷.json'), 'utf8'));
const itemById = new Map(paper.questions.map(item => [item.metric_id, item]));
const clone = value => JSON.parse(JSON.stringify(value));

function assertKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + '格式无效');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(label + '含未允许字段: ' + key);
}

function template(metricId) {
  const item = itemById.get(metricId);
  if (!item) throw new Error('未知题目');
  return JSON.parse(fs.readFileSync(path.resolve(root, 'contracts', item.template), 'utf8'));
}

function safeContextUpdate(current, updates) {
  const context = clone(current);
  assertKeys(updates, ['universe', 'combination'], 'context_updates');
  if (updates.combination !== undefined) {
    if (!['all', 'any'].includes(updates.combination)) throw new Error('条件组合无效');
    context.combination = { value: updates.combination, source: 'user_input', confirmed: false };
  }
  if (updates.universe === null) context.universe = { value: null, source: 'unfilled', confirmed: false };
  else if (updates.universe !== undefined) {
    const universe = updates.universe;
    if (!universe || typeof universe !== 'object' || Array.isArray(universe)) throw new Error('股票池格式无效');
    if (universe.type === 'explicit_symbols') {
      assertKeys(universe, ['type', 'symbols'], 'universe');
      if (!Array.isArray(universe.symbols) || !universe.symbols.length || universe.symbols.length > 100 || universe.symbols.some(code => typeof code !== 'string' || !/^\d{6}\.(SH|SZ|BJ)$/.test(code))) throw new Error('股票代码列表无效');
      context.universe = { value: { type: universe.type, symbols: [...new Set(universe.symbols)] }, source: 'user_input', confirmed: false };
    } else if (universe.type === 'index_constituents') {
      assertKeys(universe, ['type', 'index_code'], 'universe');
      if (typeof universe.index_code !== 'string' || !/^\d{6}\.(SH|SZ|BJ)$/.test(universe.index_code)) throw new Error('指数代码无效');
      context.universe = { value: { type: universe.type, index_code: universe.index_code }, source: 'user_input', confirmed: false };
    } else throw new Error('暂不支持该股票池类型');
  }
  return context;
}

function applyCustomerEdits(existingExam, input) {
  assertKeys(input, ['question_updates', 'context_updates'], '请求');
  if (!Array.isArray(input.question_updates)) throw new Error('question_updates必须是数组');
  const exam = clone(existingExam);
  const expectedIds = paper.questions.map(item => item.metric_id);
  if (!Array.isArray(exam.questions) || exam.questions.length !== expectedIds.length || expectedIds.some((id, i) => exam.questions[i]?.metric_id !== id)) throw new Error('当前试卷结构无效');
  const seen = new Set();
  for (const update of input.question_updates) {
    assertKeys(update, ['metric_id', 'active', 'slots'], 'question_update');
    if (!itemById.has(update.metric_id)) throw new Error('未知题目');
    if (seen.has(update.metric_id)) throw new Error('同一题目不能重复更新');
    seen.add(update.metric_id);
    if (typeof update.active !== 'boolean') throw new Error('active必须是布尔值');
    const q = exam.questions.find(question => question.metric_id === update.metric_id);
    if (!update.active) {
      if (update.slots && Object.keys(update.slots).length) throw new Error('停用题目不能同时填槽');
      q.active = false;
      continue;
    }
    const t = template(update.metric_id);
    const slots = update.slots === undefined ? {} : update.slots;
    assertKeys(slots, Object.keys(t.slot_definitions), 'slots');
    let base = q;
    if (!q.active) {
      base = questionnaire.createQuestion(update.metric_id);
      for (const [key, entry] of Object.entries(q.slots || {})) if (entry?.value !== null && entry?.value !== undefined && base.slots[key]) base.slots[key] = clone(entry);
    }
    const filled = questionnaire.fillQuestion(base, slots, base.original_text || '');
    filled.active = true;
    Object.assign(q, filled);
  }
  exam.context = safeContextUpdate(exam.context, input.context_updates || {});
  return questionnaire.validateExam(exam);
}

function confirmExam(existingExam) {
  const exam = clone(existingExam);
  for (const question of exam.questions) {
    if (!question.active) continue;
    const keys = Object.entries(question.slots || {}).filter(([, slot]) => slot && slot.value !== null && slot.value !== undefined).map(([key]) => key);
    if (keys.length) Object.assign(question, questionnaire.confirmSlots(question, keys));
  }
  if (exam.context?.universe?.value) exam.context.universe.confirmed = true;
  if (exam.context?.combination?.value) exam.context.combination.confirmed = true;
  return questionnaire.validateExam(exam);
}

module.exports = { applyCustomerEdits, confirmExam };
