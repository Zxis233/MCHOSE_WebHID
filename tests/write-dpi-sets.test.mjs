import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDpiSetWrite, sendDpiSetWrite } from '../dist/write-dpi.js';
import { parseConfiguration } from '../dist/config.js';
import { mockDevice } from './fakes.mjs';

const gold = JSON.parse(readFileSync(new URL('./fixtures/g3-v1-dpi-stage-sets.json', import.meta.url), 'utf8'));
const identity = { matchesG3: true, productCode: '040000000019' };
const packet = (hex) => Buffer.from(hex.replaceAll(' ', ''), 'hex');

for (const sample of gold.cases) {
  test(`native DPI group frame ${sample.frame}: ${sample.target.values.length} slots and selected stage ${sample.target.currentStage}`, () => {
    const plan = buildDpiSetWrite(parseConfiguration(packet(sample.beforeHex)), sample.target);
    assert.equal(Buffer.concat([Buffer.from([9]), Buffer.from(plan.payload)]).toString('hex'), sample.requestHex);
    assert.equal(plan.payload.length, 519);
    const parsed = parseConfiguration(packet(plan.expectedPacketHex));
    assert.deepEqual(parsed.dpiStages.map((stage) => stage.xDpi), sample.target.values);
    assert.equal(parsed.currentStage, sample.target.currentStage);
  });
}

test('shrinking a six-slot group preserves every inactive slot and unrelated byte', () => {
  const sample = gold.cases.find((item) => item.frame === 112617);
  const before = packet(sample.beforeHex);
  const plan = buildDpiSetWrite(parseConfiguration(before), { values: [100, 12000], currentStage: 1 });
  const after = packet(plan.expectedPacketHex);
  const allowed = new Set([1, 11, 15, 16, 17, 18, 35, 36, 37, 38]);
  for (let index = 0; index < before.length; index += 1) if (!allowed.has(index)) assert.equal(after[index], before[index], `unrelated offset ${index}`);
  assert.deepEqual(after.subarray(19, 35), before.subarray(19, 35));
  assert.deepEqual(after.subarray(39), before.subarray(39));
});

test('group transport gates identity and skips a no-op without sending', async () => {
  const sample = gold.cases[0];
  const baseline = parseConfiguration(packet(sample.beforeHex));
  const device = mockDevice(); device.opened = true;
  const sends = [];
  device.sendFeatureReport = async (id, payload) => sends.push({ id, payload });
  await assert.rejects(sendDpiSetWrite(device, { ...identity, productCode: 'other' }, baseline, sample.target));
  await assert.rejects(sendDpiSetWrite(device, identity, baseline, { values: [800], currentStage: 1 }), /2–6/);
  await sendDpiSetWrite(device, identity, baseline, { values: [1600, 2400], currentStage: 2 });
  assert.equal(sends.length, 0);
  await sendDpiSetWrite(device, identity, baseline, sample.target);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].id, 9);
});
