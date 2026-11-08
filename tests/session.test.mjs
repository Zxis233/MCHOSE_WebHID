import test from 'node:test';
import assert from 'node:assert/strict';
import { G3Session } from '../dist/session.js';
import { mockDevice } from './fakes.mjs';
import { readFileSync } from 'node:fs';

function fixture(options = {}) {
  const device = mockDevice();
  const hid = new EventTarget();
  hid.requestDevice = async () => [device];
  return { device, hid, session: new G3Session({ hid, now: () => 1000, ...options }) };
}

function emit(device, bytes, reportId = 9) {
  device.dispatchEvent(Object.assign(new Event('inputreport'), { device, reportId, data: new DataView(Uint8Array.from(bytes).buffer) }));
}

test('passive session opens and parses real input without any active HID commands', async () => {
  const { device, session } = fixture();
  await session.connect();
  emit(device, [0x0a, 5, 97, 0, 0, 0, 0]);
  assert.equal(session.snapshot().phase, 'connected');
  assert.equal(session.snapshot().batteryView.percent, 97);
  assert.equal(session.snapshot().events.at(-1).hex, '09 0A 05 61 00 00 00 00');
  await session.disconnect();
  assert.equal(session.snapshot().batteryView.percent, null);
  emit(device, [0x0a, 5, 50, 0, 0, 0, 0]);
  assert.equal(session.snapshot().reportCount, 0);
});

test('offline and online reports do not revive an earlier battery reading', async () => {
  const { device, session } = fixture();
  await session.connect();
  emit(device, [0x0a, 5, 97, 0, 0, 0, 0]);
  emit(device, [0x0a, 2, 0, 0, 0, 0, 0]);
  emit(device, [0x0a, 2, 1, 0, 0, 0, 0]);
  assert.equal(session.snapshot().battery, null);
  assert.equal(session.snapshot().link, 'online');
});

test('unplug clears readings and ignores later reports from the old device', async () => {
  const { device, hid, session } = fixture();
  await session.connect();
  emit(device, [0x0a, 5, 97, 0, 0, 0, 0]);
  hid.dispatchEvent(Object.assign(new Event('disconnect'), { device }));
  assert.equal(session.snapshot().phase, 'removed');
  assert.equal(session.snapshot().batteryView.percent, null);
  emit(device, [0x0a, 5, 50, 0, 0, 0, 0]);
  assert.equal(session.snapshot().reportCount, 0);
});

test('battery reports received while explicitly offline cannot reappear on reconnect', async () => {
  const { device, session } = fixture();
  await session.connect();
  emit(device, [0x0a, 2, 0, 0, 0, 0, 0]);
  emit(device, [0x0a, 5, 97, 0, 0, 0, 0]);
  emit(device, [0x0a, 2, 1, 0, 0, 0, 0]);
  assert.equal(session.snapshot().batteryView.percent, null);
  emit(device, [0x0a, 5, 96, 0, 0, 0, 0]);
  assert.equal(session.snapshot().batteryView.percent, 96);
});

test('late open completion is closed after session cancellation', async () => {
  const { device, session } = fixture();
  let finishOpen;
  device.open = () => new Promise((resolve) => { finishOpen = () => { device.opened = true; resolve(); }; });
  const connecting = session.connect();
  await Promise.resolve();
  assert.equal(session.snapshot().phase, 'opening');
  await session.disconnect();
  finishOpen();
  await connecting;
  assert.equal(device.opened, false);
  assert.equal(session.snapshot().phase, 'idle');
});

test('mismatched descriptor is rejected before opening', async () => {
  const { device, session } = fixture();
  device.collections = [];
  await session.connect();
  assert.equal(device.opened, false);
  assert.equal(session.snapshot().phase, 'error');
});

test('unplug during open invalidates a late completion', async () => {
  const { device, hid, session } = fixture();
  let finishOpen;
  device.open = () => new Promise((resolve) => { finishOpen = () => { device.opened = true; resolve(); }; });
  const connecting = session.connect();
  await Promise.resolve();
  hid.dispatchEvent(Object.assign(new Event('disconnect'), { device }));
  finishOpen();
  await connecting;
  assert.equal(device.opened, false);
  assert.equal(session.snapshot().phase, 'removed');
  assert.equal(session.snapshot().busy, false);
});

test('chooser cancellation is recoverable and records no fake reading', async () => {
  const { hid, session } = fixture();
  hid.requestDevice = async () => { throw new DOMException('Cancelled', 'NotFoundError'); };
  await session.connect();
  assert.equal(session.snapshot().phase, 'idle');
  assert.equal(session.snapshot().error, null);
  assert.equal(session.snapshot().batteryView.percent, null);
});

test('empty chooser result is normal cancellation rather than an error', async () => {
  const { hid, session } = fixture();
  hid.requestDevice = async () => [];
  await session.connect();
  assert.equal(session.snapshot().phase, 'idle');
  assert.equal(session.snapshot().error, null);
  assert.equal(session.snapshot().busy, false);
});

test('reports from another collection on the same HID interface are ignored', async () => {
  const { device, session } = fixture();
  await session.connect();
  emit(device, [0x0a, 5, 97, 0, 0, 0, 0], 2);
  assert.equal(session.snapshot().reportCount, 0);
  assert.equal(session.snapshot().battery, null);
});

