#!/usr/bin/env python3
"""Capture Commons revision evidence and audit all selected world image licenses.

This deliberately accepts no inferred public-domain status, author, or license
URL. Wrapper templates without a literal license tag are left for manual review.
"""
import importlib.util
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]
CACHE = ROOT / 'scripts/world-photo-sources'
spec = importlib.util.spec_from_file_location('research', ROOT / 'scripts/world-photo-research.py')
research = importlib.util.module_from_spec(spec)
spec.loader.exec_module(research)
selection = json.loads((CACHE / 'selection.json').read_text())
metadata = json.loads((CACHE / 'metadata.json').read_text())
titles = list(dict.fromkeys(s['title'] for values in selection.values() for s in values))
selected_by_title = {s['title']: s for values in selection.values() for s in values}
raw_path = CACHE / 'license-pages.json'
raw = json.loads(raw_path.read_text()) if raw_path.exists() else {}
missing = [title for title in titles if title not in raw]
for start in range(0, len(missing), 20):
    data = research.api('commons.wikimedia.org', {
        'action': 'query', 'format': 'json', 'prop': 'revisions', 'redirects': 1,
        'titles': '|'.join(missing[start:start+20]), 'rvprop': 'ids|content|timestamp',
        'rvslots': 'main',
    })
    for page in data['query']['pages'].values():
        revision = page.get('revisions', [{}])[0]
        raw[page['title']] = {
            'pageId': page['pageid'], 'revisionId': revision.get('revid'),
            'timestamp': revision.get('timestamp'),
            'wikitext': revision.get('slots', {}).get('main', {}).get('*', ''),
        }
    research.save(raw_path, raw)

evidence = {}
wrappers_path = CACHE / 'license-wrapper-pages.json'
wrappers = json.loads(wrappers_path.read_text())['query']['pages'].values() if wrappers_path.exists() else []
wrapper_text = {p['title']: p.get('revisions', [{}])[0].get('slots', {}).get('main', {}).get('*', '') for p in wrappers}
for title in titles:
    page = raw.get(title, {})
    text = page.get('wikitext', '')
    info = metadata.get(title, {}).get('imageinfo', [{}])[0]
    ext = {k: research.plain(v['value']) for k, v in info.get('extmetadata', {}).items()}
    selected = selected_by_title[title]
    license_name = selected.get('reviewedLicense', ext.get('LicenseShortName', ''))
    license_tag = selected.get('reviewedLicenseTag', ext.get('License', ''))
    author = ext.get('Artist', '')
    license_url = selected.get('reviewedLicenseUrl', ext.get('LicenseUrl', ''))
    expected_tag = license_tag.lower().replace('_', '-')
    literal = expected_tag and expected_tag in text.lower().replace('_', '-')
    proof = 'literal-license-tag' if literal else ''
    if license_name == 'CC0' and re.search(r'\{\{(?:self\|)?cc-?zero\b', text, re.I):
        literal, proof = True, 'explicit-cc-zero-template'
    if not literal and 'cc-by-sa-all' in text.lower() and expected_tag == 'cc-by-sa-4.0':
        template = wrapper_text.get('Template:Cc-by-sa-4.0,3.0,2.5,2.0,1.0', '')
        if 'recversion=4.0' in template:
            literal, proof = True, 'explicit-cc-by-sa-all-template-offers-4.0'
    for template in ['User:Argenberg/License', 'User:Stan Shebs/License']:
        aliases = [template, 'Stan Shebs photo'] if 'Stan Shebs' in template else [template]
        if not literal and any('{{' + a.lower() + '}}' in text.lower() for a in aliases):
            if expected_tag in wrapper_text.get(template, '').lower():
                literal, proof = True, 'verified-author-license-template:' + template
    if not literal and '{{template:arnemueselercredit}}' in text.lower():
        template = 'User:Arne Müseler/License'
        if expected_tag in wrapper_text.get(template, '').lower():
            literal, proof = True, 'verified-author-license-template:' + template
    templates = list(dict.fromkeys(re.findall(r'\{\{\s*([^{}|\n]+)', text)))
    errors = []
    if not author:
        errors.append('missing-author')
    if not license_url.startswith(('http://', 'https://')):
        errors.append('missing-license-url')
    if not re.match(r'^(CC BY(?:-SA)? |CC0)', license_name):
        errors.append('unaccepted-or-incomplete-license')
    if not literal:
        errors.append('manual-template-review-required')
    evidence[title] = {
        'author': author, 'license': license_name, 'licenseTag': license_tag,
        'licenseUrl': license_url.replace('http://', 'https://'),
        'sourceUrl': info.get('descriptionurl'), 'revisionId': page.get('revisionId'),
        'sourceRevisionUrl': 'https://commons.wikimedia.org/w/index.php?oldid=' + str(page.get('revisionId')),
        'templates': templates, 'literalLicenseEvidence': bool(literal),
        'licenseProof': proof,
        'attribution': selected.get('attribution', author),
        'errors': errors,
    }
research.save(CACHE / 'license-evidence.json', evidence)
issues = {title: e['errors'] for title, e in evidence.items() if e['errors']}
print(json.dumps({'images': len(evidence), 'issues': issues}, ensure_ascii=False, indent=2))
