const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDate, parseMoney, assertLatestMatch } = require('../../scripts/import-ifind-sample.cjs');

test('iFinD真实总市值的万亿和亿单位换算为元', () => {
  assert.equal(parseMoney('1.8064万亿').value_cny, 1.8064e12);
  assert.equal(parseMoney('2307.3637亿').value_cny, 230736370000);
  assert.throws(() => parseMoney(''), /无法识别/);
  assert.throws(() => parseMoney('9'.repeat(400) + '万亿'), /换算结果无效/);
});

test('iFinD日期列需要有效的8位日期', () => {
  assert.equal(parseDate('20261109'), '2026-11-09');
  assert.throws(() => parseDate('最新'), /实际日期字段无效/);
});

test('最新对照表必须真实包含PE和总市值且数值一致', () => {
  const latest = { PE: '7.1', cap: '1.1万亿' };
  assert.doesNotThrow(() => assertLatestMatch(latest, { PE: '7.1', cap: '1.1万亿' }, 'PE', 'cap'));
  assert.throws(() => assertLatestMatch({ PE: '7.1' }, { PE: '7.1', cap: '1.1万亿' }, 'PE', 'cap'), /缺少PE或总市值/);
  assert.throws(() => assertLatestMatch({ PE: '7.2', cap: '1.1万亿' }, { PE: '7.1', cap: '1.1万亿' }, 'PE', 'cap'), /数值不一致/);
});