test('one physical selection with several interfaces chooses the unique compatible one', async () => {
  const { device, hid, session } = fixture();
  const unrelated = mockDevice();
  unrelated.collections = [{ usagePage: 12, usage: 1, inputReports: [], children: [] }];
  hid.requestDevice = async () => [unrelated, device];
  await session.connect();
  assert.equal(device.opened, true);
  assert.equal(unrelated.opened, false);
  assert.equal(session.snapshot().phase, 'connected');
});

test('ambiguous compatible devices are not automatically opened', async () => {
  const { device, hid, session } = fixture();
  const another = mockDevice();
  hid.requestDevice = async () => [device, another];
  await session.connect();
  assert.equal(device.opened, false);
  assert.equal(another.opened, false);
  assert.equal(session.snapshot().phase, 'error');
});

test('a unique previously granted device reconnects without another chooser', async () => {
  const { device, hid, session } = fixture();
  hid.getDevices = async () => [device];
  hid.requestDevice = async () => { throw new Error('Should reuse existing grant'); };
  await session.connect();
  assert.equal(session.snapshot().phase, 'connected');
  assert.ok(session.snapshot().events.some((event) => event.type === 'reused-grant'));
});

const configFixture = JSON.parse(readFileSync(new URL('./fixtures/g3-v1-config-read.json', import.meta.url), 'utf8'));
const productReply = Buffer.from('090d050101000600040000000019', 'hex');
const configReply = Buffer.from(configFixture.responseHex, 'hex');
const dataView = (buffer) => new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

function permitReads(device, identity = productReply, configuration = configReply) {
  const calls = [];
  const replies = [identity, configuration];
  device.sendFeatureReport = async (id, payload) => { calls.push({ id, payload: [...payload] }); };
  device.receiveFeatureReport = async () => dataView(replies.shift());
  return calls;
}

test('explicit configuration read verifies the model before displaying real parameters', async () => {
  const { device, session } = fixture();
  const calls = permitReads(device);
  await session.connect();
  await session.readConfiguration();
  const state = session.snapshot();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].payload[1], 5);
  assert.equal(calls[1].payload[1], 0x44);
  assert.equal(state.identity.productCode, '040000000019');
  assert.equal(state.configuration.selectedDpi.xDpi, 2400);
  assert.equal(state.queryBusy, false);
  assert.equal(state.queryError, null);
});

test('explicit offline state prevents any feature query', async () => {
  const { device, session } = fixture();
  const calls = permitReads(device);
  await session.connect();
  emit(device, [0x0a, 2, 0, 0, 0, 0, 0]);
  await session.readConfiguration();
  assert.equal(calls.length, 0);
  assert.match(session.snapshot().queryError.message, /上线/);
});

test('a different product code cannot proceed to configuration lookup', async () => {
  const { device, session } = fixture();
  const other = Buffer.from(productReply);
  other[13] = 0x1b;
  const calls = permitReads(device, other);
  await session.connect();
  await session.readConfiguration();
  assert.equal(calls.length, 1);
  assert.equal(session.snapshot().configuration, null);
  assert.match(session.snapshot().queryError.message, /产品标识/);
});

test('configuration returned after unplug cannot populate the removed session', async () => {
  const { device, hid, session } = fixture();
  permitReads(device);
  let finishConfig;
  let signalConfig;
  const pendingConfig = new Promise((resolve) => { signalConfig = resolve; });
  let reads = 0;
  device.receiveFeatureReport = async () => {
    if (++reads === 1) return dataView(productReply);
    signalConfig();
    return new Promise((resolve) => { finishConfig = () => resolve(dataView(configReply)); });
  };
  await session.connect();
  const reading = session.readConfiguration();
  await pendingConfig;
  hid.dispatchEvent(Object.assign(new Event('disconnect'), { device }));
  finishConfig();
  await reading;
  assert.equal(session.snapshot().phase, 'removed');
  assert.equal(session.snapshot().configuration, null);
  assert.equal(session.snapshot().identity, null);
  assert.equal(session.snapshot().queryBusy, false);
});

test('a slow warning keeps the transport locked rather than pretending to cancel', async () => {
  const { device, session } = fixture({ warningAfterMs: 5 });
  const calls = permitReads(device);
  let finishIdentity;
  device.receiveFeatureReport = () => new Promise((resolve) => { finishIdentity = () => resolve(dataView(productReply)); });
  await session.connect();
  const reading = session.readConfiguration();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(session.snapshot().querySlow, true);
  assert.equal(session.snapshot().queryBusy, true);
  await session.readConfiguration();
  assert.equal(calls.length, 1);
  await session.disconnect();
  finishIdentity();
  await reading;
  assert.equal(session.snapshot().phase, 'idle');
  assert.equal(session.snapshot().queryBusy, false);
  assert.equal(session.snapshot().configuration, null);
});

test('a corrupted configuration becomes an error rather than displayed settings', async () => {
  const { device, session } = fixture();
  const corrupted = Buffer.from(configReply);
  corrupted[15] ^= 1;
  permitReads(device, productReply, corrupted);
  await session.connect();
  await session.readConfiguration();
  assert.equal(session.snapshot().configuration, null);
  assert.match(session.snapshot().queryError.message, /校验/);
});
