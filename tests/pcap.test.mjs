import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeUsbPcap } from '../tools/pcap.mjs';

function capture(records) {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0xa1b2c3d4, 0);
  header.writeUInt16LE(2, 4);
  header.writeUInt16LE(4, 6);
  header.writeUInt32LE(65535, 16);
  header.writeUInt32LE(249, 20);
  return Buffer.concat([header, ...records]);
}

function controlRecord(stage, payload, status = 0, irp = 1n, device = 43) {
  const usb = Buffer.alloc(28);
  usb.writeUInt16LE(28, 0);
  usb.writeBigUInt64LE(irp, 2);
  usb.writeUInt32LE(status, 10);
  usb.writeUInt16LE(1, 17);
  usb.writeUInt16LE(device, 19);
  usb[22] = 2;
  usb.writeUInt32LE(payload.length, 23);
  usb[27] = stage;
  const record = Buffer.alloc(16);
  record.writeUInt32LE(1794120000, 0);
  record.writeUInt32LE(28 + payload.length, 8);
  record.writeUInt32LE(28 + payload.length, 12);
  return Buffer.concat([record, usb, payload]);
}

test('USBPcap setup and completion match by full 64-bit IRP', () => {
  const bytes = capture([
    controlRecord(0, Buffer.from('a101090301000804', 'hex'), 0, 0x123456789abcdef0n),
    controlRecord(3, Buffer.from('090d050101000600040000000019', 'hex'), 0xc0000004, 0x123456789abcdef0n),
  ]);
  const result = decodeUsbPcap(bytes, { device: 43 });
  assert.equal(result.controls[0].length, 1032);
  assert.equal(result.controls[0].value, 0x309);
  assert.equal(result.controls[0].statusHex, '0xc0000004');
  assert.equal(result.controls[0].responseBytes, 14);
  assert.equal(result.pendingControls, 0);
});

test('device descriptor establishes VID/PID independently of USB address', () => {
  const bytes = capture([
    controlRecord(0, Buffer.from('8006000100001200', 'hex')),
    controlRecord(3, Buffer.from('12011001000000088a253801100201020001', 'hex')),
  ]);
  assert.equal(decodeUsbPcap(bytes).descriptors[0].vendorId, 0x258a);
  assert.equal(decodeUsbPcap(bytes).descriptors[0].productId, 0x0138);
  assert.equal(decodeUsbPcap(bytes, { device: 42 }).descriptors.length, 0);
});

test('incomplete files are rejected except explicitly allowed live tails', () => {
  assert.throws(() => decodeUsbPcap(Buffer.alloc(24)), /Expected/);
  const bytes = capture([controlRecord(3, Buffer.alloc(14))]);
  assert.throws(() => decodeUsbPcap(bytes.subarray(0, -1)), /Incomplete/);
  assert.equal(decodeUsbPcap(bytes.subarray(0, -1), { allowIncompleteTail: true }).warnings.length, 1);
});
