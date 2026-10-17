import { createWorkChatter } from "./work-chatter.js";

// Static trusted document: descriptors and labels arrive only over the isolated preload bridge.
export const PET_HTML = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src omp-desktop:; style-src 'unsafe-inline'; script-src 'nonce-omp-pet-renderer'; connect-src 'none'"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;user-select:none;font-family:'Segoe UI',sans-serif}
#mascot{position:absolute;right:8px;bottom:8px;touch-action:none;cursor:grab}#mascot.dragging{cursor:grabbing}
#bubble{position:absolute;z-index:1;right:8px;max-width:calc(100% - 16px);padding:9px 12px;border:1px solid #F6A9C6;border-radius:14px 14px 3px 14px;background:#FFF0E4;color:#42436B;font-family:inherit;font-size:12px;font-weight:600;line-height:1.4;cursor:pointer;box-sizing:border-box;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#bubble:focus-visible{outline:2px solid #DFAB4D;outline-offset:2px}
</style></head><body><button id="bubble" type="button" hidden></button><canvas id="mascot"></canvas><script nonce="omp-pet-renderer">
const bridge=window.ompPet, canvas=document.getElementById('mascot'), bubble=document.getElementById('bubble');
const ctx=canvas.getContext('2d',{willReadFrequently:true}), motion=matchMedia('(prefers-reduced-motion: reduce)');
const sizes={small:112,medium:152,large:200},holds={idle:6000,needs_input:6000,ready:7000,blocked:9000};
const frameInterval=1000/30,transitionDuration=210,patDuration=850,motionEpoch=performance.now();
const chatter=(${createWorkChatter.toString()})();
let state=null,image=null,imageUrl='',loadGeneration=0,animationKey='',animationStarted=0;
let poseImage=null,poseDescriptor=null,transition=null,patStarted=-1;
let dragging=false,pointerStart=null,moved=false,interactive=null,pointer={x:-1,y:-1};
let animationTimer=null,timerDue=0,lastDraw=-Infinity,checkPointerAfterDraw=false;
let chatterTimer=null,chatterDue=Infinity;
let canvasLeft=0,canvasTop=0,canvasRight=0,canvasBottom=0,bubbleLeft=0,bubbleTop=0,bubbleRight=0,bubbleBottom=0;
function fail(error){bridge.reportError(error instanceof Error ? error.message : String(error)).catch(console.error)}
function setInteractive(value){if(interactive!==value){interactive=value;bridge.interactive(value)}}
function refreshHitBounds(){
  const rect=canvas.getBoundingClientRect(),bx=bubble.getBoundingClientRect();
  canvasLeft=rect.left;canvasTop=rect.top;canvasRight=rect.right;canvasBottom=rect.bottom;
  bubbleLeft=bx.left;bubbleTop=bx.top;bubbleRight=bx.right;bubbleBottom=bx.bottom;
}
function hitTest(){
  if(dragging){setInteractive(true);return}
  let hit=!bubble.hidden&&pointer.x>=bubbleLeft&&pointer.x<bubbleRight&&pointer.y>=bubbleTop&&pointer.y<bubbleBottom;
  if(!hit&&poseImage&&pointer.x>=canvasLeft&&pointer.x<canvasRight&&pointer.y>=canvasTop&&pointer.y<canvasBottom){
    try{hit=ctx.getImageData(Math.floor((pointer.x-canvasLeft)*canvas.width/(canvasRight-canvasLeft)),Math.floor((pointer.y-canvasTop)*canvas.height/(canvasBottom-canvasTop)),1,1).data[3]>16}catch(error){fail(error)}
  }
  setInteractive(hit);
}
function renderBubble(){
  const activity=state.activity,task=activity.tasks[0];
  const count=activity.tasks.length>1?' · '+activity.labels.taskCount.replace('{{count}}',String(activity.tasks.length)):'';
  bubble.textContent=chatter.line?chatter.line.text:(task?activity.labels[task.status]:(activity.connected?activity.labels.idle:activity.labels.offline))+count;
  bubble.style.whiteSpace=chatter.line?'normal':'nowrap';
  bubble.title=task?task.title:activity.labels.openApp;
  bubble.setAttribute('aria-label',task?activity.labels.openTask+': '+task.title:activity.labels.openApp);
  bubble.hidden=false;
  refreshHitBounds();checkPointerAfterDraw=true;
}
function syncChatter(now){
  const enabled=!!image&&state.descriptor.builtIn&&state.descriptor.id==='iris'&&!dragging&&patStarted<0;
  const changed=chatter.update(state.activity,now,enabled);
  if(chatter.nextAt!==chatterDue){
    clearTimeout(chatterTimer);chatterTimer=null;chatterDue=chatter.nextAt;
    if(Number.isFinite(chatterDue))chatterTimer=setTimeout(onChatterTimer,Math.ceil(Math.max(0,chatterDue-now)));
  }
  return changed;
}
function onChatterTimer(){
  chatterTimer=null;chatterDue=Infinity;
  const now=performance.now();
  if(syncChatter(now)){renderBubble();syncPose(now);requestDraw()}
}
function frameAt(animation,key,started,now){
  if(motion.matches||animation.frames===1)return 0;
  if(key==='ready'&&patStarted>=0)return Math.min(animation.frames-1,Math.floor(Math.max(0,now-patStarted)*(animation.frames-1)/patDuration));
  const cycle=animation.frames*1000/animation.fps,phase=Math.max(0,now-started)%(cycle+(holds[key]||0));
  return phase>=cycle?0:Math.min(animation.frames-1,Math.floor(phase*animation.fps/1000));
}
function syncPose(now){
  if(!state||!image)return;
  const descriptor=state.descriptor,key=dragging&&descriptor.animations.dragging?'dragging':
    patStarted>=0&&now-patStarted<patDuration?'ready':chatter.line?.animation||state.activity.tasks[0]?.status||'idle';
  const animation=descriptor.animations[key],previous=poseDescriptor?.animations[animationKey];
  const changed=!poseDescriptor||poseImage!==image||poseDescriptor.id!==descriptor.id||animationKey!==key||
    poseDescriptor.frameWidth!==descriptor.frameWidth||poseDescriptor.frameHeight!==descriptor.frameHeight||
    previous.row!==animation.row||previous.frames!==animation.frames||previous.fps!==animation.fps;
  if(changed){
    transition=poseImage&&!motion.matches?{image:poseImage,descriptor:poseDescriptor,animation:previous,frame:frameAt(previous,animationKey,animationStarted,now),started:now}:null;
    animationKey=key;animationStarted=now;checkPointerAfterDraw=true;
  }
  poseImage=image;poseDescriptor=descriptor;
}
// All event-driven redraws share the same ceiling; snapshots never restart the pose clock.
function requestDraw(){
  const now=performance.now(),due=Math.max(now,lastDraw+frameInterval);
  if(animationTimer!==null&&timerDue<=due)return;
  clearTimeout(animationTimer);
  timerDue=due;animationTimer=setTimeout(advance,Math.ceil(Math.max(0,due-now)));
}
function drawSprite(sprite,descriptor,animation,frame,alpha){
  ctx.globalAlpha=alpha;
  const width=canvas.width,height=canvas.height;
  ctx.drawImage(sprite,frame*descriptor.frameWidth,animation.row*descriptor.frameHeight,descriptor.frameWidth,descriptor.frameHeight,
    motion.matches?width*.03:-width*.47,motion.matches?height*.03:-height*.94,width*.94,height*.94);
}
function drawHeart(x,y,size){
  ctx.beginPath();
  ctx.moveTo(x,y+size*.45);
  ctx.bezierCurveTo(x-size,y-size*.15,x-size*.55,y-size*.9,x,y-size*.4);
  ctx.bezierCurveTo(x+size*.55,y-size*.9,x+size,y-size*.15,x,y+size*.45);
  ctx.fill();
}
function draw(now){
  if(!poseImage)return;
  const width=canvas.width,height=canvas.height;
  const age=patStarted<0?patDuration:now-patStarted;
  if(age>=patDuration&&patStarted>=0){patStarted=-1;if(syncChatter(now))renderBubble();syncPose(now)}
  ctx.clearRect(0,0,width,height);
  if(!motion.matches){
    const elapsed=now-motionEpoch,breath=Math.sin(elapsed*Math.PI*2/4200),angle=Math.sin(elapsed*Math.PI*2/6900)*.006;
    let sx=1-breath*.0035,sy=1+breath*.007,y=0;
    if(age<120){
      const squash=Math.sin(age*Math.PI/120);
      sx+=squash*.10;sy-=squash*.13;
    }else if(age<620){
      const bounce=Math.sin((age-120)*Math.PI/500);
      y=-height*.085*bounce;sx-=bounce*.025;sy+=bounce*.045;
    }
    const cosine=Math.cos(angle),sine=Math.sin(angle),x=Math.sin(elapsed*Math.PI*2/6900)*width*.004;
    ctx.setTransform(sx*cosine,sx*sine,-sy*sine,sy*cosine,width*.5+x,height*.97+y);
  }
  const animation=poseDescriptor.animations[animationKey],frame=frameAt(animation,animationKey,animationStarted,now);
  let blend=1;
  if(transition){
    const progress=Math.min(1,(now-transition.started)/transitionDuration);
    blend=progress*progress*(3-2*progress);
    if(progress>=1)transition=null;
    else drawSprite(transition.image,transition.descriptor,transition.animation,transition.frame,1-blend);
  }
  drawSprite(poseImage,poseDescriptor,animation,frame,blend);
  if(!motion.matches)ctx.resetTransform();
  ctx.globalAlpha=1;
  if(patStarted>=0){
    ctx.fillStyle='#CE5D8A';
    for(let i=0;i<3;i++){
      const heartAge=age-i*90;
      if(!motion.matches&&heartAge<0)continue;
      const progress=motion.matches?0:Math.min(1,heartAge/(patDuration-i*90));
      ctx.globalAlpha=motion.matches ? .9 : Math.sin(progress*Math.PI);
      drawHeart(width*(.16+i*.34)+(motion.matches?0:Math.sin(progress*Math.PI)*width*.025*(i-1)),
        height*(.10+(i%2)*.015)-(motion.matches?0:progress*height*.07),width*.055);
    }
    ctx.globalAlpha=1;
  }
  // Only sample alpha when a real pointer overlaps moving art, never for the idle loop alone.
  const pointerOnArt=pointer.x>=canvasLeft&&pointer.x<canvasRight&&pointer.y>=canvasTop&&pointer.y<canvasBottom;
  const pointerOnBubble=!bubble.hidden&&pointer.x>=bubbleLeft&&pointer.x<bubbleRight&&pointer.y>=bubbleTop&&pointer.y<bubbleBottom;
  if(checkPointerAfterDraw||(!motion.matches&&!dragging&&!pointerOnBubble&&pointerOnArt))hitTest();
  checkPointerAfterDraw=false;
}
function advance(){
  animationTimer=null;
  const now=performance.now();
  if(now<lastDraw+frameInterval){requestDraw();return}
  draw(now);lastDraw=now;
  if(poseImage&&!motion.matches)requestDraw();
  else if(patStarted>=0){
    timerDue=patStarted+patDuration;animationTimer=setTimeout(advance,Math.ceil(Math.max(0,timerDue-performance.now())));
  }
}
function update(next){
  state=next;
  const activity=state.activity;
  document.body.style.fontFamily=activity.fontFamily+", 'Segoe UI', sans-serif";
  const size=sizes[state.size],ratio=state.descriptor.frameHeight/state.descriptor.frameWidth;
  const width=ratio>1?size/ratio:size,height=ratio>1?size:size*ratio;
  const pixelWidth=Math.round(width*devicePixelRatio),pixelHeight=Math.round(height*devicePixelRatio);
  if(canvas.width!==pixelWidth||canvas.height!==pixelHeight){canvas.width=pixelWidth;canvas.height=pixelHeight}
  canvas.style.width=width+'px';canvas.style.height=height+'px';
  // Keep the pet-side corner anchored: longer captions must grow away from the face.
  const bubbleRight=8+width-Math.min(40,width/4);
  bubble.style.right=bubbleRight+'px';bubble.style.maxWidth='calc(100% - '+(bubbleRight+8)+'px)';
  bubble.style.bottom=Math.round(height*.8+10)+'px';
  if(imageUrl!==state.descriptor.spriteUrl){
    imageUrl=state.descriptor.spriteUrl;image=null;const generation=++loadGeneration;
    const pending=new Image();pending.onload=()=>{if(generation===loadGeneration){image=pending;const now=performance.now();if(syncChatter(now))renderBubble();syncPose(now);requestDraw()}};
    pending.onerror=()=>{if(generation===loadGeneration)fail(new Error('Cannot load selected companion spritesheet'))};
    // The pet has its own origin; keep canvas pixels readable for alpha hit-testing.
    const spriteUrl=new URL(imageUrl);spriteUrl.host=location.host;pending.src=spriteUrl.href;
  }
  const now=performance.now();
  syncChatter(now);renderBubble();syncPose(now);requestDraw();
}
bridge.onState(update);bridge.onPointer(point=>{pointer=point;hitTest()});
bridge.ready().then(update).catch(fail);
addEventListener('resize',()=>{if(state)update(state)});
bubble.addEventListener('click',()=>bridge.open().catch(fail));
document.addEventListener('contextmenu',event=>{event.preventDefault();bridge.menu().catch(fail)});
canvas.addEventListener('pointerdown',event=>{
  if(event.button!==0||pointerStart)return;
  pointer.x=event.clientX;pointer.y=event.clientY;hitTest();
  if(interactive!==true)return;
  pointerStart={x:event.screenX,y:event.screenY,id:event.pointerId};moved=false;canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove',event=>{
  pointer.x=event.clientX;pointer.y=event.clientY;
  if(pointerStart&&event.pointerId===pointerStart.id&&!moved&&Math.hypot(event.screenX-pointerStart.x,event.screenY-pointerStart.y)>4){
    moved=true;dragging=true;patStarted=-1;canvas.classList.add('dragging');setInteractive(true);bridge.dragStart().catch(fail);
    const now=performance.now();if(syncChatter(now))renderBubble();syncPose(now);requestDraw();
  }
  hitTest();
});
function finish(event){
  if(!pointerStart||event.pointerId!==pointerStart.id)return;
  const wasDragging=dragging;
  pointerStart=null;dragging=false;canvas.classList.remove('dragging');
  if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);
  const now=performance.now();
  if(wasDragging)bridge.dragEnd().catch(fail);
  else if(event.type==='pointerup'&&event.button===0&&!moved)patStarted=now;
  if(syncChatter(now))renderBubble();
  syncPose(now);checkPointerAfterDraw=true;requestDraw();hitTest();
}
canvas.addEventListener('pointerup',finish);canvas.addEventListener('pointercancel',finish);canvas.addEventListener('lostpointercapture',finish);
motion.addEventListener('change',()=>{transition=null;checkPointerAfterDraw=true;requestDraw()});
</script></body></html>`;
