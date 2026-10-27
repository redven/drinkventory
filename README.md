# Drinkventory

A wine and spirits inventory for two iPhones. You scan a QR sticker on each bottle to add it, move it or take it out of stock. Every action goes into a history. The app also shows statistics and a cellar climate record. Your data lives in a Google Sheet in your Drive. Everything is free: no App Store, no Apple Developer Program, no server to pay for.

```
 iPhone (you)          iPhone (partner)            Climate sensor
 home-screen web app   home-screen web app         ESP32 + SHT4x
        │  local copy + offline queue                    │
        └──────────────┬─────────────────────────────────┘
                       │ HTTPS (app key / sensor key)
              Google Apps Script web app  (apps-script/Code.gs + Logic.gs)
                       │
              Google Sheet "Drinkventory" in your Drive
              tabs: products · bottles · events · ops · climate
              folder: "Drinkventory photos" (label photos)

 Web app files: GitHub Pages (docs/)        Analysis: analysis/load_drinkventory.py (pandas)
```

Why this split: Google Drive cannot host web pages, and an Apps Script page cannot use the camera reliably. So the app files are on GitHub Pages and only the data goes to Google.

## Contents

| Path | What it is |
|---|---|
| `docs/` | The web app (GitHub Pages serves this folder). |
| `docs/js/logic.js` | Shared rules for all changes. The same file runs on the phone and in Apps Script. |
| `apps-script/Code.gs` | Backend: sync, photos, climate, e-mail alerts. |
| `apps-script/Logic.gs` | Identical copy of `docs/js/logic.js`. |
| `sensor/` | MicroPython script for an ESP32 + SHT4x climate sensor. |
| `analysis/load_drinkventory.py` | Loads everything into pandas DataFrames. |
| `tests/` | Backend tests, end-to-end browser test, sensor test. |

## Setup (about 20 minutes)

### 1. Google Sheet and backend

1. In Google Drive, create a blank Google Sheet. Name it `Drinkventory`.
2. In the Sheet: **Extensions > Apps Script**.
3. Replace the content of `Code.gs` with `apps-script/Code.gs`.
4. Add a second script file (**+ > Script**), name it `Logic`, and paste `apps-script/Logic.gs`.
5. Save. Select the function `setup` in the toolbar and click **Run**.
6. Google asks for authorization. Because this is your own unverified script, click **Advanced > Go to … (unsafe)** and allow. The script needs access to this Sheet, to Drive (for the photo folder) and, for alerts, to send e-mail to you.
7. Reload the Sheet. A **Drinkventory** menu appears. **Drinkventory > Setup / show keys** shows two keys:
   - **App key**: for both phones.
   - **Sensor key**: for climate sensors only. It can add readings but cannot read or change the cellar.

### 2. Deploy the backend as a web app

1. In Apps Script: **Deploy > New deployment**, type **Web app**.
2. **Execute as: Me**. **Who has access: Anyone**.
3. **Deploy**, then copy the **Web app URL**. It ends with `/exec`.

"Anyone" means anyone with the URL can call the backend, but every call needs the key. Keep the key private.

When you change `Code.gs` or `Logic.gs` later: **Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy**. The URL stays the same. If you skip this step, the old code keeps running.

### 3. Host the web app on GitHub Pages

1. Create a GitHub repository (public is fine, no secrets are in the files) and push this folder.
2. Repository **Settings > Pages > Build and deployment**: Source **Deploy from a branch**, branch `main`, folder `/docs`.
3. After a minute the app is at `https://<user>.github.io/<repo>/`.

### 4. Install on the iPhones

1. Open the URL in **Safari**.
2. **Share > Add to Home Screen**. Always start the app from this icon. The home-screen app keeps its own storage, separate from Safari tabs.
3. In the app: **Settings**. Enter your name, the backend URL and the app key. **Save and connect**.
4. Allow camera access when iOS asks. (iOS can ask again after the app was closed for a while; that is iOS behaviour for home-screen web apps.)
5. Your partner does the same on her phone with her own name. Send her the URL and the app key through a private channel.

## QR stickers

Recommendation:

| Property | Choice | Reason |
|---|---|---|
| Content | Unique sequential numbers, plain text (for example `000001`) | Works with any app URL. The app also accepts URLs and any other text as an ID. |
| Human-readable number | Printed under the code | Manual entry if a code is damaged. |
| Material | White **matte** polyester (PET) or vinyl, permanent adhesive | Waterproof, survives condensation from fridges and ice buckets. Matte avoids glare. |
| Size | 20–25 mm square, or 20 mm round for capsule tops | Scans from 10–20 cm. On a narrow neck use at most 20 mm, because curvature distorts larger codes. |
| Quantity | Number of bottles + 50 % | For new purchases. |
| Re-order | Ask for a start number after your last one | Avoids duplicate IDs. If the seller cannot do that, choose a different prefix. |

Placement: wine on the capsule top or neck (visible when the bottle lies in the rack, and the label stays clean for resale), spirits on the back or shoulder.

The app rejects a sticker that is already in use, so a duplicate from a re-order is caught when you scan it.

## Daily use

