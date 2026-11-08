import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { G3Session } from '../dist/session.js';
import { mockDevice } from './fakes.mjs';

const gold = JSON.parse(readFileSync(new URL('./fixtures/g3-v1-dpi-write-cycle.json', import.meta.url), 'utf8'));
const product = Buffer.from('090d050101000600040000000019', 'hex');
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function fixture(options = {}) {
  const device = mockDevice();
  const hid = new EventTarget();
  hid.requestDevice = async () => [device];
  const session = new G3Session({ hid });
  const board = { packet: Buffer.from(gold.baselineHex, 'hex'), writes: [], reads: 0, command: null };
  device.sendFeatureReport = async (id, payload) => {
    assert.equal(id, 9);
    assert.equal(payload.length, 519);
    board.command = payload[1];
    if (board.command === 4) {
      const wire = Buffer.concat([Buffer.from([id]), Buffer.from(payload)]);
      board.writes.push(wire);
      if (options.onWrite) await options.onWrite({ board, device, hid, session });
      if (!options.ignoreWrite) {
        board.packet = Buffer.from(wire.subarray(0, 408));
        board.packet[2] = 0x44;
        board.packet[1] = (wire[1] + 0x40) & 0xff;
      }
    } else assert.ok(board.command === 5 || board.command === 0x44);
  };
  device.receiveFeatureReport = async () => {
    if (board.command === 5) return view(product);
    assert.equal(board.command, 0x44);
    board.reads += 1;
    options.onConfigRead?.({ board, device, hid, session });
    if (options.failReadback && board.writes.length) throw new DOMException('Readback failed', 'NetworkError');
    return view(board.packet);
  };
  return { board, device, hid, session };
}

function stageReport(device, stage) {
  const data = Uint8Array.from([0x0a, 3, stage, 0, 0, 0, 0]);
  device.dispatchEvent(Object.assign(new Event('inputreport'), { device, reportId: 9, data: view(data) }));
}

function linkReport(device, online) {
  const data = Uint8Array.from([0x0a, 2, online ? 1 : 0, 0, 0, 0, 0]);
  device.dispatchEvent(Object.assign(new Event('inputreport'), { device, reportId: 9, data: view(data) }));
}

test('session writes and restores exactly the two native packets with readback verification', async () => {
  const { board, session } = fixture();
  await session.connect();
  await session.applyDpi(2, 2500);
  assert.equal(board.writes[0].toString('hex'), gold.changed.requestHex);
  assert.equal(session.snapshot().lastWrite.status, 'verified');
  assert.equal(session.snapshot().configuration.selectedDpi.xDpi, 2500);
  assert.equal(session.snapshot().writeHistory[0].beforeDpi, 2400);
  await session.applyDpi(2, 2400);
  assert.equal(board.writes[1].toString('hex'), gold.restored.requestHex);
  assert.equal(session.snapshot().configuration.selectedDpi.xDpi, 2400);
  assert.equal(session.snapshot().lastWrite.status, 'verified');
});

test('save reads a fresh baseline and preserves an unrelated field changed since the UI snapshot', async () => {
  const { board, session } = fixture();
  await session.connect();
  await session.readConfiguration();
  board.packet[82] = 4;
  board.packet[1] = board.packet.subarray(2).reduce((sum, byte) => (sum + byte) & 255, 0);
  await session.applyDpi(2, 2500);
  assert.equal(board.writes[0][82], 4);
  assert.equal(session.snapshot().configuration.unverifiedFields.byte82, 4);
  assert.equal(session.snapshot().lastWrite.status, 'verified');
});

test('readback mismatch keeps a backup and does not retry the write', async () => {
  const { board, session } = fixture({ ignoreWrite: true });
  await session.connect();
  await session.applyDpi(2, 2500);
  assert.equal(board.writes.length, 1);
  assert.equal(session.snapshot().lastWrite.status, 'uncertain');
  assert.equal(session.snapshot().configuration, null);
  assert.ok(session.snapshot().writeHistory[0].beforePacketHex.startsWith('09 7E 44'));
  assert.match(session.snapshot().queryError.message, /不会自动重复写入/);
});

