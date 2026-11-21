import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deviceRequestFilters, inspectCapabilities, transportForDevice } from '../dist/protocol.js';
import { G3Session } from '../dist/session.js';
import { mockDevice } from './fakes.mjs';

const gold = JSON.parse(readFileSync(new URL('./fixtures/g3-v1-config-read.json', import.meta.url), 'utf8'));
const product = Buffer.from('090d050101000600040000000019', 'hex');
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), 'wired transport operation did not finish');
}

function fixture(t, productId = 0x0136) {
  const hid = new EventTarget();
  const board = { packet: Buffer.from(gold.responseHex, 'hex'), product: Buffer.from(product), commands: [], writes: [], selectors: [] };
  function makeDevice(pid = 0x0136) {
    const device = mockDevice();
    device.productId = pid;
    device.productName = pid === 0x0136 ? 'G3 Gaming Mouse' : 'Wireless Mouse';
    device.sendFeatureReport = async (id, payload) => {
      assert.equal(id, 9); assert.equal(payload.length, 519);
      device.command = payload[1];
      board.commands.push({ productId: pid, command: device.command });
      assert.ok([5, 0x44, 4].includes(device.command));
      if (device.command === 4) {
        const wire = Buffer.concat([Buffer.from([id]), Buffer.from(payload)]);
        board.writes.push(wire);
        board.packet = Buffer.from(wire.subarray(0, 408));
        board.packet[2] = 0x44;
        board.packet[1] = board.packet.subarray(2).reduce((sum, byte) => (sum + byte) & 255, 0);
      }
    };
    device.receiveFeatureReport = async () => view(device.command === 5 ? board.product : board.packet);
    return device;
  }
  const device = makeDevice(productId);
  hid.granted = [device]; hid.choice = device;
  hid.getDevices = async () => hid.granted;
  hid.requestDevice = async (options) => { board.selectors.push(options); return [hid.choice]; };
  const session = new G3Session({ hid, automaticDelayMs: 1, automaticRetryMs: 2 });
  t.after(() => session.disconnect());
  return { session, device, hid, board, makeDevice };
}

test('permanent chooser includes exactly the wired and receiver USB IDs', () => {
  assert.deepEqual(deviceRequestFilters(), [{ vendorId: 0x258a, productId: 0x0138 }, { vendorId: 0x258a, productId: 0x0136 }]);
  const device = mockDevice();
  assert.equal(transportForDevice(device).key, 'receiver');
  device.productId = 0x0136;
  assert.equal(transportForDevice(device).key, 'wired');
  for (const pid of [0x0137, 0x01bb, 0xfa09]) { device.productId = pid; assert.equal(transportForDevice(device), null); }
  device.productId = 0x0136; device.vendorId = 1;
  assert.equal(transportForDevice(device), null);
});

test('wired ID does not bypass exact vendor collection and report length checks', async (t) => {
  const { device, session, board } = fixture(t);
  assert.equal(inspectCapabilities(device).featureCompatible, true);
  device.collections[0].usagePage = 0xff00;
  await session.connect();
  assert.equal(device.opened, false);
  assert.equal(session.snapshot().phase, 'error');
  assert.equal(board.commands.length, 0);
  device.collections[0].usagePage = 0xff02;
  device.collections[0].featureReports[0].items[0].reportCount = 518;
  assert.equal(inspectCapabilities(device).featureCompatible, false);
  await session.connect(); await session.readConfiguration();
  assert.equal(board.commands.length, 0);
  assert.equal(session.snapshot().configuration, null);
});

test('wired manual selection verifies the model and reads configuration through the normal session', async (t) => {
  const { device, session, hid, board } = fixture(t); hid.granted = [];
  await session.connect(); await session.readConfiguration();
  assert.equal(board.selectors.length, 1);
  assert.deepEqual(board.selectors[0].filters, deviceRequestFilters());
  assert.equal(session.snapshot().device.productId, 0x0136);
  assert.equal(session.snapshot().device.transport, 'wired');
  assert.equal(session.snapshot().identity.productCode, '040000000019');
  assert.equal(session.snapshot().configuration.selectedDpi.xDpi, 2400);
  assert.deepEqual(board.commands.map((item) => item.command), [5, 0x44]);
  assert.equal(device.opened, true);
});

test('wired startup reuses the granted device without a chooser or configuration write', async (t) => {
  const { session, board } = fixture(t);
  session.startAutomatic(); await until(() => session.snapshot().configuration);
  assert.equal(session.snapshot().device.transport, 'wired');
  assert.equal(board.selectors.length, 0); assert.equal(board.writes.length, 0);
  assert.deepEqual(board.commands.map((item) => item.command), [5, 0x44]);
});

