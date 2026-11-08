import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProductIdentityRequest, maxFeatureReportBytes, parseProductIdentity, queryProductIdentity } from '../dist/identity.js';
import { mockDevice } from './fakes.mjs';

const captured = Uint8Array.from([9, 0x0d, 5, 1, 1, 0, 6, 0, 4, 0, 0, 0, 0, 0x19]);

test('identity request reproduces the captured 520-byte report with a separate ID', () => {
  const payload = buildProductIdentityRequest();
  assert.equal(payload.length, 519);
  assert.deepEqual(Array.from(payload.subarray(0, 6)), [0x0d, 5, 1, 1, 0, 6]);
  assert.ok(payload.subarray(6).every((byte) => byte === 0));
  payload[0] = 0;
  assert.equal(buildProductIdentityRequest()[0], 0x0d);
});

test('captured identification response matches the official G3 product code', () => {
  const parsed = parseProductIdentity(captured);
  assert.equal(parsed.productCode, '040000000019');
  assert.equal(parsed.matchesG3, true);
  assert.equal(parsed.layout, 'report-id-prefixed');
  assert.equal(parsed.responseBytes, 14);
  assert.equal(parseProductIdentity(captured.subarray(1)).layout, 'payload-only');
});

test('identity parsing respects sliced DataViews and OS zero padding', () => {
  const backing = new Uint8Array(530).fill(0xff);
  backing.fill(0, 5, 525);
  backing.set(captured, 5);
  assert.equal(parseProductIdentity(new DataView(backing.buffer, 5, 520)).productCode, '040000000019');
});

test('malformed response headers, short data and unverified trailing data are rejected', () => {
  assert.throws(() => parseProductIdentity(captured.subarray(0, 13)), /长度/);
  const wrong = captured.slice();
  wrong[1] = 0x0a;
  assert.throws(() => parseProductIdentity(wrong), /响应头/);
  const trailing = new Uint8Array(520);
  trailing.set(captured);
  trailing[519] = 1;
  assert.throws(() => parseProductIdentity(trailing), /尾部/);
  assert.throws(() => parseProductIdentity(new Uint8Array(521)), /长度/);
});

test('another product sharing VID/PID is not reported as G3', () => {
  const other = captured.slice();
  other[13] = 0x1b;
  assert.equal(parseProductIdentity(other).matchesG3, false);
  assert.equal(parseProductIdentity(other).productCode, '04000000001B');
});

test('Feature lookup is serialized as one SET followed by one GET', async () => {
  const device = mockDevice();
  device.opened = true;
  const calls = [];
  device.sendFeatureReport = async (id, payload) => { calls.push(['set', id, payload.length]); };
  device.receiveFeatureReport = async (id) => { calls.push(['get', id]); return new DataView(captured.buffer); };
  const transfers = [];
  const result = await queryProductIdentity(device, (event) => transfers.push(event));
  assert.deepEqual(calls, [['set', 9, 519], ['get', 9]]);
  assert.equal(result.matchesG3, true);
  assert.equal(transfers[0].hex.split(' ').length, 520);
  assert.equal(transfers[1].receivedBytes, 14);
});

test('closed or incompatible devices are rejected without sending', async () => {
  const device = mockDevice();
  let sent = false;
  device.sendFeatureReport = async () => { sent = true; };
  await assert.rejects(queryProductIdentity(device), /连接/);
  device.opened = true;
  device.collections[0].featureReports[0].items[0].reportCount = 518;
  await assert.rejects(queryProductIdentity(device), /长度/);
  assert.equal(sent, false);
});

test('merged HID interfaces may return an OS buffer sized for a larger Feature report', () => {
  const device = mockDevice();
  device.collections.push({ featureReports: [{ reportId: 6, items: [{ reportSize: 8, reportCount: 1031 }] }] });
  assert.equal(maxFeatureReportBytes(device), 1032);
  const padded = new Uint8Array(1032);
  padded.set(captured);
  assert.equal(parseProductIdentity(padded, { maxBytes: maxFeatureReportBytes(device) }).matchesG3, true);
});
