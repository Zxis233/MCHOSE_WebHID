import { MOUSE_BUTTONS, MouseTestState } from './mouse-test-state.js';

const el = (id) => document.getElementById(id);
const text = (id, value) => { const node = el(id); if (node.textContent !== String(value)) node.textContent = String(value); };
const directions = { up: '向上', down: '向下', left: '向左', right: '向右' };

export class MouseTester {
  #model = new MouseTestState();
  #active = false;
  #zone = el('mouse-test-zone');
  #owned = new Set();
  #wheelTimer = null;
  #logKey = null;
  #scrollDirection = '';

  constructor() {
    // Mouse buttons can change during pointermove when another button is held.
    // Handle those transitions too; touch and pen do not enter the mouse test.
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
      this.#zone.addEventListener(type, (event) => this.#input(event));
    }
    for (const type of ['pointermove', 'pointerup']) {
      document.addEventListener(type, (event) => this.#releaseOutside(event), true);
    }
    this.#zone.addEventListener('pointercancel', (event) => {
      if (this.#active && event.pointerType === 'mouse') this.#interrupt();
    });
    document.addEventListener('mousedown', (event) => {
      if (!this.#zone.contains(event.target)) this.#owned.delete(event.button);
    }, true);
    // Stop browser navigation/autoscroll for gestures that began in the zone,
    // including when their release happens outside it.
    for (const type of ['mouseup', 'auxclick', 'contextmenu']) {
      document.addEventListener(type, (event) => {
        if (this.#active && (this.#zone.contains(event.target) || this.#owned.has(event.button))) event.preventDefault();
        if (type === 'auxclick') this.#owned.delete(event.button);
      }, true);
    }
    this.#zone.addEventListener('mousedown', (event) => {
      if (this.#active) event.preventDefault();
    });
    this.#zone.addEventListener('dragstart', (event) => event.preventDefault());
    this.#zone.addEventListener('wheel', (event) => {
      if (!this.#active || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      if (!this.#model.wheel(event.deltaX, event.deltaY, event.timeStamp)) return;
      this.#scrollDirection = this.#model.snapshot().events[0].direction;
      clearTimeout(this.#wheelTimer);
      this.#wheelTimer = setTimeout(() => { this.#scrollDirection = ''; this.#render(); }, 160);
      this.#render();
    }, { passive: false });
    window.addEventListener('blur', () => this.#interrupt());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.#interrupt(); });
    el('reset-mouse-test').addEventListener('click', () => this.reset());
    this.#render();
  }

  #input(event) {
    if (!this.#active || event.pointerType !== 'mouse') return;
    const info = MOUSE_BUTTONS.find((item) => item.button === event.button);
    let changed = false;
    if (info) {
      if (event.buttons & info.mask) {
        if (event.type !== 'pointerup') {
          changed = this.#model.down(event.button, event.timeStamp);
          if (changed) {
            this.#owned.add(event.button);
            this.#zone.focus({ preventScroll: true });
          }
        }
      } else changed = this.#model.up(event.button, event.timeStamp);
    }
    changed = this.#model.reconcile(event.buttons, event.timeStamp) || changed;
    if (changed) this.#render();
  }

  #releaseOutside(event) {
    if (!this.#active || event.pointerType !== 'mouse') return;
    const info = MOUSE_BUTTONS.find((item) => item.button === event.button);
    let changed = false;
    if (info && !(event.buttons & info.mask)) changed = this.#model.up(event.button, event.timeStamp);
    changed = this.#model.reconcile(event.buttons, event.timeStamp) || changed;
    if (changed) this.#render();
  }

  #interrupt() {
    this.#model.interrupt(performance.now());
    this.#owned.clear();
    clearTimeout(this.#wheelTimer);
    this.#scrollDirection = '';
    this.#render();
  }

  setActive(active) {
    if (this.#active === active) return;
    this.#active = active;
    this.#interrupt();
  }

  reset() {
    this.#model.reset();
    this.#owned.clear();
    clearTimeout(this.#wheelTimer);
    this.#scrollDirection = '';
    this.#render();
    text('mouse-test-live', '测试记录已重置');
  }

  #render() {
    const state = this.#model.snapshot();
    for (const { button, key } of MOUSE_BUTTONS) {
      text('test-count-' + key, state.counts[key]);
      const held = state.pressed.includes(button);
      el('test-stat-' + key).classList.toggle('pressed', held);
      const part = this.#zone.querySelector(`[data-mouse-button="${button}"]`);
      part.classList.toggle('pressed', held);
      part.classList.toggle('tested', state.counts[key] > 0);
    }
    text('test-count-rapid', state.rapidCount);
    for (const direction of Object.keys(directions)) text('test-scroll-' + direction, state.scroll[direction]);
    this.#zone.dataset.scroll = this.#scrollDirection;
    const latest = state.events[0];
    const meaning = (event) => event.kind === 'wheel' ? '滚轮' + directions[event.direction] : event.label + ' · ' + (event.kind === 'down' ? '按下' : event.kind === 'up' ? '松开' : event.reason);
    const heldLabels = MOUSE_BUTTONS.filter(({ button }) => state.pressed.includes(button)).map(({ label }) => label);
    text('mouse-test-live', heldLabels.length ? heldLabels.join(' + ') + ' 按下中' : latest ? meaning(latest) : '在此区域内点击或滚动');
    const key = latest?.id ?? 0;
    if (key === this.#logKey) return;
    this.#logKey = key;
    el('mouse-test-empty').hidden = state.events.length > 0;
    el('mouse-test-events').replaceChildren(...state.events.map((event) => {
      const row = document.createElement('li');
      if (event.rapid) row.className = 'rapid-event';
      const stamp = document.createElement('time');
      stamp.textContent = (event.elapsedMs / 1000).toFixed(3) + ' s';
      const value = document.createElement('span');
      value.textContent = meaning(event);
      row.append(stamp, value);
      if (event.kind === 'down' && event.intervalMs !== null) {
        const interval = document.createElement('small');
        interval.textContent = (event.rapid ? '短间隔 · ' : '间隔 ') + event.intervalMs.toFixed(1) + ' ms';
        row.append(interval);
      }
      return row;
    }));
  }

  snapshot() { return { active: this.#active, ...this.#model.snapshot() }; }
}
