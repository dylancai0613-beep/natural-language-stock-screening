// Model may fill fixed questionnaire fields; the server owns merge, confirmation, and validation.
const fs = require('node:fs');
const path = require('node:path');
const questionnaire = require('./questionnaire.cjs');

const root = path.resolve(__dirname, '../../..');
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, ''));
const clone = value => JSON.parse(JSON.stringify(value));
const paper = readJson('contracts/选股意图试卷.json');
const metricItems = paper.questions.map(item => ({ item, template: readJson(path.join('contracts', item.template)) }));
const allowedIds = new Set(metricItems.map(({ item }) => item.metric_id));
const opPatterns = {
  gte: /大于等于|不少于|不低于|至少|下限|最低/, lte: /小于等于|不超过|不高于|至多|不大于|上限|最高/,
  gt: /(?<!不)(?:大于(?!等于)|超过|高于|多于)/, lt: /(?<!不)(?:小于(?!等于)|低于|少于)/,
  eq: /等于|正好/
};
const moneyFactors = { '万亿': 1e12, '亿': 1e8, '万': 1e4, '元': 1 };

function assertKeys(value, allowed, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(where + '必须为对象');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(where + '含未允许字段: ' + key);
}

function buildCatalog() {
  return metricItems.map(({ item, template }) => ({
    metric_id: item.metric_id,
    label: item.label,
    slots: Object.fromEntries(Object.entries(template.slot_definitions).map(([key, slot]) => [key, {
      kind: slot.kind, required: slot.required, default: slot.default, options: slot.options
    }]))
  }));
}

function buildMessages(userText, exam) {
  if (typeof userText !== 'string' || !userText.trim()) throw new Error('请提供本轮客户原话');
  const current = {
    context: {
      universe: exam.context?.universe?.value ?? null,
      combination: exam.context?.combination?.value ?? null
    },
    questions: exam.questions.filter(q => q.active).map(q => ({
      metric_id: q.metric_id,
      slots: Object.fromEntries(Object.entries(q.slots || {}).map(([key, entry]) => [key, entry?.value ?? null]))
    })),
    open_unmapped: (exam.unmapped_inputs || []).filter(x => typeof x === 'string' || x?.status !== 'resolved').map(x => typeof x === 'string' ? x : { id: x.id, text: x.text })
  };
  const system = fs.readFileSync(path.join(root, 'config/prompts/intent.md'), 'utf8') +
    '\n只输出JSON对象，字段必须严格符合给定格式。模型只填客户本轮明确说出的值；不要自行猜阈值。产品配置默认由服务端应用，不要求模型重复返回，且必须保留source=default。返回question_updates数组、context_updates对象、unmapped_additions数组。question_updates每项仅含metric_id、active、slots；slots只能使用该题目录中的槽位名。context_updates仅含universe或combination。unmapped_additions只能摘录客户原话中的未支持条件。不得返回validation、confirmed、source、题目定义或其他字段。固定股票池只接受原话中明确出现的A股代码。总市值threshold用客户说出的原始数字（例如“2万亿”返回2），由服务端按指标单位转换成人民币元。每个本轮新增需求只返回本轮明确新增的字段，不复制未修改项。\n' +
    'JSON样例：{"question_updates":[{"metric_id":"pe_ttm","active":true,"slots":{"operator":"lt","threshold":20,"as_of":"2026-11-06"}}],"context_updates":{"universe":{"type":"explicit_symbols","symbols":["600519.SH"]}},"unmapped_additions":[]}';
  const payload = { user_text: userText, fixed_question_catalog: buildCatalog(), current_answers: current };
  return [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(payload) }];
}

function parseModelJson(content) {
  let value;
  try { value = JSON.parse(content); } catch { throw new Error('模型返回无效JSON'); }
  assertKeys(value, ['question_updates', 'context_updates', 'unmapped_additions'], '模型结果');
  if (!Array.isArray(value.question_updates) || !Array.isArray(value.unmapped_additions)) throw new Error('模型结果缺少数组字段');
  if (value.context_updates === undefined) throw new Error('模型结果缺少context_updates');
  assertKeys(value.context_updates, ['universe', 'combination'], 'context_updates');
  const updated = new Set();
  for (const update of value.question_updates) {
    assertKeys(update, ['metric_id', 'active', 'slots'], 'question_update');
    if (!allowedIds.has(update.metric_id)) throw new Error('模型选择了未知题目');
    if (updated.has(update.metric_id)) throw new Error('模型重复更新同一题目');
    updated.add(update.metric_id);
    if (typeof update.active !== 'boolean') throw new Error('active必须为布尔值');
    const template = metricItems.find(x => x.item.metric_id === update.metric_id).template;
    assertKeys(update.slots, Object.keys(template.slot_definitions), 'slots');
    if (!update.active && Object.keys(update.slots).length) throw new Error('停用题目不能同时填槽');
  }
  for (const text of value.unmapped_additions) if (typeof text !== 'string' || !text.trim() || text.length > 200) throw new Error('未映射原话格式无效');
  return value;
}

