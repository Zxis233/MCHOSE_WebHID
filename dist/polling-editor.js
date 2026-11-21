import { POLLING_RATES } from './write-polling.js';

const el = (id) => document.getElementById(id);
const text = (id, value) => { if (el(id).textContent !== value) el(id).textContent = value; };

export class PollingEditor {
  #session;
  #state = null;
  #draft = null;
  #dirty = false;

  constructor(session) {
    this.#session = session;
    el('polling-options').addEventListener('change', (event) => {
      const rate = Number(event.target.value);
      if (!event.target.matches('input[name="polling-rate"]') || !POLLING_RATES.includes(rate)) return;
      this.#draft = rate;
      this.#dirty = rate !== this.#state?.configuration?.pollingRate;
      this.#controls();
    });
    el('apply-polling').addEventListener('click', async () => {
      if (!POLLING_RATES.includes(this.#draft)) return;
      await this.#session.applyPollingRate(this.#draft);
      this.#controls();
    });
  }

  update(state) {
    this.#state = state;
    const rate = state.configuration?.pollingRate;
    // A background refresh or a DPI-only save must not discard a pending rate.
    if (rate && (!this.#dirty || this.#draft === rate)) {
      this.#draft = rate;
      this.#dirty = false;
    }
    this.#controls();
  }

  #controls() {
    const state = this.#state;
    const rate = state?.configuration?.pollingRate;
    const busy = Boolean(state?.queryBusy);
    const readOnly = state?.device?.configurationWritable === false;
    const applying = state?.queryKind === 'write' && state.queryTarget === 'polling';
    const matches = rate === this.#draft;
    const valid = POLLING_RATES.includes(this.#draft);
    el('polling-options').querySelectorAll('input').forEach((input) => {
      input.checked = Number(input.value) === this.#draft;
      input.disabled = busy || readOnly || !rate || state?.phase !== 'connected' || state.link === 'offline';
    });
    el('apply-polling').disabled = busy || readOnly || !valid || matches || !rate || state?.phase !== 'connected' || state.link === 'offline';
    text('apply-polling', applying ? '正在应用…' : '应用回报率');
    text('polling-current', rate ? `当前 ${rate} Hz · ${1000 / rate} ms` : '尚未读取');
    const last = state?.lastWrite;
    const uncertain = last?.kind === 'polling' && last.status === 'uncertain';
    const status = busy ? applying ? '正在应用并核对…' : state.queryKind === 'write' ? '正在应用 DPI…' : '正在读取配置…' : readOnly ? '有线模式目前仅支持读取' : rate ? matches ? '与设备一致' : `待应用：${this.#draft} Hz` : uncertain ? '应用未确认，请重新读取设备。' : state?.link === 'offline' ? '唤醒鼠标后自动恢复' : '读取设备配置后可设置';
    text('polling-status', status);
  }

  snapshot() { return { pollingRate: this.#draft, edited: this.#dirty }; }
}
