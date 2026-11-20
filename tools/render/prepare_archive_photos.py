#!/usr/bin/env python3
"""Rebuild the pilot from verified Wikimedia Commons original photographs.

Requires Pillow; does not modify the GLB or rendered preview inventory.
"""
from hashlib import sha1, sha256
from html import unescape
from io import BytesIO
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[2]
ARCHIVE = ROOT / 'assets/archive'
USER_AGENT = 'VELANCE photo archive/1.0 (personal educational project)'
# Each selected image was visually inspected; known author/license are pinned.
SELECTION = [
    ('tourbillon24', 'front', 'Front three-quarter', 'Silver-blue Bugatti Tourbillon displayed outdoors at Chantilly, front three-quarter view', 'Bugatti Tourbillon - 01.jpg', 'Y.Leclercq', 'CC BY-SA 4.0'),
    ('tourbillon24', 'rear', 'Rear three-quarter', 'Silver-blue Bugatti Tourbillon rear light bar and diffuser at Chantilly', 'Bugatti Tourbillon - 02.jpg', 'Y.Leclercq', 'CC BY-SA 4.0'),
    ('tourbillon24', 'profile', 'Side profile', 'Silver-blue Bugatti Tourbillon in full side profile outside the Bugatti pavilion at Chantilly', 'Bugatti Tourbillon - 03.jpg', 'Y.Leclercq', 'CC BY-SA 4.0'),
    ('tourbillon24', 'cockpit', 'Cockpit', 'Bugatti Tourbillon tan cockpit with its mechanical instrument cluster and steering wheel', 'Bugatti Tourbillon I.jpg', 'Sokrates 399', 'CC BY-SA 4.0'),
    ('mclarenp1', 'night', 'Night portrait', 'Orange McLaren P1 in race mode parked outside an illuminated building at night', 'Volcano Orange McLaren P1 (18852267050).jpg', 'Axion23', 'CC BY 2.0'),
    ('mclarenp1', 'motion', 'In motion', 'Azure blue McLaren P1 driving past a blurred roadside background', 'Azure Blue McLaren P1 Driving (14193637588).jpg', 'Axion23', 'CC BY 2.0'),
    ('mclarenp1', 'coast', 'Coastal portrait', 'Black McLaren P1 with both doors raised beside the Monterey coastline', 'Black McLaren P1 on 17 Mile Drive (20744898595).jpg', 'Axion23', 'CC BY 2.0'),
    ('mclarenp1', 'rear', 'Rear three-quarter', 'Orange 2014 McLaren P1 leaving the Greenwich Concours, showing its raised rear wing', '2014 McLaren P1 (Volcano Orange, rear left), leaving Greenwich 2018.jpg', 'Mr.choppers', 'CC BY-SA 3.0'),
]


def fetch(url):
    try:
        with urlopen(Request(url, headers={'User-Agent': USER_AGENT}), timeout=90) as response:
            return response.read()
    except HTTPError as error:
        if error.code == 429:
            raise RuntimeError(f'Wikimedia rate limit: wait at least {error.headers.get("Retry-After", "the server-specified interval")} seconds before retrying {url}') from error
        raise


def metadata_value(metadata, key):
    return unescape(re.sub(r'<[^>]+>', '', metadata.get(key, {}).get('value', ''))).strip()


