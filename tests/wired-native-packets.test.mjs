import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseConfiguration } from '../dist/config.js';
import { sendPollingRateWrite } from '../dist/write-polling.js';
import { mockDevice } from './fakes.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/g3-v1-wired-polling-writes.json', import.meta.url), 'utf8'));
for (const sample of fixture.samples) {
  test(`wired ${sample.pollingRate} Hz sends all 520 bytes of native frame ${sample.frame}`, async () => {
    const device = mockDevice();
    device.productId = 0x0136; device.opened = true;
    const sends = [];
    device.sendFeatureReport = async (id, payload) => sends.push(Buffer.concat([Buffer.from([id]), Buffer.from(payload)]).toString('hex'));
    const before = parseConfiguration(Buffer.from(sample.baselineHex, 'hex'));
    const plan = await sendPollingRateWrite(device, { matchesG3: true, productCode: '040000000019' }, before, sample.pollingRate);
    assert.deepEqual(sends, [sample.requestHex]);
    const expected = Buffer.from(plan.expectedPacketHex.replaceAll(' ', ''), 'hex');
    assert.deepEqual([...expected.keys()].filter(i => expected[i] !== Buffer.from(sample.baselineHex, 'hex')[i]), [1, 10]);
    assert.equal(parseConfiguration(expected).pollingRate, sample.pollingRate);
  });
}
