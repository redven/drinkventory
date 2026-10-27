"""
End-to-end test: real web app in headless Chromium (two phones), real Code.gs in
the Apps Script mock behind a local HTTP server, fake camera showing QR "000777".

Usage: python3 tests/e2e.py <fake-camera.mjpeg> <screenshot-dir>
"""
import json, subprocess, sys, time, os, urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAM, SHOTS = sys.argv[1], sys.argv[2]
os.makedirs(SHOTS, exist_ok=True)

srv = subprocess.Popen(['node', os.path.join(ROOT, 'tests/server.js')], stdout=subprocess.PIPE, text=True)
keys = json.loads(srv.stdout.readline())
seed = subprocess.run(['node', os.path.join(ROOT, 'tests/seed.js'), keys['apiKey'], keys['sensorKey']], capture_output=True, text=True)
assert seed.returncode == 0, seed.stderr
print('seed', seed.stdout.strip())

API = 'http://localhost:8787/exec'
APP = 'http://localhost:8080/'
errors = []


def backend(body):
    body['key'] = keys['apiKey']
    req = urllib.request.Request(API, data=json.dumps(body).encode(), method='POST')
    return json.loads(urllib.request.urlopen(req).read())


def phone(browser, user, scheme='light'):
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True,
                              has_touch=True, color_scheme=scheme, reduced_motion='reduce', permissions=['camera'])
    ctx.add_init_script("localStorage.setItem('drinkventory.settings', JSON.stringify(%s));" % json.dumps(
        {'apiUrl': API, 'apiKey': keys['apiKey'], 'user': user}))
    page = ctx.new_page()
    page.on('console', lambda m: errors.append(f'{user}: {m.text}') if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(f'{user}: pageerror {e}'))
    return ctx, page


def wait_synced(page, after_action=True):
    """Waits for a completed sync. After an action, the sync must finish after this call."""
    since = page.evaluate('new Date().toISOString()') if after_action else ''
    page.wait_for_function("(since) => window.DrinkventoryApp && DrinkventoryApp.app.lastSync && DrinkventoryApp.app.lastSync > since && DrinkventoryApp.app.pending.length === 0 && !DrinkventoryApp.app.syncing && !DrinkventoryApp.app.syncError", arg=since, timeout=15000)
    expect(page.locator('#syncBadge')).to_contain_text('Synced', timeout=5000)


def shot(page, name, full=False):
    page.wait_for_timeout(350)
    page.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=full)


