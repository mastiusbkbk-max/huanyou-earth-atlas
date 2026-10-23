#!/usr/bin/env python3
"""Validate the destination photographic package against audited sources."""
import hashlib
import json
import pathlib
import re

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
CACHE = ROOT / 'scripts/world-photo-sources'


def read(path):
    return json.loads(path.read_text())


places = read(ROOT / 'scripts/world-manifest.json')
ids = {place['id'] for place in places}
count = len(ids)
covers = read(ROOT / 'public/data/photo-sources-world.json')
details = read(ROOT / 'public/data/detail-photos-world.json')
evidence = read(CACHE / 'license-evidence.json')
selection = read(CACHE / 'selection.json')
detail_index = {record['id']: record for record in details}
assert len(covers) == len(details) == count
assert set(covers) == set(detail_index) == ids
assert len(evidence) == count * 2
assert {p['title'] for photos in selection.values() for p in photos} == set(evidence)
assert all(not p['errors'] and p['literalLicenseEvidence'] for p in evidence.values())
total_bytes = 0

for key in sorted(ids):
    cover, detail = covers[key], detail_index[key]
    assert cover['sourceUrl'] != detail['sourceUrl'], key
    hashes = []
    for index, record in enumerate((cover, detail)):
        audit = evidence['File:' + record['title']]
        for field in ['author', 'license', 'licenseUrl', 'sourceUrl',
                      'visualReview', 'licenseEvidenceUrl']:
            assert record.get(field), (key, index, field)
        assert re.match(r'^(CC BY(?:-SA)? |CC0)', record['license'])
        assert not re.search(r'NC|ND|Public domain', record['license'])
        assert record['license'] == audit['license']
        assert record['licenseEvidenceUrl'] == audit['sourceRevisionUrl']
        assert record['licenseUrl'].rstrip('/') == audit['licenseUrl'].rstrip('/')
        assert record['sourceUrl'] == audit['sourceUrl']
        path = ROOT / 'public' / record['file'].lstrip('/')
        raw = path.read_bytes()
        with Image.open(path) as picture:
            picture.load()
            assert picture.format == 'JPEG'
            assert picture.size == (record['width'], record['height'])
            assert max(picture.size) <= 1920
            assert record['width'] <= record['originalWidth']
            assert record['height'] <= record['originalHeight']
        assert len(raw) == record['bytes']
        total_bytes += len(raw)
        hashes.append(hashlib.sha256(raw).hexdigest())
        if index:
            assert record.get('caption') and record.get('alt')
    assert hashes[0] != hashes[1], key
    thumbnail = ROOT / 'public/images/thumbs' / (key + '.webp')
    with Image.open(thumbnail) as picture:
        picture.load()
        assert picture.format == 'WEBP' and picture.width == 480, key
    total_bytes += thumbnail.stat().st_size

assert covers['world-kilimanjaro']['location'] == '肯尼亚安博塞利国家公园，远望坦桑尼亚乞力马扎罗山'
assert covers['world-rio']['attribution'] == 'Arne Müseler / www.arne-mueseler.com'
smallest = min(covers.values(), key=lambda r: r['width'] * r['height'])
report = {
    'destinations': count, 'covers': count, 'details': count, 'thumbnails': count,
    'photographs': count * 2, 'licenseEvidenceEntries': len(evidence),
    'validationErrors': 0, 'totalPhotoAndThumbBytes': total_bytes,
    'totalPhotoAndThumbMiB': round(total_bytes / 1024 / 1024, 2),
    'smallestCoverByPixelArea': {key: smallest[key] for key in ['id', 'width', 'height']},
}
(CACHE / 'validation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(report, ensure_ascii=False, indent=2))
