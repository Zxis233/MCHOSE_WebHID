import { G3_PROFILE, G3_TRANSPORTS, transportForDevice } from './protocol.js';
import { G3Session } from './session.js';
import { DpiEditor } from './dpi-editor.js';
import { PollingEditor } from './polling-editor.js';
import { MouseTester } from './mouse-tester.js';

const el = (id) => document.getElementById(id);
const text = (id, value) => {
  const node = el(id);
  const next = String(value);
  if (node.textContent !== next) node.textContent = next;
};
const usable = window.isSecureContext && 'hid' in navigator;
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
const time = (value) => value == null ? '--' : timeFormat.format(new Date(value));
const hex = (value) => value.toString(16).padStart(4, '0').toUpperCase();
let dpiEditor = null;
let pollingEditor = null;
let mouseTester = null;
let currentView = 'settings';
let stagesKey = null;
let reportsKey = null;

function initializeAppearance() {
  let theme = 'dark';
  try { if (localStorage.getItem('g3-webhid-theme') === 'light') theme = 'light'; } catch { /* Theme selection still works without storage. */ }
  const apply = () => {
    document.documentElement.dataset.theme = theme;
    const next = theme === 'dark' ? '浅色' : '深色';
    text('theme-label', next + '模式');
    el('theme-toggle').setAttribute('aria-label', '切换到' + next + '模式');
    document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#151618' : '#f4f3f1';
  };
  el('theme-toggle').addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    apply();
    try { localStorage.setItem('g3-webhid-theme', theme); } catch { /* Preserve the current theme for this visit. */ }
  });
  apply();
}

