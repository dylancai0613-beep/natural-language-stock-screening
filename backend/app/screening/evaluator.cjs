// Three-valued deterministic evaluator for the two cached, real-data metrics.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const universe = JSON.parse(fs.readFileSync(path.join(root, 'config/sample-universe.json'), 'utf8'));
const paper = JSON.parse(fs.readFileSync(path.join(root, 'contracts/选股意图试卷.json'), 'utf8'));
const snapshotFile = path.join(root, 'data/snapshots/runtime/ifind-screening-sample.json');
const labels = Object.fromEntries(paper.questions.map(item => [item.metric_id, item.label]));
labels.pe_ttm = '市盈率 TTM';
const ops = {
  gt: (v, x) => v > x, gte: (v, x) => v >= x, lt: (v, x) => v < x,
  lte: (v, x) => v <= x, eq: (v, x) => v === x, between: (v, x) => v >= x[0] && v <= x[1]
};

function readSnapshot() {
  try { return JSON.parse(fs.readFileSync(snapshotFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('本地真实数据缓存无法读取'); }
}

function unknown(metricId, reason, question) {
  return { metric_id: metricId, label: labels[metricId] || metricId, status: 'unknown', reason, requested: question?.slots || null };
}

function checkMetric(question, item, snapshot) {
  const metricId = question.metric_id;
  if (!['pe_ttm', 'market_cap_cny'].includes(metricId)) return unknown(metricId, '该指标的数据未接入，不能据此判断。', question);
  if (!snapshot || snapshot.status !== 'usable_for_exact_date_only') return unknown(metricId, '没有可用的真实数据快照。', question);
  const asOf = question.slots?.as_of?.value;
  if (asOf !== snapshot.data_date) return unknown(metricId, '条件日期与缓存快照日期不一致；本地只保留指定日期快照，不提供历史回溯。', question);
  if (snapshot.metadata?.metadata_match !== true) return unknown(metricId, '源字段的日期元数据与指定日期存在冲突。', question);
  const metric = item?.metrics?.[metricId];
  if (!metric || !Number.isFinite(metric.value)) return unknown(metricId, '该股票缺少此指标的有效数值。', question);
  if (metricId === 'pe_ttm' && metric.value <= 0) return unknown(metricId, 'PE为非正数，当前低估值条件不对其作通过/不通过判断。', question);
  const op = question.slots?.operator?.value;
  const threshold = question.slots?.threshold?.value;
  if (!ops[op] || threshold === null || threshold === undefined) return unknown(metricId, '筛选槽位不完整。', question);
  const passed = ops[op](metric.value, threshold);
  return {
    metric_id: metricId,
    label: labels[metricId],
    status: passed ? 'pass' : 'fail',
    value: metric.value,
    raw_value: metric.raw_value,
    unit: metric.unit,
    source_field: metric.source_field,
    source: 'iFinD · get_stock_performance',
    data_date: snapshot.data_date,
    operator: op,
    threshold,
    reason: passed ? '数据与条件匹配。' : '数据不满足此条件。',
    metadata_note: snapshot.metadata.caveat
  };
}

function combine(statuses, combination) {
  if (!statuses.length) return 'unknown';
  if (combination === 'all') {
    if (statuses.includes('fail')) return 'fail';
    if (statuses.includes('unknown')) return 'unknown';
    return 'pass';
  }
  if (statuses.includes('pass')) return 'pass';
  if (statuses.includes('unknown')) return 'unknown';
  return 'fail';
}

function evaluateExam(exam, options = {}) {
  if (!exam?.validation) throw new Error('请先补全并确认当前条件');
  const snapshot = options.snapshot === undefined ? readSnapshot() : options.snapshot;
  const value = exam.context?.universe?.value;
  if (value?.type === 'index_constituents') { const error = new Error('本机版本没有指数成分数据；请选择固定三只样本或明确股票代码。'); error.status = 422; throw error; }
  const codes = value?.type === 'explicit_symbols' ? value.symbols : [];
  const byCode = new Map((snapshot?.items || []).map(item => [item.thscode, item]));
  const activeQuestions = exam.questions.filter(q => q.active);
  const rows = codes.map(code => {
    const item = byCode.get(code);
    const sampleMeta = universe.symbols.find(x => x.thscode === code);
    const conditions = activeQuestions.map(question => checkMetric(question, item, snapshot));
    if (!item) for (const condition of conditions) { condition.status = 'unknown'; condition.reason = '此股票不在当前三只验收样本覆盖内。'; }
    const status = combine(conditions.map(x => x.status), exam.context.combination.value);
    return { thscode: code, name: item?.name || sampleMeta?.name || code, status, conditions };
  });
  const counts = { pass: rows.filter(x => x.status === 'pass').length, fail: rows.filter(x => x.status === 'fail').length, unknown: rows.filter(x => x.status === 'unknown').length };
  const snapshotId = snapshot?.snapshot_id || null;
  const result = {
    snapshot_id: snapshotId,
    data_date: snapshot?.data_date || null,
    provider: snapshot?.source?.provider || null,
    coverage: { label: snapshot?.coverage?.label || universe.label, note: snapshot?.coverage?.note || universe.coverage_note, count: rows.length, codes },
    metadata_note: snapshot?.metadata?.caveat || '当前没有真实数据缓存，条件结果均为unknown。',
    active_metrics: activeQuestions.map(x => ({ metric_id: x.metric_id, label: labels[x.metric_id] || x.label })),
    combination: exam.context.combination.value,
    counts,
    rows,
    comparison: null
  };
  if (options.previous && options.previous.snapshot_id === snapshotId && snapshotId) result.comparison = compareResults(options.previous, result);
  return result;
}

function compareResults(previous, current) {
  const before = new Map((previous.rows || []).map(row => [row.thscode, row.status]));
  const transitions = current.rows.filter(row => before.has(row.thscode) && before.get(row.thscode) !== row.status).map(row => ({ thscode: row.thscode, from: before.get(row.thscode), to: row.status }));
  return { same_snapshot: true, from_snapshot: previous.snapshot_id, to_snapshot: current.snapshot_id, changed_count: transitions.length, transitions };
}

function snapshotStatus() {
  const snapshot = readSnapshot();
  if (!snapshot) return { available: false, provider: null, data_date: null, count: 0, note: '没有本地真实数据缓存。' };
  return { available: true, provider: snapshot.source?.provider || null, data_date: snapshot.data_date, count: snapshot.items?.length || 0, coverage: snapshot.coverage, caveat: snapshot.metadata?.caveat, snapshot_id: snapshot.snapshot_id };
}

module.exports = { readSnapshot, evaluateExam, compareResults, snapshotStatus, snapshotFile };
