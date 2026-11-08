import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPollingRateWrite, sendPollingRateWrite } from '../dist/write-polling.js';
import { parseConfiguration } from '../dist/config.js';
import { mockDevice } from './fakes.mjs';

const gold = JSON.parse(readFileSync(new URL('./fixtures/g3-v1-polling-writes.json', import.meta.url), 'utf8'));
const baseline = parseConfiguration(Buffer.from(gold.samples[0].baselineHex, 'hex'));
const identity = { matchesG3: true, productCode: '040000000019' };

for (const sample of gold.samples) {
  test(`polling ${sample.rate} Hz reproduces every byte of native frame ${sample.frame}`, () => {
    const before = parseConfiguration(Buffer.from(sample.baselineHex, 'hex'));
    const plan = buildPollingRateWrite(before, sample.rate);
    const wire = Buffer.concat([Buffer.from([9]), Buffer.from(plan.payload)]);
    assert.equal(wire.toString('hex'), sample.requestHex);
    const expected = Buffer.from(plan.expectedPacketHex.replaceAll(' ', ''), 'hex');
    assert.equal(parseConfiguration(expected).pollingRate, sample.rate);
    assert.deepEqual([...expected.keys()].filter((i) => expected[i] !== Buffer.from(sample.baselineHex, 'hex')[i]), [1, 10]);
    assert.equal(plan.beforePollingRate, before.pollingRate);
    assert.equal(plan.payload.length, 519);
    assert.equal(before.packetHex, parseConfiguration(Buffer.from(sample.baselineHex, 'hex')).packetHex);
  });
}

test('polling builder rejects unsupported rates and corrupted baselines', () => {
  for (const rate of [0, 126, 2000, 4000, 8000, 500.5, '500', null, NaN, Infinity]) assert.throws(() => buildPollingRateWrite(baseline, rate), /回报率/);
  assert.throws(() => buildPollingRateWrite({ packetHex: '09' }, 500), /基线/);
  assert.throws(() => buildPollingRateWrite({ packetHex: baseline.packetHex.replace('96', '00') }, 500), /校验/);
});

test('polling transport requires exact G3 identity and sends no SET for the current rate', async () => {
  const device = mockDevice(); device.opened = true;
  assert.equal((await sendPollingRateWrite(device, identity, baseline, 1000)).sent, false);
  for (const wrong of [null, { matchesG3: true, productCode: '040000000020' }]) await assert.rejects(sendPollingRateWrite(device, wrong, baseline, 500), /未确认/);
  device.opened = false;
  await assert.rejects(sendPollingRateWrite(device, identity, baseline, 500), /未确认/);
});

test('polling transport sends one native packet and correctly labels the transfer', async () => {
  const device = mockDevice(); device.opened = true;
  const writes = [], transfers = [];
  device.sendFeatureReport = async (id, payload) => writes.push(Buffer.concat([Buffer.from([id]), Buffer.from(payload)]).toString('hex'));
  await sendPollingRateWrite(device, identity, baseline, 500, (event) => transfers.push(event));
  assert.deepEqual(writes, [gold.samples[0].requestHex]);
  assert.equal(transfers[0].operation, 'write-polling-rate');
});
