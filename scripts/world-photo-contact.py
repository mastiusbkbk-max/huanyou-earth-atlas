#!/usr/bin/env python3
"""Generate world-only, uncropped contact sheets for editorial visual review."""
import json
import pathlib
import sys

from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'scripts/world-photo-sources'
FONT = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 15)
if '--expansion' in sys.argv:
    places = json.loads((ROOT / 'scripts/world-expansion-manifest.json').read_text())
    records = [
        {'id': place['id'], 'kind': kind, 'file': '/images/' + ('details/' if kind == 'detail' else '') + place['id'] + '.jpg'}
        for place in places for kind in ['cover', 'detail']
        if (ROOT / 'public/images' / ('details/' if kind == 'detail' else '') / (place['id'] + '.jpg')).exists()
    ]
    for start in range(0, len(records), 32):
        sheet = Image.new('RGB', (1440, 2000), '#f2f2ec')
        draw = ImageDraw.Draw(sheet)
        for i, entry in enumerate(records[start:start+32]):
            x, y = i % 4 * 360, i // 4 * 250
            with Image.open(ROOT / 'public' / entry['file'].lstrip('/')) as photo:
                photo = ImageOps.contain(photo, (350, 215))
                sheet.paste(photo, (x + (360 - photo.width) // 2, y + (215 - photo.height) // 2))
            draw.text((x + 5, y + 222), entry['id'] + ' | ' + entry['kind'], font=FONT, fill='#222222')
        target = OUTPUT / f'contact-world-expansion-{start // 32 + 1}.jpg'
        sheet.save(target, 'JPEG', quality=92)
        print(target)
    print(f'{len(records)} of {len(places) * 2} expansion photographs available')
    raise SystemExit

for kind, name in [('covers', 'photo-sources-world.json'), ('details', 'detail-photos-world.json')]:
    data = json.loads((ROOT / 'public/data' / name).read_text())
    records = list(data.values()) if isinstance(data, dict) else data
    for start in range(0, len(records), 16):
        sheet = Image.new('RGB', (1280, 940), '#f2f2ec')
        draw = ImageDraw.Draw(sheet)
        for i, entry in enumerate(records[start:start+16]):
            x, y = i % 4 * 320, i // 4 * 235
            with Image.open(ROOT / 'public' / entry['file'].lstrip('/')) as photo:
                photo = ImageOps.contain(photo, (310, 195))
                sheet.paste(photo, (x + (320-photo.width)//2, y + (195-photo.height)//2))
            draw.text((x+5, y+201), entry['id'], font=FONT, fill='#222222')
        target = OUTPUT / f'contact-world-{kind}-{start//16+1}.jpg'
        sheet.save(target, 'JPEG', quality=90)
        print(target)
