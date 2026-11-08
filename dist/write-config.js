import { G3_PROFILE, inspectCapabilities, toHex } from './protocol.js';
import { G3_PRODUCT_CODE } from './identity.js';
import { parseConfiguration } from './config.js';

export function configurationPacket(configuration) {
  const parts = configuration?.packetHex?.trim().split(/\s+/);
  if (!parts || parts.length !== 408 || parts.some((part) => !/^[0-9a-f]{2}$/i.test(part))) throw new Error('缺少完整的设备配置基线。');
  const packet = Uint8Array.from(parts, (part) => Number.parseInt(part, 16));
  return { packet, parsed: parseConfiguration(packet) };
}

const checksum = (packet) => packet.subarray(2).reduce((sum, value) => (sum + value) & 0xff, 0);

export function configurationWritePlan(packet, expected, details) {
  expected[1] = checksum(expected);
  const write = new Uint8Array(G3_PROFILE.featurePayloadBytes + 1);
  write.set(expected);
  write[2] = 0x04;
  write[1] = checksum(write);
  const beforePacketHex = toHex(packet);
  const expectedPacketHex = toHex(expected);
  return { ...details, changed: expectedPacketHex !== beforePacketHex, beforePacketHex, expectedPacketHex, payload: write.subarray(1) };
}

export function requireConfigurationTarget(device, identity) {
  if (!device.opened || !inspectCapabilities(device).featureCompatible || !identity?.matchesG3 || identity.productCode !== G3_PRODUCT_CODE) throw new Error('未确认目标 G3 接收器，未发送写入。');
}

export async function sendConfigurationWrite(device, identity, plan, operation, onTransfer) {
  requireConfigurationTarget(device, identity);
  if (!plan.changed) return { ...plan, sent: false };
  onTransfer({ api: 'sendFeatureReport', direction: 'out', operation, reportId: 9, payloadBytes: plan.payload.length, hex: `09 ${toHex(plan.payload)}` });
  await device.sendFeatureReport(9, plan.payload);
  return { ...plan, sent: true };
}
