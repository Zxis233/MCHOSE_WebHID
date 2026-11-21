import { G3_PROFILE, bytesOf, inspectCapabilities, toHex } from './protocol.js';
import { G3_PRODUCT_CODE, maxFeatureReportBytes } from './identity.js';

const READ_PREFIX = Object.freeze([0x00, 0x44, 0x00, 0x01, 0x00, 0x90, 0x01]);
const CONFIG_HEADER = Object.freeze([0x44, 0x00, 0x01, 0x00, 0x90, 0x01]);
const POLLING_RATES = Object.freeze({ 1: 125, 2: 250, 3: 500, 4: 1000 });
const CONFIG_BYTES = 408;

// Preserve the API error name while distinguishing GET failures from a failed
// read request, identity gate, or response validation. Only GET can be rechecked.
export class ConfigurationReceiveError extends Error {
  constructor(cause) {
    super(cause?.message ?? '配置 GET 传输失败。', { cause });
    this.name = cause?.name ?? 'Error';
  }
}

export function buildReadConfigurationRequest() {
  const payload = new Uint8Array(G3_PROFILE.featurePayloadBytes);
  payload.set(READ_PREFIX);
  return payload;
}

export function parseConfiguration(data, { maxBytes = 520 } = {}) {
  const raw = bytesOf(data);
  const prefixed = raw[0] === G3_PROFILE.reportId;
  const payload = prefixed ? raw.subarray(1) : raw;
  if (payload.length < CONFIG_BYTES - 1 || payload.length > maxBytes - 1) throw new Error('基础配置响应长度不匹配。');
  if (!CONFIG_HEADER.every((value, index) => payload[index + 1] === value)) throw new Error('基础配置响应头不匹配。');
  if (payload.subarray(CONFIG_BYTES - 1).some((value) => value !== 0)) throw new Error('基础配置响应包含未验证的尾部数据。');
  const packet = new Uint8Array(CONFIG_BYTES);
  packet[0] = G3_PROFILE.reportId;
  packet.set(payload.subarray(0, CONFIG_BYTES - 1), 1);
  const checksum = packet.subarray(2).reduce((sum, value) => (sum + value) & 0xff, 0);
  if (checksum !== packet[1]) throw new Error('基础配置校验失败，未显示参数。');
  const count = packet[11] & 0x0f;
  const currentStage = packet[11] >>> 4;
  const pollingRate = POLLING_RATES[packet[10]];
  if (count < 1 || count > 6 || currentStage < 1 || currentStage > count || !pollingRate) {
    throw new Error('配置字段超出已支持范围，保留原始响应。');
  }
  const view = new DataView(packet.buffer);
  const dpiStages = Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    xDpi: (view.getUint16(15 + index * 2, true) + 1) * 100,
    yDpi: (view.getUint16(35 + index * 2, true) + 1) * 100,
  }));
  // Only the 100-DPI-step profile has been validated against this G3 V1.
  if (packet[8] !== 100 || dpiStages.some((stage) => stage.xDpi > 12000 || stage.yDpi > 12000)) {
    throw new Error('当前 DPI 步进或数值未经过验证，未显示换算结果。');
  }
  return {
    pollingRate, dpiCount: count, currentStage, dpiStages,
    selectedDpi: dpiStages[currentStage - 1],
    checksum, checksumValid: true,
    responseBytes: raw.length,
    layout: prefixed ? 'report-id-prefixed' : 'payload-only',
    packetHex: toHex(packet),
    unverifiedFields: { byte12: packet[12], byte13: packet[13], byte14: packet[14], byte82: packet[82] },
  };
}

export async function queryConfiguration(device, identity, onTransfer = () => {}, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  if (!device.opened || !inspectCapabilities(device).featureCompatible) throw new Error('请先连接匹配的鼠标。');
  if (!identity?.matchesG3 || identity.productCode !== G3_PRODUCT_CODE) throw new Error('产品标识尚未确认是 G3，未发送配置读取请求。');
  const payload = buildReadConfigurationRequest();
  onTransfer({ api: 'sendFeatureReport', direction: 'out', operation: 'read-configuration', reportId: 9, payloadBytes: payload.length, hex: `09 ${toHex(payload)}` });
  await device.sendFeatureReport(9, payload);
  // Official capture frames 20267/20271 were separated by about 107 ms.
  await wait(100);
  let response;
  try {
    response = await device.receiveFeatureReport(9);
  } catch (error) {
    throw new ConfigurationReceiveError(error);
  }
  onTransfer({ api: 'receiveFeatureReport', direction: 'in', operation: 'read-configuration', reportId: 9, receivedBytes: response.byteLength, hex: toHex(response) });
  return parseConfiguration(response, { maxBytes: maxFeatureReportBytes(device) });
}
