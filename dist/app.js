import { G3_PROFILE } from './protocol.js';
import { G3Session } from './session.js';

const el = (id) => document.getElementById(id);
const usable = window.isSecureContext && 'hid' in navigator;
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
const time = (value) => value == null ? '--' : timeFormat.format(new Date(value));
const hex = (value) => value.toString(16).padStart(4, '0').toUpperCase();
let editorKey = null;
let editorState = null;
const session = new G3Session({ hid: usable ? navigator.hid : null, onChange: render });

function selectEditorStage() {
  const config = editorState?.configuration;
  const stage = config?.dpiStages.find((item) => item.index === Number(el('dpi-stage').value));
  el('dpi-value').value = stage && stage.xDpi === stage.yDpi ? String(stage.xDpi) : '';
  updateEditorButtons();
}

function updateEditorButtons() {
  const state = editorState;
  const stage = state?.configuration?.dpiStages.find((item) => item.index === Number(el('dpi-stage').value));
  const dpi = Number(el('dpi-value').value);
  const valid = Number.isInteger(dpi) && dpi >= 100 && dpi <= 12000 && dpi % 100 === 0;
  const ready = state?.phase === 'connected' && !state.busy && !state.queryBusy && state.link !== 'offline' && state.identity?.matchesG3 && stage;
  el('dpi-stage').disabled = !ready;
  el('dpi-value').disabled = !ready || stage.xDpi !== stage.yDpi;
  el('save-dpi').disabled = !ready || !valid || stage.xDpi !== stage.yDpi || dpi === stage.xDpi;
  el('save-dpi').textContent = state?.queryKind === 'write' ? '正在保存…' : '保存 DPI';
  const last = state?.lastWrite;
  el('save-status').textContent = last?.status === 'verified' ? `第 ${last.stage} 档已保存为 ${last.dpi} DPI，读回已核对。` : last?.status === 'unchanged' ? '设备当前已经是这个数值。' : last?.status === 'uncertain' ? '上次保存尚未读回确认，请先重新读取设备。' : '100–12000 DPI，步进 100；当前编辑同步修改 X/Y。';
}

function badge(id, text, kind = '') {
  el(id).textContent = text;
  el(id).className = `badge ${kind}`;
}

