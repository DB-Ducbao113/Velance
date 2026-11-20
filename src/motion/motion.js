/** VÉLANCE V8 — editorial motion orchestration.
 * GSAP + ScrollTrigger + Lenis when the official UMD bundles are available.
 * IntersectionObserver/native-scroll fallback when offline; never blocks content.
 * Vehicle image transforms are deliberately forbidden (no scale/rotation/translation).
 */
const lowMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const nativeWebKit = /AppleWebKit/.test(navigator.userAgent) && !/(Chrome|Chromium|Edg|OPR)/.test(navigator.userAgent);
const clamp = x => Math.min(1, Math.max(0, x));
const smooth = x => { const p=clamp(x); return p*p*(3-2*p); };
let lenis = null;
let active = [];
let observers = [];
let fallbackScroll = null;
let initialized = false;
let scrollTicker = null;
const motionStage = { engine: 'native-fallback', images:0, reveals:0, interactive:0, lenis:false, reduced:lowMotion.matches };
window.__VELANCE_MOTION_QA__=motionStage;

function clearSections() {
  for (const t of active) t.kill?.(); active=[];
  for (const obs of observers) obs.disconnect(); observers=[];
  if(fallbackScroll){window.removeEventListener('scroll',fallbackScroll);window.removeEventListener('resize',fallbackScroll);fallbackScroll=null;}
}
function reduce(){ return lowMotion.matches; }
function setupLenis() {
  if(initialized) return;
  initialized=true;
  const gsap=window.gsap;
  const ScrollTrigger=window.ScrollTrigger;
  if(reduce() || nativeWebKit || !gsap || !ScrollTrigger || !window.Lenis) return;
  try {
    gsap.registerPlugin(ScrollTrigger);
    lenis = new window.Lenis({autoRaf:false, duration:1.05, smoothWheel:true, syncTouch:false, touchMultiplier:1, wheelMultiplier:.85});
    lenis.on('scroll',ScrollTrigger.update);
    scrollTicker=t=>lenis?.raf(t*1000);
    gsap.ticker.add(scrollTicker);
    gsap.ticker.lagSmoothing(0);
    motionStage.lenis=true;
  }catch(e){console.warn('[VELANCE MOTION] Lenis unavailable, native scrolling continues',e);lenis=null;}
}
function initializeMotion() {
  const gsap=window.gsap;
  if(gsap && window.ScrollTrigger && !reduce()){
    gsap.registerPlugin(window.ScrollTrigger);
    motionStage.engine='GSAP ScrollTrigger';
  }
  setupLenis();
  setupMicroInteractions();
}
export function motionScrollTo(target, immediate = false) {
  const element=typeof target==='string'?document.querySelector(target):target;
  if(!element)return;
  if(immediate){
    if(lenis){lenis.resize();lenis.scrollTo(element,{offset:0,immediate:true,force:true});}
    element.scrollIntoView({behavior:'instant',block:'start'});
    return;
  }
  if(lenis&&!reduce()){
    // Review chapters are inserted asynchronously. Refresh the scroll limit
    // before requesting an offset; ResizeObserver may not have fired yet.
    lenis.resize();
    lenis.scrollTo(element,{offset:-12,duration:1.08});
  }
  else element.scrollIntoView({behavior:reduce()?'instant':'smooth',block:'start'});
}

function scrollGeometry(section) {
  const r=section.getBoundingClientRect(), h=window.innerHeight;
  // A long, smooth fade in as the photo enters and fade out as it leaves.
  // The image never changes size or visual orientation.
  const enter=smooth((h*.97-r.top)/(h*.53));
  const exit=smooth((r.bottom-h*.10)/(h*.42));
  return {alpha:clamp(Math.min(enter,exit)),progress:clamp((h-r.top)/(h+r.height))};
}
function setPhotoOpacity(photo,value){
  // Respect hidden/missing assets: never animate a broken image as if it exists.
  photo.style.opacity=photo.hidden?'0':String(clamp(value));
}
function setupPhotos(sections){
  const gsap=window.gsap,Trigger=window.ScrollTrigger;
  if(!reduce()&&gsap&&Trigger){
    for(const section of sections){
      const photo=section.querySelector('.shot-slot img');if(!photo)continue;
      const trigger=Trigger.create({trigger:section,start:'top 97%',end:'bottom 10%',invalidateOnRefresh:true,onUpdate:()=>setPhotoOpacity(photo,scrollGeometry(section).alpha),onEnter:()=>{photo.style.willChange='opacity';},onLeave:()=>{photo.style.willChange='auto';},onLeaveBack:()=>{photo.style.willChange='auto';}});
      active.push(trigger);
      setPhotoOpacity(photo,scrollGeometry(section).alpha);
    }
  } else if(!reduce()){
    let raf=0;
    const frame=()=>{raf=0;for(const section of sections){const photo=section.querySelector('.shot-slot img');if(photo)setPhotoOpacity(photo,scrollGeometry(section).alpha);}};
    fallbackScroll=()=>{if(!raf)raf=requestAnimationFrame(frame);};
    window.addEventListener('scroll',fallbackScroll,{passive:true});
    window.addEventListener('resize',fallbackScroll,{passive:true});
    frame();
  } else {for(const section of sections){const img=section.querySelector('.shot-slot img');if(img)img.style.opacity=img.hidden?'0':'1';}}
  motionStage.images=sections.length;
}
function setupTextReveals() {
  const targets=[
    ...document.querySelectorAll('.review-intro > .eyebrow,.review-intro h2,.review-intro p'),
    ...document.querySelectorAll('.shot-copy > .shot-label,.shot-copy h3,.shot-copy > p,.shot-copy dl,.shot-caption'),
    // Keep the final BACK control visible. Near the document bottom the
    // closing row may never cross the scroll-trigger's start threshold.
    ...document.querySelectorAll('.board-topline,.board-heading')
  ];
  motionStage.reveals=targets.length;
  if(reduce())return;
  const gsap=window.gsap,ST=window.ScrollTrigger;
  if(gsap&&ST){
    for (const el of targets){
      const anim=gsap.fromTo(el,{autoAlpha:0,y:18},{autoAlpha:1,y:0,duration:.68,ease:'power2.out',paused:true});
      active.push(anim);
      const st=ST.create({trigger:el,start:'top 91%',once:false,onEnter:()=>anim.play(),onLeaveBack:()=>anim.reverse()});
      active.push(st);
    }
  } else {
    const obs=new IntersectionObserver((entries)=>{
      for (const e of entries){
        if(e.isIntersecting)e.target.classList.add('velance-in-view');
        else if(e.boundingClientRect.top>0)e.target.classList.remove('velance-in-view');
      }
    },{threshold:0.08,rootMargin:'0px 0px -5% 0px'});
    for(const el of targets){el.classList.add('velance-await');obs.observe(el);}
    observers.push(obs);
  }
}

