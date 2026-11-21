import {
  G3_PROFILE,
  bytesOf,
  inspectCapabilities,
  reportPayloadBytes,
  toHex,
} from "./protocol.js";

const REQUEST_PREFIX = Object.freeze([0x0d, 0x05, 0x01, 0x01, 0x00, 0x06]);
const RESPONSE_PREFIX = Object.freeze([...REQUEST_PREFIX, 0x00]);
export const G3_PRODUCT_CODE = "040000000019";

export function buildProductIdentityRequest() {
  // Matches captured SET_REPORT 09 0D 05 01 01 00 06 + zeros, total 520.
  // sendFeatureReport takes the Report ID separately, so only 519 bytes here.
  const payload = new Uint8Array(G3_PROFILE.featurePayloadBytes);
  payload.set(REQUEST_PREFIX);
  return payload;
}

export function maxFeatureReportBytes(device) {
  const sizes = [];
  function visit(collection) {
    for (const report of collection.featureReports ?? []) {
      const size = reportPayloadBytes(report);
      if (size !== null) sizes.push(size + 1);
    }
    for (const child of collection.children ?? []) visit(child);
  }
  for (const collection of device.collections ?? []) visit(collection);
  return Math.max(G3_PROFILE.featurePayloadBytes + 1, ...sizes);
}

export function parseProductIdentity(data, { maxBytes = 520 } = {}) {
  const raw = bytesOf(data);
  const prefixed = raw[0] === G3_PROFILE.reportId;
  const payload = prefixed ? raw.subarray(1) : raw;
  if (payload.length < 13 || payload.length > maxBytes - 1) {
    throw new Error(`产品识别响应长度不匹配：${raw.length} 字节。`);
  }
  if (!RESPONSE_PREFIX.every((value, index) => payload[index] === value)) {
    throw new Error("产品识别响应头与已验证样本不匹配。");
  }
  if (payload.subarray(13).some((value) => value !== 0)) {
    throw new Error("产品识别响应包含尚未验证的尾部数据。");
  }
  const productCode = toHex(payload.subarray(7, 13)).replaceAll(" ", "");
  return {
    productCode,
    matchesG3: productCode === G3_PRODUCT_CODE,
    model: productCode === G3_PRODUCT_CODE ? "迈从 G3" : "未支持的产品",
    responseBytes: raw.length,
    layout: prefixed ? "report-id-prefixed" : "payload-only",
  };
}

// This is the only active command implemented at this stage. It reproduces
// the existing product lookup; it cannot take arbitrary opcodes or payloads.
export async function queryProductIdentity(device, onTransfer = () => {}) {
  if (!device.opened) throw new Error("请先连接鼠标。");
  if (!inspectCapabilities(device).featureCompatible) {
    throw new Error("厂商集合的 ID 9 Feature 报告长度不匹配，未发送请求。");
  }
  const payload = buildProductIdentityRequest();
  onTransfer({
    api: "sendFeatureReport",
    direction: "out",
    reportId: G3_PROFILE.reportId,
    payloadBytes: payload.length,
    hex: `09 ${toHex(payload)}`,
  });
  await device.sendFeatureReport(G3_PROFILE.reportId, payload);
  const response = await device.receiveFeatureReport(G3_PROFILE.reportId);
  onTransfer({
    api: "receiveFeatureReport",
    direction: "in",
    reportId: G3_PROFILE.reportId,
    receivedBytes: response.byteLength,
    hex: toHex(response),
  });
  return parseProductIdentity(response, {
    maxBytes: maxFeatureReportBytes(device),
  });
}
