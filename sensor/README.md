# Climate sensor (ESP32 + SHT4x, MicroPython)

The sensor measures temperature and relative humidity every 10 minutes and sends the values to your Apps Script backend. The app shows the curves under **Stats > Cellar climate**.

## Parts (about 15–25 €)

| Part | Example | Notes |
|---|---|---|
| ESP32 board with Wi-Fi | Seeed XIAO ESP32C3, or any ESP32-C3/C6/classic dev board | USB-C power. Small boards with low sleep current are better for battery use. |
| Sensor breakout | Sensirion SHT40, SHT41 or SHT45 on a breakout board (I2C, address 0x44) | SHT4x has better long-term stability and humidity accuracy than DHT22 or BME280. |
| 4 jumper wires | | Or solder directly. |
| USB power supply + cable | any 5 V phone charger | Simplest and most reliable. |

Precondition: Wi-Fi in the cellar. If the signal is weak, add a repeater or powerline adapter. The sensor queues up to 300 readings (about 2 days) when Wi-Fi is down.

## Wiring

| Sensor | ESP32 |
|---|---|
| VIN / VCC | 3V3 |
| GND | GND |
| SDA | GPIO 6 (XIAO ESP32C3: D4) |
| SCL | GPIO 7 (XIAO ESP32C3: D5) |

Other boards: use any two free GPIOs and set `SDA_PIN` and `SCL_PIN` in `config.py`.

## Install

1. Flash MicroPython for your board from <https://micropython.org/download/>. The simplest tool is **Thonny** (Tools > Options > Interpreter > Install or update MicroPython).
2. Copy `config.example.py` to `config.py` and fill in Wi-Fi, the backend URL and the **sensor key** (Sheet menu **Drinkventory > Setup / show keys**).
3. Copy both files to the board, for example with `mpremote`:
   ```bash
   pip install mpremote
   mpremote cp config.py :config.py
   mpremote cp main.py :main.py
   mpremote reset
   ```
4. Watch the output with `mpremote repl`. You should see `measured … C … %RH` and `uploaded 1 stored`.
5. In the app, open **Stats**. The reading appears under **Cellar climate**.

## Placement

- Put the sensor at bottle height in the middle of the rack, not at a wall, the door, a lamp or the board itself. The ESP32 warms up a little; a 10 cm cable between board and sensor helps.
- Let it settle for an hour before you judge the values.
- To calibrate, compare with a reference thermometer and hygrometer for a day, then set `TEMP_OFFSET` and `RH_OFFSET`.

## Battery operation

Set `DEEP_SLEEP = True`. The board then wakes, measures, sends and sleeps. Battery life depends strongly on the board's sleep current and on Wi-Fi signal strength (uncertain: weeks to months with an 18650 cell). For a permanent cellar sensor, USB power is the better choice. Optional battery level: a voltage divider (2 × 100 kΩ) from the cell to an ADC pin, then set `BATTERY_ADC_PIN`.

## Timestamps

The script sets the board clock by NTP at the first Wi-Fi connection. If the clock is not set, the backend uses its own receive time. Queued readings from a board without a set clock therefore get the upload time.

## More sensors

Use one board per location with different `SENSOR_NAME` values (for example `cellar`, `fridge`). The app plots up to three sensors.