test('readback transport failure is not reported as a successful save', async () => {
  const { board, session } = fixture({ failReadback: true });
  await session.connect();
  await session.applyDpi(2, 2500);
  assert.equal(board.writes.length, 1);
  assert.equal(session.snapshot().lastWrite.status, 'uncertain');
  assert.equal(session.snapshot().queryBusy, false);
});

test('a DPI button event during baseline reading prevents configuration write', async () => {
  const { board, session } = fixture({ onConfigRead: ({ device }) => stageReport(device, 1) });
  await session.connect();
  await session.applyDpi(2, 2500);
  assert.equal(board.writes.length, 0);
  assert.match(session.snapshot().queryError.message, /DPI 按键切换/);
});

test('unplug after a write attempt blocks readback and preserves an uncertain backup', async () => {
  const { board, session } = fixture({ onWrite: ({ hid, device, session }) => {
    assert.equal(session.snapshot().writeHistory.length, 1);
    hid.dispatchEvent(Object.assign(new Event('disconnect'), { device }));
  } });
  await session.connect();
  await session.applyDpi(2, 2500);
  assert.equal(board.writes.length, 1);
  assert.equal(board.reads, 1);
  assert.equal(session.snapshot().phase, 'removed');
  assert.equal(session.snapshot().configuration, null);
  assert.equal(session.snapshot().writeHistory[0].status, 'uncertain');
  assert.equal(session.snapshot().queryBusy, false);
});

test('DPI input events update the live stage without modifying the raw read snapshot', async () => {
  const { device, session } = fixture();
  await session.connect();
  await session.readConfiguration();
  const original = session.snapshot().configuration.packetHex;
  stageReport(device, 1);
  assert.equal(session.snapshot().activeDpiStage, 1);
  stageReport(device, 2);
  assert.equal(session.snapshot().activeDpiStage, 2);
  assert.equal(session.snapshot().configuration.packetHex, original);
});

test('save of an unchanged value performs no write', async () => {
  const { board, session } = fixture();
  await session.connect();
  await session.applyDpi(2, 2400);
  assert.equal(board.writes.length, 0);
  assert.equal(session.snapshot().lastWrite.status, 'unchanged');
});

test('offline then online during baseline read still prevents the write', async () => {
  const { board, session } = fixture({ onConfigRead: ({ device }) => { linkReport(device, false); linkReport(device, true); } });
  await session.connect();
  await session.applyDpi(2, 2500);
  assert.equal(board.writes.length, 0);
  assert.match(session.snapshot().queryError.message, /曾离线/);
});

test('offline, DPI change, online during a write cannot be marked verified', async () => {
  const { board, session } = fixture({ onWrite: ({ device }) => { linkReport(device, false); stageReport(device, 1); linkReport(device, true); } });
  await session.connect();
  await session.applyDpi(2, 2500);
  assert.equal(board.writes.length, 1);
  assert.equal(session.snapshot().lastWrite.status, 'uncertain');
  assert.match(session.snapshot().queryError.message, /DPI 按键切换/);
  assert.equal(session.snapshot().configuration, null);
});

test('a transient offline report after send cannot be hidden by reconnect', async () => {
  const { session } = fixture({ onWrite: ({ device }) => { linkReport(device, false); linkReport(device, true); } });
  await session.connect();
  await session.applyDpi(2, 2500);
  assert.equal(session.snapshot().lastWrite.status, 'uncertain');
  assert.match(session.snapshot().queryError.message, /曾离线/);
});

