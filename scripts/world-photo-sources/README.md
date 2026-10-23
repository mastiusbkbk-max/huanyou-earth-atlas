# World photography sources

The reviewed package contains 118 destination covers, 118 distinct detail photographs,
and 118 cover thumbnails. All are real Wikimedia Commons photographs; none are
generated. The public manifests are `public/data/photo-sources-world.json` and
`public/data/detail-photos-world.json`.

## Source and license evidence

- `selection.json`: reviewed file selections, detail captions and alternative text,
  explicit license choices where required, and visual review notes.
- `metadata.json`: cached Commons imageinfo and extmetadata responses, including
  research candidates that are not necessarily selected.
- `license-pages.json`: raw source wikitext, revision IDs and timestamps.
- `license-wrapper-pages.json`: source revisions for custom license wrappers.
- `license-evidence.json`: exactly 236 currently selected titles, each with author,
  license, license URL, literal-template evidence, stable source revision URL and
  an empty `errors` list after a successful audit.
- `validation.json`: generated package consistency report.

License labels come from explicit source templates and reviewed wrapper templates.
Noncommercial and no-derivative licenses are rejected. No selected image relies
on a Public Domain label.

The Eiffel Tower cover (`Tour Eiffel Wikimedia Commons.jpg`) has separate rights
for the architecture and photograph. Its `Licensed-PD` source template marks the
architecture as public domain and the photograph by Benh LIEU SONG as
**CC BY-SA 3.0**. The public manifest uses the photographic license, not the
misleading aggregate Public Domain value in machine metadata.

The Rio cover by Arne Müseler requires the attribution
**Arne Müseler / www.arne-mueseler.com**. Render `attribution || author` in credits
and retain its `authorUrl`; using only the shorter author field omits the source's
requested credit text. Its selected license is CC BY-SA 3.0 de.

The Bwindi cover by Ron Van Oers uses **CC BY-SA 3.0 IGO**, explicitly declared
by `{{cc-by-sa-3.0-igo}}` in Commons revision 894953266. Its machine metadata
omits the license tag, so the selection records a reviewed override with that
literal source evidence and the IGO-specific license URL. The displayed suffix
is normalized to uppercase; this does not change the license version or terms.

## Rebuild and audit

Run from the project root with Python 3 and Pillow installed:

```sh
python3 scripts/world-photo-audit.py
python3 scripts/world-photo-build.py
python3 scripts/world-photo-contact.py
python3 scripts/world-photo-contact.py --expansion
python3 scripts/world-photo-validate.py
```

Complete caches allow the audit and build to run offline. Missing sources require
network access. The builder retains existing local JPEGs; after changing a file
selection, remove only that destination's old cover or detail JPEG before rebuilding.
Do not run the research script's legacy `metadata` mode over the final metadata
cache: that mode is for candidate discovery.

The builder applies EXIF orientation, fits originals within 1920 × 1920 without
upscaling, and recompresses JPEGs at quality 86. It makes 480 px wide WebP cover
thumbnails at quality 82. It performs no cropping or generative editing. A few
secondary originals are lower resolution; original and local dimensions are
retained in the public records. Validation fully decodes all JPEGs and WebP
thumbnails, then checks dimensions, file sizes, distinct cover/detail bytes,
attribution, source revisions and license consistency.

## Visual review

The original 114 selected photographs were inspected on uncropped contact sheets
on 2026-10-22, and the 122 expansion photographs on 2026-10-23. Subject identity,
caption alignment and obvious visual quality were
checked against Commons source metadata. The current covers and details occupy
eight contact sheets each (`contact-world-covers-1.jpg` through `-8.jpg`, and the
matching detail files). The 61 new destinations also appear in four paired sheets
(`contact-world-expansion-1.jpg` through `-4.jpg`, cover then detail). This is
manual visual review, not an automated identity verification claim.

Cross-border context is explicit: the Kilimanjaro cover is photographed from
Amboseli National Park, Kenya, looking toward the mountain in Tanzania. Banff
photography is identified as Moraine Lake, the Sossusvlei detail as nearby
Deadvlei, and Iguazu as the Brazil–Argentina border.