def make_photo(item, pages, rendition=False):
    car, slug, label, alt, title, author, license_name = item
    info = pages['File:' + title]['imageinfo'][0]
    meta = info['extmetadata']
    assert metadata_value(meta, 'Artist') == author, title
    assert metadata_value(meta, 'LicenseShortName') == license_name, title
    license_url = metadata_value(meta, 'LicenseUrl')
    assert license_url.startswith('https://creativecommons.org/licenses/'), title
    assert info['mime'] == 'image/jpeg', title
    # imageinfo includes marketing query parameters; use the canonical media URL.
    parts = urlsplit(info['url'])
    original_url = urlunsplit((parts.scheme, parts.netloc, parts.path, '', ''))
    input_url = info['thumburl'] if rendition else original_url
    blob = fetch(input_url)
    if not rendition:
        assert len(blob) == info['size'], title
        assert sha1(blob).hexdigest() == info['sha1'], title
    with Image.open(BytesIO(blob)) as original:
        if rendition:
            # Commons rounds requested widths to cached thumbnail buckets. The
            # API's thumbwidth may describe the request, not the returned JPEG.
            bucket = re.search(r'/(\d+)px-', urlsplit(input_url).path)
            expected_width = int(bucket.group(1)) if bucket else info['thumbwidth']
            assert original.width == expected_width, (title, original.width, expected_width)
            assert abs(original.height - original.width * info['height'] / info['width']) <= 2, title
            expected = original.size
        else:
            expected = (info['width'], info['height'])
            assert original.size == expected, (title, original.size, expected)
        assert original.width <= info['width'] and original.height <= info['height'], title
        photo = ImageOps.exif_transpose(original).convert('RGB')
    folder = ARCHIVE / car
    folder.mkdir(parents=True, exist_ok=True)
    variants = {}
    # Preserve the original framing. No upscale, crop, grade or compositing.
    for key, cap, quality in [('thumb', 640, 82), ('medium', 1600, 86), ('full', 3200, 90)]:
        width = min(cap, photo.width)
        existing = next((v for v in variants.values() if v['width'] == width), None)
        if existing:
            variants[key] = existing
            continue
        height = round(photo.height * width / photo.width)
        rendered = photo.resize((width, height), Image.Resampling.LANCZOS) if width != photo.width else photo
        path = folder / f'{slug}-{width}.webp'
        rendered.save(path, 'WEBP', quality=quality, method=6)
        variants[key] = {'path': './' + path.relative_to(ROOT).as_posix(), 'width': width, 'height': height, 'bytes': path.stat().st_size, 'sha256': sha256(path.read_bytes()).hexdigest()}
    record = dict(label=label, alt=alt, **{k: v['path'] for k, v in variants.items()}, width=variants['full']['width'], height=variants['full']['height'], source=info['descriptionurl'], author=author, license=license_name, licenseUrl=license_url)
    evidence = dict(title=title, original_url=original_url, original_sha256=None if rendition else sha256(blob).hexdigest(), original_sha1=info['sha1'], original_width=info['width'], original_height=info['height'], input_url=input_url, input_sha256=sha256(blob).hexdigest(), input_width=expected[0], input_height=expected[1], variants=variants)
    print(car, slug, [(k, v['width'], v['height'], v['bytes']) for k, v in variants.items()], flush=True)
    return car, record, evidence


def main():
    query = dict(action='query', format='json', prop='imageinfo', iiprop='url|size|extmetadata|mime|sha1', titles='|'.join('File:' + x[4] for x in SELECTION))
    responses = json.loads(fetch('https://commons.wikimedia.org/w/api.php?' + urlencode(query)))
    pages = {p['title']: p for p in responses['query']['pages'].values()}
    # Serial acquisition reduces load on Wikimedia upload servers.
    results = [make_photo(item, pages) for item in SELECTION]
    archive = {}
    for car, record, _ in results:
        archive.setdefault(car, []).append(record)
    manifest = ROOT / 'src/data/photo-archive.js'
    manifest.write_text('// Generated by tools/render/prepare_archive_photos.py.\n// Actual photographs only; display author, source, license and modification notice.\nexport const PHOTO_ARCHIVE = ' + json.dumps(archive, ensure_ascii=False, indent=2) + ';\n', encoding='utf-8')
    doc = ['# VÉLANCE — pilot photo archive sources', '', 'Verified against Wikimedia Commons imageinfo original-file records and visually inspected on 2026-11-18. These are photographs of real cars, not interactive GLB renders or generated images. The photographed cars may have different colors/configurations from the showroom model. Tourbillon photos show the exhibited vehicle in 2024; no claim of a customer production car is made.', '', 'All variant files are redistributed under their individually listed source licenses. Display photographer credit, source and license link for each photograph, plus a notice that the image was resized and WebP-encoded. CC BY-SA photos and their derivatives retain the same listed license; this does not assign that license to independent website code. No claim is made about vehicle trademarks or other non-copyright rights.', '', 'Processing: EXIF orientation correction when needed, RGB conversion, proportional downsampling with Lanczos to maximum widths of 640, 1600 and 3200 pixels, WebP encoding. No cropping, compositing, background replacement, grading, or upscaling. For a source narrower than a target, reuse the largest existing variant. `width`/`height` in the manifest describe the viewer file. Original JPEGs are fetched from Commons, verified against its SHA-1 and size, and not committed.', '', '## Source records', '']
    for car, record, e in results:
        doc.extend([f'### {car} — {record["label"]}', '', f'- [{e["title"]}]({record["source"]}) — {record["author"]}, [{record["license"]}]({record["licenseUrl"]}).', f'- [Original JPEG]({e["original_url"]}); {e["original_width"]} × {e["original_height"]} px; SHA-256 `{e["original_sha256"]}`.', f'- Description: {record["alt"]}.', '', '| Variant | File | Pixels | Bytes | SHA-256 |', '| --- | --- | ---: | ---: | --- |'])
        for key, v in e['variants'].items():
            doc.append(f'| {key} | `{v["path"]}` | {v["width"]} × {v["height"]} | {v["bytes"]} | `{v["sha256"]}` |')
        doc.append('')
    doc.extend(['## Coverage and reproduction', '', 'The pilot covers `tourbillon24` and `mclarenp1` only. The remaining 14 vehicle entries have no verified photographic archive here. Do not relabel existing rendered previews as photographs. The P1 night photograph is the same original used previously in the archived landing hero; the archive uses independent, uncropped variants.', '', 'Run `python3 tools/render/prepare_archive_photos.py` with Pillow installed and Wikimedia Commons accessible to reproduce the files and manifest. Source checks fail closed if author, license, mime, downloaded hash or dimensions differ.'])
    (ROOT / 'docs/frontend-photo-sources.md').write_text('\n'.join(doc) + '\n', encoding='utf-8')


