// One explicit request for the fixed five-stock PE snapshot. No retries.
const fs = require('node:fs');
const path = require('node:path');
const { loadFuyaoKey, createFuyaoClient } = require('../backend/app/providers/fuyao-snapshot.cjs');

if (!process.argv.includes('--live')) {
  console.log('No network request. Add --live to make one read-only valuation snapshot request.');
  process.exit(0);
}

const root = path.resolve(__dirname, '..');
const universe = JSON.parse(fs.readFileSync(path.join(root, 'config/sample-universe.json'), 'utf8'));
const outputFile = path.join(root, 'data/snapshots/runtime/fuyao-valuations.json');
async function main() {
  const apiKey = loadFuyaoKey({ projectRoot: root });
  if (!apiKey) throw new Error('FUYAO_API_KEY未配置');
  const fetchSnapshot = createFuyaoClient({ apiKey, timeoutMs: 20000 });
  const result = await fetchSnapshot(universe.symbols.map(x => x.thscode));
  const envelope = result.envelope;
  const businessCode = envelope?.code;
  if (businessCode !== 0 || !Array.isArray(envelope?.data?.item)) throw new Error('扶摇业务返回未通过(code=' + String(businessCode) + ')');
  const timestamp = Number.isFinite(envelope.data.timestamp) ? envelope.data.timestamp : null;
  const timestampIso = timestamp === null ? null : new Date(timestamp).toISOString();
  const fileRecord = {
    provider: 'fuyao',
    endpoint: '/api/a-share/valuations/snapshot',
    received_at: result.receivedAt,
    http_status: result.httpStatus,
    business_code: businessCode,
    request_id: envelope.request_id || null,
    requested_codes: result.requestedCodes,
    data_timestamp_ms: timestamp,
    data_timestamp_iso_utc: timestampIso,
    timestamp_scope: 'API文档说明：本次响应所用上游指标元数据最大有效时间，不是逐字段时间戳',
    data: envelope.data,
    raw_response: result.rawText
  };
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(fileRecord, null, 2) + '\n', 'utf8');
  console.log('Fuyao valuation snapshot saved; request_id=' + String(fileRecord.request_id) + ', items=' + envelope.data.item.length + ', data_timestamp=' + String(timestampIso));
  console.log('Private cache: data/snapshots/runtime/fuyao-valuations.json; raw response preserved, API key omitted.');
}

main().catch(error => {
  console.error('Snapshot refresh failed: ' + error.message);
  process.exitCode = 1;
});
