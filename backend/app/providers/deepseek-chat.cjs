// DeepSeek chat/completions adapter. It never logs credentials, prompts, or response bodies.
const fs = require('node:fs');
const path = require('node:path');

function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?(LLM_API_KEY|LLM_BASE_URL|LLM_MODEL|LLM_MAX_CALLS)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values[match[1]] = value;
  }
  return values;
}

function loadConfig(options = {}) {
  const projectRoot = options.projectRoot || path.resolve(__dirname, '../../..');
  const env = options.env || process.env;
  let fileValues = {};
  const envPath = options.envPath || path.join(projectRoot, '.env');
  try { fileValues = parseEnv(fs.readFileSync(envPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取本地LLM配置文件'); }
  const value = key => (env[key] !== undefined && env[key] !== '' ? env[key] : fileValues[key]);
  const configuredCalls = Number(value('LLM_MAX_CALLS') || 20);
  const config = { apiKey: value('LLM_API_KEY'), baseUrl: value('LLM_BASE_URL'), model: value('LLM_MODEL'), maxCalls: configuredCalls };
  const missing = Object.entries({ LLM_API_KEY: config.apiKey, LLM_BASE_URL: config.baseUrl, LLM_MODEL: config.model }).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error('缺少LLM配置项: ' + missing.join(', '));
  if (!Number.isInteger(config.maxCalls) || config.maxCalls < 1 || config.maxCalls > 100) throw new Error('LLM_MAX_CALLS必须是1到100之间的整数');
  let parsed;
  try { parsed = new URL(config.baseUrl); } catch { throw new Error('LLM_BASE_URL不是有效URL'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('LLM_BASE_URL格式不受支持');
  return config;
}

function createDeepSeekChat(options = {}) {
  const config = options.config || loadConfig(options);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前Node.js没有内置fetch');
  const timeoutMs = options.timeoutMs || 20000;
  const maxTokens = options.maxTokens || 1800;
  const endpoint = config.baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') + '/chat/completions';
  return async function complete(messages, request = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.apiKey },
          body: JSON.stringify({
            model: config.model,
            messages,
            ...(Array.isArray(request.tools) && request.tools.length ? { tools: request.tools, tool_choice: request.tool_choice || 'auto' } : { response_format: { type: 'json_object' } }),
            thinking: { type: 'disabled' },
            max_tokens: Number.isInteger(request.max_tokens) ? Math.min(maxTokens, request.max_tokens) : maxTokens,
            stream: false
          }),
          signal: controller.signal
        });
      } catch {
        if (controller.signal.aborted) throw new Error('LLM请求超时');
        throw new Error('LLM网络请求失败');
      }
      if (!response || !response.ok) throw new Error('LLM服务返回HTTP错误' + (response ? ' ' + response.status : ''));
      let body;
      try { body = await response.json(); } catch {
        if (controller.signal.aborted) throw new Error('LLM请求超时');
        throw new Error('LLM响应不是有效JSON');
      }
      if (controller.signal.aborted) throw new Error('LLM请求超时');
      const message = body?.choices?.[0]?.message;
      const finishReason = body?.choices?.[0]?.finish_reason;
      if (finishReason === 'length') throw new Error('LLM响应超过长度上限');
      if (!message || typeof message !== 'object') throw new Error('LLM响应缺少assistant消息');
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (toolCalls.length && !(Array.isArray(request.tools) && request.tools.length)) throw new Error('LLM在未提供工具时返回了tool call');
      if (!toolCalls.length && (typeof message.content !== 'string' || !message.content.trim())) throw new Error('LLM响应内容为空');
      if (finishReason === 'tool_calls' && !toolCalls.length) throw new Error('LLM声明工具调用但没有返回tool_calls');
      return {
        content: typeof message.content === 'string' ? message.content : null,
        message: { role: 'assistant', content: typeof message.content === 'string' ? message.content : null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        tool_calls: toolCalls,
        finish_reason: finishReason || null,
        usage: body.usage && typeof body.usage === 'object' ? {
          prompt_tokens: Number.isFinite(body.usage.prompt_tokens) ? body.usage.prompt_tokens : null,
          completion_tokens: Number.isFinite(body.usage.completion_tokens) ? body.usage.completion_tokens : null,
          total_tokens: Number.isFinite(body.usage.total_tokens) ? body.usage.total_tokens : null
        } : null,
        model: typeof body.model === 'string' ? body.model : config.model
      };
    } finally { clearTimeout(timer); }
  };
}

module.exports = { parseEnv, loadConfig, createDeepSeekChat };
