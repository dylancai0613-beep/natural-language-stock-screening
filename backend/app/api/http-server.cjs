// Small loopback-only JSON API for the local workbench.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const questionnaire = require('../intent/questionnaire.cjs');
const { fillFromText, resolveUnmappedInput } = require('../intent/ai-intake.cjs');
const { applyCustomerEdits, confirmExam } = require('../intent/customer-edits.cjs');
const chatController = require('../intent/chat-controller.cjs');
const { createDeepSeekChat, loadConfig } = require('../providers/deepseek-chat.cjs');
const evaluator = require('../screening/evaluator.cjs');
const conversation = require('../intent/conversation.cjs');
const { runScreeningConversation, explainScreeningResults } = require('../screening/model-screening.cjs');

const root = path.resolve(__dirname, '../../..');
const frontend = path.join(root, 'frontend', 'src');
const defaultStrategiesDir = path.join(root, 'data', 'strategies');
const sampleUniverse = JSON.parse(fs.readFileSync(path.join(root, 'config/sample-universe.json'), 'utf8'));
const staticFiles = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/styles.css', 'styles.css'], ['/app.js', 'app.js']]);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const sessions = new Map();
const MAX_BODY = 16 * 1024;
const DEFAULT_MODEL_CALLS = 20;

function reply(res, status, data) {
  const bytes = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(bytes);
}

function apiError(res, status, message, details) { reply(res, status, { error: message, ...(details ? { details } : {}) }); }

async function readJsonBody(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') { const error = new Error('请求必须使用application/json'); error.status = 415; throw error; }
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BODY) { const error = new Error('请求体不能超过16KB'); error.status = 413; throw error; }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) { const error = new Error('请求体不能超过16KB'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  if (!length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error = new Error('请求体不是有效JSON'); error.status = 400; throw error; }
}

function assertKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(name + '格式无效');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(name + '含未允许字段: ' + key);
}

function getCatalog() {
  const paper = JSON.parse(fs.readFileSync(path.join(root, 'contracts/选股意图试卷.json'), 'utf8'));
  return paper.questions.map(item => {
    const template = JSON.parse(fs.readFileSync(path.resolve(root, 'contracts', item.template), 'utf8'));
    return { metric_id: item.metric_id, label: item.label, category: item.category, slot_definitions: template.slot_definitions };
  });
}

function catalogForUi() { return getCatalog().map(({ metric_id, label, category, slot_definitions }) => ({ metric_id, label, category, slots: slot_definitions })); }

