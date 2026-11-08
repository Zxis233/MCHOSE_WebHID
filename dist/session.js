import { G3_PROFILE, batteryView, describeDevice, inspectCapabilities, parseInputReport, toHex } from './protocol.js';
import { queryProductIdentity } from './identity.js';
import { queryConfiguration } from './config.js';
import { buildDpiWrite, sendDpiWrite, buildDpiSetWrite, sendDpiSetWrite } from './write-dpi.js';
import { buildPollingRateWrite, sendPollingRateWrite } from './write-polling.js';

export class G3Session {
  #hid;
  #now;
  #onChange;
  #device = null;
  #openingDevice = null;
  #openingJob = null;
  #generation = 0;
  #busy = false;
  #phase = 'idle';
  #metadata = null;
  #battery = null;
  #link = 'unknown';
  #error = null;
  #startedAt = null;
  #lastReportAt = null;
  #reportCount = 0;
  #events = [];
  #identity = null;
  #configuration = null;
  #queryJob = null;
  #queryError = null;
  #querySlow = false;
  #warningAfterMs;
  #activeDpiStage = null;
  #stageRevision = 0;
  #offlineRevision = 0;
  #lastWrite = null;
  #writeHistory = [];
  #automatic = false;
  #automaticSuspended = false;
  #automaticTimer = null;
  #pendingConnect = false;
  #pendingRead = false;
  #automaticAttempts = 0;
  #automaticBlocked = false;
  #automaticReason = null;
  #automaticNotBefore = 0;
  #automaticDelayMs;
  #automaticRetryMs;

  constructor({ hid, onChange = () => {}, now = () => Date.now(), warningAfterMs = 5000, automaticDelayMs = 250, automaticRetryMs = 1000 }) {
    this.#hid = hid;
    this.#now = now;
    this.#onChange = onChange;
    this.#warningAfterMs = warningAfterMs;
    this.#automaticDelayMs = automaticDelayMs;
    this.#automaticRetryMs = automaticRetryMs;
    this.#hid?.addEventListener('disconnect', this.#onDisconnect);
    this.#hid?.addEventListener('connect', this.#onConnect);
  }

  #record(type, details = {}) {
    this.#events.push({ time: new Date(this.#now()).toISOString(), type, ...details });
    if (this.#events.length > 300) this.#events.splice(0, this.#events.length - 300);
  }

  #notify() { this.#onChange(this.snapshot()); }

