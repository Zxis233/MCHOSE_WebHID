import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { G3Session } from '../dist/session.js';
import { mockDevice } from './fakes.mjs';

const gold = JSON.parse(readFileSync(new URL('./fixtures/g3-v1-config-read.json', import.meta.url), 'utf8'));
const product = Buffer.from('090d050101000600040000000019', 'hex');
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const sleep = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message = 'automatic operation did not finish') {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await sleep(5);
  assert.ok(check(), message);
}
function emit(device, subtype, value) {
  device.dispatchEvent(Object.assign(new Event('inputreport'), { device, reportId: 9, data: view(Uint8Array.from([10, subtype, value, 0, 0, 0, 0])) }));
}
function usb(hid, type, device) { hid.dispatchEvent(Object.assign(new Event(type), { device })); }
function fixture(t, options = {}) {
  const hid = new EventTarget();
  const board = { product: Buffer.from(product), config: Buffer.from(gold.responseHex, 'hex'), commands: [], selectors: 0, failures: 0, inFlight: 0, configReads: 0, onReceive: null };
  function device() {
    const d = mockDevice(); d.opens = 0;
    d.open = async () => { d.opens += 1; d.opened = true; };
    d.sendFeatureReport = async (id, payload) => {
      assert.equal(id, 9); assert.equal(payload.length, 519);
      assert.equal(board.inFlight, 0, 'Feature request overlapped an unfinished response');
      d.command = payload[1];
      assert.ok([5, 0x44].includes(d.command), 'automatic recovery must never write configuration');
      board.commands.push({ device: d, command: d.command, at: Date.now() });
    };
    d.receiveFeatureReport = async () => {
      board.inFlight += 1;
      try {
        if (board.failures > 0) { board.failures -= 1; throw new DOMException('Receiver is sleeping', 'NotAllowedError'); }
        const reply = Buffer.from(d.command === 5 ? board.product : board.config);
        if (d.command === 0x44) board.configReads += 1;
        return view(await board.onReceive?.({ device: d, command: d.command, reply }) ?? reply);
      } finally { board.inFlight -= 1; }
    };
    return d;
  }
  const receiver = device();
  hid.granted = [receiver];
  hid.getDevices = async () => hid.granted;
  hid.requestDevice = async () => { board.selectors += 1; return [receiver]; };
  const session = new G3Session({ hid, automaticDelayMs: 1, automaticRetryMs: 2, ...options });
  t.after(() => session.disconnect());
  return { hid, board, receiver, session, device };
}

test('startup reuses one grant and reads only the verified product/configuration commands', async (t) => {
  const { board, receiver, session } = fixture(t);
  session.startAutomatic();
  await until(() => session.snapshot().configuration !== null);
  assert.equal(receiver.opens, 1);
  assert.equal(board.selectors, 0);
  assert.deepEqual(board.commands.map((c) => c.command), [5, 0x44]);
  assert.equal(session.snapshot().configuration.selectedDpi.xDpi, 2400);
});

test('no grant leaves a usable idle session without opening the chooser', async (t) => {
  const { hid, board, session } = fixture(t); hid.granted = [];
  session.startAutomatic();
  await until(() => session.snapshot().events.some((e) => e.type === 'automatic-connect-unavailable'));
  assert.equal(session.snapshot().phase, 'idle');
  assert.equal(board.selectors, 0);
  assert.equal(board.commands.length, 0);
  await session.connect();
  await until(() => session.snapshot().configuration !== null);
  assert.equal(board.selectors, 1);
});

test('ambiguous grants do not select or open either receiver automatically', async (t) => {
  const { hid, board, receiver, device, session } = fixture(t); const other = device(); hid.granted.push(other);
  session.startAutomatic();
  await until(() => session.snapshot().events.some((e) => e.type === 'automatic-connect-unavailable'));
  assert.equal(receiver.opens + other.opens, 0);
  assert.equal(board.selectors, 0);
});

test('an authorized replug opens the new receiver and restores configuration', async (t) => {
  const { hid, receiver, device, board, session } = fixture(t);
  session.startAutomatic(); await until(() => session.snapshot().configuration !== null);
  receiver.opened = false; usb(hid, 'disconnect', receiver);
  const replugged = device(); hid.granted = [replugged]; usb(hid, 'connect', replugged);
  await until(() => replugged.opened && session.snapshot().configuration !== null);
  assert.equal(board.selectors, 0);
  assert.deepEqual(board.commands.map((c) => c.command), [5, 0x44, 5, 0x44]);
  emit(receiver, 3, 1);
  assert.equal(session.snapshot().activeDpiStage, 2);
});