function initializeNavigation() {
  const pages = { settings: ['settings-page', 'settings-heading', '设备设置'], test: ['mouse-test-page', 'mouse-test-heading', '按键测试'], debug: ['debug-page', 'debug-heading', '调试'] };
  const show = (focus = false) => {
    let view = location.hash.slice(1);
    if (view === 'main-content') {
      if (focus) el('main-content').focus();
      return;
    }
    if (!Object.hasOwn(pages, view)) {
      view = 'settings';
      history.replaceState(null, '', '#settings');
    }
    for (const [name, [id]] of Object.entries(pages)) el(id).hidden = name !== view;
    currentView = view;
    el('device-notices').hidden = view === 'test';
    mouseTester?.setActive(view === 'test');
    document.querySelectorAll('.nav-link').forEach((link) => {
      if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    document.title = pages[view][2] + ' · G3 V1';
    if (focus) {
      el(pages[view][1]).focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  };
  window.addEventListener('hashchange', () => show(true));
  document.querySelector('.skip-link').addEventListener('click', (event) => {
    event.preventDefault();
    el('main-content').focus();
  });
  show();
}

initializeAppearance();
initializeNavigation();
const session = new G3Session({ hid: usable ? navigator.hid : null, onChange: render });
dpiEditor = new DpiEditor(session);
pollingEditor = new PollingEditor(session);
mouseTester = new MouseTester();
mouseTester.setActive(currentView === 'test');

function badge(id, value, kind = '') {
  text(id, value);
  const className = 'badge' + (kind ? ' ' + kind : '');
  if (el(id).className !== className) el(id).className = className;
}

function render(state = session.snapshot()) {
  const connected = state.phase === 'connected';
  const transport = transportForDevice(state.device);
  const names = { idle: '未连接', searching: '查找设备', choosing: '选择设备中', opening: '正在连接', connected: '已连接', closing: '正在断开', removed: '设备已拔出', error: '连接异常' };
  badge('connection-badge', names[state.phase], connected ? 'good' : state.phase === 'error' ? 'bad' : '');
  el('connect').disabled = !usable || state.busy || state.hasOpenDevice || state.queryBusy;
  el('connect').hidden = state.hasOpenDevice;
  el('disconnect').disabled = state.busy || !state.hasOpenDevice;
  el('disconnect').hidden = !state.hasOpenDevice;
  text('connect', state.busy ? names[state.phase] : '连接鼠标');
  text('device-name', state.identity?.matchesG3 ? '迈从 G3 V1' : state.device?.productName || '迈从 G3 V1');
  text('device-mode', transport?.label ?? 'USB 有线 / 2.4G');
  const help = !connected ? state.automatic.suspended ? '已断开，点击连接可恢复。' : state.phase === 'removed' ? '等待设备接入；已有授权时会自动连接。' : '未找到可用授权时，请点击连接鼠标。' : state.link === 'offline' ? '鼠标已离线，唤醒后会自动恢复配置。' : transport?.configurationWritable === false ? '有线模式目前仅开放读取，写入仍在验证。' : '';
  text('connection-help', help);
  el('connection-help').hidden = !help;
  text('receiver-state', connected ? '已连接' : '未连接');
  text('mouse-state', state.link === 'online' ? '在线' : state.link === 'offline' ? '离线' : connected && transport?.key === 'wired' ? 'USB 已连接' : '尚未确认');
  text('report-count', state.reportCount);
  text('battery-time', time(state.battery?.receivedAt));

  const reading = state.batteryView;
  text('battery-value', reading.percent === null ? '--' : reading.percent);
  el('battery-fill').style.height = String(reading.percent ?? 0) + '%';
  el('battery-level').classList.toggle('stale', reading.stale);
  if (reading.percent === null) el('battery-level').removeAttribute('aria-valuenow');
  else el('battery-level').setAttribute('aria-valuenow', String(reading.percent));
  el('battery-level').setAttribute('aria-valuetext', reading.percent === null ? '暂无电量读数' : String(reading.percent) + '%，' + (reading.stale ? '读数已过期' : '最近读数'));
  document.querySelector('.battery-note').hidden = !connected;
  if (state.link === 'offline') {
    text('battery-badge', '等待电量');
    text('battery-help', '鼠标离线');
  } else if (reading.percent === null) {
    text('battery-badge', '等待电量');
    text('battery-help', transport?.key === 'wired' ? '等待电量上报' : '轻动鼠标后等待上报');
  } else {
    text('battery-badge', reading.stale ? '电量已过期' : '电量');
    text('battery-help', time(state.battery.receivedAt) + ' 上报');
  }

  el('error').hidden = !state.error;
  if (state.error) text('error', state.error.message);
  el('read-config').disabled = !connected || state.busy || state.queryBusy || state.link === 'offline' || !state.device?.capabilities.featureCompatible;
  text('read-config', state.queryBusy ? state.queryKind === 'write' ? '正在应用…' : '正在读取…' : '读取设备配置');
  text('config-model', state.identity?.model || '待识别');
  text('identity-info', state.identity ? state.identity.model + ' · ' + state.identity.productCode : '尚未识别');
  const config = state.configuration;
  const activeStage = state.activeDpiStage ?? config?.currentStage;
  const selectedDpi = config?.dpiStages.find((item) => item.index === activeStage);
  text('config-polling', config ? String(config.pollingRate) + ' Hz' : '--');
  text('config-current', selectedDpi ? '第 ' + String(activeStage) + ' 档 · ' + (selectedDpi.xDpi === selectedDpi.yDpi ? String(selectedDpi.xDpi) : 'X ' + String(selectedDpi.xDpi) + ' / Y ' + String(selectedDpi.yDpi)) + ' DPI' : '--');
  text('config-time', time(config?.receivedAt));
  badge('config-badge', state.queryBusy ? state.queryKind === 'write' ? '应用中' : '读取中' : config ? '校验通过' : state.queryError ? '未确认' : '未读取', state.queryBusy ? 'waiting' : config ? 'good' : state.queryError ? 'bad' : '');
  text('query-status', state.querySlow ? '设备响应较慢，底层请求仍在进行。' : state.queryBusy ? state.queryKind === 'write' ? '正在读取新基线、写入并读回核对。' : '正在核对产品标识和配置。' : config ? '配置校验通过。' : '尚未读取配置。');
  el('query-status').hidden = Boolean(config && !state.queryBusy && !state.queryError);
  el('query-error').hidden = !state.queryError;
  if (state.queryError) text('query-error', state.queryError.message);
  const nextStagesKey = (config?.packetHex ?? '') + ':' + String(activeStage);
  if (nextStagesKey !== stagesKey) {
    stagesKey = nextStagesKey;
    if (config) {
      el('dpi-stages').replaceChildren(...config.dpiStages.map((stage) => {
        const item = document.createElement('div');
        item.className = 'dpi-stage' + (stage.index === activeStage ? ' selected' : '');
        const label = document.createElement('small');
        label.textContent = '第 ' + String(stage.index) + ' 档';
        const value = document.createElement('strong');
        value.textContent = stage.xDpi === stage.yDpi ? String(stage.xDpi) : String(stage.xDpi) + ' / ' + String(stage.yDpi);
        item.append(label, value);
        return item;
      }));
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'field-hint';
      placeholder.textContent = '尚未读取配置';
      el('dpi-stages').replaceChildren(placeholder);
    }
  }
  dpiEditor?.update(state);
  pollingEditor?.update(state);
  const reports = state.events.filter((event) => event.type === 'report' || event.type === 'feature').slice(-30).reverse();
  const nextReportsKey = JSON.stringify(reports);
  if (nextReportsKey !== reportsKey) {
    reportsKey = nextReportsKey;
    if (reports.length) {
      el('reports').replaceChildren(...reports.map((report) => {
        const row = document.createElement('tr');
        const parsed = report.parsed;
        const meaning = report.type === 'feature' ? (report.operation === 'write-polling-rate' ? '回报率写入' : report.operation?.startsWith('write-dpi') ? 'DPI 写入' : report.operation === 'read-configuration' ? '配置读取' : '产品识别') + ' · ' + (report.direction === 'out' ? '发送' : '返回 ' + String(report.receivedBytes) + ' 字节') : parsed?.type === 'battery' ? '电量 ' + String(parsed.percent) + '%' : parsed?.type === 'dpi-stage' ? '切换到第 ' + String(parsed.stage) + ' 档' : parsed?.type === 'connection' ? '鼠标' + (parsed.online ? '在线' : '离线') : '未解析';
        const shownHex = report.hex.length > 95 ? report.hex.slice(0, 95) + ' …' : report.hex;
        for (const [index, value] of [time(report.time), shownHex, meaning].entries()) {
          const cell = document.createElement('td');
          cell.textContent = value;
          if (index === 1) cell.className = 'code';
          row.append(cell);
        }
        return row;
      }));
    }
  }
  if (state.device) {
    const caps = state.device.capabilities;
    text('device-id', hex(state.device.vendorId) + ':' + hex(state.device.productId));
    text('collection-info', caps.vendorCollection ? 'FF02:0002' : '未找到匹配集合');
    text('report-info', 'ID 9 · 输入 ' + String(caps.inputPayloadBytes ?? '?') + ' + 1 字节 · Feature ' + String(caps.featurePayloadBytes ?? '?') + ' + 1 字节');
    text('descriptor', JSON.stringify(state.device, null, 2));
  }
}

export function getDiagnosticSnapshot() {
  return {
    schemaVersion: 1,
    appVersion: '0.9.1',
    exportedAt: new Date().toISOString(),
    mode: 'dpi-configuration',
    environment: { userAgent: navigator.userAgent, secureContext: window.isSecureContext, webHidAvailable: 'hid' in navigator },
    profile: { ...G3_PROFILE },
    transports: G3_TRANSPORTS.map((transport) => ({ ...transport })),
    session: session.snapshot(),
    dpiEditor: dpiEditor.snapshot(),
    pollingEditor: pollingEditor.snapshot(),
    mouseTest: mouseTester.snapshot(),
    ui: { view: currentView, theme: document.documentElement.dataset.theme },
  };
}

el('connect').addEventListener('click', () => { void session.connect({ selectDevice: true }); });
el('disconnect').addEventListener('click', () => { void session.disconnect(); });
el('read-config').addEventListener('click', () => { void session.readConfiguration(); });
window.addEventListener('focus', () => session.resumeAutomatic());
document.addEventListener('visibilitychange', () => { if (!document.hidden) session.resumeAutomatic(); });
el('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(getDiagnosticSnapshot(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'g3-webhid-' + new Date().toISOString().replaceAll(':', '-') + '.json';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

text('browser-support', (window.isSecureContext ? '安全上下文' : '非安全上下文') + ' · ' + ('hid' in navigator ? 'WebHID 可用' : 'WebHID 不可用'));
if (!usable) {
  el('compatibility').hidden = false;
  text('compatibility', '请使用桌面版 Chrome 或 Edge，通过本机地址或 HTTPS 打开页面。');
}
render();
session.startAutomatic();
setInterval(() => render(), 1000);
