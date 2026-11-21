import {
  configurationPacket,
  configurationWritePlan as writePlan,
  requireConfigurationTarget,
  sendConfigurationWrite,
} from "./write-config.js";
import { validateDpiSet, dpiSetFromConfiguration } from "./presets.js";

export function buildDpiWrite(configuration, stage, dpi) {
  const { packet, parsed } = configurationPacket(configuration);
  if (!Number.isInteger(stage) || stage < 1 || stage > parsed.dpiCount)
    throw new Error("DPI 档位超出设备当前范围。");
  if (!Number.isInteger(dpi) || dpi < 100 || dpi > 12000 || dpi % 100 !== 0)
    throw new Error("DPI 必须为 100–12000 之间的 100 的倍数。");
  const before = parsed.dpiStages[stage - 1];
  if (before.xDpi !== before.yDpi)
    throw new Error("当前仅支持 X/Y 相同的 DPI 档位。");
  const expected = packet.slice();
  const view = new DataView(expected.buffer);
  const value = dpi / 100 - 1;
  view.setUint16(15 + (stage - 1) * 2, value, true);
  view.setUint16(35 + (stage - 1) * 2, value, true);
  return writePlan(packet, expected, {
    kind: "single",
    stage,
    beforeDpi: before.xDpi,
    dpi,
  });
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
  return writePlan(packet, expected, {
    kind: "set",
    beforeDpiSet,
    dpiSet: target,
  });
}

export async function sendDpiWrite(
  device,
  identity,
  configuration,
  stage,
  dpi,
  onTransfer = () => {},
) {
  requireConfigurationTarget(device, identity);
  const plan = buildDpiWrite(configuration, stage, dpi);
  return sendConfigurationWrite(
    device,
    identity,
    plan,
    "write-dpi",
    onTransfer,
  );
}

export async function sendDpiSetWrite(
  device,
  identity,
  configuration,
  dpiSet,
  onTransfer = () => {},
) {
  requireConfigurationTarget(device, identity);
  const plan = buildDpiSetWrite(configuration, dpiSet);
  return sendConfigurationWrite(
    device,
    identity,
    plan,
    "write-dpi-set",
    onTransfer,
  );
}
