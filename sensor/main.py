# Cellar climate sensor: ESP32 (C3, C6 or classic) + Sensirion SHT4x (SHT40/SHT41/SHT45).
# MicroPython. Copy main.py and config.py to the board (see sensor/README.md).
#
# Every INTERVAL_S seconds: read temperature and humidity, send them to the
# Apps Script backend. If Wi-Fi or the backend is down, the reading goes into
# queue.json and is sent with the next successful upload.

import time
import json
import machine
import network
import os
import binascii

try:
    import urequests as requests
except ImportError:
    import requests

import config

QUEUE_FILE = 'queue.json'
QUEUE_MAX = getattr(config, 'QUEUE_MAX', 300)
SHT4X_ADDR = getattr(config, 'SHT4X_ADDR', 0x44)


def log(*a):
    print('[cellar]', *a)


# ---------- SHT4x ----------

def crc8(data):
    crc = 0xFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ 0x31) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def read_sht4x(i2c):
    """High-precision measurement. Returns (temp_c, rh_pct)."""
    i2c.writeto(SHT4X_ADDR, b'\xfd')
    time.sleep_ms(10)
    d = i2c.readfrom(SHT4X_ADDR, 6)
    if crc8(d[0:2]) != d[2] or crc8(d[3:5]) != d[5]:
        raise ValueError('SHT4x CRC error')
    t_raw = (d[0] << 8) | d[1]
    rh_raw = (d[3] << 8) | d[4]
    temp = -45 + 175 * t_raw / 65535
    rh = -6 + 125 * rh_raw / 65535
    rh = min(100, max(0, rh))
    return round(temp, 2), round(rh, 1)


def measure():
    i2c = machine.SoftI2C(scl=machine.Pin(config.SCL_PIN), sda=machine.Pin(config.SDA_PIN), freq=100000)
    temps, rhs = [], []
    for _ in range(3):  # median of three readings
        t, h = read_sht4x(i2c)
        temps.append(t)
        rhs.append(h)
        time.sleep_ms(50)
    temps.sort()
    rhs.sort()
    return temps[1] + getattr(config, 'TEMP_OFFSET', 0), rhs[1] + getattr(config, 'RH_OFFSET', 0)


def battery_pct():
    pin = getattr(config, 'BATTERY_ADC_PIN', None)
    if pin is None:
        return None
    adc = machine.ADC(machine.Pin(pin))
    adc.atten(machine.ADC.ATTN_11DB)
    mv = adc.read_uv() / 1000 * getattr(config, 'BATTERY_DIVIDER', 2.0)
    # Li-ion: 3.3 V empty, 4.2 V full (linear approximation)
    return int(max(0, min(100, (mv - 3300) / 9)))


# ---------- clock, Wi-Fi, queue ----------

def iso_now():
    """UTC timestamp, or '' if the clock was never set (the backend then uses its own time)."""
    y, mo, d, h, mi, s = time.gmtime()[0:6]
    if y < 2024:
        return ''
    return '%04d-%02d-%02dT%02d:%02d:%02dZ' % (y, mo, d, h, mi, s)


def wifi(timeout_s=20):
    sta = network.WLAN(network.STA_IF)
    sta.active(True)
    if not sta.isconnected():
        sta.connect(config.WIFI_SSID, config.WIFI_PASSWORD)
        t0 = time.time()
        while not sta.isconnected() and time.time() - t0 < timeout_s:
            time.sleep_ms(200)
    return sta if sta.isconnected() else None


def sync_clock():
    if time.gmtime()[0] >= 2024:
        return
    try:
        import ntptime
        ntptime.settime()
        log('clock set', iso_now())
    except Exception as e:
        log('ntp failed', e)


def load_queue():
    try:
        with open(QUEUE_FILE) as f:
            return json.load(f)
    except Exception:
        return []


def save_queue(q):
    q = q[-QUEUE_MAX:]
    if not q:
        try:
            os.remove(QUEUE_FILE)
        except OSError:
            pass
        return
    with open(QUEUE_FILE, 'w') as f:
        json.dump(q, f)


def upload(readings):
    body = json.dumps({'action': 'climate', 'key': config.SENSOR_KEY, 'readings': readings})
    r = requests.post(config.BACKEND_URL, data=body, headers={'Content-Type': 'text/plain'})
    try:
        status = r.status_code
        text = r.text
    finally:
        r.close()
    if status != 200:
        raise OSError('HTTP %d' % status)
    res = json.loads(text)
    if not res.get('ok'):
        raise OSError(res.get('error', 'backend error'))
    return res


# ---------- one cycle ----------

def cycle():
    try:
        temp, rh = measure()
    except Exception as e:
        log('sensor error', e)
        return False
    reading = {
        'reading_id': '%s-%s' % (config.SENSOR_NAME, binascii.hexlify(os.urandom(6)).decode()),
        'sensor': config.SENSOR_NAME,
        'ts': iso_now(),
        'temp_c': temp,
        'rh_pct': rh,
    }
    bat = battery_pct()
    if bat is not None:
        reading['battery_pct'] = bat
    log('measured', temp, 'C', rh, '%RH')

    queue = load_queue()
    queue.append(reading)
    sent = False
    if wifi():
        sync_clock()
        for r in queue:
            if not r.get('ts'):
                r.pop('ts', None)  # backend stamps it
        try:
            for i in range(0, len(queue), 50):
                res = upload(queue[i:i + 50])
                log('uploaded', res.get('stored'), 'stored,', res.get('duplicates'), 'duplicates')
            queue = []
            sent = True
        except Exception as e:
            # A failed redirect after the POST can still mean "stored": the reading_id makes a retry safe.
            log('upload failed', e)
    else:
        log('no Wi-Fi')
    save_queue(queue)
    return sent


def main():
    interval = getattr(config, 'INTERVAL_S', 600)
    if getattr(config, 'DEEP_SLEEP', False):
        cycle()
        network.WLAN(network.STA_IF).active(False)
        machine.deepsleep(interval * 1000)
    else:
        while True:
            t0 = time.time()
            cycle()
            time.sleep(max(5, interval - (time.time() - t0)))


main()