test('DPI set save changes count/current stage and verifies six slots at both range boundaries', async () => {
  const { board, session } = fixture();
  await session.connect();
  await session.applyDpiSet({ values: [100, 1600, 2400, 3200, 5000, 12000], currentStage: 2 });
  assert.equal(board.writes.length, 1);
  assert.equal(session.snapshot().lastWrite.status, 'verified');
  assert.equal(session.snapshot().configuration.dpiCount, 6);
  assert.equal(session.snapshot().configuration.currentStage, 2);
  assert.equal(session.snapshot().configuration.dpiStages[5].xDpi, 12000);
  assert.deepEqual(session.snapshot().lastWrite.beforeDpiSet, { values: [1600, 2400], currentStage: 2 });
});

test('even a target-stage notification after SET cannot bypass the physical-switch guard', async () => {
  const { session } = fixture({ onWrite: ({ device }) => stageReport(device, 1) });
  await session.connect();
  await session.applyDpiSet({ values: [800, 1600], currentStage: 1 });
  assert.equal(session.snapshot().lastWrite.status, 'uncertain');
  assert.equal(session.snapshot().activeDpiStage, 1);
});

test('matching stage notifications before SET and an unexpected switch after SET cannot be hidden', async () => {
  const before = fixture({ onConfigRead: ({ device }) => stageReport(device, 1) });
  await before.session.connect();
  await before.session.applyDpiSet({ values: [800, 1600], currentStage: 1 });
  assert.equal(before.board.writes.length, 0);
  const after = fixture({ onWrite: ({ device }) => { stageReport(device, 3); stageReport(device, 2); } });
  await after.session.connect();
  await after.session.applyDpiSet({ values: [800, 1600, 2400], currentStage: 2 });
  assert.equal(after.board.writes.length, 1);
  assert.equal(after.session.snapshot().lastWrite.status, 'uncertain');
  assert.equal(after.session.snapshot().configuration, null);
});

test('a no-op DPI set skips SET, while a new selected stage is a real change', async () => {
  const { board, session } = fixture();
  await session.connect();
  await session.applyDpiSet({ values: [1600, 2400], currentStage: 2 });
  assert.equal(board.writes.length, 0);
  await session.applyDpiSet({ values: [1600, 2400], currentStage: 1 });
  assert.equal(board.writes.length, 1);
  assert.equal(session.snapshot().configuration.currentStage, 1);
});

test('DPI set intent is copied before async baseline reads', async () => {
  const { session } = fixture();
  await session.connect();
  const target = { values: [800, 1600, 2400], currentStage: 2 };
  const job = session.applyDpiSet(target);
  target.values[0] = 12000;
  target.currentStage = 3;
  await job;
  assert.deepEqual(session.snapshot().lastWrite.dpiSet, { values: [800, 1600, 2400], currentStage: 2 });
});

