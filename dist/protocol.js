export const G3_PROFILE = Object.freeze({
  vendorId: 0x258a,
  productId: 0x0138,
  usagePage: 0xff02,
  usage: 0x0002,
  reportId: 0x09,
  inputPayloadBytes: 7,
  featurePayloadBytes: 519,
  staleAfterMs: 180_000,
});

export const G3_TRANSPORTS = Object.freeze([
  Object.freeze({ key: 'receiver', productId: 0x0138, label: '2.4G 无线接收器', configurationWritable: true }),
  Object.freeze({ key: 'wired', productId: 0x0136, label: 'USB 有线连接', configurationWritable: true }),
]);

export function transportForDevice(device) {
  if (device?.vendorId !== G3_PROFILE.vendorId) return null;
  return G3_TRANSPORTS.find((transport) => transport.productId === device.productId) ?? null;
}

export function deviceRequestFilters() {
  // Restrict the chooser to the two known USB IDs. Validate the exact vendor
  // collection/report sizes after selection, before opening either transport.
  return G3_TRANSPORTS.map(({ productId }) => ({ vendorId: G3_PROFILE.vendorId, productId }));
}

export function bytesOf(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError('Expected a binary report');
}

export function toHex(data) {
  return Array.from(bytesOf(data), (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

// WebHID inputreport.data excludes the Report ID. Windows hidapi includes it.
export function parseInputReport(reportId, data) {
  const bytes = bytesOf(data);
  if (reportId !== G3_PROFILE.reportId || bytes.length !== G3_PROFILE.inputPayloadBytes) return null;
  if (bytes[0] !== 0x0a) return null;
  if (bytes[1] === 0x05 && bytes[2] <= 100) {
    return { type: 'battery', percent: bytes[2] };
  }
  if (bytes[1] === 0x02 && (bytes[2] === 0 || bytes[2] === 1)) {
    return { type: 'connection', online: bytes[2] === 1 };
  }
  if (bytes[1] === 0x03 && bytes[2] >= 1 && bytes[2] <= 6) {
    return { type: 'dpi-stage', stage: bytes[2] };
  }
  return null;
}

export function reportPayloadBytes(report) {
  const bits = (report.items ?? []).reduce((sum, item) => sum + item.reportSize * item.reportCount, 0);
  return bits > 0 && bits % 8 === 0 ? bits / 8 : null;
}

export function targetCollection(device) {
  if (!transportForDevice(device)) return null;
  return (device.collections ?? []).find((collection) =>
    collection.usagePage === G3_PROFILE.usagePage && collection.usage === G3_PROFILE.usage) ?? null;
}

function collectReports(collection, key) {
  return [...(collection[key] ?? []), ...(collection.children ?? []).flatMap((child) => collectReports(child, key))];
}

export function inspectCapabilities(device) {
  const collection = targetCollection(device);
  const input = collection && collectReports(collection, 'inputReports').find((report) => report.reportId === G3_PROFILE.reportId);
  const feature = collection && collectReports(collection, 'featureReports').find((report) => report.reportId === G3_PROFILE.reportId);
  const inputBytes = input ? reportPayloadBytes(input) : null;
  const featureBytes = feature ? reportPayloadBytes(feature) : null;
  return {
    vendorCollection: Boolean(collection),
    passiveInputCompatible: inputBytes === G3_PROFILE.inputPayloadBytes,
    featureCompatible: featureBytes === G3_PROFILE.featurePayloadBytes,
    inputPayloadBytes: inputBytes,
    featurePayloadBytes: featureBytes,
  };
}

export function describeDevice(device) {
  const describeReports = (reports = []) => reports.map((report) => ({
    reportId: report.reportId,
    payloadBytes: reportPayloadBytes(report),
    items: (report.items ?? []).map((item) => ({ reportSize: item.reportSize, reportCount: item.reportCount })),
  }));
  const describeCollection = (collection) => ({
    usagePage: collection.usagePage,
    usage: collection.usage,
    inputReports: describeReports(collection.inputReports),
    outputReports: describeReports(collection.outputReports),
    featureReports: describeReports(collection.featureReports),
    children: (collection.children ?? []).map(describeCollection),
  });
  return {
    productName: device.productName,
    vendorId: device.vendorId,
    productId: device.productId,
    transport: transportForDevice(device)?.key ?? null,
    configurationWritable: transportForDevice(device)?.configurationWritable === true,
    capabilities: inspectCapabilities(device),
    collections: (device.collections ?? []).map(describeCollection),
  };
}

export function batteryView(battery, phase, link, now) {
  if (phase !== 'connected' || link === 'offline' || !battery) {
    return { percent: null, stale: false, ageMs: null };
  }
  const ageMs = Math.max(0, now - battery.receivedAt);
  return { percent: battery.percent, stale: ageMs > G3_PROFILE.staleAfterMs, ageMs };
}
