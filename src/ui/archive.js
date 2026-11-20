// Photography is separate from the technical GLB render inventory.
import { PHOTO_ARCHIVE } from '../data/archive-catalog.js?v=12.4';
import { CINEMATIC_ARCHIVE } from '../data/cinematic-archive.js?v=12.7';
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2,'0');
export function createArchive(onVisible) {
  const dialog = $('archiveViewer'), grid = $('boardGrid'), image = $('viewerImage');
  let items = [], car = '', index = 0, opener = null, epoch = 0, imageEpoch = 0, startX = null;
  let observer=null;
  const collections=$('archiveCollections'), photosButton=$('archivePhotos'), cinematicButton=$('archiveCinematic'), cinematicNote=$('cinematicNote');
  const constrained=matchMedia('(max-width:620px)').matches||(/AppleWebKit/.test(navigator.userAgent)&&!/(Chrome|Chromium|Edg|OPR)/.test(navigator.userAgent));
  function releaseTile(img){img.removeAttribute('srcset');img.removeAttribute('src');img.hidden=true;}
  function close() { if (dialog.open) dialog.close(); }
  function clear() {
    epoch++; imageEpoch++; opener = null; startX = null; close(); observer?.disconnect();observer=null;
    for(const img of grid.querySelectorAll('img')){img.onload=img.onerror=null;releaseTile(img);}
    items = []; grid.replaceChildren();
    collections.hidden=true;cinematicNote.hidden=true;photosButton.onclick=cinematicButton.onclick=null;
    image.removeAttribute('src'); document.body.classList.remove('archive-viewer-open');
  }
  function link(label, href) {
    const a = document.createElement('a'); a.textContent = label; a.href = href;
    a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
  }
  function creditFor(target, p) {
    target.replaceChildren();
    if (p.source) {
      const changes = p.changes || (p.full.endsWith('/mclarenp1/night-3200.webp') ? 'Cropped, contrast, sharpened / WebP' : 'Resized / WebP');
      target.append(link(p.author,p.source), ' · ',link(p.license,p.licenseUrl),' · '+changes);
    } else if(p.kind==='cinematic') target.textContent = 'AI-generated concept illustration · not a photograph · native '+p.width+' × '+p.height+' px';
    else target.textContent = '3D render · not a photograph';
  }
  function show(i) {
    if (!items.length) return;
    index = (i + items.length) % items.length;
    const p = items[index];
    $('viewerName').textContent = car;
    $('viewerCount').textContent = pad(index+1)+' / '+pad(items.length);
    $('viewerLabel').textContent = p.label + (p.width && p.height ? ` · ${p.width} × ${p.height} px` : '');
    $('viewerStatus').textContent = 'Loading image…';
    const ticket = ++imageEpoch;
    image.alt = p.alt; image.hidden = true;
    image.removeAttribute('src');
    image.src = p.full;
    image.decode().then(() => {
      if (ticket !== imageEpoch || !dialog.open) return;
      image.hidden = false; $('viewerStatus').textContent = '';
    }, () => {
      if (ticket !== imageEpoch || !dialog.open) return;
      $('viewerStatus').textContent = 'Image unavailable';
    });
    creditFor($('viewerCredit'),p);
    $('viewerPrev').disabled = $('viewerNext').disabled = items.length < 2;
  }
  function open(i, button) {
    opener = button; dialog.showModal(); document.body.classList.add('archive-viewer-open');
    show(i); $('viewerClose').focus();
  }
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    imageEpoch++; startX = null;
    document.body.classList.remove('archive-viewer-open');
    image.onload = image.onerror = null; image.removeAttribute('src');
    if (opener?.isConnected) opener.focus({preventScroll:true});
  });
  dialog.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); show(index+(e.key==='ArrowLeft'?-1:1)); }
  });
  $('viewerClose').addEventListener('click',close);
  $('viewerPrev').addEventListener('click',()=>show(index-1));
  $('viewerNext').addEventListener('click',()=>show(index+1));
  image.addEventListener('pointerdown', e=> { if(e.pointerType==='touch' && e.isPrimary) { startX=e.clientX; image.setPointerCapture(e.pointerId); } });
  image.addEventListener('pointerup', e=> { if(startX!==null && Math.abs(e.clientX-startX)>48) show(index+(e.clientX<startX?1:-1)); startX=null; });
  image.addEventListener('pointercancel',()=>{startX=null;});
  async function render(v, fallback, collection='photo') {
    clear(); const ticket=epoch;
    const photos = PHOTO_ARCHIVE[v.id] || [];
    const cinematic = CINEMATIC_ARCHIVE[v.id] || [];
    const isCinematic=collection==='cinematic' && cinematic.length>0;
    items = isCinematic ? cinematic : photos.length ? photos : fallback;
    car = v.make+' / '+v.name;
    collections.hidden=!cinematic.length;
    cinematicNote.hidden=!isCinematic;
    photosButton.textContent=photos.length?'PHOTOGRAPHY':'3D STUDY';
    photosButton.setAttribute('aria-pressed',String(!isCinematic));
    cinematicButton.setAttribute('aria-pressed',String(isCinematic));
    const switchTo=(kind,button) => {
      if((kind==='cinematic')===isCinematic)return;
      render(v,fallback,kind); button.focus({preventScroll:true});
    };
    photosButton.onclick=()=>switchTo('photo',photosButton);
    cinematicButton.onclick=()=>switchTo('cinematic',cinematicButton);
    $('boardMaker').textContent = car;
    $('archiveKind').textContent = isCinematic ? 'AI CONCEPT IMAGERY' : photos.length ? 'PHOTOGRAPHY' : '3D RENDERS · PHOTO ARCHIVE PENDING';
    $('archiveCount').textContent = pad(items.length)+' IMAGES';
    $('boardTitle').textContent = isCinematic ? 'CINEMATIC.' : photos.length ? 'ARCHIVE.' : '3D STUDY.';
    grid.dataset.kind = isCinematic ? 'cinematic' : photos.length ? 'photo' : 'render';
    grid.dataset.count = String(items.length);
    const activate=new Map();
    if('IntersectionObserver' in window)observer=new IntersectionObserver(entries=>{
      if(ticket!==epoch)return;
      for(const entry of entries){
        const img=entry.target.__archiveImage;
        if(entry.isIntersecting){if(!img.hasAttribute('src'))activate.get(entry.target)?.();}
        else if(img.hasAttribute('src'))releaseTile(img);
      }
    },{rootMargin:'650px 0px'});
    for (const [i,p] of items.entries()) {
      const fig=document.createElement('figure'); fig.className='board-item'; fig.dataset.no=pad(i+1);
      const btn=document.createElement('button'); btn.type='button'; btn.className='archive-tile';
      btn.setAttribute('aria-label','View '+p.alt); btn.addEventListener('click',()=>open(i,btn));
      const img=document.createElement('img'); img.alt=p.alt; img.loading='eager'; img.decoding='async';img.hidden=true;
      const status=document.createElement('span'); status.className='archive-image-status'; status.textContent='IMAGE UNAVAILABLE'; status.hidden=true;
      let counted=false;
      img.onload=()=>{if(ticket===epoch&&img.hasAttribute('src')){img.hidden=false;status.hidden=true;if(!counted){counted=true;onVisible();}}};
      img.onerror=()=>{if(img.hasAttribute('src')){img.hidden=true;status.hidden=false;}};
      if (p.width && p.height) {img.width=p.width;img.height=p.height;}
      const load=()=>{
      if (p.thumb!==p.medium && p.width) {
        img.srcset=p.thumb+' '+(p.thumbWidth || Math.min(640,p.width))+'w, '+p.medium+' '+(p.mediumWidth || Math.min(1600,p.width))+'w';
        if (!constrained&&p.large && p.large!==p.full) img.srcset+=', '+p.large+' '+p.largeWidth+'w';
        const wide = i===0 || (i===items.length-1 && items.length%2===0);
        img.sizes=wide?'(max-width: 620px) 92vw, min(90vw, 1240px)':'(max-width: 620px) 45vw, min(45vw, 612px)';
      }
      img.src=i===0?p.medium:p.thumb;
      };
      const caption=document.createElement('figcaption'); caption.textContent=p.label;
      const cue=document.createElement('span');cue.className='archive-expand';cue.textContent='↗';cue.setAttribute('aria-hidden','true');
      btn.append(img,status,cue);fig.append(btn,caption);
      if(p.source||p.kind==='cinematic'){const by=document.createElement('div');by.className='archive-credit';creditFor(by,p);fig.append(by);}
      grid.append(fig);
      // Observe the fixed-size tile, not the hidden image. Outside the
      // window remove source attributes so decoded frames are reclaimable.
      if(observer){activate.set(btn,()=>load());btn.__archiveImage=img;observer.observe(btn);}else load();
    }
    return true;
  }
  return {render,clear,isOpen:()=>dialog.open};
}
