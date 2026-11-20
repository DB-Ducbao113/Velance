#!/usr/bin/env python3
"""Acquire 3840-pixel Commons published renditions for two pilot lead photos.

Run --acquire, inspect contact sheet, then --apply after confirming both photos.
No upscaling, no generated images; original metadata is not original acquisition.
"""
import argparse
import fcntl
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from PIL import Image, ImageOps, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
STAGE = ROOT / 'assets/archive/mclarenp1/.stage-pilot-hd'
MANIFEST = ROOT / 'src/data/photo-archive.js'
DOC = ROOT / 'docs/frontend-photo-sources.md'
TARGETS = [('mclarenp1','night','Volcano Orange McLaren P1 (18852267050).jpg'),('tourbillon24','front','Bugatti Tourbillon - 01.jpg')]

def fetch(url):
    with urlopen(Request(url,headers={'User-Agent':'VELANCE educational photo archive/1.0 (low-rate local review)'}), timeout=35) as r:
        return r.read()

def digest(data): return sha256(data).hexdigest()

def catalog():
    return json.loads(MANIFEST.read_text().split('export const PHOTO_ARCHIVE = ',1)[1].strip().rstrip(';'))

def acquire():
    STAGE.mkdir(parents=True,exist_ok=True)
    results=[]; current=catalog()
    with open('/tmp/velance-commons-download.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        try:
            query=dict(action='query',format='json',prop='imageinfo',iiprop='url|size|extmetadata|mime|sha1',iiurlwidth=3840,titles='|'.join('File:'+t for _,_,t in TARGETS))
            pages={p['title']:p for p in json.loads(fetch('https://commons.wikimedia.org/w/api.php?'+urlencode(query)))['query']['pages'].values()}
            time.sleep(2)
            for car,slug,title in TARGETS:
                try:
                    info=pages['File:'+title]['imageinfo'][0]; meta=info['extmetadata']; p=current[car][0]
                    for field,key in [('Artist','author'),('LicenseShortName','license')]:
                        val=re.sub(r'<[^>]+>','',meta[field]['value']).strip();assert val==p[key],(title,val)
                    assert info['mime']=='image/jpeg' and info['width']>=3840
                    blob=fetch(info['thumburl']);photo=ImageOps.exif_transpose(Image.open(BytesIO(blob))).convert('RGB')
                    assert photo.width>=3840 and photo.width<=info['width'] and photo.height<=info['height'],photo.size
                    assert abs(photo.height-photo.width*info['height']/info['width'])<=2
                    path=STAGE/f'{car}.jpg';path.write_bytes(blob)
                    results.append(dict(car=car,slug=slug,title=title,source=info['descriptionurl'],url=info['thumburl'],width=photo.width,height=photo.height,originalWidth=info['width'],originalHeight=info['height'],originalSHA1=info['sha1'],inputSHA256=digest(blob)))
                    print('ACQUIRED',car,photo.size,flush=True)
                except HTTPError as e:
                    print('HTTP',e.code,car,'Retry-After:',e.headers.get('Retry-After'),flush=True)
                    if e.code==429: break
                except Exception as e: print('SKIP',car,repr(e),flush=True)
                time.sleep(2)
        except HTTPError as e: print('Metadata HTTP',e.code,'Retry-After:',e.headers.get('Retry-After'),flush=True)
    (STAGE/'metadata.json').write_text(json.dumps(results,indent=2))
    if results:
        sheet=Image.new('RGB',(960,len(results)*340),'#171717');draw=ImageDraw.Draw(sheet)
        for i,r in enumerate(results):
            for j,path in enumerate([ROOT/current[r['car']][0]['full'],STAGE/f"{r['car']}.jpg"]):
                im=Image.open(path).convert('RGB');im.thumbnail((472,310));sheet.paste(im,(j*480,i*340+24));draw.text((j*480+4,i*340+4),f"{r['car']} {'prior' if j==0 else 'retrieved'}",fill='white')
        sheet.save(STAGE/'comparison.jpg',quality=90)

def apply():
    records=json.loads((STAGE/'metadata.json').read_text());current=catalog()
    lines=['','## Subsequent high-resolution lead replacements','', 'These records supersede the earlier lead-file variants above. The retained historical entries document the previous preparation. Retrieved published JPEG renditions are verified; original dimensions and SHA-1 remain source metadata only. No crop, contrast adjustment, sharpening, or upscaling was applied to these new derivatives.','']
    for r in records:
        car,slug=r['car'],r['slug'];p=current[car][0];old=set(p[k] for k in ('thumb','medium','full'))
        blob=(STAGE/f'{car}.jpg').read_bytes();assert digest(blob)==r['inputSHA256']
        photo=ImageOps.exif_transpose(Image.open(BytesIO(blob))).convert('RGB');assert photo.size==(r['width'],r['height'])
        variants={}
        for key,cap,quality in [('thumb',640,82),('medium',1600,86),('full',3840,92)]:
            width=min(cap,photo.width);height=round(photo.height*width/photo.width);path=ROOT/'assets/archive'/car/f'{slug}-hd-{width}.webp';im=photo if photo.size==(width,height) else photo.resize((width,height),Image.Resampling.LANCZOS);im.save(path,'WEBP',quality=quality,method=6)
            rel='./'+path.relative_to(ROOT).as_posix();variants[key]=(rel,width,height,path.stat().st_size,digest(path.read_bytes()))
        for key,v in variants.items(): p[key]=v[0]
        p['width'],p['height']=variants['full'][1:3];p['changes']='Resized / WebP';p['source']=r['source']
        lines.extend([f"### {car} — {p['label']}",'',f"- [{r['title']}]({p['source']}) — {p['author']}, [{p['license']}]({p['licenseUrl']}).",f"- Original metadata: {r['originalWidth']} × {r['originalHeight']}; SHA-1 `{r['originalSHA1']}` (not independently downloaded).",f"- [Retrieved rendition]({r['url']}): {r['width']} × {r['height']}; SHA-256 `{r['inputSHA256']}`.",'','| Variant | Local file | Dimensions | Bytes | SHA-256 |','| --- | --- | --- | ---: | --- |'])
        for key,v in variants.items():lines.append(f'| {key} | `{v[0]}` | {v[1]} × {v[2]} | {v[3]} | `{v[4]}` |')
        lines.append('');r['obsolete']=list(old-set(v[0] for v in variants.values()))
    if not records:return
    DOC.write_text(DOC.read_text()+'\n'.join(lines)+'\n');MANIFEST.write_text('// Verified pilot photographs; sources in docs/frontend-photo-sources.md.\nexport const PHOTO_ARCHIVE = '+json.dumps(current,indent=2,ensure_ascii=False)+';\n')
    active={p[k] for photos in current.values() for p in photos for k in ('thumb','medium','full')}
    for r in records:
        for old in r['obsolete']:
            if old not in active and old.startswith('./assets/archive/'+r['car']+'/'): (ROOT/old).unlink(missing_ok=True)
    print('PUBLISHED',len(records),flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();g=parser.add_mutually_exclusive_group(required=True);g.add_argument('--acquire',action='store_true');g.add_argument('--apply',action='store_true');args=parser.parse_args();acquire() if args.acquire else apply()