function render(state = session.snapshot()) {
  const connected = state.phase === 'connected';
  const names = { idle: '未连接', choosing: '选择设备中', opening: '正在连接', connected: '已连接', closing: '正在断开', removed: '接收器已拔出', error: '连接异常' };
  badge('connection-badge', names[state.phase], connected ? 'good' : state.phase === 'error' ? 'bad' : '');
  el('connect').disabled = !usable || state.busy || state.hasOpenDevice || state.queryBusy;
  el('disconnect').disabled = state.busy || !state.hasOpenDevice;
  el('connect').firstChild.textContent = connected ? '接收器已连接 ' : '连接接收器 ';
  el('device-name').textContent = state.identity?.matchesG3 ? '迈从 G3 V1' : state.device?.productName || '迈从 G3 V1';
  el('connection-help').textContent = connected ? '已连接，正在监听电量报告。' : state.phase === 'removed' ? '插回接收器后，点击连接接收器。' : '保持接收器插入，使用 2.4G 模式。';
  el('receiver-state').textContent = connected ? '已连接' : '未连接';
  el('mouse-state').textContent = state.link === 'online' ? '在线' : state.link === 'offline' ? '离线' : '尚未确认';
  el('report-count').textContent = String(state.reportCount);
  el('battery-time').textContent = time(state.battery?.receivedAt);

  const reading = state.batteryView;
  el('battery-value').textContent = reading.percent === null ? '--' : String(reading.percent);
  el('battery-fill').style.width = `${reading.percent ?? 0}%`;
  document.querySelector('.battery-card').classList.toggle('stale', reading.stale);
  const progress = document.querySelector('[role="progressbar"]');
  if (reading.percent === null) progress.removeAttribute('aria-valuenow');
  else progress.setAttribute('aria-valuenow', String(reading.percent));
  progress.setAttribute('aria-valuetext', reading.percent === null ? '暂无电量读数' : `${reading.percent}%，${reading.stale ? '已过期' : '最近读数'}`);
  if (!connected) {
    badge('battery-badge', '等待连接');
    el('battery-help').textContent = '连接后等待鼠标主动上报。';
  } else if (state.link === 'offline') {
    badge('battery-badge', '鼠标离线', 'waiting');
    el('battery-help').textContent = '已收到离线状态；请唤醒鼠标并等待新报告。';
  } else if (reading.percent === null) {
    badge('battery-badge', '等待上报', 'waiting');
    el('battery-help').textContent = '轻动鼠标保持唤醒，等待约一分钟。';
  } else {
    badge('battery-badge', reading.stale ? '读数已过期' : '已收到电量', reading.stale ? 'waiting' : 'good');
    el('battery-help').textContent = `${Math.floor(reading.ageMs / 1000)} 秒前收到${reading.stale ? '，等待新报告。' : '。'}`;
  }

  el('error').hidden = !state.error;
  if (state.error) {
    el('error').textContent = `${state.error.name}: ${state.error.message} 如果打开失败，请退出官方 HUB 和电量托盘后重试；无须更换系统驱动。`;
  }

  el('read-config').disabled = !connected || state.busy || state.queryBusy || state.link === 'offline' || !state.device?.capabilities.featureCompatible;
  el('read-config').textContent = state.queryBusy ? state.queryKind === 'write' ? '正在保存…' : '正在读取…' : '读取设备配置';
  el('config-model').textContent = state.identity?.model || '待识别';
  el('identity-info').textContent = state.identity ? `${state.identity.model} · ${state.identity.productCode}` : '使用 G3 V1 档案，读取配置时核对产品标识。';
  const config = state.configuration;
  const activeStage = state.activeDpiStage ?? config?.currentStage;
  const selectedDpi = config?.dpiStages.find((item) => item.index === activeStage);
  el('config-polling').textContent = config ? `${config.pollingRate} Hz` : '--';
  el('config-current').textContent = selectedDpi ? `第 ${activeStage} 档 · ${selectedDpi.xDpi === selectedDpi.yDpi ? selectedDpi.xDpi : `X ${selectedDpi.xDpi} / Y ${selectedDpi.yDpi}`} DPI` : '--';
  el('config-time').textContent = time(config?.receivedAt);
  badge('config-badge', state.queryBusy ? state.queryKind === 'write' ? '保存中' : '读取中' : config ? '已从设备读取' : state.queryError ? '操作未确认' : '未读取', state.queryBusy ? 'waiting' : config ? 'good' : state.queryError ? 'bad' : '');
  el('query-status').textContent = state.querySlow ? '设备响应较慢。请保持鼠标唤醒；底层请求仍在进行。' : state.queryBusy ? state.queryKind === 'write' ? '正在读取新基线、保存 DPI 并读回核对…' : '正在核对型号并读取配置…' : config ? '型号与配置校验通过。修改 DPI 后点击保存，完成后会读回核对。' : '连接后轻动鼠标，再点击读取设备配置。';
  el('query-error').hidden = !state.queryError;
  if (state.queryError) el('query-error').textContent = `${state.queryError.name}: ${state.queryError.message} 请保持官方 HUB 退出，唤醒鼠标后再试。`;
  if (config) {
    el('dpi-stages').replaceChildren(...config.dpiStages.map((stage) => {
      const item = document.createElement('div');
      item.className = `dpi-stage ${stage.index === activeStage ? 'selected' : ''}`;
      const label = document.createElement('small');
      label.textContent = `档位 ${stage.index}${stage.index === activeStage ? ' · 当前' : ''}`;
      const value = document.createElement('strong');
      value.textContent = stage.xDpi === stage.yDpi ? String(stage.xDpi) : `${stage.xDpi} / ${stage.yDpi}`;
      item.append(label, value);
      return item;
    }));
  } else {
    const placeholder = document.createElement('span');
    placeholder.className = 'muted';
    placeholder.textContent = '等待读取板载 DPI 档位。';
    el('dpi-stages').replaceChildren(placeholder);
  }
  editorState = state;
  const key = config ? `${config.receivedAt}:${config.packetHex}` : null;
  if (key !== editorKey) {
    editorKey = key;
    if (config) {
      el('dpi-stage').replaceChildren(...config.dpiStages.map((stage) => {
        const option = document.createElement('option');
        option.value = String(stage.index);
        option.textContent = `第 ${stage.index} 档`;
        return option;
      }));
      el('dpi-stage').value = String(config.currentStage);
      selectEditorStage();
    }
  }
  updateEditorButtons();
  const reports = state.events.filter((event) => event.type === 'report' || event.type === 'feature').slice(-30).reverse();
  if (reports.length) {
    el('reports').replaceChildren(...reports.map((report) => {
      const row = document.createElement('tr');
      const parsed = report.parsed;
      const meaning = report.type === 'feature' ? `${report.operation === 'write-dpi' ? 'DPI 保存' : report.operation === 'read-configuration' ? '配置读取' : '产品识别'} · ${report.direction === 'out' ? '请求' : `返回 ${report.receivedBytes} 字节`}` : parsed?.type === 'battery' ? `电量 ${parsed.percent}%` : parsed?.type === 'dpi-stage' ? `切换到第 ${parsed.stage} 档` : parsed?.type === 'connection' ? `鼠标${parsed.online ? '在线' : '离线'}` : '未解析，保留原始报告';
      const shownHex = report.hex.length > 95 ? `${report.hex.slice(0, 95)} …` : report.hex;
      for (const [index, text] of [time(report.time), shownHex, meaning].entries()) {
        const cell = document.createElement('td');
        cell.textContent = text;
        if (index === 1) cell.className = 'code';
        row.append(cell);
      }
      return row;
    }));
  }
  if (state.device) {
    const caps = state.device.capabilities;
    el('device-id').textContent = `${hex(state.device.vendorId)}:${hex(state.device.productId)}`;
    el('collection-info').textContent = caps.vendorCollection ? 'FF02:0002 · 已找到' : '未找到匹配集合';
    el('report-info').textContent = `ID 9 · 输入 ${caps.inputPayloadBytes ?? '?'} + 1 字节 · Feature ${caps.featurePayloadBytes ?? '?'} + 1 字节`;
    el('descriptor').textContent = JSON.stringify(state.device, null, 2);
  }
}

