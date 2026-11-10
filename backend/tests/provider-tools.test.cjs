const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeepSeekChat } = require('../app/providers/deepseek-chat.cjs');

const config = { apiKey: 'mock-secret', baseUrl: 'https://example.invalid', model: 'mock' };
const definitions = [{ type: 'function', function: { name: 'get_snapshot', parameters: { type: 'object', properties: {} } } }];

test('provider sends function definitions and preserves model-origin assistant tool calls', async () => {
  const call = { id: 'snapshot-1', type: 'function', function: { name: 'get_snapshot', arguments: '{}' } };
  let request;
  const complete = createDeepSeekChat({ config, fetchImpl: async (url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [call] } }], usage: { total_tokens: 7 } }) };
  } });
  const response = await complete([{ role: 'user', content: 'mock task' }], { tools: definitions });
  assert.deepEqual(request.tools, definitions);
  assert.equal(request.response_format, undefined);
  assert.equal(request.tool_choice, 'auto');
  assert.deepEqual(response.message, { role: 'assistant', content: null, tool_calls: [call] });
  assert.equal(response.usage.total_tokens, 7);
});

test('provider rejects unsolicited tool calls and truncated tool replies', async () => {
  const call = { id: 'unexpected', type: 'function', function: { name: 'get_snapshot', arguments: '{}' } };
  const response = message => ({ ok: true, json: async () => ({ choices: [message] }) });
  const unsolicited = createDeepSeekChat({ config, fetchImpl: async () => response({ finish_reason: 'tool_calls', message: { content: null, tool_calls: [call] } }) });
  await assert.rejects(unsolicited([]), /未提供工具/);
  const truncated = createDeepSeekChat({ config, fetchImpl: async () => response({ finish_reason: 'length', message: { content: null, tool_calls: [call] } }) });
  await assert.rejects(truncated([], { tools: definitions }), /长度上限/);
});

test('provider keeps JSON mode for clarification and accepts final text in tool mode', async () => {
  const requests = [];
  const complete = createDeepSeekChat({ config, fetchImpl: async (url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"reply":"查看证据"}' } }] }) };
  } });
  await complete([]);
  const final = await complete([{ role: 'tool', tool_call_id: 'snapshot-1', content: '{}' }], { tools: definitions });
  assert.deepEqual(requests[0].response_format, { type: 'json_object' });
  assert.equal(final.message.content, '{"reply":"查看证据"}');
  assert.deepEqual(final.tool_calls, []);
});
