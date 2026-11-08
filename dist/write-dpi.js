import { G3_PROFILE, inspectCapabilities, toHex } from './protocol.js';
import { G3_PRODUCT_CODE } from './identity.js';
import { parseConfiguration } from './config.js';
import { validateDpiSet, dpiSetFromConfiguration } from './presets.js';

function configurationPacket(configuration) {
  const parts = configuration?.packetHex?.trim().split(/\s+/);
  if (!parts || parts.length !== 408 || parts.some((part) => !/^[0-9a-f]{2}$/i.test(part))) throw new Error('缺少完整的设备配置基线。');
  const packet = Uint8Array.from(parts, (part) => Number.parseInt(part, 16));
  return { packet, parsed: parseConfiguration(packet) };
}

const checksum = (packet) => packet.subarray(2).reduce((sum, value) => (sum + value) & 0xff, 0);

function writePlan(packet, expected, details) {
  expected[1] = checksum(expected);
  const write = new Uint8Array(G3_PROFILE.featurePayloadBytes + 1);
  write.set(expected);
  write[2] = 0x04;
  write[1] = checksum(write);
  const beforePacketHex = toHex(packet);
  const expectedPacketHex = toHex(expected);
  return { ...details, changed: expectedPacketHex !== beforePacketHex, beforePacketHex, expectedPacketHex, payload: write.subarray(1) };
}

export function buildDpiWrite(configuration, stage, dpi) {
  const { packet, parsed } = configurationPacket(configuration);
  if (!Number.isInteger(stage) || stage < 1 || stage > parsed.dpiCount) throw new Error('DPI 档位超出设备当前范围。');
  if (!Number.isInteger(dpi) || dpi < 100 || dpi > 12000 || dpi % 100 !== 0) throw new Error('DPI 必须为 100–12000 之间的 100 的倍数。');
  const before = parsed.dpiStages[stage - 1];
  if (before.xDpi !== before.yDpi) throw new Error('当前仅支持 X/Y 相同的 DPI 档位。');
  const expected = packet.slice();
  const view = new DataView(expected.buffer);
  const value = dpi / 100 - 1;
  view.setUint16(15 + (stage - 1) * 2, value, true);
  view.setUint16(35 + (stage - 1) * 2, value, true);
  return writePlan(packet, expected, { kind: 'single', stage, beforeDpi: before.xDpi, dpi });
}

export function buildDpiSetWrite(configuration, dpiSet) {
  const { packet, parsed } = configurationPacket(configuration);
  const target = validateDpiSet(dpiSet);
  const beforeDpiSet = dpiSetFromConfiguration(parsed);
  const expected = packet.slice();
  expected[11] = (target.currentStage << 4) | target.values.length;
  const view = new DataView(expected.buffer);
  target.values.forEach((dpi, index) => {
    const value = dpi / 100 - 1;
    view.setUint16(15 + index * 2, value, true);
    view.setUint16(35 + index * 2, value, true);
  });
  // Inactive slots and all non-DPI fields remain from the fresh device read.
  return writePlan(packet, expected, { kind: 'set', beforeDpiSet, dpiSet: target });
}

function requireTarget(device, identity) {
  if (!device.opened || !inspectCapabilities(device).featureCompatible || !identity?.matchesG3 || identity.productCode !== G3_PRODUCT_CODE) throw new Error('未确认目标 G3 接收器，未发送写入。');
}

export async function sendDpiWrite(device, identity, configuration, stage, dpi, onTransfer = () => {}) {
  requireTarget(device, identity);
  const plan = buildDpiWrite(configuration, stage, dpi);
  if (!plan.changed) return { ...plan, sent: false };
  onTransfer({ api: 'sendFeatureReport', direction: 'out', operation: 'write-dpi', reportId: 9, payloadBytes: plan.payload.length, hex: `09 ${toHex(plan.payload)}` });
  await device.sendFeatureReport(9, plan.payload);
  return { ...plan, sent: true };
}

export async function sendDpiSetWrite(device, identity, configuration, dpiSet, onTransfer = () => {}) {
  requireTarget(device, identity);
  const plan = buildDpiSetWrite(configuration, dpiSet);
  if (!plan.changed) return { ...plan, sent: false };
  onTransfer({ api: 'sendFeatureReport', direction: 'out', operation: 'write-dpi-set', reportId: 9, payloadBytes: plan.payload.length, hex: `09 ${toHex(plan.payload)}` });
  await device.sendFeatureReport(9, plan.payload);
  return { ...plan, sent: true };
}