export function getDiagnosticSnapshot() {
  return {
    schemaVersion: 1,
    appVersion: '0.3.0',
    exportedAt: new Date().toISOString(),
    mode: 'dpi-configuration',
    environment: { userAgent: navigator.userAgent, secureContext: window.isSecureContext, webHidAvailable: 'hid' in navigator },
    profile: { ...G3_PROFILE },
    session: session.snapshot(),
  };
}

el('connect').addEventListener('click', () => { void session.connect(); });
el('disconnect').addEventListener('click', () => { void session.disconnect(); });
el('read-config').addEventListener('click', () => { void session.readConfiguration(); });
el('dpi-stage').addEventListener('change', selectEditorStage);
el('dpi-value').addEventListener('input', updateEditorButtons);
el('save-dpi').addEventListener('click', () => { void session.applyDpi(Number(el('dpi-stage').value), Number(el('dpi-value').value)); });
el('dpi-value').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !el('save-dpi').disabled) el('save-dpi').click(); });
el('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(getDiagnosticSnapshot(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `g3-webhid-${new Date().toISOString().replaceAll(':', '-')}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

el('browser-support').textContent = `${window.isSecureContext ? '安全上下文' : '非安全上下文'} · ${'hid' in navigator ? 'WebHID 可用' : 'WebHID 不可用'}`;
if (!usable) {
  el('compatibility').hidden = false;
  el('compatibility').textContent = '请使用桌面版 Chrome 或 Edge，通过本机 HTTP 地址或 HTTPS 打开此页面。当前浏览器环境无法使用 WebHID。';
}
render();
setInterval(() => render(), 1000);