test('a wired connection event restores after removal of a receiver', async (t) => {
  const { session, device, hid, board, makeDevice } = fixture(t, 0x0138);
  session.startAutomatic(); await until(() => session.snapshot().configuration);
  hid.dispatchEvent(Object.assign(new Event('disconnect'), { device }));
  const wired = makeDevice(); hid.granted = [wired];
  hid.dispatchEvent(Object.assign(new Event('connect'), { device: wired }));
  await until(() => session.snapshot().device?.transport === 'wired' && session.snapshot().configuration);
  assert.equal(board.selectors.length, 0);
  assert.deepEqual(board.commands.slice(-2).map((item) => item.productId), [0x0136, 0x0136]);
});

test('two granted transports require explicit selection rather than choosing a device automatically', async (t) => {
  const { session, device, hid, board, makeDevice } = fixture(t);
  const receiver = makeDevice(0x0138); hid.granted = [device, receiver];
  session.startAutomatic();
  await until(() => session.snapshot().events.some((event) => event.type === 'automatic-connect-unavailable'));
  assert.equal(device.opened, false); assert.equal(receiver.opened, false);
  assert.equal(board.selectors.length, 0);
  await session.connect(); await until(() => session.snapshot().configuration);
  assert.equal(board.selectors.length, 1);
  assert.equal(session.snapshot().device.transport, 'wired');
});

test('shared wired VID/PID still refuses a different G3-family product code', async (t) => {
  const { session, board } = fixture(t);
  board.product[board.product.length - 1] = 0x20;
  await session.connect(); await session.readConfiguration();
  assert.equal(board.writes.length, 0);
  assert.equal(session.snapshot().configuration, null);
  assert.match(session.snapshot().queryError.message, /产品标识不匹配/);
});

test('explicit connection can choose an ungranted wired mouse instead of reusing a sole receiver grant', async (t) => {
  const { session, hid, board, makeDevice } = fixture(t);
  hid.granted = [makeDevice(0x0138)];
  await session.connect({ selectDevice: true }); await session.readConfiguration();
  assert.equal(board.selectors.length, 1);
  assert.equal(session.snapshot().device.transport, 'wired');
  assert.ok(board.commands.every((item) => item.productId === 0x0136));
  assert.equal(session.snapshot().events.some((event) => event.type === 'selected-device'), true);
  assert.equal(session.snapshot().events.some((event) => event.type === 'reused-grant'), false);
});

test('verified wired DPI and polling transport preserves other fields and restores the full block', async (t) => {
  const { session, board } = fixture(t);
  const baseline = board.packet.toString('hex');
  await session.connect(); await session.readConfiguration();
  assert.equal(session.snapshot().device.configurationWritable, true);
  await session.applyDpiSet({ values: [1600, 2500], currentStage: 2 });
  assert.equal(session.snapshot().lastWrite.status, 'verified');
  assert.equal(session.snapshot().configuration.pollingRate, 1000);
  await session.applyDpiSet({ values: [1600, 2400], currentStage: 2 });
  await session.applyPollingRate(500);
  assert.equal(session.snapshot().lastWrite.status, 'verified');
  assert.equal(session.snapshot().configuration.selectedDpi.xDpi, 2400);
  await session.applyPollingRate(1000);
  assert.equal(session.snapshot().lastWrite.status, 'verified');
  assert.equal(board.writes.length, 4);
  assert.equal(board.packet.toString('hex'), baseline);
});

function interceptReadback(device, board, receive) {
  const original = device.receiveFeatureReport;
  let attempts = 0;
  device.receiveFeatureReport = async () => {
    if (device.command === 0x44 && board.writes.length) {
      attempts += 1;
      return receive(attempts, () => original.call(device));
    }
    return original.call(device);
  };
  return () => attempts;
}
const getFailure = (name = 'NotAllowedError') => new DOMException('USB GET failed', name);
function input(device, payload) {
  device.dispatchEvent(Object.assign(new Event('inputreport'), { device, reportId: 9, data: view(Buffer.from(payload)) }));
}

for (const name of ['NotAllowedError', 'NetworkError']) {
  test(`wired ${name} after SET rechecks a read once and never repeats the write`, async (t) => {
    const { session, device, board } = fixture(t);
    const attempts = interceptReadback(device, board, (n, read) => { if (n === 1) throw getFailure(name); return read(); });
    await session.connect(); await session.applyPollingRate(500);
    const s = session.snapshot();
    assert.equal(s.lastWrite.status, 'verified'); assert.equal(s.configuration.pollingRate, 500);
    assert.equal(s.lastWrite.readbackRetry.name, name); assert.equal(s.lastWrite.readbackAttempts, 2);
    assert.equal(attempts(), 2); assert.equal(board.writes.length, 1);
    assert.deepEqual(board.commands.map((c) => c.command), [5, 0x44, 4, 0x44, 0x44]);
    assert.equal(s.lastWrite.readbackPacketHex, s.lastWrite.expectedPacketHex);
  });
}

test('a second wired GET failure remains uncertain with no third read or extra write', async (t) => {
  const { session, device, board } = fixture(t);
  const attempts = interceptReadback(device, board, () => { throw getFailure(); });
  await session.connect(); await session.applyPollingRate(500);
  assert.equal(session.snapshot().lastWrite.status, 'uncertain');
  assert.equal(session.snapshot().configuration, null);
  assert.equal(attempts(), 2); assert.equal(board.writes.length, 1);
  assert.equal(session.snapshot().queryBusy, false);
});

