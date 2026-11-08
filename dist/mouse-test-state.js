export const MOUSE_BUTTONS = Object.freeze([
  Object.freeze({ button: 0, key: 'left', label: '左键', mask: 1 }),
  Object.freeze({ button: 2, key: 'right', label: '右键', mask: 2 }),
  Object.freeze({ button: 1, key: 'middle', label: '中键', mask: 4 }),
  Object.freeze({ button: 4, key: 'forward', label: '前进', mask: 16 }),
  Object.freeze({ button: 3, key: 'back', label: '后退', mask: 8 }),
]);
export const RAPID_CLICK_MS = 40;

export class MouseTestState {
  #counts;
  #scroll;
  #pressed;
  #lastDown;
  #rapid;
  #events;
  #startedAt;
  #sequence;

  constructor() { this.reset(); }

  reset() {
    this.#counts = Object.fromEntries(MOUSE_BUTTONS.map(({ key }) => [key, 0]));
    this.#scroll = { up: 0, down: 0, left: 0, right: 0 };
    this.#pressed = new Set();
    this.#lastDown = new Map();
    this.#rapid = 0;
    this.#events = [];
    this.#startedAt = null;
    this.#sequence = 0;
  }

  #record(kind, at, details) {
    this.#startedAt ??= at;
    this.#events.unshift({ id: ++this.#sequence, kind, elapsedMs: Math.max(0, at - this.#startedAt), ...details });
    if (this.#events.length > 60) this.#events.length = 60;
  }

  down(button, at) {
    const info = MOUSE_BUTTONS.find((item) => item.button === button);
    if (!info || !Number.isFinite(at) || this.#pressed.has(button)) return false;
    const previous = this.#lastDown.get(button);
    const intervalMs = previous === undefined ? null : at - previous;
    const rapid = intervalMs !== null && intervalMs >= 0 && intervalMs <= RAPID_CLICK_MS;
    if (rapid) this.#rapid += 1;
    this.#counts[info.key] += 1;
    this.#pressed.add(button);
    this.#lastDown.set(button, at);
    this.#record('down', at, { button, label: info.label, intervalMs, rapid });
    return true;
  }

  up(button, at) {
    if (!Number.isFinite(at) || !this.#pressed.delete(button)) return false;
    const info = MOUSE_BUTTONS.find((item) => item.button === button);
    this.#record('up', at, { button, label: info.label });
    return true;
  }

  reconcile(buttons, at) {
    if (!Number.isInteger(buttons) || buttons < 0 || !Number.isFinite(at)) return false;
    let changed = false;
    for (const info of MOUSE_BUTTONS) {
      if (this.#pressed.has(info.button) && !(buttons & info.mask)) {
        this.#pressed.delete(info.button);
        this.#lastDown.delete(info.button);
        this.#record('cancel', at, { button: info.button, label: info.label, reason: '按下状态已结束' });
        changed = true;
      }
    }
    return changed;
  }

  interrupt(at) {
    for (const button of this.#pressed) {
      const info = MOUSE_BUTTONS.find((item) => item.button === button);
      this.#record('cancel', at, { button, label: info.label, reason: '测试已中断' });
    }
    const changed = this.#pressed.size > 0;
    this.#pressed.clear();
    this.#lastDown.clear();
    return changed;
  }

  wheel(deltaX, deltaY, at) {
    if (![deltaX, deltaY, at].every(Number.isFinite) || (!deltaX && !deltaY)) return false;
    const direction = Math.abs(deltaY) >= Math.abs(deltaX) ? deltaY < 0 ? 'up' : 'down' : deltaX < 0 ? 'left' : 'right';
    this.#scroll[direction] += 1;
    this.#record('wheel', at, { direction });
    return true;
  }

  snapshot() {
    return { counts: { ...this.#counts }, scroll: { ...this.#scroll }, pressed: [...this.#pressed], rapidCount: this.#rapid, thresholdMs: RAPID_CLICK_MS, events: structuredClone(this.#events) };
  }
}