function listStrategies(directory = defaultStrategiesDir) {
  fs.mkdirSync(directory, { recursive: true });
  return fs.readdirSync(directory).filter(file => /^[0-9a-f-]{36}\.json$/i.test(file)).flatMap(file => {
    try { const item = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')); return [{ id: path.basename(file, '.json'), name: item.name, updated_at: item.updated_at }]; }
    catch { return []; }
  }).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

function localOriginAllowed(req, port) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && ['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.port === String(port) && parsed.host.toLowerCase() === host;
  } catch { return false; }
}

function getSession(id, store) { const value = store.get(id); if (!value) { const error = new Error('会话已失效，请新建试卷'); error.status = 404; throw error; } return value; }

function createSessionState(snapshot) {
  const exam = questionnaire.createExam();
  exam.context.universe = { value: { type: 'explicit_symbols', symbols: sampleUniverse.symbols.map(item => item.thscode) }, source: 'default', confirmed: false };
  exam.context.combination = { value: 'all', source: 'default', confirmed: false };
  return {
    exam,
    last_results: null,
    chat_history: [{ role: 'assistant', text: `你好，我是选股助手。请直接描述你想寻找的股票或调整条件；我会结合当前可用数据与你逐步确认。` }],
    stage: 'start',
    original_request: '',
    pending_conditions: [],
    deferred_conditions: [],
    excluded_conditions: [],
    semantic_unresolved: [],
    unavailable_conditions: [],
    last_options: [],
    condition_audit: []
  };
}

function explicitConfirmation(text) { return /^(确认|确认以上条件|按这些条件筛|按这个筛|开始筛选|没问题按这个来|就按这个)$/.test(text.trim()); }

function modelLimitFromConfig() {
  try { return loadConfig().maxCalls; } catch { return Number(process.env.LLM_MAX_CALLS) || DEFAULT_MODEL_CALLS; }
}

async function clarifyTurn({ state, text, snapshot, complete }) {
  const status = snapshot ? {
    available: snapshot.status === 'usable_for_exact_date_only', provider: snapshot.source?.provider || null,
    data_date: snapshot.data_date || null, count: snapshot.items?.length || 0,
    coverage: snapshot.coverage || null, caveat: snapshot.metadata?.caveat || null
  } : evaluator.snapshotStatus();
  state.chat_history.push({ role: 'user', text });
  let model, applied, feedback = null;
  const usage = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = conversation.buildClarifyMessages({ history: state.chat_history.slice(0, -1), userText: text, exam: state.exam, dataStatus: status, validationFeedback: feedback });
    model = await complete(messages, { max_tokens: 1500 });
    usage.push(model.usage || null);
    const draft = JSON.parse(JSON.stringify(state));
    try {
      applied = conversation.applyClarifyResponse({ state: draft, userText: text, content: model.content, dataDate: snapshot?.data_date || status.data_date, dataStatus: status });
      Object.assign(state, draft);
      break;
    } catch (error) {
      if (error.code === 'INTENT_PATCH_REJECTED') console.warn('Intent patch rejected fields:', error.validationFeedback.map(item => item.field).join(', '));
      if (attempt || error.code !== 'INTENT_PATCH_REJECTED') throw error;
      feedback = { errors: error.validationFeedback, rejected_response: model.content,
        instruction: '修正本轮未通过的字段，避免重复无关旧条件。保持原有条件。如果客户真实含义或单位仍不明确，请用自然语言追问并提供清楚的选项，不要声称改好了。' };
    }
  }
  if (usage.length > 1) model.usage = { calls: usage.length, by_call: usage, total_tokens: usage.every(item => Number.isFinite(item?.total_tokens)) ? usage.reduce((sum, item) => sum + item.total_tokens, 0) : null };
  const readiness = conversation.canConfirmIntent(state);
  state.exam = readiness.exam;
  let actions = applied.options.map(label => ({ action: 'option', label }));
  if (readiness.ready && explicitConfirmation(text)) {
    state.exam = confirmExam(state.exam);
    state.stage = 'confirmed';
    actions = [{ action: 'screen', label: '执行筛选' }];
  } else if (readiness.ready) {
    state.stage = 'ready';
    actions.unshift({ action: 'confirm', label: '确认条件' });
  } else state.stage = 'clarifying';
  state.chat_history.push({ role: 'assistant', text: applied.reply, actions, usage: model.usage || null });
  return { exam: state.exam, chat_history: state.chat_history, stage: state.stage, model_usage: model.usage || null, model_calls_remaining: null };
}

