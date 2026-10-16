import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentDir, configPath, parseConfig, readConfig, readConfigCached, DEFAULT_MODEL, DEFAULT_PROVIDER } from '../src/config.mjs';

const dir = mkdtempSync(join(tmpdir(), 'jev-config-'));
const env = { ...process.env, PI_CODING_AGENT_DIR: dir };

test('the config lives in Pi\'s agent directory', () => {
  assert.equal(agentDir(env), dir);
  assert.equal(configPath(env), join(dir, 'jev-browser.json'));
  assert.equal(agentDir({ HOME: '/home/nobody' }).endsWith('/.pi/agent'), true);
});

test('a minimal config is accepted and defaults the optional keys', () => {
  const config = parseConfig('{"allowedOrigins":["https://*.wikipedia.org"]}');
  assert.deepEqual(config.allowedOrigins, ['https://*.wikipedia.org']);
  assert.equal(config.sharePageText, false);
  assert.equal(config.hideNativeTools, false);
  assert.equal(config.provider, DEFAULT_PROVIDER);
  assert.equal(config.model, DEFAULT_MODEL);
  assert.equal(config.classifierBaseUrl, null);
  assert.equal(config.classifierApiKey, null);
  assert.equal(config.autoLoadChromeSkill, true);
  assert.deepEqual(config.warnings, []);
  assert.equal(parseConfig('{"allowedOrigins":["https://a.test"],"autoLoadChromeSkill":false}').autoLoadChromeSkill, false);
});

test('any classifier provider can be selected, so no single vendor is hard-coded', () => {
  const config = parseConfig('{"allowedOrigins":["https://a.test"],"provider":"opencode","model":"jev-1.13"}');
  assert.equal(config.provider, 'opencode');
  assert.equal(config.model, 'jev-1.13');
  const spaced = parseConfig('{"allowedOrigins":["https://a.test"],"provider":"  openrouter ","model":"  ~typesafe/jev-latest "}');
  assert.equal(spaced.provider, 'openrouter');
  assert.equal(spaced.model, '~typesafe/jev-latest');
  const blank = parseConfig('{"allowedOrigins":["https://a.test"],"provider":"   "}');
  assert.equal(blank.provider, DEFAULT_PROVIDER);
});

test('a classifier endpoint and key can be overridden from the config file', () => {
  const config = parseConfig('{"allowedOrigins":["https://a.test"],"classifierBaseUrl":"http://127.0.0.1:3425/v1/","classifierApiKey":"magpie"}');
  assert.equal(config.classifierBaseUrl, 'http://127.0.0.1:3425/v1/');
  assert.equal(config.classifierApiKey, 'magpie');
  const spaced = parseConfig('{"allowedOrigins":["https://a.test"],"classifierBaseUrl":" https://gw.test/v1 ","classifierApiKey":" key "}');
  assert.equal(spaced.classifierBaseUrl, 'https://gw.test/v1');
  assert.equal(spaced.classifierApiKey, 'key');
  // A typo must not silently fall back to the vendor endpoint.
  assert.throws(() => parseConfig('{"allowedOrigins":["https://a.test"],"classifierBaseUrl":"127.0.0.1:3425"}'), /classifierBaseUrl/);
  assert.throws(() => parseConfig('{"allowedOrigins":["https://a.test"],"classifierBaseUrl":"ftp://gw.test"}'), /http/);
  assert.throws(() => parseConfig('{"allowedOrigins":["https://a.test"],"classifierApiKey":"   "}'), /classifierApiKey/);
});

test('an empty or missing allowlist is refused, never widened', () => {
  assert.throws(() => parseConfig('{}'), /allowedOrigins/);
  assert.throws(() => parseConfig('{"allowedOrigins":[]}'), /allowedOrigins/);
  assert.throws(() => parseConfig('{"allowedOrigins":[42]}'), /字符串/);
  assert.throws(() => parseConfig('{"allowedOrigin":["https://a.test"]}'), /allowedOrigins/);
  assert.throws(() => parseConfig('not json'), /不是合法 JSON/);
  assert.throws(() => parseConfig('["https://a.test"]'), /JSON 对象/);
});

test('unknown keys are warned about, not silently dropped', () => {
  const config = parseConfig('{"allowedOrigins":["https://a.test"],"hideNativeTool":true}');
  assert.equal(config.warnings.length, 1);
  assert.match(config.warnings[0], /hideNativeTool/);
});

test('a missing file names the path it expected', () => {
  assert.throws(() => readConfig({ env }), /未找到配置文件/);
  assert.equal(readConfigCached({ env }), null);
});

test('the file is read, and the cached reader follows edits', () => {
  const path = join(dir, 'jev-browser.json');
  writeFileSync(path, JSON.stringify({ allowedOrigins: ['https://a.test'], model: 'other-model' }));
  assert.equal(readConfig({ env }).config.model, 'other-model');
  assert.equal(readConfigCached({ env }).model, 'other-model');

  const later = Date.now() + 5000;
  writeFileSync(path, JSON.stringify({ allowedOrigins: ['https://b.test'] }));
  utimesSync(path, new Date(later), new Date(later));
  assert.equal(readConfigCached({ env }).model, DEFAULT_MODEL);
  assert.deepEqual(readConfigCached({ env }).allowedOrigins, ['https://b.test']);
});

test('a broken file makes the cached reader report nothing rather than throw', () => {
  writeFileSync(join(dir, 'jev-browser.json'), '{ broken');
  assert.equal(readConfigCached({ env }), null);
  assert.throws(() => readConfig({ env }), /不是合法 JSON/);
});