test('wake recovery waits for a pending write and never retries that write', async (t) => {
  let releaseWrite;
  const { board, session } = fixture({ onWrite: async ({ device }) => {
    linkReport(device, false); linkReport(device, true);
    await new Promise((resolve) => { releaseWrite = resolve; });
  } });
  t.after(() => session.disconnect());
  await session.connect(); await session.readConfiguration(); session.startAutomatic();
  const saving = session.applyDpi(2, 2500);
  while (!releaseWrite) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(board.reads, 2, 'recovery must not query while SET is unsettled');
  releaseWrite(); await saving;
  const deadline = Date.now() + 3000;
  while (!session.snapshot().configuration && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(board.writes.length, 1);
  assert.equal(board.reads, 3);
  assert.equal(session.snapshot().configuration.selectedDpi.xDpi, 2500);
  assert.equal(session.snapshot().lastWrite.status, 'uncertain');
});

test('polling saves cover all four rates and restore the entire initial configuration', async () => {
  const { board, session } = fixture();
  const initial = board.packet.toString('hex');
  await session.connect();
  for (const rate of [125, 250, 500, 1000]) {
    await session.applyPollingRate(rate);
    const state = session.snapshot();
    assert.equal(state.lastWrite.status, 'verified');
    assert.equal(state.lastWrite.kind, 'polling');
    assert.equal(state.configuration.pollingRate, rate);
    assert.deepEqual(state.configuration.dpiStages.map((stage) => stage.xDpi), [1600, 2400]);
    assert.equal(state.activeDpiStage, 2);
  }
  assert.equal(board.writes.length, 4);
  assert.equal(board.packet.toString('hex'), initial);
  await session.applyPollingRate(1000);
  assert.equal(board.writes.length, 4);
  assert.equal(session.snapshot().lastWrite.status, 'unchanged');
});

test('polling uses fresh DPI, inactive slots and unrelated fields instead of stale UI values', async () => {
  const { board, session } = fixture();
  await session.connect(); await session.readConfiguration();
  board.packet[11] = 0x12;
  board.packet.writeUInt16LE(24, 17); board.packet.writeUInt16LE(24, 37);
  board.packet.writeUInt16LE(89, 25); board.packet[82] = 7;
  board.packet[1] = board.packet.subarray(2).reduce((sum, byte) => (sum + byte) & 255, 0);
  const fresh = Buffer.from(board.packet);
  await session.applyPollingRate(500);
  const expected = Buffer.from(session.snapshot().lastWrite.expectedPacketHex.replaceAll(' ', ''), 'hex');
  assert.deepEqual([...expected.keys()].filter((i) => expected[i] !== fresh[i]), [1, 10]);
  assert.equal(session.snapshot().configuration.currentStage, 1);
  assert.equal(session.snapshot().configuration.dpiStages[1].xDpi, 2500);
});

test('polling readback mismatch and transport failure remain uncertain without a retry', async () => {
  for (const options of [{ ignoreWrite: true }, { failReadback: true }]) {
    const { board, session } = fixture(options);
    await session.connect(); await session.applyPollingRate(500);
    assert.equal(board.writes.length, 1);
    assert.equal(session.snapshot().lastWrite.status, 'uncertain');
    assert.equal(session.snapshot().configuration, null);
    assert.match(session.snapshot().queryError.message, /不会自动重复写入/);
  }
});

test('DPI switching or a brief offline cycle during polling baseline read prevents SET', async () => {
  for (const signal of [(device) => stageReport(device, 1), (device) => { linkReport(device, false); linkReport(device, true); }]) {
    const { board, session } = fixture({ onConfigRead: ({ device }) => signal(device) });
    await session.connect(); await session.applyPollingRate(500);
    assert.equal(board.writes.length, 0);
    assert.ok(session.snapshot().queryError);
  }
});

test('disconnect after polling SET preserves an uncertain backup and blocks readback', async () => {
  const { board, session } = fixture({ onWrite: ({ hid, device }) => hid.dispatchEvent(Object.assign(new Event('disconnect'), { device })) });
  await session.connect(); await session.applyPollingRate(500);
  assert.equal(board.writes.length, 1);
  assert.equal(board.reads, 1);
  assert.equal(session.snapshot().phase, 'removed');
  assert.equal(session.snapshot().writeHistory[0].status, 'uncertain');
});

test('polling shares the write lock with reads and DPI saves while SET is unsettled', async () => {
  let release;
  const { board, session } = fixture({ onWrite: async () => new Promise((resolve) => { release = resolve; }) });
  await session.connect();
  const saving = session.applyPollingRate(500);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(session.snapshot().queryTarget, 'polling');
  await Promise.all([session.readConfiguration(), session.applyDpiSet({ values: [800, 1600], currentStage: 1 }), session.applyPollingRate(125)]);
  assert.equal(board.reads, 1); assert.equal(board.writes.length, 1);
  release(); await saving;
  assert.equal(session.snapshot().configuration.pollingRate, 500);
  assert.equal(session.snapshot().lastWrite.status, 'verified');
});
