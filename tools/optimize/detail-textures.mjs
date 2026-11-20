// Keep original detail geometry; bound decoded texture memory per selected car.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { textureCompress } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectGLB } from './budget.mjs';
const root=fileURLToPath(new URL('../../assets/models/',import.meta.url)),out=join(root,'detail');
await Promise.all([MeshoptEncoder.ready,MeshoptDecoder.ready]);
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.encoder':MeshoptEncoder,'meshopt.decoder':MeshoptDecoder});
mkdirSync(out,{recursive:true});const entries=[];
for(const file of readdirSync(root).filter(f=>f.endsWith('.glb')).sort()){
  const doc=await io.read(join(root,file)),textures=doc.getRoot().listTextures();
  const dimensions=await Promise.all(textures.map(t=>sharp(t.getImage()).metadata()));
  const estimate=cap=>dimensions.reduce((sum,{width:w,height:h})=>{const s=Math.min(1,cap/Math.max(w,h));return sum+Math.ceil(w*s)*Math.ceil(h*s)*4;},0);
  const cap=[1024,768,512,384].find(n=>estimate(n)<=32*1048576)??256;
  await doc.transform(textureCompress({encoder:sharp,formats:/^image\/(webp|jpeg|png)$/,resize:[cap,cap],targetFormat:'webp',quality:90}));
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({method:EXTMeshoptCompression.EncoderMethod.FILTER});
  const path=join(out,file);await io.write(path,doc);
  let decodedImageBytes=0;for(const t of textures){const {width,height}=await sharp(t.getImage()).metadata();decodedImageBytes+=width*height*4;}
  const entry={cap,decodedImageBytes,...inspectGLB(readFileSync(path),file)};
  if(decodedImageBytes>32*1048576)throw new Error(file+' exceeds decoded budget');
  if(entry.triangles!==inspectGLB(readFileSync(join(root,file))).triangles)throw new Error(file+' changed triangles');
  entries.push(entry);console.log(file,cap,(decodedImageBytes/1048576).toFixed(1)+' MiB');
}
writeFileSync(join(out,'manifest.json'),JSON.stringify({version:1,entries},null,2)+'\n');
