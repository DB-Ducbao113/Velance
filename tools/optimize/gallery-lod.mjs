// Derived gallery-only GLBs. Keep the existing detailed source assets intact.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { simplify, prune, dedup, reorder, textureCompress } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectGLB } from './budget.mjs';

const root=fileURLToPath(new URL('../../assets/models/',import.meta.url)),out=join(root,'gallery');
await Promise.all([MeshoptEncoder.ready,MeshoptDecoder.ready,MeshoptSimplifier.ready]);
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.encoder':MeshoptEncoder,'meshopt.decoder':MeshoptDecoder});
mkdirSync(out,{recursive:true});
async function measure(path){
  const bytes=readFileSync(path),entry=inspectGLB(bytes,basename(path)),doc=await io.read(path);
  let rgba=0,gpu=0,geom=0;const arrays=new Set();
  for(const t of doc.getRoot().listTextures()){
    const {width,height}=await sharp(t.getImage()).metadata();rgba+=width*height*4;gpu+=width*height*4*4/3;
  }
  for(const a of doc.getRoot().listAccessors()){const v=a.getArray();if(v&&!arrays.has(v)){arrays.add(v);geom+=v.byteLength;}}
  return {...entry,decodedImageBytes:rgba,estimatedMipTextureBytes:Math.ceil(gpu),attributeBytes:geom};
}
const records=[];
for(const file of readdirSync(root).filter(f=>f.endsWith('.glb')).sort()){
  const input=join(root,file),output=join(out,file),before=await measure(input),doc=await io.read(input);
  // Limit the geometric error to a small fraction of the car extent. Keep
  // material boundaries, UVs, and authored normals, including windows/wheels.
  await doc.transform(simplify({simplifier:MeshoptSimplifier,ratio:.38,error:.008}),prune(),dedup(),
    textureCompress({encoder:sharp,formats:/^image\/(webp|jpeg|png)$/,resize:[256,256],targetFormat:'webp',quality:84}),
    reorder({encoder:MeshoptEncoder,target:'size'}));
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({method:EXTMeshoptCompression.EncoderMethod.FILTER});
  await io.write(output,doc);
  const after=await measure(output);records.push({file,before,after});
  console.log(file,`${before.triangles} -> ${after.triangles} tris, ${(before.decodedImageBytes/1048576).toFixed(1)} -> ${(after.decodedImageBytes/1048576).toFixed(1)} MiB decoded`);
}
const totals=Object.fromEntries(['before','after'].map(k=>[k,Object.fromEntries(['bytes','triangles','decodedImageBytes','estimatedMipTextureBytes','attributeBytes'].map(m=>[m,records.reduce((s,r)=>s+r[k][m],0)]))]));
writeFileSync(join(out,'manifest.json'),JSON.stringify({version:1,records,totals},null,2)+'\n');
console.log(JSON.stringify(totals));
