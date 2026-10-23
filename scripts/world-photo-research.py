#!/usr/bin/env python3
"""Discover attributable Commons photographs used by the world destination pages.

Run ``discover`` to cache Wikipedia image lists, then ``metadata`` to resolve
Commons image licenses and source URLs. Caches are source evidence, not UI data.
"""
import concurrent.futures
import html
import json
import pathlib
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
CACHE = ROOT / 'scripts/world-photo-sources'
CACHE.mkdir(exist_ok=True)
HEADERS = {'User-Agent': 'ShanheWorldAtlas/1.0 (educational geography; Commons attribution)'}


def api(host, params):
    url = f'https://{host}/w/api.php?' + urllib.parse.urlencode(params)
    for attempt in range(4):
        try:
            response = subprocess.run(['curl', '--fail', '--silent', '--show-error',
                '--location', '--max-time', '35', '--user-agent', HEADERS['User-Agent'], url],
                check=True, capture_output=True, text=True, timeout=40)
            return json.loads(response.stdout)
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 + attempt * 3)


def save(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def plain(value):
    return ' '.join(html.unescape(re.sub('<[^>]+>', ' ', str(value or ''))).split())


def discover(place):
    path = CACHE / (place['id'] + '.json')
    if path.exists():
        return json.loads(path.read_text())
    data = api('en.wikipedia.org', {'action': 'query', 'format': 'json',
        'prop': 'pageimages|images', 'titles': place['wikipedia'],
        'pithumbsize': 1600, 'pilimit': 1, 'imlimit': 100, 'redirects': 1})
    page = next(iter(data['query']['pages'].values()))
    result = {**place, 'wikipediaTitle': page['title'],
              'primary': page.get('pageimage'), 'images': page.get('images', [])}
    save(path, result)
    return result


def metadata(titles):
    data = api('commons.wikimedia.org', {'action': 'query', 'format': 'json',
        'prop': 'imageinfo', 'titles': '|'.join(titles),
        'iiprop': 'url|size|mime|extmetadata', 'iiurlwidth': 1600, 'redirects': 1})
    return list(data['query']['pages'].values())


if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'discover':
        places = json.loads((ROOT / 'scripts/world-manifest.json').read_text())
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(discover, places))
        for place in results:
            print(place['id'], '|', place['primary'], '|', len(place['images']))
    elif mode == 'discover-batch':
        places = [p for p in json.loads((ROOT / 'scripts/world-manifest.json').read_text())
                  if not (CACHE / (p['id'] + '.json')).exists()]
        if not places:
            raise SystemExit('All destination source pages already cached.')
        params = {'action': 'query', 'format': 'json', 'prop': 'pageimages|images',
                  'titles': '|'.join(p['wikipedia'] for p in places), 'redirects': 1,
                  'pilimit': 50, 'pithumbsize': 1600, 'imlimit': 500}
        collected = {}
        for _ in range(8):
            data = api('en.wikipedia.org', params)
            for page in data['query']['pages'].values():
                if page['title'] not in collected:
                    collected[page['title']] = {**page, 'images': []}
                collected[page['title']]['images'].extend(page.get('images', []))
            if 'continue' not in data:
                break
            params.update(data['continue'])
        for place in places:
            page = collected.get(place['wikipedia'])
            if page:
                result = {**place, 'wikipediaTitle': page['title'],
                          'primary': page.get('pageimage'), 'images': page['images']}
                save(CACHE / (place['id'] + '.json'), result)
                print(place['id'], '|', result['primary'], '|', len(result['images']))
    elif mode == 'metadata':
        chosen = json.loads((CACHE / 'candidates.json').read_text())
        unique = list(dict.fromkeys(title for titles in chosen.values() for title in titles))
        batches = [unique[i:i+30] for i in range(0, len(unique), 30)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            results = [page for batch in pool.map(metadata, batches) for page in batch]
        save(CACHE / 'metadata.json', {p['title']: p for p in results})
        for page in results:
            info = page.get('imageinfo', [{}])[0]
            ext = info.get('extmetadata', {})
            print(page['title'], '|', plain(ext.get('LicenseShortName', {}).get('value', 'MISSING')),
                  '|', info.get('width'), info.get('height'))