try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
                                          '--use-file-for-fake-video-capture=' + CAM])

        # ---------- phone A: scan a new sticker and add a product ----------
        a_ctx, a = phone(browser, 'Stefan')
        a.goto(APP + '#/scan')
        a.wait_for_url('**/#/new/000777', timeout=20000)
        print('ok  camera scan of QR 000777 opened the new-bottle form')
        wait_synced(a, after_action=False)
        a.click('button[data-act=new-product]')
        a.select_option('#f_type', 'whisky')
        a.fill('input[name=distillery]', 'Glen Scotia')
        a.fill('input[name=name]', 'Victoriana')
        a.fill('input[name=age]', 'NAS')
        a.fill('input[name=abv]', '54,2')
        a.fill('#intakeForm input[name=location]', 'Cabinet')
        a.fill('#intakeForm .tag-input', 'Whisky fair Nuremberg')
        a.click('#intakeForm .tag-add-btn')
        a.check('input[name=keep_adding]')
        shot(a, '02-new-bottle-form', full=True)
        a.click('#intakeForm button[type=submit]')
        a.wait_for_url('**/#/scan')
        expect(a.locator('.banner')).to_contain_text('Glen Scotia Victoriana')
        expect(a.locator('#toast')).to_contain_text('Already added: 000777', timeout=10000)
        print('ok  batch mode active; re-scan of the same sticker is recognised')
        a.click('button[data-act=batch-stop]')
        wait_synced(a, after_action=False)

        # ---------- phone A: take-out mode on the scan screen ----------
        a.click('button[data-act=scan-mode][data-mode=out]')
        expect(a.locator('#toast')).to_contain_text('Taken out: Glen Scotia Victoriana', timeout=10000)
        expect(a.locator('.banner.out')).to_contain_text('1 taken out so far')
        shot(a, '01-scan-take-out')
        print('ok  take-out mode removed the scanned bottle from stock')
        a.goto(APP + '#/b/000777')
        expect(a.locator('.necktag .tag-status')).to_contain_text('Taken out')
        a.click('button[data-act=restore]')
        expect(a.locator('.necktag .tag-status')).to_have_text('In stock, Cabinet')
        wait_synced(a)
        print('ok  back in stock')

        # ---------- phone A: bottle card, find online, take out ----------
        a.goto(APP + '#/b/000002')
        expect(a.locator('.necktag .tag-code')).to_have_text('000002')
        href = a.get_attribute('.action-grid a:has-text("Find online")', 'href')
        assert href.startswith('https://www.google.com/search?q=Keller%20Riesling%20Kirchspiel%20GG%202019'), href
        shot(a, '03-bottle')
        a.click('button[data-act=take-out]')
        expect(a.locator('.necktag .tag-status')).to_contain_text('Taken out', timeout=5000)
        wait_synced(a)
        print('ok  find-online link and take-out from the bottle card')

        # ---------- phone B: sees A's changes, moves a bottle, works offline ----------
        b_ctx, b = phone(browser, 'Partner')
        b.goto(APP + '#/cellar')
        wait_synced(b, after_action=False)
        b.fill('#cellarSearch', 'whisky fair')
        expect(b.locator('#cellarList')).to_contain_text('Victoriana')
        b.fill('#cellarSearch', '')
        b.click('button[data-group=cat][data-value=spirit]')
        expect(b.locator('#cellarList')).to_contain_text('Victoriana')
        print('ok  partner phone sees the product created on phone A')
        b.click('button[data-group=cat][data-value=all]')
        shot(b, '05-cellar', full=True)
        b.goto(APP + '#/b/000003')
        b.click('button[data-act=move]')
        b.fill('#dlg input[name=location]', 'Fridge door')
        shot(b, '04-move-dialog')
        b.click('#dlg button[value=ok]')
        expect(b.locator('.necktag .tag-status')).to_contain_text('Fridge door')
        wait_synced(b)

        b_ctx.set_offline(True)
        b.goto(APP + '#/b/000005')
        b.click('button[data-act=take-out]')
        expect(b.locator('#syncBadge')).to_contain_text('1 waiting', timeout=10000)
        print('ok  offline change queued on the phone')
        b_ctx.set_offline(False)
        b.click('#syncBadge')
        wait_synced(b)
        print('ok  queued change synced after reconnect')

        # ---------- conflict: both phones take out the same bottle while A is offline ----------
        a_ctx.set_offline(True)
        a.goto(APP + '#/b/000006')
        a.click('button[data-act=take-out]')
        a.wait_for_function("() => DrinkventoryApp.app.pending.length === 1")
        b.goto(APP + '#/b/000006')
        b.click('button[data-act=take-out]')
        wait_synced(b)
        a_ctx.set_offline(False)
        a.evaluate('DrinkventoryApp.syncNow(false)')
        expect(a.locator('#syncBadge')).to_contain_text('1 rejected', timeout=15000)
        a.click('#syncBadge')
        a.wait_for_url('**/#/settings')
        expect(a.locator('main')).to_contain_text('Taken out 000006')
        expect(a.locator('main')).to_contain_text('bottle is not in stock')
        expect(a.locator('#syncBadge')).not_to_contain_text('rejected')
        print('ok  conflicting change rejected and reported; server state wins')

        # ---------- backend state ----------
        snap = backend({'action': 'sync', 'ops': []})['snapshot']
        ev = [(e['bottle_id'], e['type'], e['user']) for e in snap['events']]
        assert ('000002', 'out', 'Stefan') in ev
        assert ('000003', 'move', 'Partner') in ev
        assert ('000005', 'out', 'Partner') in ev
        assert ('000006', 'out', 'Partner') in ev
        assert ('000006', 'out', 'Stefan') not in ev
        assert [t for (bid, t, u) in ev if bid == '000777'] == ['intake', 'out', 'restore']
        prod = [x for x in snap['products'] if x['name'] == 'Victoriana'][0]
        assert prod['abv'] == 54.2 and prod['type'] == 'whisky'
        assert [x['tags'] for x in snap['bottles'] if x['bottle_id'] == '000777'] == ['Whisky fair Nuremberg']
        assert set(snap['bottles'][0].keys()) == {'bottle_id', 'product_id', 'status', 'location', 'acquired_date', 'tags', 'out_at', 'created_at', 'created_by', 'updated_at'}
        print('ok  Sheet contains the changes from both phones')
        assert a.evaluate('DrinkventoryApp.app.backendIssue') is None, 'version warning with matching backend'
        a.goto(APP + '#/settings')
        a.click('button[data-act=test-conn]')
        expect(a.locator('#toast')).to_contain_text('Connected. Backend version', timeout=10000)
        print('ok  no version warning when Code.gs and Logic.gs match the app')

        # ---------- stats and settings ----------
        a.goto(APP + '#/stats')
        a.wait_for_selector('#chTemp', timeout=15000)
        a.wait_for_timeout(800)
        shot(a, '06-stats', full=True)
        a.goto(APP + '#/settings')
        shot(a, '07-settings', full=True)
        a.goto(APP + '#/p/p_keller')
        shot(a, '08-product', full=True)

        # ---------- dark mode ----------
        c_ctx, c = phone(browser, 'Stefan', 'dark')
        c.goto(APP + '#/b/000008')
        wait_synced(c, after_action=False)
        c.goto(APP + '#/b/000008')
        shot(c, '09-bottle-dark')
        c.goto(APP + '#/stats')
        c.wait_for_selector('#chTemp', timeout=15000)
        c.wait_for_timeout(800)
        shot(c, '10-stats-dark', full=True)
        c.goto(APP + '#/b/000002')
        shot(c, '11-taken-out-dark')
        browser.close()
finally:
    srv.terminate()

bad = [e for e in errors if 'favicon' not in e and 'ERR_INTERNET_DISCONNECTED' not in e]
if bad:
    print('CONSOLE ERRORS:\n' + '\n'.join(bad))
    sys.exit(1)
print('e2e: all checks passed, no console errors')
