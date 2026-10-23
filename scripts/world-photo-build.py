#!/usr/bin/env python3
"""Build reviewed world photographs and attribution manifests from Commons.

Selection and raw API metadata live in world-photo-sources/. Existing local JPEGs
are retained, allowing interrupted downloads to resume without re-downloading.
"""
import concurrent.futures
import datetime
import html
import importlib.util
import io
import json
import pathlib
import re
import subprocess
import sys

from PIL import Image, ImageOps

ROOT = pathlib.Path(__file__).resolve().parents[1]
CACHE = ROOT / 'scripts/world-photo-sources'
PUBLIC = ROOT / 'public'
spec = importlib.util.spec_from_file_location('research', ROOT / 'scripts/world-photo-research.py')
research = importlib.util.module_from_spec(spec)
spec.loader.exec_module(research)


def save(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def build(task):
    place, selected, index, page = task
    info = page['imageinfo'][0]
    ext = {k: research.plain(v['value']) for k, v in info['extmetadata'].items()}
    license_name = selected.get('reviewedLicense', ext.get('LicenseShortName', ''))
    license_url = selected.get('reviewedLicenseUrl', ext.get('LicenseUrl', '')).replace('http://', 'https://')
    author = ext.get('Artist', '')
    if not author or not license_url.startswith('https://'):
        raise ValueError(f'Incomplete explicit attribution: {page["title"]}')
    if 'reviewedLicense' in selected:
        raw = json.loads((CACHE / 'license-pages.json').read_text())[page['title']]['wikitext']
        if not selected.get('licenseBasis') or selected['reviewedLicenseTag'] not in raw.lower():
            raise ValueError(f'Reviewed license lacks literal source evidence: {page["title"]}')
    if not re.search(r'^(CC BY(?:-SA)? |CC0)', license_name) or re.search(r'NC|ND', license_name):
        raise ValueError(f'Unapproved license: {page["title"]}: {license_name}')
    title = page['title'].removeprefix('File:')
    name = place['id'] + '.jpg'
    relative = '/images/' + ('details/' if index else '') + name
    target = PUBLIC / relative.lstrip('/')
    target.parent.mkdir(exist_ok=True, parents=True)
    download_url = selected.get('downloadUrl', info.get('thumburl', info['url']))
    if not target.exists():
        response = subprocess.run(['curl', '--fail', '--silent', '--show-error',
            '--location', '--retry', '3', '--retry-all-errors', '--max-time', '60',
            '--user-agent', research.HEADERS['User-Agent'], download_url],
            check=True, capture_output=True, timeout=260)
        raw = response.stdout
        with Image.open(io.BytesIO(raw)) as picture:
            image = ImageOps.exif_transpose(picture).convert('RGB')
            image.thumbnail((1920, 1920), Image.Resampling.LANCZOS)
            image.save(target, 'JPEG', quality=86, optimize=True)
    with Image.open(target) as image:
        width, height = image.size
        if not index:
            thumb = PUBLIC / 'images/thumbs' / (place['id'] + '.webp')
            thumb.parent.mkdir(exist_ok=True, parents=True)
            image.thumbnail((480, 10000), Image.Resampling.LANCZOS)
            image.save(thumb, 'WEBP', quality=82, method=6)
    record = {
        'id': place['id'], 'location': place['name'], 'title': title,
        'sourceUrl': info.get('descriptionurl', 'https://commons.wikimedia.org/wiki/' + page['title'].replace(' ', '_')),
        'originalUrl': info['url'], 'downloadUrl': download_url,
        'author': author,
        'license': license_name,
        'licenseUrl': license_url,
        'credit': f'{title} — {selected.get("attribution", author)} · {license_name}',
        'file': relative, 'description': ext.get('ImageDescription', ''),
        'width': width, 'height': height, 'bytes': target.stat().st_size,
        'originalWidth': info['width'], 'originalHeight': info['height'],
        'modifications': 'EXIF orientation applied; resized to at most 1920 px on the longest side without upscaling and recompressed as JPEG. Cover also has a 480 px wide WebP thumbnail. No cropping or generative edits.',
        'retrievedAt': datetime.date.today().isoformat(),
        'mediaType': 'photograph',
    }
    for field in ['caption', 'alt', 'visualReview', 'attribution', 'authorUrl']:
        if field in selected:
            record[field] = selected[field]
    if selected.get('licenseBasis'):
        record['licenseBasis'] = selected['licenseBasis']
    audit_path = CACHE / 'license-evidence.json'
    if audit_path.exists():
        audit = json.loads(audit_path.read_text()).get(page['title'], {})
        if audit and not audit['errors']:
            record['licenseEvidenceUrl'] = audit['sourceRevisionUrl']
    if place['id'] == 'world-iguazu':
        record['location'] = '伊瓜苏瀑布，巴西与阿根廷边境'
    elif place['id'] == 'world-kilimanjaro' and not index:
        record['location'] = '肯尼亚安博塞利国家公园，远望坦桑尼亚乞力马扎罗山'
    elif place['id'] == 'world-banff':
        record['location'] = '班夫国家公园梦莲湖'
    elif place['id'] == 'world-sossusvlei' and index:
        record['location'] = '德德弗雷，索苏斯盐沼区域附近'
    print('Built', place['id'], 'detail' if index else 'cover', flush=True)
    return place['id'], index, record


if __name__ == '__main__':
    selection = json.loads((CACHE / 'selection.json').read_text())
    metadata_path = CACHE / 'metadata.json'
    metadata = json.loads(metadata_path.read_text()) if metadata_path.exists() else {}
    titles = list(dict.fromkeys(s['title'] for selected in selection.values() for s in selected))
    missing = [title for title in titles if title not in metadata]
    for start in range(0, len(missing), 15):
        for page in research.metadata(missing[start:start+15]):
            metadata[page['title']] = page
        save(metadata_path, metadata)
    places = json.loads((ROOT / 'scripts/world-manifest.json').read_text())
    tasks = [(place, s, i, metadata[s['title']]) for place in places if place['id'] in selection
             for i, s in enumerate(selection[place['id']])]
    covers, details, failures = {}, [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(build, task): (task[0]['id'], task[2]) for task in tasks}
        for future in concurrent.futures.as_completed(futures):
            try:
                key, index, record = future.result()
                if index:
                    details.append(record)
                else:
                    covers[key] = record
            except Exception as error:
                failures.append((futures[future], str(error)))
    order = {p['id']: i for i, p in enumerate(places)}
    covers = dict(sorted(covers.items(), key=lambda p: order[p[0]]))
    details.sort(key=lambda p: order[p['id']])
    save(PUBLIC / 'data/photo-sources-world.json', covers)
    save(PUBLIC / 'data/detail-photos-world.json', details)
    print(json.dumps({'covers': len(covers), 'details': len(details), 'failures': failures}, ensure_ascii=False))
    if failures:
        sys.exit(1)
