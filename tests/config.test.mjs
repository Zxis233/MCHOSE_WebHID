import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildReadConfigurationRequest, parseConfiguration, queryConfiguration } from '../dist/config.js';
import { mockDevice } from './fakes.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/g3-v1-config-read.json', import.meta.url), 'utf8'));
const response = Uint8Array.from(Buffer.from(fixture.responseHex, 'hex'));
const identity = { matchesG3: true, productCode: '040000000019' };

test('configuration read request exactly matches the official captured report', () => {
  const actual = Buffer.concat([Buffer.from([9]), Buffer.from(buildReadConfigurationRequest())]).toString('hex');
  assert.equal(actual, fixture.requestHex);
});

test('real 408-byte configuration agrees with the values confirmed in the official UI', () => {
  const parsed = parseConfiguration(response);
  assert.equal(parsed.pollingRate, fixture.confirmedByUser.pollingRate);
  assert.equal(parsed.dpiCount, fixture.confirmedByUser.dpiCount);
  assert.equal(parsed.currentStage, fixture.confirmedByUser.currentStage);
  assert.deepEqual(parsed.dpiStages.map((stage) => stage.xDpi), fixture.confirmedByUser.dpiStages);
  assert.equal(parsed.selectedDpi.xDpi, 2400);
  assert.equal(parsed.checksum, 0x7e);
});

test('configuration handles sliced DataViews and padded OS buffers', () => {
  const buffer = new Uint8Array(1042);
  buffer.set(response, 5);
  assert.equal(parseConfiguration(new DataView(buffer.buffer, 5, 1032), { maxBytes: 1032 }).selectedDpi.yDpi, 2400);
  assert.equal(parseConfiguration(response.subarray(1)).layout, 'payload-only');
});

test('configuration rejects corrupted, short and unrelated responses', () => {
  const corrupted = response.slice();
  corrupted[15] ^= 1;
  assert.throws(() => parseConfiguration(corrupted), /校验/);
  assert.throws(() => parseConfiguration(response.subarray(0, 407)), /长度/);
  const wrong = response.slice();
  wrong[2] = 1;
  assert.throws(() => parseConfiguration(wrong), /响应头/);
});

test('configuration query uses only the verified read packet and delay', async () => {
  const device = mockDevice();
  device.opened = true;
  const calls = [];
  device.sendFeatureReport = async (id, data) => { calls.push(['set', id]); assert.equal(Buffer.concat([Buffer.from([id]), Buffer.from(data)]).toString('hex'), fixture.requestHex); };
  device.receiveFeatureReport = async (id) => { calls.push(['get', id]); return new DataView(response.buffer); };
  const parsed = await queryConfiguration(device, identity, () => {}, async (ms) => { calls.push(['wait', ms]); });
  assert.deepEqual(calls, [['set', 9], ['wait', 100], ['get', 9]]);
  assert.equal(parsed.currentStage, 2);
});

test('configuration query rejects missing or different product identity before sending', async () => {
  const device = mockDevice();
  device.opened = true;
  let sent = false;
  device.sendFeatureReport = async () => { sent = true; };
  await assert.rejects(queryConfiguration(device, null), /产品标识/);
  await assert.rejects(queryConfiguration(device, { matchesG3: true, productCode: '04000000001B' }), /产品标识/);
  assert.equal(sent, false);
});
