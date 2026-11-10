// Read-only Fuyao valuation snapshot client. The API key is only sent in X-api-key.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../..');

function loadFuyaoKey(options = {}) {
  const env = options.env || process.env;
  if (env.FUYAO_API_KEY) return env.FUYAO_API_KEY;
  const file = options.envPath || path.join(options.projectRoot || ROOT, '.env');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw new Error('无法读取金融数据配置'); }
  const match = text.match(/^\s*(?:export\s+)?FUYAO_API_KEY\s*=\s*(.*?)\s*$/m);
  if (!match) return '';
  let value = match[1];
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  else value = value.replace(/\s+#.*$/, '');
  return value;
}

function createFuyaoClient(options = {}) {
  const key = options.apiKey || loadFuyaoKey(options);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!key) throw new Error('未配置FUYAO_API_KEY');
  if (typeof fetchImpl !== 'function') throw new Error('当前Node.js没有内置fetch');
  const timeoutMs = options.timeoutMs || 20000;
  return async function getValuations(codes) {
    if (!Array.isArray(codes) || !codes.length || codes.length > 10 || codes.some(x => typeof x !== 'string' || !/^\d{6}\.(SH|SZ|BJ)$/.test(x))) throw new Error('股票代码列表无效');
    const url = new URL('https://fuyao.aicubes.cn/api/a-share/valuations/snapshot');
    url.searchParams.set('thscodes', [...new Set(codes)].join(','));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try { response = await fetchImpl(url, { method: 'GET', headers: { 'X-api-key': key, accept: 'application/json' }, signal: controller.signal }); }
      catch { if (controller.signal.aborted) throw new Error('扶摇请求超时'); throw new Error('扶摇网络请求失败'); }
      if (!response || !response.ok) throw new Error('扶摇HTTP错误' + (response ? ' ' + response.status : ''));
      let rawText;
      try { rawText = await response.text(); } catch { if (controller.signal.aborted) throw new Error('扶摇请求超时'); throw new Error('扶摇响应读取失败'); }
      if (controller.signal.aborted) throw new Error('扶摇请求超时');
      let envelope;
      try { envelope = JSON.parse(rawText); } catch { throw new Error('扶摇响应不是有效JSON'); }
      return { rawText, envelope, requestedCodes: [...new Set(codes)], receivedAt: new Date().toISOString(), httpStatus: response.status };
    } finally { clearTimeout(timer); }
  };
}

module.exports = { loadFuyaoKey, createFuyaoClient };
