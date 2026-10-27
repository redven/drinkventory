"""
Load the cellar into pandas through the Apps Script backend (no Google API setup).

    from load_cellar import load
    d = load()                      # reads CELLAR_URL and CELLAR_KEY from the environment
    d['stock'].groupby('country').size()
    d['taken_out'].set_index('out_at').resample('ME').size()

Command line:
    CELLAR_URL=... CELLAR_KEY=... python load_cellar.py --csv out/

Tables returned (dict of DataFrames):
    products, bottles, events  as stored in the Sheet (typed)
    stock                      bottles in stock, joined with their product
    taken_out                  bottles taken out (one row per bottle, with out_at), joined with product
    climate                    climate readings (raw, or hourly/daily aggregates)
"""
from __future__ import annotations

import argparse
import json
import os
import urllib.request

import pandas as pd

NUMERIC = ['abv', 'volume_ml', 'drink_from', 'drink_to']
TIMES = ['ts', 'created_at', 'updated_at', 'out_at']
CATEGORY = {
    'red': 'wine', 'white': 'wine', 'rose': 'wine', 'orange': 'wine', 'sparkling': 'wine',
    'sweet': 'wine', 'fortified': 'wine', 'whisky': 'spirit', 'rum': 'spirit', 'brandy': 'spirit',
    'gin': 'spirit', 'agave': 'spirit', 'other_spirit': 'spirit', 'other': 'other',
}


def _post(url: str, key: str, body: dict, timeout: float = 120) -> dict:
    data = json.dumps({**body, 'key': key}).encode()
    req = urllib.request.Request(url, data=data, method='POST', headers={'Content-Type': 'text/plain'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read())
    if not out.get('ok'):
        raise RuntimeError(out.get('error', 'backend error'))
    return out


def _typed(df: pd.DataFrame, tz: str) -> pd.DataFrame:
    df = df.copy()
    for c in NUMERIC:
        if c in df:
            df[c] = pd.to_numeric(df[c], errors='coerce')
    for c in TIMES:
        if c in df:
            df[c] = pd.to_datetime(df[c].replace('', None), utc=True, errors='coerce').dt.tz_convert(tz)
    if 'acquired_date' in df:
        df['acquired_date'] = pd.to_datetime(df['acquired_date'].replace('', None), errors='coerce')
    return df


def load(url: str | None = None, key: str | None = None, climate_days: int = 90,
         raw_climate: bool = False, tz: str = 'Europe/Berlin') -> dict[str, pd.DataFrame]:
    url = url or os.environ['CELLAR_URL']
    key = key or os.environ['CELLAR_KEY']
    snap = _post(url, key, {'action': 'sync', 'ops': []})['snapshot']
    products = _typed(pd.DataFrame(snap['products']), tz)
    bottles = _typed(pd.DataFrame(snap['bottles']), tz)
    events = _typed(pd.DataFrame(snap['events']), tz)
    if not products.empty:
        products['category'] = products['type'].map(CATEGORY).fillna('other')

    joined = bottles.merge(products, on='product_id', how='left', suffixes=('', '_product'))
    stock = joined[joined['status'] == 'in_stock'].reset_index(drop=True) if not joined.empty else joined
    taken_out = joined[joined['status'] == 'out'].reset_index(drop=True) if not joined.empty else joined

    cl = _post(url, key, {'action': 'climate_get', 'days': climate_days, 'raw': raw_climate})
    climate = pd.DataFrame(cl['series'])
    if not climate.empty:
        if cl['bucket'] == 'raw':
            climate['t'] = pd.to_datetime(climate['t'], utc=True).dt.tz_convert(tz)
        else:
            climate['t'] = pd.to_datetime(climate['t']).dt.tz_localize(cl.get('tz') or tz, ambiguous='NaT', nonexistent='NaT')
        climate = climate.replace('', pd.NA)
        for c in ['temp', 'temp_min', 'temp_max', 'rh', 'rh_min', 'rh_max']:
            climate[c] = pd.to_numeric(climate[c], errors='coerce')
        climate.attrs['bucket'] = cl['bucket']

    return {'products': products, 'bottles': bottles, 'events': events,
            'stock': stock, 'taken_out': taken_out, 'climate': climate}


def main() -> None:
    ap = argparse.ArgumentParser(description='Load the cellar from the Apps Script backend.')
    ap.add_argument('--url', default=os.environ.get('CELLAR_URL'))
    ap.add_argument('--key', default=os.environ.get('CELLAR_KEY'))
    ap.add_argument('--climate-days', type=int, default=90)
    ap.add_argument('--raw-climate', action='store_true')
    ap.add_argument('--csv', metavar='DIR', help='write every table as CSV into DIR')
    a = ap.parse_args()
    d = load(a.url, a.key, a.climate_days, a.raw_climate)
    for name, df in d.items():
        print(f'{name:12s} {len(df):6d} rows')
    s = d['stock']
    if not s.empty:
        print('\nIn stock by category and type:')
        print(s.groupby(['category', 'type']).size().to_string())
    if a.csv:
        os.makedirs(a.csv, exist_ok=True)
        for name, df in d.items():
            df.to_csv(os.path.join(a.csv, f'{name}.csv'), index=False)
        print(f'\nCSV files written to {a.csv}')


if __name__ == '__main__':
    main()
