"""
Runs sensor/main.py in CPython with mocked MicroPython modules (machine, network,
urequests) against the local test backend (tests/server.js).
Checks: SHT4x CRC and conversion, upload, offline queue, duplicate-safe retry.
"""
import json, os, subprocess, sys, tempfile, time, types, urllib.request, importlib.util

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
srv = subprocess.Popen(['node', os.path.join(ROOT, 'tests/server.js')], stdout=subprocess.PIPE, text=True)
keys = json.loads(srv.stdout.readline())
work = tempfile.mkdtemp()
os.chdir(work)

state = {'wifi': True, 'raw': (0x66, 0x66, 0x5E, 0x8C)}  # about 25 C / 50 %RH


def crc8(data):
    crc = 0xFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ 0x31) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


class I2C:
    def __init__(self, **kw): pass
    def writeto(self, addr, buf): assert addr == 0x44 and buf == b'\xfd'
    def readfrom(self, addr, n):
        a, b, c, d = state['raw']
        return bytes([a, b, crc8([a, b]), c, d, crc8([c, d])])


class Sleep(Exception):
    pass


machine = types.ModuleType('machine')
machine.SoftI2C = I2C
machine.Pin = lambda n: n
machine.deepsleep = lambda ms: (_ for _ in ()).throw(Sleep(ms))
network = types.ModuleType('network')
network.STA_IF = 0


class WLAN:
    def __init__(self, i): pass
    def active(self, v=None): return True
    def isconnected(self): return state['wifi']
    def connect(self, s, p): pass


network.WLAN = WLAN


class Resp:
    def __init__(self, code, text): self.status_code, self.text = code, text
    def close(self): pass


def post(url, data=None, headers=None):
    if not state['wifi']:
        raise OSError('no route')
    req = urllib.request.Request(url, data=data.encode(), method='POST')
    with urllib.request.urlopen(req) as r:
        return Resp(r.status, r.read().decode())


urequests = types.ModuleType('urequests')
urequests.post = post
config = types.ModuleType('config')
config.__dict__.update(WIFI_SSID='x', WIFI_PASSWORD='y', BACKEND_URL='http://localhost:8787/exec',
                       SENSOR_KEY=keys['sensorKey'], SENSOR_NAME='cellar', INTERVAL_S=600,
                       SDA_PIN=6, SCL_PIN=7, DEEP_SLEEP=True)
for name, mod in [('machine', machine), ('network', network), ('urequests', urequests), ('config', config)]:
    sys.modules[name] = mod
# MicroPython-only helpers
time.sleep_ms = lambda ms: None
import binascii  # noqa: E402,F401

ok = 0
try:
    assert crc8([0xBE, 0xEF]) == 0x92, 'CRC must match the Sensirion datasheet example'
    spec = importlib.util.spec_from_file_location('sensor_main', os.path.join(ROOT, 'sensor/main.py'))
    m = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(m)  # runs main(): one cycle, then deepsleep
    except Sleep:
        pass
    t, h = m.measure()
    assert abs(t - 25.0) < 0.1 and abs(h - 40.0) < 3, (t, h)
    ok += 1; print('  ok  SHT4x CRC and conversion')

    def climate():
        body = json.dumps({'action': 'climate_get', 'key': keys['apiKey'], 'days': 1}).encode()
        return json.loads(urllib.request.urlopen(urllib.request.Request('http://localhost:8787/exec', data=body, method='POST')).read())

    assert len(climate()['series']) == 1
    ok += 1; print('  ok  first cycle uploaded one reading')

    state['wifi'] = False
    assert m.cycle() is False and m.cycle() is False
    assert len(m.load_queue()) == 2
    ok += 1; print('  ok  offline readings queued on the board')

    state['wifi'] = True
    assert m.cycle() is True
    assert m.load_queue() == []
    assert len(climate()['series']) == 4
    ok += 1; print('  ok  queue flushed after reconnect')

    q = [{'reading_id': 'dup-1', 'sensor': 'cellar', 'temp_c': 12.0, 'rh_pct': 60}]
    m.upload(q)
    res = m.upload(q)
    assert res['stored'] == 0 and res['duplicates'] == 1
    ok += 1; print('  ok  retry of the same reading is ignored')
finally:
    srv.terminate()
print(f'sensor: {ok} passed')
