#!/usr/bin/env python3
"""Bounded same-photograph upgrade of the five eligible pilot secondary views.

Acquire published renditions only, compare against current images, then apply.
No retry of original-file hosts and no enlargement of source pixels.
"""
import argparse
import fcntl
import json
import re
import time
from html import unescape
from io import BytesIO
from urllib.error import HTTPError
from urllib.parse import unquote, urlencode, urlsplit
from PIL import Image, ImageOps, ImageDraw
from upgrade_pilot_archive import ROOT, MANIFEST, DOC, catalog, fetch, digest

STAGE = ROOT / 'assets/archive/mclarenp1/.stage-secondary-hd'
TARGETS = [('mclarenp1', 1), ('mclarenp1', 2), ('mclarenp1', 3), ('tourbillon24', 1), ('tourbillon24', 2)]

def title(p):
    return unquote(urlsplit(p['source']).path.split('/wiki/', 1)[1]).replace('_', ' ')

def acquire():
    STAGE.mkdir(parents=True, exist_ok=True)
    current = catalog(); selected = [(car, i, current[car][i]) for car, i in TARGETS if current[car][i]['width'] < 3840]
    accepted = []; attempts = []
    if selected:
        with open('/tmp/velance-commons-download.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                query = dict(action='query', format='json', prop='imageinfo', iiprop='url|size|extmetadata|mime|sha1', iiurlwidth=3840, titles='|'.join(title(p) for _, _, p in selected))
                data = json.loads(fetch('https://commons.wikimedia.org/w/api.php?' + urlencode(query)))
                pages = {p['title']: p for p in data['query']['pages'].values()}; time.sleep(2)
                for car, i, p in selected:
                    key = f'{car}-{i}'; attempt = dict(car=car, label=p['label']); attempts.append(attempt)
                    try:
                        info = pages[title(p)]['imageinfo'][0]; meta = info['extmetadata']
                        for k, expected in [('Artist',p['author']), ('LicenseShortName',p['license'])]:
                            assert unescape(re.sub(r'<[^>]+>', '', meta[k]['value'])).strip() == expected, k
                        assert info['sha1'] in DOC.read_text(), 'source fingerprint changed'
                        assert info['width'] >= 3840 and info['height']*3840/info['width'] >= 2160, 'original cannot meet target'
                        url = info['thumburl']; assert urlsplit(url).hostname == 'thumb.wikimedia.org', 'not published thumbnail host'
                        blob = fetch(url); im = ImageOps.exif_transpose(Image.open(BytesIO(blob))).convert('RGB')
                        assert im.width == 3840 and 2160 <= im.height <= info['height']
                        assert abs(im.height-im.width*info['height']/info['width']) <= 2, 'aspect mismatch'
                        (STAGE/f'{key}.jpg').write_bytes(blob)
                        accepted.append(dict(car=car, index=i, key=key, source=p['source'], old=p['full'], width=im.width, height=im.height, originalWidth=info['width'], originalHeight=info['height'], originalSHA1=info['sha1'], url=url, inputSHA256=digest(blob)))
                        attempt['result'] = f'ACQUIRED {im.width}x{im.height}'
                    except HTTPError as e:
                        attempt['result'] = f'HTTP {e.code}; Retry-After {e.headers.get("Retry-After")}'
                        if e.code == 429: print(attempt, flush=True); break
                    except Exception as e: attempt['result'] = repr(e)
                    print(attempt, flush=True); time.sleep(2)
            except Exception as e: attempts.append(dict(result=repr(e)))
    (STAGE/'metadata.json').write_text(json.dumps(dict(accepted=accepted, attempts=attempts), indent=2))
    if accepted:
        # Show entire frame and matching native pixel detail for visual review.
        sheet = Image.new('RGB', (1280, 270*len(accepted)), '#151515'); draw = ImageDraw.Draw(sheet)
        for i, r in enumerate(accepted):
            for j, path in enumerate([ROOT/r['old'], STAGE/f"{r['key']}.jpg"]):
                im = Image.open(path).convert('RGB'); frame = im.copy(); frame.thumbnail((310,240)); x=j*640
                sheet.paste(frame,(x,i*270+24)); w,h=im.size; crop=im.crop((w//2-150,h//2-108,w//2+150,h//2+108)); sheet.paste(crop,(x+320,i*270+24))
                draw.text((x+4,i*270+4),r['key']+(' current' if j==0 else ' retrieved')+f' {w}x{h}',fill='white')
        sheet.save(STAGE/'comparison.jpg',quality=92)

def apply(keys):
    data=json.loads((STAGE/'metadata.json').read_text()); current=catalog(); lines=['','## Secondary high-resolution upgrade','', 'Same verified photographs; only viewer renditions replaced after visual comparison. Existing thumbs and medium assets remain unchanged. No upscale. Original size/SHA-1 are Commons metadata; retrieved JPEG and WebP hashes below.','']; obsolete=[]
    for r in data['accepted']:
        if r['key'] not in keys: continue
        p=current[r['car']][r['index']]; assert p['source']==r['source'] and p['full']==r['old']; blob=(STAGE/f"{r['key']}.jpg").read_bytes();assert digest(blob)==r['inputSHA256']
        im=ImageOps.exif_transpose(Image.open(BytesIO(blob))).convert('RGB');assert im.size==(r['width'],r['height']);old=ROOT/p['full'];target=old.with_name(old.stem.rsplit('-',1)[0]+f'-{im.width}.webp');assert not target.exists()
        im.save(target,'WEBP',quality=90,method=6); rel='./'+target.relative_to(ROOT).as_posix(); p.update(full=rel,width=im.width,height=im.height); obsolete.append(old)
        lines.extend([f"### {r['car']} — {p['label']}", '', f"- [{title(p)}]({p['source']}) — {p['author']}, [{p['license']}]({p['licenseUrl']}).",f"- Original metadata: {r['originalWidth']} × {r['originalHeight']}; SHA-1 `{r['originalSHA1']}`.",f"- [Retrieved rendition]({r['url']}): {r['width']} × {r['height']}; SHA-256 `{r['inputSHA256']}`.",f"- Full variant: `{rel}`; {target.stat().st_size} bytes; SHA-256 `{digest(target.read_bytes())}`.",''])
    if obsolete:
        DOC.write_text(DOC.read_text()+'\n'.join(lines)+'\n'); MANIFEST.write_text('// Verified pilot photographs; sources in docs/frontend-photo-sources.md.\nexport const PHOTO_ARCHIVE = '+json.dumps(current,indent=2,ensure_ascii=False)+';\n')
        active={(ROOT/p[k]).resolve() for photos in current.values() for p in photos for k in ('thumb','medium','full')}
        for old in obsolete:
            if old.resolve() not in active: old.unlink()
    print('PUBLISHED',len(obsolete),flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser(); group=parser.add_mutually_exclusive_group(required=True);group.add_argument('--acquire',action='store_true');group.add_argument('--apply',nargs='+');args=parser.parse_args();acquire() if args.acquire else apply(args.apply)