function createHttpServer(options = {}) {
  const port = options.port !== undefined ? options.port : Number(process.env.PORT || 4173);
  const sessionStore = options.sessions || sessions;
  const strategyDirectory = options.strategiesDir || defaultStrategiesDir;
  let modelCalls = 0;
  const modelCallLimit = Number.isInteger(options.maxModelCalls) && options.maxModelCalls > 0 ? options.maxModelCalls : modelLimitFromConfig();
  const chatInFlight = new Set();
  const completeOverride = options.complete;
  const screeningOverride = options.runScreeningConversation;
  const getSnapshot = options.getSnapshot || (() => evaluator.readSnapshot());
  const server = http.createServer(async (req, res) => {
    let chatLock = null;
    if (!localOriginAllowed(req, port)) return apiError(res, 403, '仅允许同源本机访问');
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const sendError = error => apiError(res, error.status || 400, error.message || '请求失败');
    try {
      if (req.method === 'GET' && url.pathname === '/api/health') return reply(res, 200, { ok: true, service: 'stock-intent-local', host: '127.0.0.1' });
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') return reply(res, 200, {
        catalog: catalogForUi(), sample_universe: sampleUniverse, data_status: evaluator.snapshotStatus(), model_calls_remaining: Math.max(0, modelCallLimit - modelCalls)
      });
      if (req.method === 'GET' && url.pathname === '/api/strategies') return reply(res, 200, { strategies: listStrategies(strategyDirectory) });
      if (req.method === 'GET' && url.pathname === '/api/evidence/raw') {
        const sources = { 'ifind-latest': 'ifind-latest-pe-marketcap.json', 'ifind-2026-11-09': 'ifind-2026-11-09-pe-marketcap.json' };
        const file = sources[url.searchParams.get('source')];
        if (!file) return apiError(res, 400, '证据来源不在允许列表中。');
        const raw = JSON.parse(await fs.promises.readFile(path.join(root, 'data/snapshots/discovery', file), 'utf8'));
        return reply(res, 200, { source_file: file, evidence: raw });
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        const body = await readJsonBody(req); assertKeys(body, [], '请求');
        const id = randomUUID();
        const snapshot = getSnapshot();
        const state = createSessionState(snapshot);
        sessionStore.set(id, state);
        return reply(res, 201, { session_id: id, exam: state.exam, chat_history: state.chat_history, stage: state.stage });
      }
      if (req.method === 'POST' && url.pathname === '/api/reload-snapshot') {
        const body = await readJsonBody(req); assertKeys(body, [], '请求');
        return reply(res, 200, { data_status: evaluator.snapshotStatus(), note: '已重新读取本地缓存；本操作不调用外部数据接口。' });
      }
      const match = /^\/api\/sessions\/([0-9a-f-]{36})(?:\/(.*))?$/i.exec(url.pathname);
      if (match) {
        const [, id, action = ''] = match;
        const state = getSession(id, sessionStore);
        if (req.method === 'POST' && action === 'chat') {
          if (chatInFlight.has(id)) return apiError(res, 409, '上一条消息仍在处理，请稍后再发。');
          chatInFlight.add(id); chatLock = id;
          const body = await readJsonBody(req);
          assertKeys(body, ['text', 'action'], '请求');
          const snapshot = getSnapshot();
          const originalState = JSON.parse(JSON.stringify(state));
          if (body.text !== undefined) {
            if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 2000) return apiError(res, 400, '请发送不超过2000字的消息。');
            if (modelCalls >= modelCallLimit) return apiError(res, 429, '本机模型调用额度已用完，请调整服务调用额度后再试。');
            const text = body.text.trim();
            const historyLength = state.chat_history.length;
            const complete = async (messages, request = {}) => {
              if (modelCalls >= modelCallLimit) { const error = new Error('本机模型调用额度已用完。'); error.status = 429; throw error; }
              modelCalls++;
              const provider = completeOverride || createDeepSeekChat({ config: loadConfig(), timeoutMs: 20000, maxTokens: 1800 });
              return provider(messages, request);
            };
            try {
              const payload = await clarifyTurn({ state, text, snapshot, complete });
              payload.model_calls_remaining = Math.max(0, modelCallLimit - modelCalls);
              return reply(res, 200, payload);
            } catch (error) {
              for (const key of Object.keys(state)) delete state[key];
              Object.assign(state, originalState);
              if (error.status === 429) return apiError(res, 429, error.message);
              if (/LLM_API_KEY|LLM_BASE_URL|LLM_MODEL|LLM_MAX_CALLS|未配置/.test(error.message || '')) return apiError(res, 503, error.message);
              return apiError(res, 502, error.message || '这轮暂时没有处理成功，请稍后重试。', error.validationFeedback ? { validation_errors: error.validationFeedback } : undefined);
            }
          }
          if (!['confirm', 'screen', 'explain'].includes(body.action)) return apiError(res, 400, '聊天操作无效。');
          if (body.action === 'confirm') {
            if (state.stage !== 'ready') return apiError(res, 409, '请先完成当前条件的说明和选择。');
            const ready = conversation.canConfirmIntent(state);
            if (!ready.ready) return apiError(res, 422, '当前条件还需要补充或澄清。');
            state.chat_history.push({ role: 'user', text: '确认条件' });
            state.exam = confirmExam(ready.exam);
            if (!state.exam.validation) return apiError(res, 422, '当前条件未通过服务端校验。');
            state.stage = 'confirmed';
            state.chat_history.push({ role: 'assistant', text: '已确认，可以开始筛选。', actions: [{ action: 'screen', label: '执行筛选' }] });
            return reply(res, 200, { exam: state.exam, chat_history: state.chat_history, stage: state.stage });
          }
          const explaining = body.action === 'explain';
          if (explaining ? state.stage !== 'complete' || !state.last_results || !state.exam.validation : state.stage !== 'confirmed' || !state.exam.validation) return apiError(res, 422, '请先明确确认当前条件。');
          const historyLength = state.chat_history.length;
          state.chat_history.push({ role: 'user', text: explaining ? '重新生成解释' : '执行筛选' });
          const complete = async (messages, request = {}) => {
            if (modelCalls >= modelCallLimit) { const error = new Error('本机模型调用额度已用完。'); error.status = 429; throw error; }
            modelCalls++;
            const provider = completeOverride || createDeepSeekChat({ config: loadConfig(), timeoutMs: 20000, maxTokens: 1800 });
            return provider(messages, request);
          };
          try {
            const runner = explaining ? explainScreeningResults : screeningOverride || runScreeningConversation;
            const screened = await runner({ complete, exam: state.exam, snapshot, previous: state.last_results, results: state.last_results, maxRounds: 4 });
            state.last_results = screened.results;
            state.stage = 'complete';
            state.chat_history.push({ role: 'assistant', text: screened.reply || '筛选已完成，真实结果和逐项证据已显示。AI解释暂未通过核验，可以单独重新生成解释。', actions: screened.reply ? [] : [{ action: 'explain', label: '重新生成解释' }], usage: screened.usage || null });
            return reply(res, 200, { exam: state.exam, chat_history: state.chat_history, stage: state.stage, results: screened.results, explanation: screened.explanation, tool_trace: screened.tool_trace, usage: screened.usage || null, model_calls_remaining: Math.max(0, modelCallLimit - modelCalls) });
          } catch (error) {
            state.chat_history.length = historyLength;
            if (error.status === 429) return apiError(res, 429, error.message, { tool_trace: error.tool_trace || [], usage: error.usage || null });
            return apiError(res, 502, error.message || '筛选未完成。', { tool_trace: error.tool_trace || [], usage: error.usage || null });
          }
        }
        if (req.method === 'GET' && action === '') return reply(res, 200, { session_id: id, exam: state.exam, last_results: state.last_results, chat_history: state.chat_history || [], stage: state.stage });
        if (req.method === 'POST' && action === 'intake') {
          const body = await readJsonBody(req); assertKeys(body, ['userText'], '请求');
          if (typeof body.userText !== 'string' || !body.userText.trim() || body.userText.length > 2000) return apiError(res, 400, '请填写不超过2000字的需求。');
          if (modelCalls >= modelCallLimit) return apiError(res, 429, '本机验证模型调用额度已用完，请改用固定题目手工填写。');
          modelCalls++;
          const complete = completeOverride || createDeepSeekChat({ config: loadConfig(), timeoutMs: 20000, maxTokens: 700 });
          const result = await fillFromText({ userText: body.userText, exam: state.exam, complete });
          state.exam = result.exam;
          return reply(res, 200, { exam: result.exam, rejected_model_fields: result.rejected_model_fields, model: result.model || null, usage: result.usage || null, model_calls_remaining: Math.max(0, modelCallLimit - modelCalls) });
        }
        if (req.method === 'PATCH' && action === 'answers') {
          const body = await readJsonBody(req);
          let exam;
          try { exam = applyCustomerEdits(state.exam, body); }
          catch (error) { error.status = error.status || 400; throw error; }
          state.exam = exam;
          return reply(res, 200, { exam });
        }
        if (req.method === 'POST' && action === 'confirm') {
          const body = await readJsonBody(req); assertKeys(body, [], '请求');
          state.exam = confirmExam(state.exam);
          return reply(res, state.exam.validation ? 200 : 422, { exam: state.exam, validation: state.exam.validation, validation_errors: state.exam.validation_errors });
        }
        if (req.method === 'POST' && action === 'resolve-unmapped') {
          const body = await readJsonBody(req); assertKeys(body, ['id', 'resolutionText'], '请求');
          try { state.exam = resolveUnmappedInput(state.exam, body.id, body.resolutionText); }
          catch (error) { error.status = error.status || 400; throw error; }
          return reply(res, 200, { exam: state.exam });
        }
        if (req.method === 'POST' && action === 'screen') {
          const body = await readJsonBody(req); assertKeys(body, [], '请求');
          if (!state.exam.validation) return apiError(res, 422, '请先补充并确认条件。', { validation_errors: state.exam.validation_errors });
          const result = evaluator.evaluateExam(state.exam, { snapshot: getSnapshot(), previous: state.last_results });
          state.last_results = result;
          return reply(res, 200, { results: result });
        }
        if (req.method === 'POST' && action === 'save') {
          const body = await readJsonBody(req); assertKeys(body, ['name'], '请求');
          if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 60) return apiError(res, 400, '策略名称为1至60个字符。');
          const id = randomUUID();
          fs.mkdirSync(strategyDirectory, { recursive: true });
          const record = { id, name: body.name.trim(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), exam: state.exam, deferred_conditions: state.deferred_conditions || [], excluded_conditions: state.excluded_conditions || [], chat_history: state.chat_history || [] };
          fs.writeFileSync(path.join(strategyDirectory, id + '.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');
          return reply(res, 201, { strategy: { id, name: record.name, updated_at: record.updated_at }, strategies: listStrategies(strategyDirectory) });
        }
        if (req.method === 'POST' && action === 'load') {
          const body = await readJsonBody(req); assertKeys(body, ['id'], '请求');
          if (typeof body.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.id)) return apiError(res, 400, '策略编号无效。');
          const record = JSON.parse(fs.readFileSync(path.join(strategyDirectory, body.id + '.json'), 'utf8'));
          if (record.id !== body.id || !record.exam) return apiError(res, 404, '找不到该策略。');
          state.exam = questionnaire.validateExam(record.exam);
          state.last_results = null;
          state.deferred_conditions = Array.isArray(record.deferred_conditions) ? record.deferred_conditions : [];
          state.excluded_conditions = Array.isArray(record.excluded_conditions) ? record.excluded_conditions : [];
          state.pending_conditions = [];
          state.chat_history = [{ role: 'assistant', text: `已载入“${record.name}”。请检查下面的条件，再确认运行。` }];
          chatController.explainReady(state, getSnapshot()?.data_date);
          state.stage = 'ready';
          return reply(res, 200, { exam: state.exam, strategy: { id: record.id, name: record.name }, chat_history: state.chat_history, deferred_conditions: state.deferred_conditions, excluded_conditions: state.excluded_conditions, stage: state.stage });
        }
      }
      const file = req.method === 'GET' ? staticFiles.get(url.pathname) : null;
      if (file) {
        const target = path.join(frontend, file);
        const bytes = await fs.promises.readFile(target);
        res.writeHead(200, { 'content-type': mime[path.extname(target)] || 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'" });
        return res.end(bytes);
      }
      return apiError(res, 404, '未找到该页面或接口。');
    } catch (error) {
      if (error.status) return sendError(error);
      if (/FUYAO_API_KEY|LLM_API_KEY|LLM_BASE_URL|LLM_MODEL|未配置/.test(error.message || '')) return apiError(res, 503, error.message);
      if (error.code === 'ENOENT') return apiError(res, 404, '找不到该策略或本地文件。');
      return apiError(res, 502, error.message || '服务处理失败');
    } finally {
      if (chatLock) chatInFlight.delete(chatLock);
    }
  });
  return server;
}

module.exports = { createHttpServer, MAX_BODY };
