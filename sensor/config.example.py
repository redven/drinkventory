# Copy to config.py, fill in, and copy both main.py and config.py to the board.
# Never commit config.py: it contains your Wi-Fi password and the sensor key.

WIFI_SSID = 'your-wifi'
WIFI_PASSWORD = 'your-password'

# Apps Script web app URL (the same URL the phones use) and the SENSOR key
# from the Sheet menu "Cellar > Setup / show keys". Do not use the app key here.
BACKEND_URL = 'https://script.google.com/macros/s/XXXXXXXX/exec'
SENSOR_KEY = 'paste-sensor-key'

SENSOR_NAME = 'cellar'      # shows up in the app; use one name per sensor
INTERVAL_S = 600            # 10 minutes; about 52,000 rows per year

# I2C pins. Check the pinout of your board.
# Seeed XIAO ESP32C3: SDA = GPIO6 (D4), SCL = GPIO7 (D5)
SDA_PIN = 6
SCL_PIN = 7

# USB power: keep False. Battery: True (the board sleeps between readings).
DEEP_SLEEP = False

# Optional battery measurement through a voltage divider (None = off).
BATTERY_ADC_PIN = None
BATTERY_DIVIDER = 2.0

# Optional calibration offsets after a comparison with a reference instrument.
TEMP_OFFSET = 0.0
RH_OFFSET = 0.0
