import test from 'node:test';
import assert from 'node:assert/strict';
import { MOUSE_BUTTONS, MouseTestState } from '../dist/mouse-test-state.js';

test('five mouse buttons have independent counts and holding does not repeat', () => {
  const state = new MouseTestState();
  for (const { button } of MOUSE_BUTTONS) {
    assert.equal(state.down(button, 100), true);
    assert.equal(state.down(button, 200), false);
  }
  assert.deepEqual(state.snapshot().counts, { left: 1, right: 1, middle: 1, forward: 1, back: 1 });
  assert.equal(state.snapshot().pressed.length, 5);
  for (const { button } of MOUSE_BUTTONS) assert.equal(state.up(button, 300), true);
  assert.deepEqual(state.snapshot().pressed, []);
  assert.equal(state.snapshot().events.length, 10);
});

test('chorded button transitions preserve the remaining held buttons', () => {
  const state = new MouseTestState();
  state.down(0, 100); state.down(2, 110); state.down(3, 120);
  state.up(2, 130); state.reconcile(9, 130);
  assert.deepEqual(state.snapshot().pressed, [0, 3]);
  state.up(3, 140); state.reconcile(1, 140);
  assert.deepEqual(state.snapshot().pressed, [0]);
  assert.equal(state.snapshot().rapidCount, 0);
});

test('rapid hint uses same-button down intervals, including the exact 40 ms boundary', () => {
  const state = new MouseTestState();
  state.down(0, 100); state.up(0, 110);
  state.down(0, 140); state.up(0, 145);
  state.down(0, 181); state.up(0, 185);
  state.down(2, 182); state.up(2, 190);
  assert.equal(state.snapshot().rapidCount, 1);
  const hints = state.snapshot().events.filter((entry) => entry.rapid);
  assert.equal(hints.length, 1); assert.equal(hints[0].intervalMs, 40);
});

test('release without an in-zone press does not count or create a record', () => {
  const state = new MouseTestState();
  assert.equal(state.up(0, 100), false);
  assert.equal(state.reconcile(1, 110), false);
  assert.equal(state.snapshot().counts.left, 0);
  assert.equal(state.snapshot().events.length, 0);
});

test('missing releases clear held state without inventing clicks or rapid hints', () => {
  const state = new MouseTestState();
  state.down(0, 100); state.down(2, 105);
  assert.equal(state.reconcile(2, 110), true);
  assert.deepEqual(state.snapshot().pressed, [2]);
  assert.equal(state.snapshot().events[0].kind, 'cancel');
  state.down(0, 120);
  assert.equal(state.snapshot().counts.left, 2);
  assert.equal(state.snapshot().rapidCount, 0);
});

test('blur/page interruption retains counts, clears holds and starts a new timing sequence', () => {
  const state = new MouseTestState();
  state.down(0, 100); state.down(1, 105);
  assert.equal(state.interrupt(110), true);
  assert.deepEqual(state.snapshot().pressed, []);
  assert.equal(state.snapshot().events[0].kind, 'cancel');
  state.down(0, 120);
  assert.equal(state.snapshot().counts.left, 2);
  assert.equal(state.snapshot().rapidCount, 0);
});

test('wheel counts browser events in the dominant direction, not delta magnitude', () => {
  const state = new MouseTestState();
  assert.equal(state.wheel(0, -120, 100), true);
  state.wheel(0, 0.25, 200); state.wheel(-5, 2, 300); state.wheel(7, 2, 400);
  assert.equal(state.wheel(0, 0, 500), false);
  assert.equal(state.wheel(NaN, 10, 600), false);
  assert.deepEqual(state.snapshot().scroll, { up: 1, down: 1, left: 1, right: 1 });
  assert.equal(state.snapshot().events.length, 4);
});

test('history stays bounded while counters and returned snapshots are independent', () => {
  const state = new MouseTestState();
  for (let i = 0; i < 100; i++) { state.down(0, i * 100); state.up(0, i * 100 + 10); }
  const snapshot = state.snapshot();
  assert.equal(snapshot.counts.left, 100); assert.equal(snapshot.events.length, 60);
  snapshot.counts.left = -1; snapshot.events[0].kind = 'wrong'; snapshot.pressed.push(2);
  assert.equal(state.snapshot().counts.left, 100);
  assert.equal(state.snapshot().events[0].kind, 'up');
  assert.deepEqual(state.snapshot().pressed, []);
});

test('reset clears all statistics and unsupported input cannot contaminate a new test', () => {
  const state = new MouseTestState();
  state.down(0, 100); state.wheel(0, -1, 110); state.reset();
  for (const button of [-1, 5, 9, '0', NaN]) assert.equal(state.down(button, 120), false);
  assert.equal(state.down(0, NaN), false);
  assert.equal(state.reconcile(NaN, 120), false);
  state.down(0, 130);
  assert.equal(state.snapshot().counts.left, 1);
  assert.equal(state.snapshot().rapidCount, 0);
  assert.deepEqual(state.snapshot().scroll, { up: 0, down: 0, left: 0, right: 0 });
  assert.equal(state.snapshot().events.length, 1);
  assert.equal(state.snapshot().events[0].elapsedMs, 0);
});