function setupMicroInteractions() {
  if(document.documentElement.dataset.velanceMicro==='ready')return;
  document.documentElement.dataset.velanceMicro='ready';
  // React Bits-inspired spotlight & border response; ported to the existing
  // vanilla app so the user-supplied site does NOT require a React rewrite.
  document.addEventListener('pointermove',event=>{
    if(event.pointerType==='touch')return;
    const card=event.target.closest('.shot-frame,.board-item,.car,.selected-left,.primary-button,.outline-button');
    if(!card)return;
    const r=card.getBoundingClientRect();
    card.style.setProperty('--mx',`${Math.round((event.clientX-r.left)/Math.max(1,r.width)*100)}%`);
    card.style.setProperty('--my',`${Math.round((event.clientY-r.top)/Math.max(1,r.height)*100)}%`);
  },{passive:true});
  document.addEventListener('click',event=>{
    const card=event.target.closest('.board-item[data-angle]');
    if(!card)return;
    const idx=Number(card.dataset.angle);
    if(Number.isFinite(idx))motionScrollTo(document.getElementById(`image-${idx+1}`));
  });
  motionStage.interactive=1;
}
export function refreshVelanceMotion() {
  clearSections();initializeMotion();
  const review=document.getElementById('review');
  if(!review || review.hidden){motionStage.images=0;motionStage.reveals=0;return;}
  const sections=Array.from(review.querySelectorAll('.shot-section'));
  setupPhotos(sections);
  setupTextReveals();
  if(window.ScrollTrigger && motionStage.engine.startsWith('GSAP')){
    requestAnimationFrame(()=>window.ScrollTrigger.refresh());
  }
}
let selectedTween = null;
let selectedAnimations = [];
export function resetSelectedMotion() {
  selectedTween?.kill(); selectedTween = null;
  for(const animation of selectedAnimations) animation.cancel();
  selectedAnimations = [];
  const elements=document.querySelectorAll('.selected-headline > *, .selected-metadata, .selected-spec, .selected-actions > *');
  for(const el of elements){el.style.removeProperty('opacity');el.style.removeProperty('visibility');el.style.removeProperty('transform');}
}
export function playSelectedMotion() {
  resetSelectedMotion();
  if(reduce())return;
  const elements=[...document.querySelectorAll('.selected-headline > *, .selected-metadata, .selected-spec, .selected-actions > *')];
  if(window.gsap){
    selectedTween=window.gsap.fromTo(elements,{autoAlpha:0,y:16},{autoAlpha:1,y:0,duration:.7,ease:'power3.out',stagger:.075,overwrite:true,clearProps:'transform,opacity,visibility'});
  } else {
    elements.forEach((el,i)=>{
      const animation=el.animate([{opacity:0,transform:'translateY(16px)'},{opacity:1,transform:'translateY(0)'}],{duration:620,delay:80+i*55,easing:'cubic-bezier(.2,.8,.2,1)',fill:'both'});
      selectedAnimations.push(animation);
      animation.onfinish=()=>{animation.cancel();el.style.opacity='';el.style.transform='';};
    });
  }
}
export function setImageLoaded(image) {
  if(!image || image.hidden)return;
  // If an image finished loading after scroll, synchronize its opacity immediately.
  const section=image.closest('.shot-section');
  if(section) setPhotoOpacity(image,reduce()?1:scrollGeometry(section).alpha);
}
export function bootVelanceMotion() {
  initializeMotion();
  if(lowMotion.addEventListener)lowMotion.addEventListener('change',()=>{refreshVelanceMotion();});
  refreshVelanceMotion();
}
