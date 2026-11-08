import test from 'node:test';
import assert from 'node:assert/strict';
import { batteryView, inspectCapabilities, parseInputReport, toHex } from '../dist/protocol.js';
import { mockDevice } from './fakes.mjs';

const sample = (bytes) => new DataView(Uint8Array.from(bytes).buffer);

test('real 97% capture: WebHID separates Report ID from payload', () => {
  assert.deepEqual(parseInputReport(9, sample([0x0a, 5, 0x61, 0, 0, 0, 0])), { type: 'battery', percent: 97 });
  assert.equal(parseInputReport(9, sample([9, 0x0a, 5, 0x61, 0, 0, 0, 0])), null);
});

test('reads the DataView slice rather than its entire backing buffer', () => {
  const bytes = Uint8Array.from([255, 255, 0x0a, 5, 97, 0, 0, 0, 0, 255]);
  const view = new DataView(bytes.buffer, 2, 7);
  assert.equal(parseInputReport(9, view).percent, 97);
  assert.equal(toHex(view), '0A 05 61 00 00 00 00');
});

test('unknown IDs, subtype, length and percentages are rejected', () => {
  const valid = [0x0a, 5, 97, 0, 0, 0, 0];
  assert.equal(parseInputReport(1, sample(valid)), null);
  for (const length of [0, 1, 6, 8, 519]) assert.equal(parseInputReport(9, sample(Array(length).fill(0))), null);
  assert.equal(parseInputReport(9, sample([0x0d, 5, 97, 0, 0, 0, 0])), null);
  assert.equal(parseInputReport(9, sample([0x0a, 3, 97, 0, 0, 0, 0])), null);
  assert.equal(parseInputReport(9, sample([0x0a, 5, 101, 0, 0, 0, 0])), null);
  for (const percent of [0, 100]) assert.equal(parseInputReport(9, sample([0x0a, 5, percent, 0, 0, 0, 0])).percent, percent);
});

test('connection subtype accepts only known states', () => {
  for (const online of [0, 1]) assert.deepEqual(parseInputReport(9, sample([0x0a, 2, online, 0, 0, 0, 0])), { type: 'connection', online: online === 1 });
  assert.equal(parseInputReport(9, sample([0x0a, 2, 2, 0, 0, 0, 0])), null);
});

test('expired, missing, disconnected and offline readings are distinct from 0%', () => {
  const battery = { percent: 0, receivedAt: 100 };
  assert.equal(batteryView(battery, 'connected', 'unknown', 101).percent, 0);
  assert.equal(batteryView(battery, 'connected', 'online', 180_101).stale, true);
  assert.equal(batteryView(battery, 'removed', 'unknown', 101).percent, null);
  assert.equal(batteryView(battery, 'connected', 'offline', 101).percent, null);
  assert.equal(batteryView(null, 'connected', 'unknown', 101).percent, null);
});

test('descriptor gates input compatibility and reports feature capability separately', () => {
  const device = mockDevice();
  assert.deepEqual(inspectCapabilities(device), { vendorCollection: true, passiveInputCompatible: true, featureCompatible: true, inputPayloadBytes: 7, featurePayloadBytes: 519 });
  device.collections[0].inputReports[0].items[0].reportCount = 8;
  assert.equal(inspectCapabilities(device).passiveInputCompatible, false);
  device.vendorId = 1;
  assert.equal(inspectCapabilities(device).vendorCollection, false);
});
