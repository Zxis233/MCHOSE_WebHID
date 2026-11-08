export function mockDevice() {
  const device = new EventTarget();
  Object.assign(device, {
    vendorId: 0x258a, productId: 0x0138, productName: 'Wireless Mouse', opened: false,
    collections: [{ usagePage: 0xff02, usage: 2, inputReports: [{ reportId: 9, items: [{ reportSize: 8, reportCount: 7 }] }], featureReports: [{ reportId: 9, items: [{ reportSize: 8, reportCount: 519 }] }], children: [] }],
    async open() { device.opened = true; },
    async close() { device.opened = false; },
    async sendReport() { throw new Error('Unexpected output command'); },
    async sendFeatureReport() { throw new Error('Unexpected feature command'); },
    async receiveFeatureReport() { throw new Error('Unexpected feature request'); },
  });
  return device;
}
