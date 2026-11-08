import { PRESET_STORAGE_KEY, emptyPresetLibrary, validateDpiSet, dpiSetFromConfiguration, removeDpiStage, readPresetLibrary, updatePresetLibrary, putPreset, deletePreset, validatePresetLibrary } from './presets.js';

const el = (id) => document.getElementById(id);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class DpiEditor {
  #session;
  #state = null;
  #library = emptyPresetLibrary();
  #storageReady = true;
  #selectedId = '';
  #draft = null;
  #dirty = false;
  #nameDirty = false;
  #draftBackups = [];
  #loadedPreset = null;
  #storageBusy = false;
  #configKey = null;
  #message = '读取设备配置，或新建一套预设。';

  constructor(session) {
    this.#session = session;
    try { this.#library = readPresetLibrary(localStorage); }
    catch (error) { this.#storageReady = false; this.#message = `浏览器预设读取失败，原始数据未覆盖：${error.message}`; }
    this.#renderLibrary();
    el('preset-select').addEventListener('change', () => {
      const profile = this.#library.profiles.find((item) => item.id === el('preset-select').value);
      if (profile) this.#load(profile, profile.id, profile.name);
    });
    el('new-preset').addEventListener('click', () => this.#load({ values: [800, 1600], currentStage: 1 }, '', `灵敏度预设 ${this.#library.profiles.length + 1}`));
    el('from-device').addEventListener('click', () => {
      try { this.#load(dpiSetFromConfiguration(this.#state.configuration, this.#state.activeDpiStage ?? this.#state.configuration.currentStage), '', '我的灵敏度'); }
      catch (error) { this.#message = error.message; this.#controls(); }
    });
    el('preset-name').addEventListener('input', () => { this.#nameDirty = true; this.#controls(); });
    el('save-preset').addEventListener('click', () => { void this.#savePreset(false); });
    el('copy-preset').addEventListener('click', () => { void this.#savePreset(true); });
    el('restore-draft').addEventListener('click', () => {
      const previous = this.#draftBackups.pop();
      if (previous) this.#load(previous.draft, this.#library.profiles.some((item) => item.id === previous.id) ? previous.id : '', previous.name, { edited: true, archive: false });
    });
    el('delete-preset').addEventListener('click', async () => {
      try {
        const id = this.#selectedId;
        await this.#commit((latest) => deletePreset(latest, id));
        this.#selectedId = '';
        this.#loadedPreset = null;
        this.#dirty = true;
        this.#message = '预设已删除；当前草稿与鼠标设置保留。';
        this.#renderLibrary();
      } catch (error) { this.#message = `删除未保存：${error.message}`; }
      this.#controls();
    });
    el('add-dpi').addEventListener('click', () => {
      if (!this.#draft || this.#draft.values.length >= 6) return;
      this.#draft.values.push(this.#draft.values.at(-1) || 800);
      this.#dirty = true;
      this.#renderRows();
      this.#controls();
    });
    el('apply-dpi-set').addEventListener('click', async () => {
      let target;
      try { target = validateDpiSet(this.#draft); }
      catch (error) { this.#message = error.message; this.#controls(); return; }
      await this.#session.applyDpiSet(target);
      this.#controls();
    });
    el('export-presets').addEventListener('click', () => this.#download());
    el('import-presets').addEventListener('click', () => el('preset-file').click());
    el('preset-file').addEventListener('change', () => { void this.#import(); });
    window.addEventListener('storage', (event) => {
      if (event.key !== PRESET_STORAGE_KEY && event.key !== null) return;
      try {
        this.#library = readPresetLibrary(localStorage);
        if (this.#selectedId && !this.#library.profiles.some((item) => item.id === this.#selectedId)) { this.#selectedId = ''; this.#dirty = true; }
        this.#renderLibrary();
        this.#message = '另一标签页更新了预设列表；当前编辑草稿已保留。';
      } catch (error) { this.#message = `外部预设更新读取失败：${error.message}`; }
      this.#controls();
    });
    this.#renderRows();
    this.#controls();
  }

  #load(value, id, name, { edited = false, archive = true } = {}) {
    if (archive && this.#draft && (this.#dirty || this.#nameDirty)) {
      this.#draftBackups.push({ draft: structuredClone(this.#draft), id: this.#selectedId, name: el('preset-name').value });
      if (this.#draftBackups.length > 10) this.#draftBackups.shift();
    }
    this.#draft = { values: [...value.values], currentStage: value.currentStage };
    this.#selectedId = id;
    this.#dirty = edited;
    this.#nameDirty = edited;
    this.#loadedPreset = structuredClone(this.#library.profiles.find((item) => item.id === id) ?? null);
    el('preset-name').value = name;
    el('preset-select').value = id;
    this.#message = (id ? `已载入“${name}”；与设备不同的设置可点击“应用到鼠标”生效。` : '草稿可编辑；保存预设或应用到鼠标。') + (this.#draftBackups.length ? ' 未保存的修改可通过“恢复上个草稿”找回。' : '');
    this.#renderRows();
    this.#controls();
  }

  async #commit(change) {
    if (!this.#storageReady) throw new Error('原有预设尚未成功读取，已保留浏览器中的原始数据。');
    this.#storageBusy = true;
    this.#controls();
    try { this.#library = await updatePresetLibrary(localStorage, navigator.locks, change); }
    finally { this.#storageBusy = false; this.#controls(); }
  }

  async #savePreset(copy) {
    try {
      const set = validateDpiSet(this.#draft);
      const id = copy || !this.#selectedId ? crypto.randomUUID() : this.#selectedId;
      const name = el('preset-name').value;
      const loaded = this.#loadedPreset;
      await this.#commit((latest) => {
        if (!copy && loaded && !same(latest.profiles.find((item) => item.id === id), loaded)) throw new Error('此预设已在另一标签页更改，请重新载入或另存为新预设。');
        return putPreset(latest, { id, name, ...set });
      });
      this.#selectedId = id;
      this.#dirty = false;
      this.#nameDirty = false;
      this.#loadedPreset = structuredClone(this.#library.profiles.find((item) => item.id === id));
      this.#message = '预设已保存到当前浏览器。鼠标设置由“应用到鼠标”单独生效。';
      this.#renderLibrary();
    } catch (error) { this.#message = `预设未保存：${error.message}`; }
    this.#controls();
  }

  #renderLibrary() {
    const draftOption = document.createElement('option');
    draftOption.value = '';
    draftOption.textContent = '未保存草稿';
    draftOption.disabled = true;
    el('preset-select').replaceChildren(draftOption, ...this.#library.profiles.map((profile) => {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = profile.name;
      return option;
    }));
    el('preset-select').value = this.#selectedId;
  }

  #renderRows() {
    el('draft-stages').replaceChildren();
    if (!this.#draft) return;
    this.#draft.values.forEach((dpi, index) => {
      const row = document.createElement('div');
      row.className = 'draft-row';
      const label = document.createElement('label');
      label.className = 'stage-choice';
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'current-draft-stage'; radio.value = String(index + 1);
      radio.checked = this.#draft.currentStage === index + 1;
      radio.setAttribute('aria-label', `应用后使用第 ${index + 1} 档`);
      radio.addEventListener('change', () => { this.#draft.currentStage = index + 1; this.#dirty = true; this.#controls(); });
      label.append(radio, document.createTextNode(`第 ${index + 1} 档`));
      const input = document.createElement('input');
      input.type = 'number'; input.min = '100'; input.max = '12000'; input.step = '100'; input.inputMode = 'numeric';
      input.value = Number.isFinite(dpi) ? String(dpi) : '';
      input.setAttribute('aria-label', `第 ${index + 1} 档 DPI`);
      input.addEventListener('input', () => { this.#draft.values[index] = input.value === '' ? NaN : Number(input.value); this.#dirty = true; this.#controls(); });
      const unit = document.createElement('span'); unit.className = 'muted'; unit.textContent = 'DPI';
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button stage-remove'; remove.textContent = '删除';
      remove.setAttribute('aria-label', `删除第 ${index + 1} 档`);
      remove.addEventListener('click', () => {
        try { this.#draft = removeDpiStage(this.#draft, index + 1); this.#dirty = true; this.#renderRows(); }
        catch (error) { this.#message = error.message; }
        this.#controls();
      });
      row.append(label, input, unit, remove);
      el('draft-stages').append(row);
    });
  }

  #controls() {
    const busy = Boolean(this.#state?.queryBusy || this.#storageBusy);
    let valid = false;
    try { validateDpiSet(this.#draft); valid = true; } catch { /* Keep the draft editable. */ }
    const board = this.#state?.configuration;
    let matches = false;
    try { matches = same(validateDpiSet(this.#draft), dpiSetFromConfiguration(board, this.#state.activeDpiStage ?? board.currentStage)); } catch { /* Board absent or asymmetric. */ }
    el('from-device').disabled = busy || !board;
    el('new-preset').disabled = busy;
    el('restore-draft').hidden = this.#draftBackups.length === 0;
    el('restore-draft').disabled = busy;
    el('preset-select').disabled = busy || this.#library.profiles.length === 0;
    el('preset-name').disabled = busy || !this.#draft;
    el('save-preset').disabled = busy || !valid || !this.#storageReady;
    el('copy-preset').disabled = busy || !valid || !this.#selectedId || !this.#storageReady;
    el('delete-preset').disabled = busy || !this.#selectedId || !this.#storageReady;
    el('import-presets').disabled = busy || !this.#storageReady;
    el('export-presets').disabled = this.#library.profiles.length === 0;
    el('add-dpi').disabled = busy || !this.#draft || this.#draft.values.length >= 6;
    el('apply-dpi-set').disabled = busy || !valid || matches || !board || this.#state?.phase !== 'connected' || this.#state.link === 'offline';
    el('apply-dpi-set').textContent = this.#state?.queryKind === 'write' ? '正在应用…' : '应用到鼠标';
    el('draft-state').textContent = matches ? '与设备一致' : this.#draft ? '待应用草稿' : '等待载入';
    el('draft-count').textContent = `${this.#draft?.values.length ?? 0} / 6 档`;
    el('preset-status').textContent = this.#storageReady ? this.#message : '浏览器预设未能读取，原始数据未覆盖。档位草稿仍可使用；请保留本站数据后再排查预设存储。';
    const last = this.#state?.lastWrite;
    el('save-status').textContent = last?.status === 'uncertain' ? '上次应用尚未读回确认，请先重新读取设备。' : matches && last?.status === 'verified' && same(this.#draft, last.dpiSet) ? '这套 DPI 设置与设备一致，完整配置读回已核对。' : matches ? '当前草稿与设备一致。' : this.#draft && !valid ? '请保留 2–6 档；各档范围 100–12000、步进 100，并选择一个当前档位。' : '圆点选择应用后的当前档位；增删、编辑完成后统一应用。';
    el('draft-stages').querySelectorAll('input').forEach((input) => { input.disabled = busy; });
    el('draft-stages').querySelectorAll('button').forEach((button) => { button.disabled = busy || this.#draft.values.length === 2; });
  }

  update(state) {
    this.#state = state;
    const config = state.configuration;
    const key = config ? `${config.receivedAt}:${config.packetHex}` : null;
    if (key && key !== this.#configKey && (!this.#draft || (!this.#dirty && !this.#nameDirty && !this.#selectedId))) {
      try { this.#load(dpiSetFromConfiguration(config, state.activeDpiStage ?? config.currentStage), '', '我的灵敏度'); }
      catch (error) { this.#message = error.message; }
    }
    this.#configKey = key;
    this.#controls();
  }

  #download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(this.#library, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'g3-dpi-presets.json';
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async #import() {
    const file = el('preset-file').files[0];
    el('preset-file').value = '';
    if (!file) return;
    try {
      if (file.size > 100000) throw new Error('预设文件过大。');
      const imported = validatePresetLibrary(JSON.parse(await file.text()));
      let added = 0;
      await this.#commit((latest) => {
        let next = latest;
        for (const profile of imported.profiles) {
          const existing = next.profiles.find((item) => item.id === profile.id);
          if (existing && same(existing, profile)) continue;
          next = putPreset(next, { ...profile, id: existing ? crypto.randomUUID() : profile.id });
          added += 1;
        }
        return next;
      });
      this.#renderLibrary();
      this.#message = `已导入 ${added} 套预设，原有预设保留。选择预设后可载入和应用。`;
    } catch (error) { this.#message = `导入未保存：${error.message}`; }
    this.#controls();
  }

  snapshot() { return structuredClone({ selectedPresetId: this.#selectedId, draft: this.#draft, draftEdited: this.#dirty, nameEdited: this.#nameDirty, recoverableDrafts: this.#draftBackups.length, library: this.#library, storageReady: this.#storageReady }); }
}