test('a replug with a lost grant falls back without a permission popup', async (t) => {
  const { hid, receiver, board, session } = fixture(t);
  session.startAutomatic(); await until(() => session.snapshot().configuration !== null);
  receiver.opened = false; usb(hid, 'disconnect', receiver); hid.granted = []; usb(hid, 'connect', receiver);
  await until(() => session.snapshot().events.some((e) => e.type === 'automatic-connect-unavailable'));
  assert.equal(session.snapshot().hasOpenDevice, false);
  assert.equal(board.selectors, 0);
});

test('manual disconnect suppresses focus and connect-event recovery until manual reconnect', async (t) => {
  const { hid, receiver, session } = fixture(t);
  session.startAutomatic(); await until(() => session.snapshot().configuration !== null);
  await session.disconnect(); usb(hid, 'connect', receiver); session.resumeAutomatic(); await sleep(25);
  assert.equal(receiver.opened, false);
  assert.equal(receiver.opens, 1);
  assert.equal(session.snapshot().automatic.suspended, true);
  await session.connect(); await until(() => session.snapshot().configuration !== null);
  assert.equal(receiver.opens, 2);
});

test('offline cancels a scheduled query; online restores it exactly once', async (t) => {
  const { receiver, board, session } = fixture(t, { automaticDelayMs: 25 });
  session.startAutomatic(); await until(() => session.snapshot().phase === 'connected');
  emit(receiver, 2, 0); emit(receiver, 5, 90); await sleep(55);
  assert.equal(board.commands.length, 0);
  assert.equal(session.snapshot().battery, null);
  emit(receiver, 2, 1);
  await until(() => session.snapshot().configuration !== null);
  assert.deepEqual(board.commands.map((c) => c.command), [5, 0x44]);
});

test('wake bursts coalesce; ordinary live reports do not poll configuration', async (t) => {
  const { receiver, board, session } = fixture(t);
  session.startAutomatic(); await until(() => session.snapshot().configuration !== null);
  emit(receiver, 2, 0); emit(receiver, 2, 1);
  for (let i = 0; i < 10; i += 1) { emit(receiver, 2, 1); emit(receiver, 5, 90); }
  await until(() => session.snapshot().configuration !== null);
  for (let i = 0; i < 10; i += 1) { emit(receiver, 5, 90); emit(receiver, 3, 2); }
  session.resumeAutomatic(); await sleep(25);
  assert.equal(board.commands.length, 4);
});

test('transient failures stop after three attempts and a new online edge permits recovery', async (t) => {
  const { receiver, board, session } = fixture(t); board.failures = 100;
  session.startAutomatic();
  await until(() => session.snapshot().automatic.attempts === 3 && !session.snapshot().queryBusy);
  for (let i = 0; i < 5; i += 1) { emit(receiver, 5, 90); session.resumeAutomatic(); }
  await sleep(25);
  assert.equal(board.commands.length, 3);
  assert.equal(session.snapshot().queryError.name, 'NotAllowedError');
  board.failures = 0; emit(receiver, 2, 1);
  await until(() => session.snapshot().configuration !== null);
  assert.equal(board.commands.length, 5);
  assert.equal(session.snapshot().queryError, null);
});

test('wrong product blocks automatic reads instead of retrying from battery reports', async (t) => {
  const { receiver, board, session } = fixture(t); board.product[13] = 0x1b;
  session.startAutomatic(); await until(() => session.snapshot().automatic.blocked);
  emit(receiver, 5, 90); emit(receiver, 2, 0); emit(receiver, 2, 1); session.resumeAutomatic(); await sleep(25);
  assert.deepEqual(board.commands.map((c) => c.command), [5]);
  board.product = Buffer.from(product); await session.readConfiguration();
  assert.ok(session.snapshot().configuration);
});

