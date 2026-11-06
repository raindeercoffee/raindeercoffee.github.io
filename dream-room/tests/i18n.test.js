import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { t, LANGS } from '../public/i18n.js';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../public/i18n.js', import.meta.url), 'utf8');
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
const keysOf = text => new Set([...text.matchAll(/^\s*'([\w.-]+)':/gm), ...text.matchAll(/[{,]\s*'([\w.-]+)':/g)].map(match => match[1]));

test('every tagged page text and label has a Japanese translation', () => {
  const jaStatic = keysOf(section('const JA_STATIC', 'const JA_ARIA'));
  const jaAria = keysOf(section('const JA_ARIA', '// 動態句子'));
  const textKeys = new Set([...html.matchAll(/data-i18n="([^"]+)"/g)].map(match => match[1]));
  const ariaKeys = new Set([...html.matchAll(/data-i18n-aria="([^"]+)"/g)].map(match => match[1]));
  assert(textKeys.size >= 10 && ariaKeys.size >= 10, '標籤數量異常，可能漏貼');
  for (const key of textKeys) assert(jaStatic.has(key), `日文缺內文：${key}`);
  for (const key of ariaKeys) assert(jaAria.has(key), `日文缺說明：${key}`);
});

test('Chinese and Japanese dynamic sentences have exactly the same keys', () => {
  // 從標題後面開始數，避免把「'zh-Hant'」這個標題本身算成一句。
  const zh = keysOf(section("'zh-Hant': {", '\n  ja: {').slice("'zh-Hant': {".length));
  const ja = keysOf(section('\n  ja: {', 'function initialLanguage'));
  assert.deepEqual([...ja].sort(), [...zh].sort());
  assert.deepEqual(LANGS, ['zh-Hant', 'ja']);
});

test('dynamic sentences with numbers keep the numbers', () => {
  assert.equal(t('count', 10, 10), '10 / 10 · 已滿');
  assert.match(t('population', 3), /^3/);
  assert.match(t('status.timer', 15), /15/);
});
