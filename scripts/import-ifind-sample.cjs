// Normalize two real, locally cached iFinD responses; this script never makes a network call.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const discoveryDir = path.join(root, 'data/snapshots/discovery');
const outputFile = path.join(root, 'data/snapshots/runtime/ifind-screening-sample.json');
const universe = JSON.parse(fs.readFileSync(path.join(root, 'config/sample-universe.json'), 'utf8'));
const files = {
  latest: 'ifind-latest-pe-marketcap.json',
  dated: 'ifind-2026-11-09-pe-marketcap.json'
};

function readRecord(file) {
  const record = JSON.parse(fs.readFileSync(path.join(discoveryDir, file), 'utf8'));
  const text = record.raw_response?.data?.result?.content?.find(x => x.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error('缺少iFinD原始文本: ' + file);
  const envelope = JSON.parse(text);
  if (envelope.code !== 1 || envelope.msg !== 'success' || typeof envelope.data?.answer !== 'string') throw new Error('iFinD业务返回未成功: ' + file);
  return { record, envelope };
}

function parseTable(answer) {
  const lines = answer.split(/\r?\n/).map(x => x.trim()).filter(x => x.startsWith('|'));
  if (lines.length < 3) throw new Error('iFinD响应表格结构不完整');
  const cells = line => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(x => x.trim());
  const headers = cells(lines[0]);
  const rows = lines.slice(2).map(line => cells(line));
  if (rows.some(row => row.length !== headers.length)) throw new Error('iFinD响应表格列数不一致');
  return { headers, rows: rows.map(row => Object.fromEntries(headers.map((header, index) => [header, row[index]]))) };
}

function parseDate(raw) {
  const match = /^([0-9]{4})([0-9]{2})([0-9]{2})$/.exec(raw || '');
  if (!match) throw new Error('iFinD实际日期字段无效');
  return match[1] + '-' + match[2] + '-' + match[3];
}

function parseMoney(raw) {
  const match = /^\s*([+-]?\d+(?:\.\d+)?)\s*(万亿|亿|万|元)\s*$/.exec(raw || '');
  if (!match) throw new Error('无法识别总市值原始单位');
  const factor = { '万亿': 1e12, '亿': 1e8, '万': 1e4, '元': 1 }[match[2]];
  const valueCny = Number(match[1]) * factor;
  if (!Number.isFinite(valueCny)) throw new Error('总市值换算结果无效');
  return { value_cny: valueCny, raw_value: raw, display_unit: match[2], scale_factor: factor };
}

function assertLatestMatch(latestRow, datedRow, peHeader, capHeader) {
  if (!latestRow || !Object.hasOwn(latestRow, peHeader) || !Object.hasOwn(latestRow, capHeader)) throw new Error('最新表缺少PE或总市值字段，不能确认值一致');
  if (latestRow[peHeader] !== datedRow[peHeader] || latestRow[capHeader] !== datedRow[capHeader]) throw new Error('指定日期与最新快照数值不一致');
}

function main() {
  const latest = readRecord(files.latest);
  const dated = readRecord(files.dated);
  const latestTable = parseTable(latest.envelope.data.answer);
  const datedTable = parseTable(dated.envelope.data.answer);
  const latestPeHeader = latestTable.headers.find(x => x.includes('PE,TTM'));
  const latestCapHeader = latestTable.headers.find(x => x.includes('总市值'));
  const headers = datedTable.headers;
  const codeHeader = headers.find(x => x.includes('证券代码'));
  const nameHeader = headers.find(x => x.includes('证券简称'));
  const dateHeader = headers.find(x => x === '日期');
  const peHeader = headers.find(x => x.includes('PE,TTM'));
  const capHeader = headers.find(x => x.includes('总市值'));
  if (![codeHeader, nameHeader, dateHeader, peHeader, capHeader].every(Boolean)) throw new Error('iFinD响应缺少预期字段');
  const expected = new Set(universe.symbols.map(x => x.thscode));
  const latestByCode = new Map(latestTable.rows.map(row => [row['证券代码'], row]));
  const items = datedTable.rows.map(row => {
    const code = row[codeHeader];
    if (!expected.has(code)) throw new Error('iFinD返回了样本池之外的代码');
    const latestRow = latestByCode.get(code);
    if (!latestPeHeader || !latestCapHeader) throw new Error('最新表缺少PE或总市值字段');
    assertLatestMatch(latestRow, { [peHeader]: row[peHeader], [capHeader]: row[capHeader] }, latestPeHeader, latestCapHeader);
    const rawPe = row[peHeader];
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(rawPe || '')) throw new Error('市盈率原始值无效');
    const pe = Number(rawPe);
    if (!Number.isFinite(pe)) throw new Error('市盈率数值无效');
    const cap = parseMoney(row[capHeader]);
    return {
      thscode: code,
      name: row[nameHeader],
      data_date: parseDate(row[dateHeader]),
      metrics: {
        pe_ttm: { value: pe, unit: '倍', raw_value: row[peHeader], source_field: peHeader },
        market_cap_cny: { value: cap.value_cny, unit: 'CNY', raw_value: cap.raw_value, source_field: capHeader, source_display_unit: cap.display_unit, scale_factor: cap.scale_factor }
      }
    };
  });
  if (items.length !== expected.size || [...expected].some(code => !items.some(item => item.thscode === code))) throw new Error('iFinD响应未覆盖固定的三个股票样本');
  const dates = new Set(items.map(item => item.data_date));
  if (dates.size !== 1 || !dates.has('2026-11-09')) throw new Error('iFinD响应日期不一致');
  const latestParams = latest.envelope.data.indicators_params || {};
  const datedParams = dated.envelope.data.indicators_params || {};
  const paramsLatest = JSON.stringify(latestParams) === JSON.stringify(datedParams);
  const snapshot = {
    snapshot_id: 'ifind-2026-11-09-sample-v1',
    status: 'usable_for_exact_date_only',
    source: { provider: 'iFinD', server_type: 'stock', tool_name: 'get_stock_performance' },
    retrieved_at: dated.record.requested_at,
    requested_query: dated.record.params.query,
    data_date: '2026-11-09',
    coverage: { universe_id: universe.id, label: universe.label, note: universe.coverage_note, count: items.length, codes: items.map(x => x.thscode) },
    metadata: {
      dated_table_header: headers,
      dated_indicators_params: dated.envelope.data.indicators_params || null,
      latest_indicators_params: latestParams,
      latest_value_comparison: 'all sample PE TTM and market cap raw values match the explicit 2026-11-09 table',
      metadata_match: paramsLatest,
      caveat: '表格明确日期为2026-11-09；indicators_params交易日期为“最新”，PE TTM基准日为报表公告日期。仅支持该日快照，历史时点和财报可见性未验证。'
    },
    items,
    raw_source_files: [files.latest, files.dated]
  };
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  console.log('Imported real iFinD snapshot for ' + items.length + ' stocks at ' + snapshot.data_date + '.');
  console.log('PE and total market cap retained with original fields, raw values, units, scale factors, date and metadata caveat.');
  console.log('Private normalized cache: data/snapshots/runtime/ifind-screening-sample.json (no network call).');
}

if (require.main === module) main();

module.exports = { parseTable, parseDate, parseMoney, assertLatestMatch };