test('a transient offline/online during a read discards the old response and queues one fresh read', async (t) => {
  const { receiver, board, session } = fixture(t);
  session.startAutomatic(); await until(() => session.snapshot().configuration !== null);
  let release;
  board.onReceive = ({ command, reply }) => command === 0x44 && board.configReads === 2 ? new Promise((resolve) => { release = () => resolve(reply); }) : undefined;
  const reading = session.readConfiguration(); await until(() => Boolean(release));
  emit(receiver, 2, 0); emit(receiver, 2, 1);
  board.config.writeUInt16LE(16, 15); board.config.writeUInt16LE(16, 35);
  board.config[1] = board.config.subarray(2).reduce((sum, byte) => (sum + byte) & 255, 0);
  await sleep(15); assert.equal(board.commands.length, 4);
  release(); await reading;
  await until(() => session.snapshot().configuration?.dpiStages[0].xDpi === 1700);
  assert.equal(board.commands.length, 6);
});

test('a DPI notification during a read retains its live stage without changing the raw packet', async (t) => {
  const { receiver, board, session } = fixture(t);
  session.startAutomatic(); await until(() => session.snapshot().configuration !== null);
  board.onReceive = ({ command }) => { if (command === 0x44) emit(receiver, 3, 1); };
  await session.readConfiguration(); await sleep(20);
  assert.equal(session.snapshot().activeDpiStage, 1);
  assert.equal(session.snapshot().configuration.currentStage, 2);
  assert.equal(session.snapshot().configuration.packetHex.replaceAll(' ', '').toLowerCase(), gold.responseHex);
  assert.equal(board.commands.length, 4);
});

test('manual read preempts a scheduled automatic read without duplicating it', async (t) => {
  const { board, session } = fixture(t, { automaticDelayMs: 25 });
  session.startAutomatic(); await until(() => session.snapshot().phase === 'connected');
  await session.readConfiguration(); await sleep(45);
  assert.equal(board.commands.length, 2);
});

test('a late automatic open stays closed after manual disconnect', async (t) => {
  const { receiver, board, session } = fixture(t); let finish;
  receiver.open = () => new Promise((resolve) => { finish = () => { receiver.opened = true; resolve(); }; });
  session.startAutomatic(); await until(() => Boolean(finish));
  await session.disconnect(); finish(); await sleep(25);
  assert.equal(receiver.opened, false);
  assert.equal(session.snapshot().phase, 'idle');
  assert.equal(board.commands.length, 0);
});

test('replug recovery waits for an old response to settle before opening the replacement', async (t) => {
  const { hid, receiver, device, board, session } = fixture(t);
  session.startAutomatic(); await until(() => session.snapshot().configuration !== null);
  let release;
  board.onReceive = ({ command, reply }) => command === 0x44 && board.configReads === 2 ? new Promise((resolve) => { release = () => resolve(reply); }) : undefined;
  const reading = session.readConfiguration(); await until(() => Boolean(release));
  receiver.opened = false; usb(hid, 'disconnect', receiver);
  const replacement = device(); hid.granted = [replacement]; usb(hid, 'connect', replacement);
  await sleep(15); assert.equal(replacement.opens, 0);
  release(); await reading;
  await until(() => replacement.opened && session.snapshot().configuration !== null);
  assert.equal(board.commands.length, 6);
});

test('an old open cannot overlap a reconnect to the same device object', async (t) => {
  const { receiver, session } = fixture(t); let finish; let opens = 0;
  receiver.open = () => { opens += 1; return new Promise((resolve) => { finish = () => { receiver.opened = true; resolve(); }; }); };
  session.startAutomatic(); await until(() => Boolean(finish));
  await session.disconnect();
  await session.connect();
  assert.equal(opens, 1);
  assert.equal(session.snapshot().busy, true);
  finish(); await until(() => !session.snapshot().busy);
  receiver.open = async () => { opens += 1; receiver.opened = true; };
  await session.connect(); await until(() => session.snapshot().configuration !== null);
  assert.equal(opens, 2);
  assert.equal(receiver.opened, true);
});

test('a synchronous report during failure notification cannot shorten retry backoff', async (t) => {
  let injected = false;
  const f = fixture(t, { automaticRetryMs: 80, onChange: (state) => {
    if (!injected && !state.queryBusy && state.automatic.attempts === 1 && state.events.at(-1)?.type === 'query-error') {
      injected = true; emit(f.receiver, 5, 90);
    }
  } });
  f.board.failures = 1; f.session.startAutomatic();
  await until(() => f.session.snapshot().configuration !== null);
  assert.equal(injected, true);
  assert.ok(f.board.commands[1].at - f.board.commands[0].at >= 75);
});