| Task | How |
|---|---|
| Add a bottle | Scan an unused sticker. Choose an existing product or create a new one (photo optional). Set location and, optionally, tags (where it came from, an occasion, a trip). |
| Add several identical bottles | Tick **Add more bottles of this product next**, then scan the stickers one after another. |
| Take a bottle out | Scan, then **Take out** on the bottle card. Or switch the scan screen to **Take out**: every scanned bottle then leaves the stock immediately (with **Undo**). |
| Move | Scan, **Move**, pick or type the location. |
| Tags | On the bottle page, tap a suggested tag or type a new one; tap × to remove it. Separate several with commas. Rename or delete a tag on all bottles in **Settings > Tags**. |
| Browse labels | **Cellar > Labels** shows the label photos as a grid. Tap a label to open that bottle (or the product, if there are several). |
| From statistics to bottles | Tap a drinking-window number or a bar in **Stats** to list exactly those bottles. |
| Look a product up | **Find online** opens a Google search for producer, name and vintage (or distillery, name and age). |
| Mistake | **Back in stock** reverses a take-out. **Remove** takes a wrongly labelled bottle out of all lists; the sticker can be used again. The history keeps every entry. |

Offline: every change is stored on the phone first and sent when there is a connection. The sync badge in the header shows waiting changes. If both phones change the same bottle while one is offline, the first change that reaches the backend wins, and the other phone shows **rejected** in the badge with details in **Settings**.

## Climate sensor and alerts

See `sensor/README.md` for hardware, wiring and setup.

E-mail alerts: **Drinkventory > Install climate alerts**. The backend checks once per hour and sends one e-mail when a value leaves the limits or the sensor stops reporting, and one when everything is back in range. Change the limits in **Apps Script > Project Settings > Script properties**:

| Property | Default | Meaning |
|---|---|---|
| `ALERT_TEMP_MIN` / `ALERT_TEMP_MAX` | 8 / 18 | °C |
| `ALERT_RH_MIN` / `ALERT_RH_MAX` | 50 / 85 | % relative humidity |
| `ALERT_STALE_MIN` | 120 | minutes without a reading |
| `ALERT_EMAIL` | (your account) | optional other address |

Sensors that can only call a URL (for example webhooks) can use GET:
`<web app URL>?action=climate&key=<sensor key>&sensor=cellar&temp=12.3&hum=68`

## Analysis in Python

```bash
pip install pandas
export DRINKVENTORY_URL='https://script.google.com/macros/s/…/exec'
export DRINKVENTORY_KEY='<app key>'
python analysis/load_drinkventory.py --csv out/
```

```python
from load_drinkventory import load
d = load(climate_days=365)
d['stock'].groupby(['country', 'type']).size()
d['taken_out'].set_index('out_at').resample('QE').size()
d['climate'].plot(x='t', y=['temp_min', 'temp', 'temp_max'])
```

You can also open the Sheet directly, connect it to Looker Studio, or read it with `gspread`.

## The Sheet

| Tab | One row per | Notes |
|---|---|---|
| `products` | wine or spirit (producer, name, vintage, region, grapes or cask, drink window) | Edit text fields freely. Do not change `product_id`. |
| `bottles` | physical bottle (sticker ID, status, location, acquired date, tags, taken-out date) | Status: `in_stock`, `out`, `void` (removed by mistake). |
| `events` | action: `intake`, `move`, `out`, `restore`, `void`, `edit` | Append-only history with user, time and location. |
| `ops` | change received from a phone | Makes sync safe against duplicates. Do not edit. |
| `climate` | sensor reading | Grows by about 52,000 rows per year at a 10-minute interval. |

You can add your own columns to the right of a tab. The backend keeps them.

## Security

- Anyone with the backend URL **and** the app key can read and change the cellar. Rotate the key with **Drinkventory > New app key** if needed, then enter it again on both phones.
- The sensor key can only add climate readings.
- Label photos stay private in the `Drinkventory photos` folder. The backend serves only files from that folder.
- Do not commit `sensor/config.py` (it contains your Wi-Fi password). `.gitignore` excludes it.

## Limits

- Apps Script quotas for free accounts are far above what two people and one sensor need.
- A Google Sheet holds up to 10 million cells. At 10-minute climate readings that is many years.
- The phone keeps a full copy of products, bottles and events. This is fast up to several thousand bottles.

## Updating the app

1. Change files in `docs/`.
2. If you changed `docs/js/logic.js`: copy it to `apps-script/Logic.gs`, paste it into the Apps Script editor, and deploy a new version.
3. Change `CACHE` in `docs/sw.js` (for example `drinkventory-v7`) so phones load the new files.
4. Push. GitHub Pages updates within a minute.

## Tests

```bash
node tests/backend.test.js                       # Code.gs + Logic.gs in a mocked Apps Script
python3 tests/sensor_test.py                     # sensor script against the local backend
pip install playwright qrcode && python3 -m playwright install chromium
python3 tests/e2e.py <qr.mjpeg> <screenshot-dir> # two phones, fake camera, offline, conflict
```

Third-party code in `docs/vendor/`: jsQR 1.4.0 (Apache-2.0), Chart.js 4.6.1 (MIT). Licence files are next to them.
