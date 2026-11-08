import { configurationPacket, configurationWritePlan, requireConfigurationTarget, sendConfigurationWrite } from './write-config.js';

export const POLLING_RATES = Object.freeze([125, 250, 500, 1000]);

export function buildPollingRateWrite(configuration, pollingRate) {
  const code = POLLING_RATES.indexOf(pollingRate) + 1;
  if (!code) throw new Error('回报率仅支持 125、250、500 或 1000 Hz。');
  const { packet, parsed } = configurationPacket(configuration);
  const expected = packet.slice();
  // Native capture polling-rate-native.pcap: only byte 10 and checksum change.
  expected[10] = code;
  return configurationWritePlan(packet, expected, { kind: 'polling', pollingRate, beforePollingRate: parsed.pollingRate });
}

export async function sendPollingRateWrite(device, identity, configuration, pollingRate, onTransfer = () => {}) {
  requireConfigurationTarget(device, identity);
  return sendConfigurationWrite(device, identity, buildPollingRateWrite(configuration, pollingRate), 'write-polling-rate', onTransfer);
}