for (const [label, result] of [
  ['corrupted response', (board) => { const bytes = Buffer.from(board.packet); bytes[15] ^= 1; return view(bytes); }],
  ['valid but different response', () => view(Buffer.from(gold.responseHex, 'hex'))],
]) {
  test(`wired ${label} cannot trigger recovery or confirm a save`, async (t) => {
    const { session, device, board } = fixture(t);
    const attempts = interceptReadback(device, board, () => result(board));
    await session.connect(); await session.applyPollingRate(500);
    assert.equal(session.snapshot().lastWrite.status, 'uncertain');
    assert.equal(session.snapshot().lastWrite.readbackRetry, undefined);
    assert.equal(attempts(), 1); assert.equal(board.writes.length, 1);
  });
}

test('wired baseline GET failure never reaches the write or post-write recovery', async (t) => {
  const { session, device, board } = fixture(t);
  const original = device.receiveFeatureReport;
  let reads = 0;
  device.receiveFeatureReport = async () => { if (device.command === 0x44) { reads += 1; throw getFailure(); } return original(); };
  await session.connect(); await session.applyPollingRate(500);
  assert.equal(reads, 1); assert.equal(board.writes.length, 0);
  assert.equal(session.snapshot().lastWrite, null);
});

test('wired SET failure is not treated as a recoverable GET failure', async (t) => {
  const { session, device, board } = fixture(t);
  const original = device.sendFeatureReport;
  device.sendFeatureReport = async (id, payload) => { if (payload[1] === 4) throw getFailure(); return original(id, payload); };
  await session.connect(); await session.applyPollingRate(500);
  assert.equal(session.snapshot().lastWrite.status, 'uncertain');
  assert.equal(session.snapshot().lastWrite.readbackRetry, undefined);
  assert.deepEqual(board.commands.map((c) => c.command), [5, 0x44]);
});

test('receiver GET failure keeps the existing uncertain-save behavior', async (t) => {
  const { session, device, board } = fixture(t, 0x0138);
  const attempts = interceptReadback(device, board, () => { throw getFailure(); });
  await session.connect(); await session.applyPollingRate(500);
  assert.equal(session.snapshot().lastWrite.status, 'uncertain');
  assert.equal(attempts(), 1); assert.equal(board.writes.length, 1);
});

for (const [label, interrupt] of [
  ['matching DPI notification', ({ device }) => input(device, [0x0a, 3, 2, 0, 0, 0, 0])],
  ['offline then online', ({ device }) => { input(device, [0x0a, 2, 0, 0, 0, 0, 0]); input(device, [0x0a, 2, 1, 0, 0, 0, 0]); }],
  ['disconnect', ({ hid, device }) => hid.dispatchEvent(Object.assign(new Event('disconnect'), { device }))],
]) {
  test(`${label} during wired readback delay stops verification and the second read`, async (t) => {
    const context = fixture(t); const { session, device, board } = context;
    const attempts = interceptReadback(device, board, () => { throw getFailure(); });
    await session.connect();
    const saving = session.applyPollingRate(500);
    await until(() => session.snapshot().lastWrite?.readbackRetry);
    interrupt(context); await saving;
    assert.equal(session.snapshot().writeHistory[0].status, 'uncertain');
    assert.equal(session.snapshot().configuration, null);
    assert.equal(attempts(), 1); assert.equal(board.writes.length, 1);
  });
}

test('DPI notification during the second wired GET cannot confirm a matching packet', async (t) => {
  const { session, device, board } = fixture(t);
  interceptReadback(device, board, (n, read) => {
    if (n === 1) throw getFailure();
    input(device, [0x0a, 3, 2, 0, 0, 0, 0]); return read();
  });
  await session.connect(); await session.applyPollingRate(500);
  assert.equal(session.snapshot().lastWrite.status, 'uncertain');
  assert.equal(session.snapshot().configuration, null); assert.equal(board.writes.length, 1);
});

test('wired readback recovery keeps the shared transaction lock through the delay', async (t) => {
  const { session, device, board } = fixture(t);
  const attempts = interceptReadback(device, board, (n, read) => { if (n === 1) throw getFailure(); return read(); });
  await session.connect();
  const saving = session.applyPollingRate(500);
  await until(() => session.snapshot().lastWrite?.readbackRetry);
  await Promise.all([session.readConfiguration(), session.applyPollingRate(125), session.applyDpi(2, 2500)]);
  assert.equal(attempts(), 1); assert.equal(board.writes.length, 1); assert.equal(session.snapshot().queryBusy, true);
  await saving;
  assert.equal(session.snapshot().lastWrite.status, 'verified');
  assert.equal(session.snapshot().configuration.pollingRate, 500);
  assert.equal(attempts(), 2); assert.equal(board.writes.length, 1);
});
