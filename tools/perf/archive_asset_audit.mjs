#!/usr/bin/env node
// Audit actual served WebP dimensions, file hashes and per-image provenance.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { PHOTO_ARCHIVE } from '../../src/data/archive-catalog.js';
import { VEHICLES } from '../../src/data/vehicles.js';
import { publicPath } from '../delivery/static.mjs';

const root=resolve(import.meta.dirname,'../..');
const sources=['frontend-photo-sources.md','frontend-photo-sources-a.md','frontend-photo-sources-b.md','frontend-photo-large.md'];
const docs=sources.filter(x=>existsSync(join(root,'docs',x))).map(x=>readFileSync(join(root,'docs',x),'utf8')).join('\n');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function webpSize(bytes) {
  assert.equal(bytes.toString('ascii',0,4),'RIFF');
  assert.equal(bytes.toString('ascii',8,12),'WEBP');
  for(let i=12;i+8<=bytes.length;) {
    const type=bytes.toString('ascii',i,i+4), size=bytes.readUInt32LE(i+4), j=i+8;
    assert(j+size<=bytes.length,'truncated WebP');
    if(type==='VP8X') return [bytes.readUIntLE(j+4,3)+1,bytes.readUIntLE(j+7,3)+1];
    if(type==='VP8 '){assert.equal(bytes.readUIntLE(j+3,3),0x2a019d);return [bytes.readUInt16LE(j+6)&0x3fff,bytes.readUInt16LE(j+8)&0x3fff];}
    if(type==='VP8L'){assert.equal(bytes[j],0x2f);const bits=bytes.readUInt32LE(j+1);return [(bits&0x3fff)+1,((bits>>>14)&0x3fff)+1];}
    i=j+size+(size%2);
  }
  throw Error('No WebP frame');
}
const known=new Set(VEHICLES.map(x=>x.id)), paths=new Map(), allSources=new Set(), cars=[];
for(const id of Object.keys(PHOTO_ARCHIVE)) assert(known.has(id),`Unknown vehicle ${id}`);
for(const {id} of VEHICLES) {
  const records=PHOTO_ARCHIVE[id]||[], photos=[];
  for(const p of records) {
    for(const key of ['label','alt','source','author','license','licenseUrl']) assert(typeof p[key]==='string'&&p[key].trim(),`${id}: missing ${key}`);
    assert.match(p.source,/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
    assert.match(p.licenseUrl,/^https?:\/\/creativecommons\.org\/(licenses|publicdomain)\//);
    assert(!allSources.has(p.source),`Duplicate source: ${p.source}`);allSources.add(p.source);
    const variants={};
    for(const key of ['thumb','medium',...(p.large?['large']:[]),'full']) {
      const path=p[key];assert(path.startsWith(`./assets/archive/${id}/`),path);
      assert(publicPath(path.slice(1),{release:true}),`Not servable: ${path}`);
      if(!paths.has(path)) {
        const bytes=readFileSync(resolve(root,path)), [width,height]=webpSize(bytes), sha256=digest(bytes);
        assert.equal(width,Number(path.match(/-(\d+)\.webp$/)?.[1]),path);
        assert(docs.includes(sha256),`Hash missing from provenance docs: ${path}`);
        paths.set(path,{width,height,bytes:bytes.length,sha256});
      }
      variants[key]=paths.get(path);
    }
    assert.deepEqual([variants.full.width,variants.full.height],[p.width,p.height],p.full);
    assert.equal(variants.thumb.width,p.thumbWidth||Math.min(640,p.width),p.thumb);
    assert.equal(variants.medium.width,p.mediumWidth||Math.min(1600,p.width),p.medium);
    assert(variants.thumb.width<=variants.medium.width&&variants.medium.width<=p.width);
    if(p.large) assert(variants.large.width===p.largeWidth&&variants.medium.width<=variants.large.width&&variants.large.width<p.width);
    for(const v of Object.values(variants)) assert(Math.abs(v.height-v.width*p.height/p.width)<=2,'Aspect ratio '+p.full);
    photos.push({label:p.label,width:p.width,height:p.height,source:p.source,full:p.full});
  }
  cars.push({id,photos});
}
const images=cars.flatMap(x=>x.photos), orphaned=[];
for(const id of known) {
  const folder=join(root,'assets/archive',id);
  if(existsSync(folder)) for(const name of readdirSync(folder)) if(name.endsWith('.webp')&&!paths.has(`./assets/archive/${id}/${name}`)) orphaned.push(`${id}/${name}`);
}
const result={vehicles:known.size,photographicVehicles:cars.filter(c=>c.photos.length).length,photos:images.length,uniqueWebps:paths.size,bytes:[...paths.values()].reduce((sum,p)=>sum+p.bytes,0),widthAtLeast3840:images.filter(p=>p.width>=3840).length,atLeast3840x2160:images.filter(p=>p.width>=3840&&p.height>=2160).length,maxWidth:Math.max(0,...images.map(p=>p.width)),missing:cars.filter(c=>!c.photos.length).map(c=>c.id),orphaned,cars};
if(process.env.QA_BASELINE) {
  const baseline=JSON.parse(readFileSync(process.env.QA_BASELINE,'utf8'));
  const current=new Map(cars.flatMap(c=>c.photos.map(p=>[c.id+' '+p.source,p])));
  const before=baseline.cars.flatMap(c=>c.photos.map(p=>({id:c.id,...p})));
  const improved=[];
  for(const p of before) {
    const now=current.get(p.id+' '+p.source);
    assert(now,`Previously verified photo removed: ${p.id} ${p.source}`);
    assert(now.width>=p.width&&now.height>=p.height,`Previously verified photo downgraded: ${p.source}`);
    if(now.width>p.width||now.height>p.height) improved.push({id:p.id,source:p.source,before:[p.width,p.height],after:[now.width,now.height]});
  }
  result.retention={retained:before.length,added:images.length-before.length,improved,previousBytes:baseline.bytes};
}
assert.deepEqual(result.missing,[],'Missing photographic albums');
assert.deepEqual(result.orphaned,[],'Orphaned Archive WebPs');
const out=process.env.QA_ASSET_REPORT||join(root,'tools/perf/results/archive-final/assets.json');
mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({...result,cars:cars.map(c=>({id:c.id,photos:c.photos.length}))},null,2));