function extractNumbers(text) {
  const cleaned = normalizedPeriodText(text).replace(/\b\d{4}-Q[1-4]\b/g, ' ').replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ').replace(/\b\d{6}\.(?:SH|SZ|BJ)\b/g, ' ')
    .replace(/\b\d{4}年\d{1,2}月\d{1,2}日/g, ' ');
  const result = [];
  const regex = /(?<![\d.])(-?\d+(?:\.\d+)?)(?:\s*(万亿|亿|万|元|倍|%|％))?/g;
  for (const match of cleaned.matchAll(regex)) result.push({ value: Number(match[1]), unit: match[2] || '' });
  return result;
}

function supportedOperator(text, value) {
  if (value === 'between') return /介于|之间/.test(text) || /\d+(?:\.\d+)?\s*(?:到|至)\s*\d+(?:\.\d+)?/.test(text);
  return Object.hasOwn(opPatterns, value) && opPatterns[value].test(text);
}

function normalizeMoneyThreshold(value, numbers) {
  const values = Array.isArray(value) ? value : [value];
  if (values.length !== (Array.isArray(value) ? 2 : 1) || !values.every(v => typeof v === 'number' && Number.isFinite(v))) return { supported: false };
  const suffixes = [...new Set(numbers.map(n => n.unit).filter(unit => Object.hasOwn(moneyFactors, unit)))];
  const amounts = numbers.map(n => {
    const unit = Object.hasOwn(moneyFactors, n.unit) ? n.unit : !n.unit && Array.isArray(value) && suffixes.length === 1 ? suffixes[0] : '';
    return unit ? { raw: n.value, cny: n.value * moneyFactors[unit] } : null;
  }).filter(Boolean);
  const normalized = values.map(v => {
    // Accept the stated amount or its exact CNY conversion, never multiply twice.
    const canonical = amounts.find(item => item.cny === v);
    if (canonical) return canonical.cny;
    return amounts.find(item => item.raw === v)?.cny;
  });
  return normalized.every(Number.isFinite) ? { supported: true, value: Array.isArray(value) ? normalized : normalized[0] } : { supported: false };
}

function normalizedPeriodText(text) {
  return text.replace(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/g, (_, y, m, d) => y + '-' + m.padStart(2, '0') + '-' + d.padStart(2, '0'))
    .replace(/(\d{4})年?\s*第?([一二三四1234])季度/g, (_, y, q) => y + '-Q' + ({ 一: 1, 二: 2, 三: 3, 四: 4 }[q] || q));
}

function filterSlots(metricId, slots, text, rejected) {
  const template = metricItems.find(x => x.item.metric_id === metricId).template;
  const accepted = {};
  const numbers = extractNumbers(text);
  for (const [key, value] of Object.entries(slots)) {
    const slot = template.slot_definitions[key];
    let supported = true;
    let normalized = value;
    if (key === 'operator') supported = typeof value === 'string' && supportedOperator(text, value);
    else if (slot.kind === 'number_or_range') {
      if (metricId === 'market_cap_cny') {
        const amount = normalizeMoneyThreshold(value, numbers);
        supported = amount.supported;
        normalized = amount.value;
      } else {
        const values = Array.isArray(value) ? value : [value];
        supported = values.length === (Array.isArray(value) ? 2 : 1) && values.every(v => typeof v === 'number' && Number.isFinite(v) && numbers.some(n => n.value === v));
      }
    } else if (slot.kind === 'date') {
      supported = typeof value === 'string' && new RegExp('(?:^|\\D)' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|\\D)').test(normalizedPeriodText(text));
    } else if (slot.kind === 'report') {
      supported = typeof value === 'string' && new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(normalizedPeriodText(text));
    } else if (slot.kind === 'integer') {
      supported = Number.isInteger(value) && numbers.some(n => n.value === value);
    } else if (slot.kind === 'choice') {
      if (key !== 'operator') supported = slot.options.includes(value) && text.includes(value);
    }
    if (supported) accepted[key] = normalized;
    else rejected.push(metricId + '.' + key);
  }
  return accepted;
}

function validateContextUpdates(updates, text, rejected) {
  const accepted = {};
  if (updates.combination !== undefined) {
    const phrase = updates.combination === 'all' ? ['全部满足', '所有条件', '同时满足'] : ['任一满足', '任意条件', '满足一个'];
    if (['all', 'any'].includes(updates.combination) && phrase.some(x => text.includes(x))) accepted.combination = updates.combination;
    else rejected.push('context.combination');
  }
  if (updates.universe !== undefined) {
    const u = updates.universe;
    let valid = false;
    if (u && u.type === 'explicit_symbols' && Array.isArray(u.symbols) && u.symbols.length && u.symbols.every(s => typeof s === 'string' && /^\d{6}\.(SH|SZ|BJ)$/.test(s) && text.includes(s))) valid = true;
    if (u && u.type === 'index_constituents' && typeof u.index_code === 'string' && /^\d{6}\.(SH|SZ|BJ)$/.test(u.index_code) && text.includes(u.index_code)) valid = true;
    if (valid) accepted.universe = clone(u); else rejected.push('context.universe');
  }
  return accepted;
}

