import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// USBPcap 1.5+ setup/complete records. This module never opens a device.
export function decodeUsbPcap(buffer, { device, allowIncompleteTail = false } = {}) {
  if (buffer.length < 24 || buffer.readUInt32LE(0) !== 0xa1b2c3d4 || buffer.readUInt32LE(20) !== 249) {
    throw new Error('Expected little-endian microsecond LINKTYPE_USBPCAP pcap');
  }
  const controls = [];
  const descriptors = [];
  const pending = new Map();
  const counts = new Map();
  const warnings = [];
  let offset = 24;
  let packets = 0;
  const incomplete = (message) => {
    if (!allowIncompleteTail) throw new Error(message);
    warnings.push(message);
  };
  while (offset < buffer.length) {
    if (offset + 16 > buffer.length) { incomplete('Incomplete final record header'); break; }
    const seconds = buffer.readUInt32LE(offset);
    const micros = buffer.readUInt32LE(offset + 4);
    const included = buffer.readUInt32LE(offset + 8);
    const original = buffer.readUInt32LE(offset + 12);
    if (included > 16 * 1024 * 1024) throw new Error('Unreasonable pcap record size');
    offset += 16;
    if (offset + included > buffer.length) { incomplete('Incomplete final packet'); break; }
    const data = buffer.subarray(offset, offset + included);
    offset += included;
    packets += 1;
    if (data.length < 27) throw new Error(`Short USBPcap header at frame ${packets}`);
    const headerLength = data.readUInt16LE(0);
    const irp = data.readBigUInt64LE(2).toString(16);
    const status = data.readUInt32LE(10);
    const bus = data.readUInt16LE(17);
    const address = data.readUInt16LE(19);
    const transfer = data[22];
    const declared = data.readUInt32LE(23);
    if (headerLength < 27 || headerLength > data.length) throw new Error(`Invalid USBPcap header length at frame ${packets}`);
    counts.set(`${bus}:${address}`, (counts.get(`${bus}:${address}`) ?? 0) + 1);
    if (device !== undefined && address !== device) continue;
    if (transfer !== 2 || headerLength < 28) continue;
    const stage = data[27];
    const payload = data.subarray(headerLength, headerLength + declared);
    const truncated = included < original || payload.length < declared;
    const key = `${bus}:${address}:${irp}`;
    if (stage === 0 && payload.length >= 8) {
      const entry = {
        requestFrame: packets, time: new Date(seconds * 1000 + micros / 1000).toISOString(), bus, device: address,
        bm: payload[0], request: payload[1], value: payload.readUInt16LE(2),
        interface: payload.readUInt16LE(4), length: payload.readUInt16LE(6),
        out: payload.subarray(8).toString('hex'), truncated,
      };
      controls.push(entry);
      pending.set(key, entry);
    } else if (stage === 3 && pending.has(key)) {
      const entry = pending.get(key);
      pending.delete(key);
      Object.assign(entry, { responseFrame: packets, status, statusHex: `0x${status.toString(16).padStart(8, '0')}`, response: payload.toString('hex'), responseBytes: payload.length, truncated: entry.truncated || truncated });
      if (entry.bm === 0x80 && entry.request === 6 && entry.value === 0x100 && payload.length >= 18 && payload[0] === 18 && payload[1] === 1) {
        descriptors.push({ bus, device: address, vendorId: payload.readUInt16LE(8), productId: payload.readUInt16LE(10), bcdDevice: payload.readUInt16LE(12), frame: packets });
      }
    }
  }
  return { packets, byteLength: buffer.length, counts: Object.fromEntries(counts), warnings, pendingControls: pending.size, descriptors, controls };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, addressText, ...extras] = process.argv.slice(2);
  const outputs = extras.filter((arg) => !arg.startsWith('--'));
  if (outputs.length > 1 || extras.some((arg) => arg.startsWith('--') && arg !== '--live')) throw new Error('Unknown analysis argument');
  const output = outputs[0];
  if (!input) throw new Error('Usage: node tools/pcap.mjs <file> <device-address> [output.json] [--live]');
  const device = addressText === undefined ? undefined : Number(addressText);
  if (device !== undefined && (!Number.isInteger(device) || device < 1 || device > 127)) throw new Error('Invalid device address');
  const result = decodeUsbPcap(readFileSync(input), { device, allowIncompleteTail: extras.includes('--live') });
  if (output) writeFileSync(output, JSON.stringify(result, null, 2), { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ ...result, controls: result.controls.filter((entry) => (entry.bm & 0x60) === 0x20).map(({ out, response, ...entry }) => ({ ...entry, outPrefix: out.slice(0, 64), responsePrefix: response?.slice(0, 64) })) }, null, 2));
}
