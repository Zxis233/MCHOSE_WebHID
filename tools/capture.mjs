import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [hub, addressText, name, durationText = '180'] = process.argv.slice(2);
const address = Number(addressText);
const durationSeconds = Number(durationText);
if (!/^USBPcap[1-9]\d*$/.test(hub ?? '') || !Number.isInteger(address) || address < 1 || address > 127 || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name ?? '')) {
  throw new Error('Usage: node tools/capture.mjs USBPcap1 <verified-device-address> <unique-name> [duration-seconds]');
}
if (!Number.isInteger(durationSeconds) || durationSeconds < 30 || durationSeconds > 600) throw new Error('Capture duration must be 30–600 seconds');
if (!process.stdin.isTTY) throw new Error('A real terminal is required so USBPcap can receive the q stop key.');
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const folder = join(dirname(fileURLToPath(import.meta.url)), '..', 'diagnostics', day);
mkdirSync(folder, { recursive: true });
const output = join(folder, `${name}.pcap`);
const stateFile = join(folder, `${name}.state.json`);
if (existsSync(output) || existsSync(stateFile)) throw new Error('Capture name already exists; choose a new name.');
const program = 'C:\\Program Files\\USBPcap\\USBPcapCMD.exe';
const args = ['-d', `\\\\.\\${hub}`, '--devices', String(address), '--inject-descriptors', '-o', output];
const state = {
  startedAt: new Date().toISOString(), status: 'waiting-for-authorization',
  hub, address, output, program, args, controllerPid: process.pid,
  collectorPid: null, bytesWritten: 0, durationSeconds,
  stopMethod: 'Ctrl+C or configured deadline in the owned execution session; verify process cleanup and pcap integrity afterwards',
  possiblyIncompleteTail: true,
};
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
save();
console.log(`Capture ${hub}, device address ${address}. Output: ${output}`);
console.log('Approve the USBPcap UAC prompt if shown. Keep the selected USB device connected.');
console.log(`Direct-file capture. Ctrl+C to stop; automatic deadline is ${durationSeconds} seconds.`);
const child = spawn(program, args, { stdio: 'inherit', windowsHide: true });
state.collectorPid = child.pid ?? null;
save();
let failure = null;
const updateSize = () => {
  try { state.bytesWritten = statSync(output).size; } catch { /* No file before UAC acceptance. */ }
  if (state.bytesWritten >= 24) state.status = 'capturing';
};
child.on('error', (error) => { failure = error.message; });
const timer = setInterval(() => { updateSize(); save(); }, 1000);
const interrupt = (reason) => {
  clearInterval(timer);
  clearTimeout(deadline);
  updateSize();
  state.finishedAt = new Date().toISOString();
  state.status = 'interrupted-needs-verification';
  state.stopReason = reason;
  save();
  process.exit(130);
};
const deadline = setTimeout(() => interrupt(`${durationSeconds}-second deadline`), durationSeconds * 1000);
process.on('SIGINT', () => interrupt('Ctrl+C in the owned execution session'));
child.on('close', (code, signal) => {
  clearInterval(timer);
  clearTimeout(deadline);
  updateSize();
  state.finishedAt = new Date().toISOString();
  state.exitCode = code;
  state.signal = signal;
  state.error = failure;
  state.status = !failure && code === 0 && state.bytesWritten >= 24 ? 'stopped-needs-verification' : 'failed';
  save();
  console.log(`Capture ${state.status}: ${state.bytesWritten} bytes, exit ${code}.`);
  process.exitCode = state.status === 'stopped-needs-verification' ? 0 : 1;
});