def local_pilot():
    """Use the previously verified local P1 photograph when download is blocked."""
    import shutil
    hero = ROOT / 'assets/hero/mclaren-p1-photo-desktop.webp'
    folder = ARCHIVE / 'mclarenp1'
    folder.mkdir(parents=True, exist_ok=True)
    with Image.open(hero) as original:
        assert original.size == (3200, 2000)
        photo = original.convert('RGB')
    record = dict(label='Night portrait', alt='Orange McLaren P1 in race mode parked outside an illuminated building at night', width=3200, height=2000,
                  source='https://commons.wikimedia.org/wiki/File:Volcano_Orange_McLaren_P1_(18852267050).jpg', author='Axion23', license='CC BY 2.0', licenseUrl='https://creativecommons.org/licenses/by/2.0/')
    lines = ['# VÉLANCE — pilot photo archive sources', '', '## Locally retained P1 night portrait', '', 'The exact 3200 × 2000 WebP source is the previously credited local asset `assets/hero/mclaren-p1-photo-desktop.webp` (see `docs/hero-photo-credit.md`). Original: [Volcano Orange McLaren P1](https://commons.wikimedia.org/wiki/File:Volcano_Orange_McLaren_P1_(18852267050).jpg) by Axion23, [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/). Prior recorded JPEG resolution 5763 × 3842, SHA-256 `d602ddd7c6fbd3f69ee2b2dbb02e16c12cbb0ea43403a357c1d76c021008ddc6`. The prior asset has framing/crop, contrast and sharpening changes. This preparation makes smaller proportional WebP derivatives without further grading; the full variant is copied byte-for-byte.', '', 'Display attribution, license, source link and modification notice. The photographed car is independent of the interactive model and paint selector.', '', '| Variant | File | Pixels | Bytes | SHA-256 |', '| --- | --- | ---: | ---: | --- |']
    for key, width, quality in [('thumb', 640, 82), ('medium', 1600, 86), ('full', 3200, 90)]:
        height = round(2000 * width / 3200)
        path = folder / f'night-{width}.webp'
        if key == 'full':
            shutil.copyfile(hero, path)
        else:
            photo.resize((width, height), Image.Resampling.LANCZOS).save(path, 'WEBP', quality=quality, method=6)
        rel = './' + path.relative_to(ROOT).as_posix()
        record[key] = rel
        lines.append(f'| {key} | `{rel}` | {width} × {height} | {path.stat().st_size} | `{sha256(path.read_bytes()).hexdigest()}` |')
    lines.extend(['', '## Verified source candidates — not yet included', '', 'Commons imageinfo metadata and 640-pixel previews were checked and visually inspected on 2026-11-18. Original-file downloads returned HTTP 429 with Retry-After 120 seconds, also after a cooldown. The original-publisher Flickr image URLs returned HTTP 403. No unavailable candidate is in the application manifest. No rendered or generated image is labeled a photo.', '', '| Vehicle / view | Wikimedia file | Author | License |', '| --- | --- | --- | --- |'])
    from urllib.parse import quote
    for car, slug, label, _, title, author, license_name in SELECTION:
        if car == 'mclarenp1' and slug == 'night':
            continue
        license_url = 'https://creativecommons.org/licenses/' + ('by-sa/' if 'BY-SA' in license_name else 'by/') + license_name.split()[-1] + '/'
        lines.append(f'| {car} / {label} | [{title}](https://commons.wikimedia.org/wiki/File:{quote(title.replace(" ", "_"), safe="")}) | {author} | [{license_name}]({license_url}) |')
    lines.extend(['', '## Reproduction', '', 'Run `python3 tools/render/prepare_archive_photos.py --local-p1` to rebuild the current local pilot without network access. Run the same script without an argument only when Commons original downloads are available; it verifies source author, license, size, SHA-1 and dimensions before generating additional variants. The Tourbillon and all other absent albums must stay in the unavailable state until assets are actually acquired.'])
    (ROOT / 'src/data/photo-archive.js').write_text('// Generated from previously verified local P1 photographic asset.\nexport const PHOTO_ARCHIVE = ' + json.dumps({'mclarenp1': [record]}, ensure_ascii=False, indent=2) + ';\n', encoding='utf-8')
    (ROOT / 'docs/frontend-photo-sources.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return record, lines[:lines.index('## Verified source candidates — not yet included')]


def published_pilot():
    """Use approved Commons published JPEG renditions without claiming original quality."""
    night, doc = local_pilot()
    remaining = [item for item in SELECTION if item[:2] != ('mclarenp1', 'night')]
    pages = {}
    for width, items in [(1600, [item for item in remaining if item[1] != 'cockpit']), (960, [item for item in remaining if item[1] == 'cockpit'])]:
        query = dict(action='query', format='json', prop='imageinfo', iiprop='url|size|extmetadata|mime|sha1', iiurlwidth=width, titles='|'.join('File:' + x[4] for x in items))
        responses = json.loads(fetch('https://commons.wikimedia.org/w/api.php?' + urlencode(query)))
        pages.update({p['title']: p for p in responses['query']['pages'].values()})
    archive = {'mclarenp1': [night]}
    doc.extend(['## Additional verified photographs', '', 'Commons original JPEG downloads returned HTTP 429; direct Flickr image downloads returned HTTP 403. After the indicated cooldown, the official Commons imageinfo API returned downloadable published JPEG renditions (requested width 1600, or 960 for the cockpit; actual rendition dimensions listed below). Commons uses cached width buckets; decoded dimensions were checked against the filename width and source aspect ratio. Original file dimensions and SHA-1 are metadata only; the original bytes were not acquired or independently hashed. The retrieved rendition has its own SHA-256. Output width is capped at the retrieved width, preserving framing, with no upscaling. CC BY-SA images and their resized derivatives retain their listed share-alike licenses.', ''])
    failures = []
    for index, item in enumerate(remaining):
        try:
            car, record, e = make_photo(item, pages, rendition=True)
        except Exception as error:
            failures.append((item, str(error)))
            print(f'FAILED {item[4]}: {error}', flush=True)
            if isinstance(error, RuntimeError) and 'rate limit' in str(error):
                failures.extend((later, 'not requested after rate limit') for later in remaining[index+1:])
                break
            continue
        archive.setdefault(car, []).append(record)
        doc.extend([f'### {car} — {record["label"]}', '', f'- [{e["title"]}]({record["source"]}) — {record["author"]}, [{record["license"]}]({record["licenseUrl"]}).', f'- [Original file]({e["original_url"]}) (not downloaded); {e["original_width"]} × {e["original_height"]} px; Commons SHA-1 `{e["original_sha1"]}`.', f'- [Acquired JPEG rendition]({e["input_url"]}); {e["input_width"]} × {e["input_height"]} px; SHA-256 `{e["input_sha256"]}`.', f'- Description: {record["alt"]}.', '', '| Variant | File | Pixels | Bytes | SHA-256 |', '| --- | --- | ---: | ---: | --- |'])
        for key, v in e['variants'].items():
            doc.append(f'| {key} | `{v["path"]}` | {v["width"]} × {v["height"]} | {v["bytes"]} | `{v["sha256"]}` |')
        doc.append('')
    if failures:
        doc.extend(['## Unavailable candidates (not in manifest)', ''])
        for item, error in failures:
            doc.append(f'- {item[4]} — {item[5]}, {item[6]}: {error}')
        doc.append('')
    doc.extend(['## Coverage and reproduction', '', f'Available photo counts: {", ".join(f"{car}: {len(records)}" for car, records in archive.items())}. Other entries have no verified photographic archive. Never label rendered previews as photographs.', '', 'Run `python3 tools/render/prepare_archive_photos.py --published-renditions` to rebuild this pilot. `--local-p1` restores the single local P1 photo without a network; the default mode requires original JPEG access.'])
    (ROOT / 'src/data/photo-archive.js').write_text('// Generated by tools/render/prepare_archive_photos.py.\n// Actual photographs only; source and license attribution required.\nexport const PHOTO_ARCHIVE = ' + json.dumps(archive, ensure_ascii=False, indent=2) + ';\n', encoding='utf-8')
    (ROOT / 'docs/frontend-photo-sources.md').write_text('\n'.join(doc) + '\n', encoding='utf-8')


if __name__ == '__main__':
    if sys.argv[1:] == ['--local-p1']:
        local_pilot()
    elif sys.argv[1:] == ['--published-renditions']:
        published_pilot()
    else:
        main()