  #resetReadings() {
    this.#battery = null;
    this.#link = 'unknown';
    this.#lastReportAt = null;
    this.#reportCount = 0;
    this.#identity = null;
    this.#configuration = null;
    this.#queryError = null;
    this.#querySlow = false;
    this.#activeDpiStage = null;
    this.#lastWrite = null;
  }

  snapshot() {
    return {
      phase: this.#phase,
      busy: this.#busy || Boolean(this.#openingJob),
      hasOpenDevice: Boolean(this.#device),
      device: this.#metadata ? structuredClone(this.#metadata) : null,
      modelIdentification: this.#identity?.matchesG3 ? 'official G3 product code verified; V1 supplied by user' : 'G3 V1 profile supplied by user; product not verified',
      identity: this.#identity ? structuredClone(this.#identity) : null,
      configuration: this.#configuration ? structuredClone(this.#configuration) : null,
      queryBusy: Boolean(this.#queryJob),
      queryKind: this.#queryJob?.kind ?? null,
      queryTarget: this.#queryJob?.target ?? null,
      querySlow: this.#querySlow,
      activeDpiStage: this.#activeDpiStage,
      dpiStageRevision: this.#stageRevision,
      lastWrite: this.#lastWrite ? structuredClone(this.#lastWrite) : null,
      writeHistory: structuredClone(this.#writeHistory),
      queryError: this.#queryError ? { ...this.#queryError } : null,
      startedAt: this.#startedAt,
      lastReportAt: this.#lastReportAt,
      reportCount: this.#reportCount,
      battery: this.#battery ? { ...this.#battery } : null,
      batteryView: batteryView(this.#battery, this.#phase, this.#link, this.#now()),
      link: this.#link,
      error: this.#error ? { ...this.#error } : null,
      events: structuredClone(this.#events),
      automatic: { enabled: this.#automatic, suspended: this.#automaticSuspended, pendingConnect: this.#pendingConnect, pendingRead: this.#pendingRead, scheduled: this.#automaticTimer !== null, attempts: this.#automaticAttempts, blocked: this.#automaticBlocked, reason: this.#automaticReason },
    };
  }

  #cancelAutomaticTimer() {
    clearTimeout(this.#automaticTimer);
    this.#automaticTimer = null;
  }

  startAutomatic() {
    if (!this.#hid || this.#automatic) return;
    this.#automatic = true;
    this.#record('automatic-started');
    this.resumeAutomatic();
  }

  resumeAutomatic() {
    if (!this.#automatic || this.#automaticSuspended) return;
    if (!this.#device) this.#pendingConnect = true;
    else if (!this.#configuration && this.#link !== 'offline') this.#pendingRead = true;
    this.#kickAutomatic();
  }

  #requestAutomaticRead(reason, reset = false) {
    if (!this.#automatic || this.#automaticSuspended) return;
    if (reset) { this.#automaticAttempts = 0; this.#automaticNotBefore = 0; this.#cancelAutomaticTimer(); }
    this.#automaticReason = reason;
    this.#pendingRead = true;
    this.#kickAutomatic();
  }

  #kickAutomatic(delay = this.#automaticDelayMs) {
    if (!this.#automatic || this.#automaticSuspended || this.#automaticTimer !== null || this.#busy || this.#openingJob || this.#queryJob) return;
    const action = !this.#device && this.#pendingConnect ? 'connect' : this.#device && this.#phase === 'connected' && this.#link !== 'offline' && this.#pendingRead && !this.#automaticBlocked && this.#automaticAttempts < 3 ? 'read' : null;
    if (!action) return;
    const generation = this.#generation;
    this.#automaticTimer = setTimeout(() => {
      this.#automaticTimer = null;
      if (generation !== this.#generation || this.#automaticSuspended || this.#busy || this.#openingJob || this.#queryJob) { this.#kickAutomatic(); return; }
      if (action === 'connect') {
        this.#pendingConnect = false;
        void this.connect({ interactive: false });
      } else if (this.#device && this.#phase === 'connected' && this.#link !== 'offline' && this.#pendingRead && !this.#automaticBlocked && this.#automaticAttempts < 3) {
        this.#pendingRead = false;
        this.#automaticAttempts += 1;
        void this.readConfiguration({ automatic: true });
      }
    }, action === 'read' ? Math.max(delay, this.#automaticNotBefore - Date.now()) : delay);
  }

  async connect({ interactive = true } = {}) {
    if (!this.#hid || this.#busy || this.#openingJob || this.#device || this.#queryJob) return;
    if (!interactive && this.#automaticSuspended) return;
    if (interactive) this.#automaticSuspended = false;
    this.#cancelAutomaticTimer();
    this.#pendingConnect = false;
    this.#pendingRead = false;
    const generation = ++this.#generation;
    this.#busy = true;
    this.#phase = interactive ? 'choosing' : 'searching';
    this.#error = null;
    this.#metadata = null;
    this.#startedAt = null;
    this.#resetReadings();
    this.#notify();
    let candidate;
    let openingJob = null;
    try {
      // getDevices exposes only previously granted devices. A new grant still
      // starts from the Connect button's user gesture via requestDevice.
      const granted = this.#hid.getDevices ? await this.#hid.getDevices() : [];
      if (generation !== this.#generation) return;
      const grantedMatches = granted.filter((device) => inspectCapabilities(device).passiveInputCompatible);
      if (!interactive && grantedMatches.length !== 1) {
        this.#phase = 'idle';
        this.#record('automatic-connect-unavailable', { reason: grantedMatches.length ? 'ambiguous' : 'no-grant' });
        return;
      }
      const selected = grantedMatches.length === 1 ? grantedMatches : await this.#hid.requestDevice({ filters: [{
        vendorId: G3_PROFILE.vendorId,
        productId: G3_PROFILE.productId,
        usagePage: G3_PROFILE.usagePage,
        usage: G3_PROFILE.usage,
      }] });
      if (generation !== this.#generation) return;
      if (selected.length === 0) {
        this.#phase = 'idle';
        this.#record('selection-cancelled');
        return;
      }
      // One physical selection may expose several HID interfaces in WebHID.
      const compatible = selected.filter((device) => inspectCapabilities(device).passiveInputCompatible);
      if (compatible.length > 1) throw new Error('找到多个匹配接口，请只连接一只目标接收器后重试。');
      candidate = compatible[0] ?? selected[0];
      this.#metadata = describeDevice(candidate);
      this.#record(grantedMatches.length === 1 ? 'reused-grant' : 'selected-device');
      this.#record('descriptor', { device: this.#metadata });
      if (!inspectCapabilities(candidate).passiveInputCompatible) {
        throw new Error('厂商集合或输入报告长度与 G3 V1 档案不匹配，已停止打开设备。');
      }
      this.#phase = 'opening';
      this.#openingDevice = candidate;
      openingJob = { device: candidate, generation };
      this.#openingJob = openingJob;
      this.#notify();
      await candidate.open();
      if (generation !== this.#generation) {
        if (candidate.opened) await candidate.close();
        return;
      }
      this.#device = candidate;
      candidate.addEventListener('inputreport', this.#onInput);
      this.#startedAt = this.#now();
      this.#phase = 'connected';
      this.#automaticAttempts = 0;
      this.#automaticNotBefore = 0;
      this.#automaticBlocked = false;
      this.#pendingConnect = false;
      this.#record('opened');
      this.#requestAutomaticRead('connected');
    } catch (error) {
      if (candidate?.opened && candidate !== this.#device) {
        try { await candidate.close(); } catch { /* Preserve the original open error. */ }
      }
      if (generation !== this.#generation) return;
      if (error.name === 'NotFoundError') {
        this.#phase = 'idle';
        this.#record('selection-cancelled');
      } else {
        this.#phase = 'error';
        this.#error = { name: error.name, message: error.message };
        this.#record('error', this.#error);
      }
    } finally {
      if (openingJob && this.#openingJob === openingJob) this.#openingJob = null;
      if (generation === this.#generation) {
        this.#openingDevice = null;
        this.#busy = false;
        this.#notify();
      } else if (openingJob) {
        this.#notify();
      }
      this.#kickAutomatic();
    }
  }

  async disconnect() {
    this.#automaticSuspended = true;
    this.#cancelAutomaticTimer();
    this.#pendingConnect = false;
    this.#pendingRead = false;
    const generation = ++this.#generation;
    const device = this.#device;
    this.#device = null;
    this.#openingDevice = null;
    this.#busy = true;
    this.#phase = 'closing';
    this.#error = null;
    this.#resetReadings();
    device?.removeEventListener('inputreport', this.#onInput);
    this.#notify();
    try {
      if (device?.opened) await device.close();
      if (generation !== this.#generation) return;
      this.#phase = 'idle';
      this.#record('closed');
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#device = device?.opened ? device : null;
      this.#phase = 'error';
      this.#error = { name: error.name, message: error.message };
      this.#record('close-error', this.#error);
    } finally {
      if (generation === this.#generation) {
        this.#busy = false;
        this.#notify();
      }
    }
  }

  async readConfiguration({ automatic = false } = {}) {
    if (this.#queryJob) return;
    if (this.#phase !== 'connected' || !this.#device || this.#link === 'offline') {
      this.#queryError = { name: 'DeviceUnavailable', message: '请连接接收器并轻动鼠标，等待鼠标上线后再读取。' };
      this.#notify();
      return;
    }
    const device = this.#device;
    const generation = this.#generation;
    const offlineRevision = this.#offlineRevision;
    const stageRevision = this.#stageRevision;
    const job = { device, generation, kind: 'read', automatic };
    const current = () => generation === this.#generation && device === this.#device && this.#phase === 'connected';
    const checkLink = () => {
      if (this.#link === 'offline' || offlineRevision !== this.#offlineRevision) throw Object.assign(new Error('读取期间鼠标离线，等待唤醒后重新读取。'), { name: 'ReadInterrupted' });
    };
    this.#cancelAutomaticTimer();
    this.#pendingRead = false;
    if (!automatic) { this.#automaticAttempts = 0; this.#automaticNotBefore = 0; this.#automaticBlocked = false; }
    let retryDelay = this.#automaticDelayMs;
    this.#queryJob = job;
    this.#queryError = null;
    this.#querySlow = false;
    this.#identity = null;
    this.#configuration = null;
    this.#record('configuration-read-started', { automatic, reason: automatic ? this.#automaticReason : 'manual' });
    this.#notify();
    const timer = setTimeout(() => {
      if (current() && this.#queryJob === job) {
        // This is a warning, not a cancellation: keep the transport locked
        // until the underlying browser request actually settles.
        this.#querySlow = true;
        this.#notify();
      }
    }, this.#warningAfterMs);
    const transfer = (details) => { if (current()) this.#record('feature', details); };
    try {
      const identity = await queryProductIdentity(device, transfer);
      if (!current()) return;
      checkLink();
      this.#identity = { ...identity, receivedAt: this.#now() };
      if (!identity.matchesG3) throw new Error('产品标识不匹配 G3，已停止读取配置。');
      this.#notify();
      const configuration = await queryConfiguration(device, identity, transfer);
      if (!current()) return;
      checkLink();
      const liveStage = stageRevision === this.#stageRevision ? configuration.currentStage : this.#activeDpiStage;
      if (!Number.isInteger(liveStage) || liveStage < 1 || liveStage > configuration.dpiCount) throw Object.assign(new Error('档位通知与配置不一致，请重新读取。'), { name: 'ReadInterrupted' });
      this.#configuration = { ...configuration, receivedAt: this.#now() };
      this.#activeDpiStage = liveStage;
      this.#pendingRead = false;
      this.#automaticAttempts = 0;
      this.#automaticNotBefore = 0;
      this.#automaticBlocked = false;
      this.#record('configuration-read', { dpiCount: configuration.dpiCount, currentStage: configuration.currentStage, pollingRate: configuration.pollingRate, checksumValid: configuration.checksumValid });
    } catch (error) {
      if (current()) {
        const transient = ['NetworkError', 'NotAllowedError', 'InvalidStateError', 'AbortError', 'ReadInterrupted'].includes(error.name);
        const retry = this.#automatic && !this.#automaticSuspended && transient && this.#link !== 'offline' && this.#automaticAttempts < 3;
        if (!transient) this.#automaticBlocked = true;
        if (retry) {
          this.#pendingRead = true;
          retryDelay = this.#automaticRetryMs * Math.max(1, this.#automaticAttempts);
          this.#automaticNotBefore = Date.now() + retryDelay;
        }
        if (!automatic || !retry) this.#queryError = { name: error.name, message: error.message };
        this.#record('query-error', { name: error.name, message: error.message, automatic, retry });
      }
    } finally {
      clearTimeout(timer);
      if (this.#queryJob === job) {
        this.#queryJob = null;
        this.#querySlow = false;
        this.#notify();
        this.#kickAutomatic(retryDelay);
      }
    }
  }

  async applyDpi(stage, dpi) {
    return this.#applyConfigurationChange({ kind: 'single', stage, dpi });
  }

  async applyDpiSet(dpiSet) {
    return this.#applyConfigurationChange({ kind: 'set', dpiSet: structuredClone(dpiSet) });
  }

  async applyPollingRate(pollingRate) {
    return this.#applyConfigurationChange({ kind: 'polling', pollingRate });
  }

  async #applyConfigurationChange(request) {
    if (this.#queryJob) return;
    if (this.#phase !== 'connected' || !this.#device || this.#link === 'offline') {
      this.#queryError = { name: 'DeviceUnavailable', message: '请连接并唤醒鼠标后保存。' };
      this.#notify();
      return;
    }
    const device = this.#device;
    const generation = this.#generation;
    const revision = this.#stageRevision;
    const offlineRevision = this.#offlineRevision;
    const isSet = request.kind === 'set';
    const isPolling = request.kind === 'polling';
    const { stage, dpi, dpiSet, pollingRate } = request;
    const intent = isPolling ? { pollingRate } : isSet ? { dpiSet } : { stage, dpi };
    const eventPrefix = isPolling ? 'polling' : 'dpi';
    const job = { device, generation, kind: 'write', target: request.kind };
    const current = () => generation === this.#generation && device === this.#device && this.#phase === 'connected';
    const check = () => {
      if (!current()) throw new Error('连接已改变。');
      if (this.#link === 'offline') throw new Error('鼠标已离线。');
      if (revision !== this.#stageRevision) throw new Error('检测到 DPI 按键切换，请保持档位稳定后重新读取。');
      if (offlineRevision !== this.#offlineRevision) throw new Error('保存期间鼠标曾离线，请重新读取后再保存。');
    };
    let entry = null;
    this.#queryJob = job;
    this.#queryError = null;
    this.#querySlow = false;
    this.#record(`${eventPrefix}-save-started`, { kind: request.kind, ...intent });
    this.#lastWrite = null;
    this.#notify();
    const timer = setTimeout(() => {
      if (current() && this.#queryJob === job) { this.#querySlow = true; this.#notify(); }
    }, this.#warningAfterMs);
    const transfer = (details) => {
      if (current()) this.#record('feature', details);
      if (['write-dpi', 'write-dpi-set', 'write-polling-rate'].includes(details.operation) && entry) {
        entry.attempted = true;
        entry.status = 'attempting';
      }
    };
    try {
      const identity = await queryProductIdentity(device, transfer);
      check();
      this.#identity = { ...identity, receivedAt: this.#now() };
      if (!identity.matchesG3) throw new Error('产品标识不匹配 G3，未写入。');
      const fresh = await queryConfiguration(device, identity, transfer);
      check();
      const plan = isPolling ? buildPollingRateWrite(fresh, pollingRate) : isSet ? buildDpiSetWrite(fresh, dpiSet) : buildDpiWrite(fresh, stage, dpi);
      entry = {
        startedAt: new Date(this.#now()).toISOString(), kind: request.kind,
        ...intent,
        ...(isPolling ? { beforePollingRate: plan.beforePollingRate } : isSet ? { beforeDpiSet: plan.beforeDpiSet } : { beforeDpi: plan.beforeDpi }),
        beforePacketHex: plan.beforePacketHex, expectedPacketHex: plan.expectedPacketHex,
        status: plan.changed ? 'prepared' : 'unchanged', attempted: false,
      };
      this.#lastWrite = entry;
      if (!plan.changed) {
        this.#configuration = { ...fresh, receivedAt: this.#now() };
        this.#activeDpiStage = fresh.currentStage;
        return;
      }
      this.#writeHistory.push(entry);
      if (this.#writeHistory.length > 10) this.#writeHistory.shift();
      this.#record(`${eventPrefix}-write-backup`, { kind: request.kind, ...intent, beforePacketHex: plan.beforePacketHex });
      this.#notify();
      check();
      if (isPolling) await sendPollingRateWrite(device, identity, fresh, pollingRate, transfer);
      else if (isSet) await sendDpiSetWrite(device, identity, fresh, dpiSet, transfer);
      else await sendDpiWrite(device, identity, fresh, stage, dpi, transfer);
      entry.status = 'sent';
      await new Promise((resolve) => setTimeout(resolve, 100));
      check();
      const readback = await queryConfiguration(device, identity, transfer);
      check();
      entry.readbackPacketHex = readback.packetHex;
      if (readback.packetHex !== plan.expectedPacketHex) throw new Error('读回配置与预期不一致。');
      entry.status = 'verified';
      this.#configuration = { ...readback, receivedAt: this.#now() };
      this.#activeDpiStage = readback.currentStage;
      this.#record(`${eventPrefix}-save-verified`, { kind: request.kind, ...intent });
    } catch (error) {
      if (entry) {
        entry.status = entry.attempted ? 'uncertain' : 'cancelled';
        entry.error = error.message;
      }
      if (current()) {
        this.#configuration = null;
        this.#queryError = { name: error.name, message: entry?.attempted ? `保存请求已尝试，但读回未确认：${error.message} 请先重新读取；不会自动重复写入。` : error.message };
        this.#record('query-error', this.#queryError);
      }
    } finally {
      clearTimeout(timer);
      if (entry) entry.finishedAt = new Date(this.#now()).toISOString();
      if (this.#queryJob === job) {
        this.#queryJob = null;
        this.#querySlow = false;
        this.#notify();
        this.#kickAutomatic();
      }
    }
  }

  #onInput = (event) => {
    if (this.#phase !== 'connected' || event.device !== this.#device || event.reportId !== G3_PROFILE.reportId) return;
    const time = this.#now();
    const parsed = parseInputReport(event.reportId, event.data);
    this.#lastReportAt = time;
    this.#reportCount += 1;
    this.#record('report', {
      reportId: event.reportId,
      payloadLength: event.data.byteLength,
      // Reconstruct the Windows / USBPcap representation for easy comparison.
      hex: `${event.reportId.toString(16).padStart(2, '0').toUpperCase()} ${toHex(event.data)}`,
      parsed,
    });
    if (parsed?.type === 'battery' && this.#link !== 'offline') {
      this.#battery = { percent: parsed.percent, receivedAt: time };
    }
    if (parsed?.type === 'dpi-stage') {
      this.#stageRevision += 1;
      if (this.#link !== 'offline') {
        this.#activeDpiStage = parsed.stage;
        if (this.#configuration && parsed.stage > this.#configuration.dpiCount) this.#configuration = null;
      }
    }
    if (parsed?.type === 'connection') {
      const previousLink = this.#link;
      this.#link = parsed.online ? 'online' : 'offline';
      // A later online report must not revive a reading from before a disconnect.
      if (!parsed.online) {
        this.#offlineRevision += 1;
        this.#battery = null;
        this.#configuration = null;
        this.#activeDpiStage = null;
        this.#cancelAutomaticTimer();
        this.#pendingRead = false;
      } else if (previousLink !== 'online' && !this.#configuration) {
        this.#requestAutomaticRead('mouse-online', true);
      }
    }
    if ((parsed?.type === 'battery' || parsed?.type === 'dpi-stage') && this.#link !== 'offline' && !this.#configuration) this.#requestAutomaticRead('mouse-report');
    this.#notify();
  };

  #onDisconnect = (event) => {
    if (event.device !== this.#device && event.device !== this.#openingDevice) return;
    ++this.#generation;
    this.#cancelAutomaticTimer();
    this.#pendingConnect = false;
    this.#pendingRead = false;
    this.#device?.removeEventListener('inputreport', this.#onInput);
    this.#device = null;
    this.#openingDevice = null;
    this.#busy = false;
    this.#phase = 'removed';
    this.#error = null;
    this.#resetReadings();
    this.#record('removed');
    this.#notify();
  };

  #onConnect = (event) => {
    if (event.device.vendorId !== G3_PROFILE.vendorId || event.device.productId !== G3_PROFILE.productId) return;
    this.#record('receiver-available');
    this.#notify();
    if (this.#automatic && !this.#automaticSuspended) {
      this.#pendingConnect = true;
      this.#kickAutomatic();
    }
  };
}
