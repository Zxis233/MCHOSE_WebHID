"""Developer-only read comparison. Sends only fixed identity/configuration queries.

No configuration SET (opcode 04), output report, or arbitrary command is exposed.
Run with the webpage disconnected and official HUB closed.
"""
import datetime as dt
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, r'D:\MCHOSE_Battery\tools\python-deps')
import hid

root = Path(__file__).resolve().parents[1]
output = Path(sys.argv[1]).resolve()
if not output.is_relative_to(root / 'diagnostics') or output.suffix != '.json' or output.exists():
    raise SystemExit('Use a new JSON output inside this project diagnostics directory.')

state = {'startedAt': dt.datetime.now(dt.UTC).isoformat(), 'vendorId': '258A', 'productId': '0136',
         'configurationWrites': 0, 'results': []}
device = hid.device()


def request(prefix):
    packet = bytearray(520)
    packet[:len(prefix)] = prefix
    return packet


try:
    matches = [d for d in hid.enumerate(0x258a, 0x0136)
               if d['usage_page'] == 0xff02 and d['usage'] == 2 and d['interface_number'] == 1]
    if len(matches) != 1:
        raise RuntimeError(f'Expected one wired vendor collection, found {len(matches)}')
    device.open_path(matches[0]['path'])
    state['descriptorHex'] = bytes(device.get_report_descriptor()).hex()
    identity_request = request(bytes.fromhex('09 0D 05 01 01 00 06'))
    device.send_feature_report(identity_request)
    identity = bytes(device.get_feature_report(9, 520))
    if identity[:8] != bytes.fromhex('09 0D 05 01 01 00 06 00') or identity[8:14].hex() != '040000000019':
        raise RuntimeError('Exact G3 product identity not confirmed; no configuration query sent.')
    state['productCode'] = identity[8:14].hex()
    config_request = request(bytes.fromhex('09 00 44 00 01 00 90 01'))
    # Interleave lengths on the same handle; all requests remain read-only.
    for size in [520, 1032, 520, 1032, 520, 1032]:
        result = {'requestedBytes': size, 'startedAt': dt.datetime.now(dt.UTC).isoformat()}
        try:
            start = time.perf_counter()
            result['sentBytes'] = device.send_feature_report(config_request)
            result['sendMs'] = round((time.perf_counter() - start) * 1000, 3)
            time.sleep(0.1)
            start = time.perf_counter()
            response = bytes(device.get_feature_report(9, size))
            result['getMs'] = round((time.perf_counter() - start) * 1000, 3)
            valid = (len(response) >= 408 and response[:1] == b'\x09'
                     and response[2:8] == bytes.fromhex('44 00 01 00 90 01')
                     and response[1] == sum(response[2:408]) % 256
                     and not any(response[408:]))
            result.update(returnedBytes=len(response), configurationValid=valid, responseHex=response.hex())
            if valid:
                result['pollingRate'] = {1: 125, 2: 250, 3: 500, 4: 1000}.get(response[10])
                result['currentStage'] = response[11] >> 4
        except Exception as error:
            result['error'] = f'{type(error).__name__}: {error}'
        state['results'].append(result)
        print(json.dumps({k: v for k, v in result.items() if k != 'responseHex'}), flush=True)
        time.sleep(0.3)
except Exception as error:
    state['fatal'] = f'{type(error).__name__}: {error}'
finally:
    device.close()
    state['finishedAt'] = dt.datetime.now(dt.UTC).isoformat()
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('x', encoding='utf-8') as file:
        json.dump(state, file, ensure_ascii=False, indent=2)
    if 'fatal' in state:
        raise SystemExit(state['fatal'])