function addUnmapped(exam, text, turn) {
  if (!(exam.unmapped_inputs || []).some(item => (typeof item === 'string' ? item : item.text) === text)) {
    exam.unmapped_inputs.push({ id: 'unmapped-' + turn + '-' + (exam.unmapped_inputs.length + 1), text, status: 'open', added_in_turn: turn, resolutions: [] });
  }
}

function unsupportedComparisons(text) {
  const found = new Set();
  for (const match of text.matchAll(/(?:行业|同行)(?:平均(?:值)?|中位数|百分位(?:数)?)/g)) found.add(match[0]);
  return [...found];
}

function applyModelResult(existingExam, userText, modelResult) {
  const exam = clone(existingExam || questionnaire.createExam());
  const expected = paper.questions.map(q => q.metric_id);
  if (!Array.isArray(exam.questions) || exam.questions.length !== expected.length || expected.some((id, i) => exam.questions[i]?.metric_id !== id)) throw new Error('当前答案不符合固定试卷');
  if (typeof userText !== 'string' || !userText.trim()) throw new Error('请提供本轮客户原话');
  const parsed = typeof modelResult === 'string' ? parseModelJson(modelResult) : parseModelJson(JSON.stringify(modelResult));
  const turn = (exam.turn_count || 0) + 1;
  const rejected = [];
  for (const update of parsed.question_updates) {
    const question = exam.questions.find(q => q.metric_id === update.metric_id);
    if (!update.active) {
      const item = metricItems.find(x => x.item.metric_id === update.metric_id).item;
      const removal = ['取消', '去掉', '不看', '不筛', '删除'].some(word => userText.includes(word));
      if (question.active && removal && (userText.includes(item.label) || userText.includes(update.metric_id))) question.active = false;
      else if (question.active) rejected.push(update.metric_id + '.active');
      continue;
    }
    let baseQuestion = question;
    if (!question.active) {
      baseQuestion = questionnaire.createQuestion(update.metric_id);
      for (const [key, entry] of Object.entries(question.slots || {})) {
        if (entry?.value !== null && entry?.value !== undefined && baseQuestion.slots[key]) baseQuestion.slots[key] = clone(entry);
      }
    }
    const accepted = filterSlots(update.metric_id, update.slots, userText, rejected);
    const priorText = question.original_text || '';
    const combinedText = priorText ? priorText + '\n' + userText : userText;
    const filled = questionnaire.fillQuestion(baseQuestion, accepted, combinedText);
    filled.active = true;
    Object.assign(question, filled);
  }
  const context = validateContextUpdates(parsed.context_updates, userText, rejected);
  if (context.universe) exam.context.universe = { value: context.universe, source: 'user_input', confirmed: false };
  if (context.combination) exam.context.combination = { value: context.combination, source: 'user_input', confirmed: false };
  for (const phrase of parsed.unmapped_additions) {
    if (userText.includes(phrase)) addUnmapped(exam, phrase, turn);
    else rejected.push('unmapped_additions');
  }
  for (const phrase of unsupportedComparisons(userText)) addUnmapped(exam, phrase, turn);
  exam.turn_count = turn;
  const validated = questionnaire.validateExam(exam);
  return { exam: validated, rejected_model_fields: [...new Set(rejected)] };
}

function resolveUnmappedInput(exam, id, resolutionText) {
  if (typeof resolutionText !== 'string' || !resolutionText.trim()) throw new Error('解决记录必须说明客户如何处理该条件');
  const result = clone(exam);
  const item = (result.unmapped_inputs || []).find(x => typeof x !== 'string' && x.id === id && x.status !== 'resolved');
  if (!item) throw new Error('找不到待解决的未映射需求');
  item.status = 'resolved';
  item.resolutions = [...(item.resolutions || []), { text: resolutionText.trim(), turn: result.turn_count || 0 }];
  return questionnaire.validateExam(result);
}

async function fillFromText({ userText, exam, complete }) {
  if (typeof complete !== 'function') throw new Error('未提供模型调用函数');
  const current = exam || questionnaire.createExam();
  const response = await complete(buildMessages(userText, current));
  if (typeof response === 'string') return applyModelResult(current, userText, response);
  if (!response || typeof response.content !== 'string' || !response.content.trim()) throw new Error('LLM响应内容为空');
  const applied = applyModelResult(current, userText, response.content);
  return { ...applied, model: response.model || null, usage: response.usage || null };
}

module.exports = { buildCatalog, buildMessages, parseModelJson, applyModelResult, resolveUnmappedInput, fillFromText };
