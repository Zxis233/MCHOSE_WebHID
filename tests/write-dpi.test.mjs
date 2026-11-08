import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDpiWrite, sendDpiWrite } from '../dist/write-dpi.js';
import { parseConfiguration } from '../dist/config.js';
import { mockDevice } from './fakes.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/g3-v1-dpi-write-cycle.json', import.meta.url), 'utf8'));
const baseline = parseConfiguration(Buffer.from(fixture.baselineHex, 'hex'));
const wireHex = (plan) => Buffer.concat([Buffer.from([9]), Buffer.from(plan.payload)]).toString('hex');

test('DPI 2400 to 2500 reproduces every byte of the native captured write', () => {
  const plan = buildDpiWrite(baseline, 2, 2500);
  assert.equal(wireHex(plan), fixture.changed.requestHex);
  assert.equal(plan.payload.length, 519);
  assert.equal(plan.beforeDpi, 2400);
});

test('DPI restoration reproduces every byte of the native restore packet', () => {
  const changed = buildDpiWrite(baseline, 2, 2500);
  const after = parseConfiguration(Buffer.from(changed.expectedPacketHex.replaceAll(' ', ''), 'hex'));
  assert.equal(wireHex(buildDpiWrite(after, 2, 2400)), fixture.restored.requestHex);
});

test('DPI update preserves every unrelated configuration byte', () => {
  const plan = buildDpiWrite(baseline, 2, 2500);
  const before = Buffer.from(baseline.packetHex.replaceAll(' ', ''), 'hex');
  const after = Buffer.from(plan.expectedPacketHex.replaceAll(' ', ''), 'hex');
  assert.deepEqual([...after.keys()].filter((index) => after[index] !== before[index]), [1, 17, 37]);
  assert.equal(baseline.selectedDpi.xDpi, 2400);
});

test('invalid stage, DPI and corrupted baselines cannot produce a packet', () => {
  for (const stage of [0, 3, 1.5]) assert.throws(() => buildDpiWrite(baseline, stage, 2500), /档位/);
  for (const dpi of [0, 99, 2501, 12100, NaN, Infinity, '2500']) assert.throws(() => buildDpiWrite(baseline, 2, dpi), /DPI/);
  assert.throws(() => buildDpiWrite({ packetHex: '09' }, 2, 2500), /基线/);
  assert.throws(() => buildDpiWrite({ packetHex: baseline.packetHex.replace('7E', '00') }, 2, 2500), /校验/);
});

test('unchanged DPI does not send a write', async () => {
  const device = mockDevice();
  device.opened = true;
  const result = await sendDpiWrite(device, { matchesG3: true, productCode: '040000000019' }, baseline, 2, 2400);
  assert.equal(result.sent, false);
});

test('DPI transport sends only the exact validated Feature packet', async () => {
  const device = mockDevice();
  device.opened = true;
  const calls = [];
  device.sendFeatureReport = async (id, payload) => { calls.push({ id, hex: Buffer.concat([Buffer.from([id]), Buffer.from(payload)]).toString('hex') }); };
  await sendDpiWrite(device, { matchesG3: true, productCode: '040000000019' }, baseline, 2, 2500);
  assert.deepEqual(calls, [{ id: 9, hex: fixture.changed.requestHex }]);
  await assert.rejects(sendDpiWrite(device, null, baseline, 2, 2500), /未确认/);
});
