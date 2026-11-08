import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be between 1024 and 65535');
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/session.js', ['session.js', 'text/javascript; charset=utf-8']],
  ['/protocol.js', ['protocol.js', 'text/javascript; charset=utf-8']],
  ['/identity.js', ['identity.js', 'text/javascript; charset=utf-8']],
  ['/config.js', ['config.js', 'text/javascript; charset=utf-8']],
  ['/write-dpi.js', ['write-dpi.js', 'text/javascript; charset=utf-8']],
  ['/write-config.js', ['write-config.js', 'text/javascript; charset=utf-8']],
  ['/write-polling.js', ['write-polling.js', 'text/javascript; charset=utf-8']],
  ['/polling-editor.js', ['polling-editor.js', 'text/javascript; charset=utf-8']],
  ['/presets.js', ['presets.js', 'text/javascript; charset=utf-8']],
  ['/dpi-editor.js', ['dpi-editor.js', 'text/javascript; charset=utf-8']],
  ['/mouse-tester.js', ['mouse-tester.js', 'text/javascript; charset=utf-8']],
  ['/mouse-test-state.js', ['mouse-test-state.js', 'text/javascript; charset=utf-8']],
]);
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Permissions-Policy': 'hid=(self), usb=(), camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
};

const server = createServer(async (request, response) => {
  if (!allowedHosts.has(request.headers.host)) {
    response.writeHead(403, headers).end('Loopback host required');
    return;
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { ...headers, Allow: 'GET, HEAD' }).end();
    return;
  }
  let pathname;
  try { pathname = new URL(request.url, `http://127.0.0.1:${port}`).pathname; }
  catch { response.writeHead(400, headers).end(); return; }
  if (pathname === '/health') {
    response.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ app: 'mchose-g3-webhid', version: '0.8.0', mode: 'dpi-configuration' }));
    return;
  }
  const entry = files.get(pathname);
  if (!entry) { response.writeHead(404, headers).end('Not found'); return; }
  try {
    const data = await readFile(fileURLToPath(new URL(`../dist/${entry[0]}`, import.meta.url)));
    response.writeHead(200, { ...headers, 'Content-Type': entry[1], 'Content-Length': data.length });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch (error) {
    console.error(error.message);
    response.writeHead(500, headers).end('Unable to read application file');
  }
});

server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`G3 WebHID: http://127.0.0.1:${port}`);
  console.log('G3 DPI configuration. Stop with Ctrl+C.');
});
