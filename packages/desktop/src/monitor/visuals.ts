import { ORB_EFFECTS_SCRIPT } from "./orb-effects.js";
import { ORB_GPU_SCRIPT } from "./orb-gpu.js";
import { ORB_HERO_SCRIPT } from "./orb-hero.js";
import { ORB_LIQUID_FRAGMENT_SHADER } from "./orb-liquid-shader.js";
import { ORB_PALETTE_SCRIPT } from "./orb-palette.js";
import { ORB_READOUT_SCRIPT } from "./orb-readout.js";
import { ORB_RESOURCES_SCRIPT } from "./orb-resources.js";
import { ORB_LED_FRAGMENT_SHADER } from "./orb-shader.js";
import { ORB_STYLES_SCRIPT } from "./orb-styles.js";
import { ORB_VEHICLE_ASSETS_SCRIPT } from "./orb-vehicle-data.js";

// Agent Speed v1.4.1, zoefix/agent-speed, MIT, frozen a94a67fcc78e5d8eea5f82d8d5e737bccf994e2c.
// This is the original-design port: normative LED GLSL/particles/lightning, Windows Presentation/GPU style geometry,
// original vehicles.json paths/rigs/scenery, and the original title badge. Per-module comments identify exact sources.
// Deliberate functional curation: OMP numeric frames only, tok/s only, no collectors/network/fabricated live values.
export const MONITOR_ORB_CSS = String.raw`
.as-orb-art{position:relative;isolation:isolate;overflow:visible;background:transparent!important;user-select:none;touch-action:none;--as-size:148px;--as-value:rgba(255,255,255,.96);--as-secondary:rgba(255,255,255,.55);--as-label:#7c8798;--as-hover:1}
.as-orb-art[data-appearance="light"]{--as-value:rgba(11,13,18,.92);--as-secondary:rgba(0,0,0,.5)}
.as-orb-art>canvas{position:absolute;display:block;pointer-events:none;background:transparent!important;transition:transform .2s cubic-bezier(.2,.8,.2,1);transform:scale(var(--as-hover));transform-origin:center}
.as-orb-transition{z-index:2;opacity:0}
.as-orb-gl{z-index:0}.as-orb-paint{z-index:1}.as-orb-fx{z-index:4}
.as-orb-readout{position:absolute;left:50%;top:50%;width:var(--as-size);height:var(--as-size);transform:translate(-50%,-50%) scale(var(--as-hover));transform-origin:center;pointer-events:none;z-index:3;font-family:"Segoe UI Variable Display","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;transition:transform .2s cubic-bezier(.2,.8,.2,1)}
.as-orb-number,.as-orb-unit,.as-orb-title-line{position:absolute;left:50%;transform:translateX(-50%);white-space:nowrap;line-height:1;text-align:center}
.as-orb-number{font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.5px;color:var(--as-value)}
.as-orb-value{display:inline-block;white-space:pre}.as-orb-old-value{position:absolute;left:0;top:0;opacity:0;white-space:pre;pointer-events:none}
.as-orb-unit{font-weight:500;letter-spacing:.5px;color:var(--as-secondary)}
.as-orb-title-line{font-weight:600;color:var(--as-label);letter-spacing:1.6px;text-transform:uppercase}
.as-orb-title,.as-orb-info{display:block;transition:opacity .2s ease;white-space:pre}.as-orb-info{position:absolute;left:50%;top:0;transform:translateX(-50%);opacity:0;text-transform:none;letter-spacing:.2px;color:var(--as-secondary)}
.as-orb-art[data-hovered="true"] .as-orb-title{opacity:0}.as-orb-art[data-hovered="true"] .as-orb-info{opacity:1}
.as-orb-peak{position:absolute;left:50%;transform:translate(-50%,-50%);z-index:5;padding:0 calc(var(--as-size)*.035);border-radius:999px;font:700 9px/1.55 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;outline:var(--as-pill-stroke,1px) solid rgba(250,204,21,.85);outline-offset:calc(var(--as-pill-stroke,1px)*-.5);color:#ffe58a;background:rgba(250,204,21,.18);opacity:0;white-space:nowrap;pointer-events:none}
.as-orb-art[data-appearance="light"] .as-orb-peak{color:#7a5a00;background:rgba(250,204,21,.22);outline-color:rgba(185,137,0,.85)}
.as-orb-art[data-embedded="true"] .as-orb-readout{display:none}
.as-orb-art[data-style="liquid"] .as-orb-readout{visibility:hidden}
.as-orb-art[data-thumbnail="true"] .as-orb-unit,.as-orb-art[data-thumbnail="true"] .as-orb-title-line,.as-orb-art[data-thumbnail="true"] .as-orb-peak{display:none}
.as-orb-art[data-static="true"]>canvas,.as-orb-art[data-static="true"] .as-orb-readout,.as-orb-art[data-static="true"] .as-orb-title,.as-orb-art[data-static="true"] .as-orb-info{transition:none}
.as-orb-render-error{position:absolute;inset:25%;display:grid;place-items:center;border-radius:50%;background:#141824;color:#e8ebf4;font:11px/1.4 "Segoe UI",sans-serif;text-align:center;pointer-events:none;z-index:6}
.as-orb-art[data-appearance="light"] .as-orb-render-error{background:#e7ebf3;color:#0b0d12}
@media(prefers-reduced-motion:reduce){.as-orb-art>canvas,.as-orb-readout,.as-orb-title,.as-orb-info{transition:none!important}}
`;

/** Static, nonce-authorized browser code. No Node, fetch, timers that invent data, or global renderer dependencies. */
export const MONITOR_VISUALS_SCRIPT =
  `const agentSpeedVisuals = (() => {\n"use strict";\n` +
  ORB_PALETTE_SCRIPT +
  ORB_RESOURCES_SCRIPT +
  ORB_READOUT_SCRIPT +
  ORB_STYLES_SCRIPT +
  ORB_VEHICLE_ASSETS_SCRIPT +
  ORB_HERO_SCRIPT +
  ORB_EFFECTS_SCRIPT +
  ORB_GPU_SCRIPT +
  `const LED_FRAGMENT_SHADER = ${JSON.stringify(ORB_LED_FRAGMENT_SHADER)};\n` +
  `const LIQUID_FRAGMENT_SHADER = ${JSON.stringify(ORB_LIQUID_FRAGMENT_SHADER)};\n` +
  String.raw`
const READOUTS={
  led:{value:.24,baseline:.012,max:.62,unit:.072,unitY:.116,titleY:.206,title:.062,titleMax:.58,infoMax:.62,infoScale:.92,dots:.3785,pill:-.232},
  needle:{value:.205,baseline:.035,max:.40,unit:.062,unitY:.115,titleY:.338,title:.062,titleMax:.46,infoMax:.42,infoScale:.85,dots:.405,pill:-.175},
  liquid:{value:.24,baseline:.012,max:.62,unit:.072,unitY:.116,titleY:.206,title:.062,titleMax:.58,infoMax:.62,infoScale:.92,dots:.3785,pill:-.232},
  reactor:{value:.205,baseline:.03,max:.46,unit:.062,unitY:.11,titleY:.184,title:.058,titleMax:.50,infoMax:.52,infoScale:.92,dots:.252,pill:-.172},
  minimal:{value:.30,baseline:.07,max:.66,unit:0,unitY:0,titleY:.168,title:.068,titleMax:.62,infoMax:.67,infoScale:.92,dots:null,pill:-.25}
};
const FX_LEVELS={off:0,soft:1,standard:2,max:3};
const VERTEX_SHADER='#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
function create(host,options){
  const thumbnail=!!options.thumbnail,sharedGpu=thumbnail||!!options.sharedGpu,embedded=!!options.embedded&&!thumbnail;
  host.classList.add('as-orb-art');host.dataset.embedded=String(embedded);host.dataset.thumbnail=String(thumbnail);host.dataset.hovered='false';
  const glCanvas=document.createElement('canvas'),paintCanvas=document.createElement('canvas'),fxCanvas=document.createElement('canvas'),transitionCanvas=document.createElement('canvas');
  glCanvas.className='as-orb-gl';paintCanvas.className='as-orb-paint';fxCanvas.className='as-orb-fx';transitionCanvas.className='as-orb-transition';
  for(const c of [glCanvas,paintCanvas,fxCanvas,transitionCanvas])c.setAttribute('aria-hidden','true');
  const readout=document.createElement('div'),number=document.createElement('div'),value=document.createElement('span'),oldValue=document.createElement('span'),unit=document.createElement('div'),titleLine=document.createElement('div'),titleLabel=document.createElement('span'),info=document.createElement('span'),pill=document.createElement('div');
  readout.className='as-orb-readout';readout.setAttribute('aria-hidden','true');number.className='as-orb-number';value.className='as-orb-value';oldValue.className='as-orb-old-value';unit.className='as-orb-unit';titleLine.className='as-orb-title-line';titleLabel.className='as-orb-title';info.className='as-orb-info';pill.className='as-orb-peak';pill.setAttribute('aria-hidden','true');
  number.append(oldValue,value);titleLine.append(titleLabel,info);readout.append(number,unit,titleLine);host.append(glCanvas,paintCanvas,transitionCanvas,readout,fxCanvas,pill);
  const paint=paintCanvas.getContext('2d'),fx=fxCanvas.getContext('2d'),transitionPaint=transitionCanvas.getContext('2d'),sharedPaint=sharedGpu?glCanvas.getContext('2d'):null;
  if(!paint||!fx||!transitionPaint||sharedGpu&&!sharedPaint)throw new Error('Agent Speed instruments require Canvas 2D');
  const st={S:148,dpr:1,dark:true,embedded,thumbnail,reduced:false,maxFps:60,resources:null,style:'led',fx:2,level:1,moving:true,value:0,h:0,o:0,targetH:0,targetO:0,time:0,tier:0,candidateTier:0,tierHold:0,flash:0,peakAge:99,pulseAge:99,comet:0,flow:0,phase:0,phase2:0,warp:0,corona:0,heroMotePhase:0,idleSweep:-1,sweepAge:99,hovered:false,jitterX:0,jitterY:0,jitterAt:0,needleShown:0,readoutAnimate:false,
    heatSpring:{value:0,velocity:0},overSpring:{value:0,velocity:0},needle:{value:0,velocity:0},liquid:{value:.08,velocity:0},liquidSurge:{value:0,velocity:0},liquidPhases:new Float32Array(4),rotors:new Float64Array([.3,1.1,2]),rotorFrom:new Float64Array(3),rotorTo:new Float64Array(3),bandPhase:0,kick:0,waves:Array.from({length:4},()=>({age:99,strength:1,heat:0})),ripples:Array.from({length:4},()=>({age:99,x:0,amplitude:0}))};
  const effects=createEffects(st,value,fxCanvas),hero=embedded?createHero():null,liquidText=createLiquidReadout(st),readoutMetrics={},waveUniforms=new Float32Array(16),rippleUniforms=new Float32Array(16),waveColorUniforms=new Float32Array(16);
  let frame=null,visible=true,destroyed=false,primed=false,dirty=false,raf=0,idleTimer=0,lastRendered=0,lastClock=0,idleAt=performance.now(),lastResponse=-Infinity,rollUntil=0,titleUntil=0,lastText='',lastTitle='',lastTheme='',lastValue=0,animations=[];
  let gl=null,buffer=null,programs=null,nativeGpu=null,thumbnailLease=null,gpuError=null,errorLabel=null,contextLost=false;
  function gpu(){
    if(programs)return true;if(gpuError||contextLost)return false;
    try{
      let resources;
      if(sharedGpu){
        if(!thumbnailLease)thumbnailLease=retainThumbnailGpu(lost,restored);
        resources=thumbnailGpuResources(thumbnailLease.pool);if(!resources)return false;
      }else{
        if(!nativeGpu){gl=orbGl(glCanvas);nativeGpu=createGpuResources(gl);}resources=nativeGpu;
      }
      gl=resources.gl;buffer=resources.buffer;programs=resources.programs;return true;
    }catch(error){gpuError=error instanceof Error?error.message:String(error);host.dataset.renderError=gpuError;return false;}
  }
  function releaseThumbnail(){
    if(!thumbnailLease)return;
    liquidText.reset(contextLost?null:gl);releaseThumbnailGpu(thumbnailLease);thumbnailLease=null;gl=buffer=programs=null;contextLost=false;gpuError=null;
    if(!destroyed){delete host.dataset.renderError;showError(false);}
  }
  function showError(show){
    if(show&&!errorLabel){errorLabel=document.createElement('div');errorLabel.className='as-orb-render-error';errorLabel.setAttribute('role','status');host.append(errorLabel);}
    if(errorLabel){errorLabel.hidden=!show;errorLabel.style.display=show?'grid':'none';errorLabel.textContent=frame&&frame.language==='zh'?'GPU 绘图不可用':'GPU drawing unavailable';errorLabel.title=gpuError||'WebGL context lost';}
  }
  function resize(){
    const S=st.S,dpr=Math.min(2,window.devicePixelRatio||1),extent=1.5*S,px=Math.max(1,Math.round(extent*dpr));st.dpr=dpr;
    host.style.setProperty('--as-size',S+'px');host.style.width=(embedded?S:extent)+'px';host.style.height=(embedded?S:extent)+'px';
    for(const c of [glCanvas,paintCanvas,fxCanvas,transitionCanvas]){
      c.style.left=c.style.top=(embedded?-.25*S:0)+'px';c.style.width=c.style.height=extent+'px';
      if(c.width!==px||c.height!==px){c.width=c.height=px;}
    }
    readout.style.width=readout.style.height=S+'px';
  }
  function fitText(node,text,size,maxWidth,weight,tracking,minScale,minFont=7){
    paint.font=weight+' '+size+'px "Segoe UI Variable Display","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif';
    const width=paint.measureText(text).width,chars=Math.max(0,Array.from(text).length-1);
    const track=chars>0?Math.max(0,Math.min(tracking,(maxWidth-width)/chars)):0;
    const actual=Math.max(minFont,size*Math.max(minScale,Math.min(1,maxWidth/Math.max(1,width+chars*track))));
    node.style.fontSize=actual+'px';node.style.letterSpacing=track+'px';return actual;
  }
  function layout(){
    const L=READOUTS[st.style],S=st.S;
    const size=fitText(number,frame.formattedValue,L.value*S,L.max*S,700,-.5,0);
    number.style.top=(.5*S+L.baseline*S-.80*size)+'px';
    unit.textContent=frame.unit;unit.style.display=L.unit>0?'block':'none';const unitSize=Math.max(7,L.unit*S);unit.style.fontSize=unitSize+'px';unit.style.top=(.5*S+L.unitY*S-.80*unitSize)+'px';
    const ts=fitText(titleLine,frame.title,Math.max(7,L.title*S),L.titleMax*S,600,1.6,.8);
    titleLine.style.top=(.5*S+L.titleY*S-.80*ts)+'px';info.textContent=frame.hoverLabel;const infoSize=fitText(info,frame.hoverLabel,ts*L.infoScale,L.infoMax*S,500,.2,.7,0);
    readoutMetrics.valueSize=size;readoutMetrics.unitSize=unitSize;readoutMetrics.valueY=L.baseline;readoutMetrics.unitY=L.unitY;readoutMetrics.labelY=L.titleY;
    readoutMetrics.valueTracking=parseFloat(number.style.letterSpacing)||0;readoutMetrics.labelText=st.hovered?frame.hoverLabel:frame.title;
    readoutMetrics.labelSize=st.hovered?infoSize:ts;readoutMetrics.labelTracking=parseFloat((st.hovered?info:titleLine).style.letterSpacing)||0;readoutMetrics.labelWeight=st.hovered?500:600;
    if(st.style==='liquid')liquidText.update(frame,readoutMetrics,st.readoutAnimate);
    pill.style.fontSize=.056*S+'px';pill.style.letterSpacing=frame.language==='en'?1.2*S/148+'px':'0';pill.style.setProperty('--as-pill-stroke',Math.max(1,S/148)+'px');pill.style.top=((embedded?.5:.75)*S+L.pill*S)+'px';pill.textContent=frame.language==='zh'?'新纪录':'NEW PEAK';
  }
  function cancelAnimations(){for(const animation of animations)animation.cancel();animations=[];oldValue.textContent='';value.style.opacity='';value.style.transform='';titleLabel.style.opacity='';titleLabel.style.transform='';pill.style.opacity='0';}
  function snap(){
    st.h=st.heatSpring.value=st.targetH;st.o=st.overSpring.value=st.targetO;st.heatSpring.velocity=st.overSpring.velocity=0;
    st.needle.value=st.targetH;st.needle.velocity=0;st.liquid.value=.08+.74*st.h+.06*st.o;st.liquid.velocity=0;st.liquidSurge.value=st.liquidSurge.velocity=0;
  }
  function stop(clearEvents){
    if(raf)cancelAnimationFrame(raf);raf=0;if(idleTimer)clearTimeout(idleTimer);idleTimer=0;lastClock=lastRendered=0;
    if(clearEvents){effects.clear();for(const w of st.waves)w.age=99;st.peakAge=st.pulseAge=99;st.flash=0;st.sweepAge=99;st.idleSweep=-1;cancelAnimations();}
  }
  function idleWake(){
    if(idleTimer||!st.moving||st.value>=.5||st.style==='minimal'||!visible||document.hidden||destroyed)return;
    const now=performance.now(),next=(Math.floor(now/6000)+1)*6000;
    idleTimer=setTimeout(()=>{
      idleTimer=0;if(!visible||document.hidden||destroyed||!st.moving||st.value>=.5)return;
      if(performance.now()-idleAt<2000){idleWake();return;}
      st.sweepAge=0;if(st.style==='liquid')effects.bubble(-.15*st.S,.43*st.S);schedule();
    },Math.max(1,next-now));
  }
  function pulse(){
    const now=performance.now();if(now-lastResponse<150)return;lastResponse=now;
    let slot=st.waves[0];for(const w of st.waves){if(w.age>=1){slot=w;break;}if(w.age>slot.age)slot=w;}
    slot.age=0;slot.strength=1;slot.heat=st.h;st.pulseAge=0;if(st.moving){st.kick+=.25;effects.response();}
  }
  function peak(){
    st.peakAge=0;if(st.moving)effects.peak();
    for(let i=0;i<3;i++){
      const symmetry=i===0?TAU/3:i===1?TAU/(st.S<120?12:24):Math.PI,n=(st.rotors[i]+Math.PI/2)/symmetry;
      st.rotorFrom[i]=st.rotors[i];st.rotorTo[i]=-Math.PI/2+(i===1?Math.floor(n):Math.ceil(n))*symmetry;
    }
    // ReadoutLayer.RenderPill: fixed center, native OutBack(2.2) scale; Off/RM retain only the 0.2s opacity crossfade.
    const keyframes=[];
    if(st.moving){
      for(let i=0;i<=15;i++){const t=i/15-1,appear=1+3.2*t*t*t+2.2*t*t;keyframes.push({offset:i/15*.45/1.8,transform:'translate(-50%,-50%) scale('+(.6+.4*appear)+')',opacity:clamp(appear)});}
      keyframes.push({offset:1-.25/1.8,transform:'translate(-50%,-50%) scale(1)',opacity:1},{offset:1,transform:'translate(-50%,-50%) scale(1)',opacity:0});
    }else keyframes.push({opacity:0},{opacity:1,offset:.2/1.8},{opacity:1,offset:1-.25/1.8},{opacity:0});
    const animation=pill.animate(keyframes,{duration:1800,easing:'linear'});
    animations.push(animation);
  }
  function tierFor(v){
    const thresholds=[0,.5,.15*frame.redline,.375*frame.redline,.75*frame.redline];let tier=0;
    for(let i=1;i<5;i++)if(v>=thresholds[i]||(st.tier>=i&&v>=.9*thresholds[i]))tier=i;return tier;
  }
  function step(dt){
    st.time+=dt;st.peakAge+=dt;st.pulseAge+=dt;st.flash=Math.max(0,st.flash-dt/.4);st.sweepAge+=dt;st.idleSweep=st.sweepAge<.9?lerp(-.15,1.15,st.sweepAge/.9):-1;
    for(const w of st.waves)w.age+=dt/.85;
    if(!st.moving){if(hero)hero.update(frame,st,0);return;}
    settle(st.heatSpring,st.targetH,dt,.6);settle(st.overSpring,st.targetO,dt,.6);st.h=clamp(st.heatSpring.value);st.o=clamp(st.overSpring.value);
    const candidate=tierFor(st.value);
    if(candidate!==st.candidateTier){st.candidateTier=candidate;st.tierHold=0;}else st.tierHold+=dt;
    const hold=candidate===0?3:.8;
    if(candidate!==st.tier&&st.tierHold>=hold){st.tier=candidate;st.flash=1;}
    const rate=st.fx===1?.5:1;
    if(st.h>.005)st.comet+=dt/(6+(.7-6)*st.h)*(1+.6*st.o);
    st.flow+=dt*(.35+1.9*st.h+1.6*st.o);st.phase+=dt*(.12+1.4*st.h+2.2*st.o)*rate;st.phase2+=dt*(.05+.5*st.h+1.2*st.o)*rate;st.warp+=dt*(.2+1.1*st.h+1.2*st.o);st.corona+=dt*(.5+1.7*st.h+1.8*st.o);
    const target=st.targetH+(st.targetO>0?.02+.05*st.targetO:0);
    spring(st.needle,target,dt,1.5,.55);
    if(st.needle.value<-.012){st.needle.value=-.012;st.needle.velocity*=-.32;}else if(st.needle.value>1.012){st.needle.value=1.012;st.needle.velocity*=-.32;}
    spring(st.liquid,.08+.74*st.h+.06*st.o,dt,.75,.62);spring(st.liquidSurge,0,dt,.9,.45);
    st.liquidPhases[0]+=dt*TAU*(.25+.5*st.h+.3*st.o);st.liquidPhases[1]+=dt*TAU*(.4+.8*st.h+.4*st.o);st.liquidPhases[2]+=dt*TAU*(.9+1.6*st.h);st.liquidPhases[3]+=dt*TAU*3.1;
    const p=Math.pow(st.h,1.3),k=st.kick;st.kick*=Math.exp(-dt/.5);
    if(st.value>=.5){
      const lock=st.peakAge<.57;
      if(lock){const x=Math.min(1,st.peakAge/.42)-1,q=1+2.2*x*x*x+1.2*x*x;for(let i=0;i<3;i++)st.rotors[i]=lerp(st.rotorFrom[i],st.rotorTo[i],q);}
      else{st.rotors[0]+=dt*TAU*(.03+.45*p+.35*st.o+k);st.rotors[1]-=dt*TAU*(.02+.30*p+.25*st.o+.6*k);st.rotors[2]+=dt*TAU*(.05+1.1*p+.7*st.o+1.2*k);}
      st.bandPhase+=dt*TAU*(.15+1.4*st.h+.6*st.o);st.heroMotePhase+=dt*TAU*(.06+.9*st.h+.5*st.o);
    }
    if(st.time>=st.jitterAt){st.jitterAt=st.time+1/30;const j=st.tier>=4&&st.fx>=2?(st.style==='led'?.9+1.2*st.o:.6):0;st.jitterX=(Math.random()-.5)*2*j;st.jitterY=(Math.random()-.5)*2*j;}
    effects.tick(dt);if(hero)hero.update(frame,st,dt);
  }
  function drawGpu(){
    if(!gpu())return false;
    const renderCanvas=sharedGpu?thumbnailLease.pool.canvas:glCanvas;
    if(renderCanvas.width!==glCanvas.width||renderCanvas.height!==glCanvas.height){renderCanvas.width=glCanvas.width;renderCanvas.height=glCanvas.height;}
    const p=programs[st.style],u=p.locations;gl.useProgram(p.program);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);gl.enableVertexAttribArray(0);gl.viewport(0,0,glCanvas.width,glCanvas.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    const peakAge=st.fx>0&&(st.moving||st.style==='liquid'&&st.reduced)?st.peakAge:99;
    gl.uniform2f(u.uRes,glCanvas.width,glCanvas.height);gl.uniform1f(u.uS,st.S*st.dpr);gl.uniform1f(u.uLogicalS,st.S);gl.uniform1f(u.uThumbnail,thumbnail?1:0);gl.uniform1f(u.uReduced,st.reduced?1:0);gl.uniform1f(u.uTime,st.time);gl.uniform1f(u.uH,st.h);gl.uniform1f(u.uO,st.o);gl.uniform1f(u.uDark,st.dark?1:0);gl.uniform1f(u.uNew,1);gl.uniform1f(u.uLevel,embedded?1:st.level);gl.uniform1f(u.uFlash,st.flash);gl.uniform1f(u.uPeak,peakAge);gl.uniform1f(u.uSweep,st.moving&&st.peakAge<.5?ease(st.peakAge/.5):1);gl.uniform1f(u.uTier,st.tier);gl.uniform1f(u.uComet,st.comet);gl.uniform1f(u.uFlow,st.flow);gl.uniform1f(u.uPhase,st.phase);gl.uniform1f(u.uPhase2,st.phase2);gl.uniform1f(u.uWarp,st.warp);gl.uniform1f(u.uCorona,st.corona);
    gl.uniform1f(u.uFx,embedded?Math.min(st.fx,1):st.fx);gl.uniform1f(u.uMoving,st.moving?1:0);gl.uniform1f(u.uEmbedded,embedded?1:0);gl.uniform1f(u.uIdleSweep,st.idleSweep);gl.uniform1f(u.uSurface,clamp(st.liquid.value+st.liquidSurge.value,.04,.95));gl.uniform4fv(u.uPhases,st.liquidPhases);
    gl.uniform4f(u.uTicks,Math.pow(.5/frame.redline,.6),Math.pow(.15,.6),Math.pow(.375,.6),Math.pow(.75,.6));
    waveUniforms.fill(-1);rippleUniforms.fill(0);
    for(let i=0;i<4;i++){
      const w=st.waves[i];if(st.moving&&w.age<1){waveUniforms[i*4]=w.age;waveUniforms[i*4+1]=w.strength;waveUniforms[i*4+2]=w.heat;waveUniforms[i*4+3]=0;}
      if(st.style==='liquid'&&w.age<1){
        if(!w.paint||w.paintDark!==st.dark||w.paintHeat!==w.heat){w.paint=st.dark?labMix(heatRgb(w.heat),HOT,.3):heroStroke(w.heat,false);w.paintDark=st.dark;w.paintHeat=w.heat;}
        waveColorUniforms.set(w.paint,i*4);
      }
      const r=st.ripples[i];if(r.age<2.2){rippleUniforms[i*4]=r.x;rippleUniforms[i*4+1]=.42*r.age;rippleUniforms[i*4+2]=r.amplitude*Math.exp(-r.age/.75);rippleUniforms[i*4+3]=1;}
    }
    if(st.style==='liquid'){const c=liquidColors(st);gl.uniform4fv(u.uLiquidColors,c.values);gl.uniform3fv(u.uLiquidInk,c.ink);gl.uniform2f(u.uMeniscus,c.width,c.sigma);gl.uniform4fv(u.uWaveColors,waveColorUniforms);liquidText.bind(gl,u,paintCanvas);}
    gl.uniform4fv(u.uWaves,waveUniforms);gl.uniform4fv(u.uRipples,rippleUniforms);gl.drawArrays(gl.TRIANGLES,0,3);
    if(sharedGpu){sharedPaint.clearRect(0,0,glCanvas.width,glCanvas.height);sharedPaint.drawImage(renderCanvas,0,0);}
    return true;
  }
  function shared(ctx){
    if(thumbnail)return;
    if(st.reduced&&st.fx>0&&st.style!=='minimal'){
      ctx.save();ctx.globalCompositeOperation=st.dark?'lighter':'source-over';
      for(const w of st.waves)if(w.age<1)arc(ctx,.53*st.S,.006*st.S,0,360,rgba(st.dark?mix(heatRgb(w.heat),HOT,.3):labelRgb(w.heat,false),.5*Math.sin(Math.PI*w.age)*w.strength));
      if(st.peakAge<1.3)arc(ctx,.54*st.S,3*st.S/148,0,360,rgba(st.dark?mix(heatRgb(1),HOT,.25):labelRgb(1,false),.45*Math.sin(Math.PI*st.peakAge/1.3)));
      ctx.restore();
    }
    if(st.moving&&st.style!=='led'&&st.style!=='liquid'&&st.style!=='minimal'){
      ctx.save();ctx.globalCompositeOperation=st.dark?'lighter':'source-over';
      for(const w of st.waves)if(w.age<1){const rr=.5+.24*ease(w.age),width=(.005+.005*w.strength)*(1-w.age)+.001,c=st.dark?mix(heatRgb(w.heat),HOT,.3):labelRgb(w.heat,false);arc(ctx,rr*st.S,width*st.S,0,360,rgba(c,(1-w.age)*.7*w.strength));}
      if(st.peakAge<1.4){radial(ctx,0,0,.60*st.S,st.dark?HOT:AMBER,Math.exp(-st.peakAge*4.5)*(st.dark?.75:.35));arc(ctx,(.5+.24*ease(st.peakAge/1.4))*st.S,(.012+.02*st.peakAge)*st.S,0,360,'rgba(255,199,77,'+(1-st.peakAge/1.4)+')');}
      ctx.restore();
    }
    const L=READOUTS[st.style];if(L.dots===null||st.value<.5)return;
    const active=Math.max(0,Math.floor(frame.activeAgents)),tools=Math.max(0,Math.floor(frame.toolsAgents)),count=active+tools;if(count===0)return;
    const dots=Math.min(count,6),overflow=count>6,shown=overflow?5:dots,gap=7,y=L.dots*st.S,start=-(shown-1)*gap/2-(overflow?7:0),c=[132/255,204/255,22/255];
    const pulse=st.moving?.7+.3*Math.sin(st.time*TAU*.8):1;
    for(let i=0;i<shown;i++){
      const x=start+i*gap,tool=i>=active;
      if(st.style==='liquid')dot(ctx,x,y,3.2,st.dark?'rgba(6,8,12,.55)':'rgba(255,255,255,.75)');
      if(tool){ctx.lineWidth=1.25;ctx.strokeStyle=rgba(c,.65);ctx.beginPath();ctx.arc(x,y,2,0,TAU);ctx.stroke();}else dot(ctx,x,y,2,rgba(c,pulse));
    }
    if(overflow){ctx.font='600 7px "Segoe UI",sans-serif';ctx.fillStyle=st.dark?'rgba(255,255,255,.65)':'rgba(0,0,0,.5)';ctx.textBaseline='middle';ctx.fillText('+'+(count-5),start+shown*gap-1,y);}
  }
  function readoutEffects(){
    const S=st.S,active=st.value>=.5,dark=st.dark,h=st.h,style=st.style,shadows=[];
    host.style.setProperty('--as-value',active?(dark?'rgba(255,255,255,.96)':'rgba(11,13,18,.92)'):(dark?'rgba(255,255,255,.60)':'rgba(11,13,18,.55)'));
    host.style.setProperty('--as-label',active?color(h,dark?'dark':'light'):(dark?'rgba(255,255,255,.45)':'rgba(0,0,0,.40)'));
    if(st.tier>=2&&style!=='minimal'&&st.fx>0){const blur=.035*S*(style==='led'?1+.8*st.o:1);shadows.push('0 0 '+blur+'px '+rgba(heatRgb(h),dark?.85:.2));if(style==='led'&&st.tier>=3)shadows.push('0 0 '+blur*2.4+'px '+rgba(heatRgb(h),dark?.45:.2));}
    if(style==='led'&&dark&&st.tier>=4&&st.fx>=2&&st.moving){const off=(.6+1.6*st.o)*S/300;shadows.push(-off+'px 0 0 rgba(255,60,140,.55)',off+'px 0 0 rgba(60,210,255,.55)');}
    if(style==='led'&&dark&&active)shadows.push('0 0 '+.025*S+'px rgba(0,0,0,.7)','0 '+.006*S+'px '+.012*S+'px rgba(0,0,0,.6)');
    // Liquid glyphs are rendered by the GPU through complementary analytical surface clips, including the submerged unit.
    number.style.color='';titleLabel.style.color='';
    number.style.textShadow=shadows.length?shadows.join(','):'none';
    const skew=st.tier>=3&&st.fx>=2&&st.moving&&style!=='minimal'?(style==='led'?-7.5:-6)*h:0;
    number.style.transform='translateX(-50%) translate('+st.jitterX+'px,'+st.jitterY+'px) skewX('+skew+'deg)';
  }
  function render(){
    if(!frame||!visible||document.hidden||destroyed)return;
    dirty=false;
    for(const ctx of [paint,fx]){ctx.restore();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,paintCanvas.width,paintCanvas.height);ctx.setTransform(st.dpr,0,0,st.dpr,.75*st.S*st.dpr,.75*st.S*st.dpr);ctx.save();ctx.beginPath();ctx.arc(0,0,.74*st.S,0,TAU);ctx.clip();}
    const usesGpu=st.style==='led'||st.style==='liquid';glCanvas.style.display=usesGpu?'block':'none';paintCanvas.style.visibility=st.style==='liquid'?'hidden':'visible';
    if(st.style==='liquid'){if(st.moving)effects.draw(paint);shared(paint);const okay=drawGpu();showError(!okay);}
    else{
      if(usesGpu){const okay=drawGpu();showError(!okay);}else{showError(false);paintBody(paint,st,st.style);if(st.style==='needle')paintNeedle(paint,st);else if(st.style==='reactor')paintReactor(paint,st);else paintMinimal(paint,st);}
      if(hero)hero.draw(paint,st,frame);if(st.moving){effects.draw(paint);effects.draw(fx,true);}shared(paint);
    }
    readoutEffects();
    for(let i=animations.length-1;i>=0;i--)if(animations[i].playState==='finished')animations.splice(i,1);
  }
  function settling(){
    return Math.abs(st.heatSpring.value-st.targetH)>.0005||Math.abs(st.overSpring.value-st.targetO)>.0005||Math.abs(st.heatSpring.velocity)>.001||Math.abs(st.overSpring.velocity)>.001||(st.style==='needle'&&Math.abs(st.needle.velocity)>.001)||(st.style==='liquid'&&(Math.abs(st.liquid.velocity)>.001||Math.abs(st.liquidSurge.velocity)>.001));
  }
  function animating(){
    if(thumbnail)return false;
    if((st.style==='led'||st.style==='liquid')&&(gpuError||contextLost))return false;
    if(!st.moving)return st.peakAge<1.8||st.reduced&&st.fx>0&&(st.pulseAge<.85||performance.now()<titleUntil);
    if(settling()||st.peakAge<1.8||st.pulseAge<.85||st.sweepAge<1.2||effects.busy()||performance.now()<rollUntil||performance.now()<titleUntil)return true;
    if(st.value>=.5){if(st.style==='minimal')return st.tier>=4||st.candidateTier!==st.tier;return true;}
    return hero!==null||st.tier!==0;
  }
  function schedule(){
    if(destroyed||!visible||document.hidden||!frame)return;
    if(!dirty&&!animating()){idleWake();return;}
    if(hero&&st.value<.5)idleWake();else if(idleTimer){clearTimeout(idleTimer);idleTimer=0;}
    if(!raf){lastClock=lastClock||performance.now();raf=requestAnimationFrame(tick);}
  }
  function tick(now){
    raf=0;if(destroyed||!visible||document.hidden||!frame)return;
    const transition=st.peakAge<1.8||st.pulseAge<.85||now<rollUntil||now<titleUntil;
    const heroBand=hero&&lastTheme!=='vehicles'&&st.sweepAge>=.63&&st.sweepAge<1.53;
    const preferred=!st.moving?30:hero?(hero.demanding(st)||transition||settling()?60:heroBand?30:15):st.style==='minimal'&&!transition&&!settling()?15:transition||st.h>=.45&&!(st.style==='liquid'&&st.fx===1)||st.style==='needle'&&Math.abs(st.needle.velocity)*270>90?60:30;
    // Native controller computes the cross-window budget; each isolated renderer consumes only its assigned cap.
    const fps=Math.min(st.maxFps,thumbnail?15:60,preferred);
    if(lastRendered&&now-lastRendered<1000/fps){raf=requestAnimationFrame(tick);return;}
    const dt=Math.min(.1,Math.max(0,(now-lastClock)/1000));lastClock=lastRendered=now;
    step(dt);render();if(dirty||animating())raf=requestAnimationFrame(tick);else{lastClock=0;idleWake();}
  }
  function update(next){
    if(destroyed)return;
    const wasMoving=st.moving,oldStyle=st.style,oldSize=st.S,oldAppearance=st.dark;
    const crossfade=primed&&!embedded&&oldStyle!==next.style&&wasMoving&&!next.reduceMotion&&next.effects!=='off'&&visible&&!document.hidden&&oldSize===next.size;
    if(crossfade){
      render();transitionPaint.clearRect(0,0,transitionCanvas.width,transitionCanvas.height);
      if(oldStyle==='led'||oldStyle==='liquid')transitionPaint.drawImage(glCanvas,0,0);
      transitionPaint.drawImage(paintCanvas,0,0);transitionPaint.drawImage(fxCanvas,0,0);
    }
    frame=next;st.style=embedded?'led':next.style;st.S=thumbnail?clamp(next.size,1,63):clamp(next.size,64,240);st.dark=next.appearance!=='light';st.reduced=!!next.reduceMotion;st.maxFps=next.maxFps===30?30:60;
    if(sharedGpu&&st.style!=='led'&&st.style!=='liquid')releaseThumbnail();
    const requested=FX_LEVELS[next.effects];st.fx=st.reduced||thumbnail?Math.min(requested,1):requested;st.level=st.fx===3?1.6:1;st.moving=st.fx>0&&!st.reduced&&!thumbnail;
    st.value=next.value===null?0:Math.max(0,next.value);st.targetH=heat(st.value,next.redline);st.targetO=clamp((st.value-next.redline)/next.redline);
    host.dataset.style=st.style;host.dataset.appearance=st.dark?'dark':'light';host.dataset.static=String(!st.moving);host.style.opacity=String(clamp(next.opacity,0,1));host.setAttribute('aria-label',next.formattedValue+' '+next.unit+' · '+next.title);
    st.hovered=!!next.hovered;host.dataset.hovered=String(st.hovered);host.style.setProperty('--as-hover',st.hovered&&!st.reduced&&!thumbnail?'1.03':'1');
    if(!primed||!st.moving||!visible||document.hidden)snap();
    if(!primed){st.tier=st.candidateTier=tierFor(st.value);st.tierHold=0;}
    if(st.value<.5&&lastValue>=.5)idleAt=performance.now();
    const structural=oldStyle!==st.style||oldSize!==st.S||oldAppearance!==st.dark;
    if(structural){effects.clear();for(const w of st.waves)w.age=99;st.peakAge=st.pulseAge=99;cancelAnimations();}
    if(crossfade)animations.push(transitionCanvas.animate([{opacity:1},{opacity:0}],{duration:250,easing:'ease-out'}));
    if(!st.moving){if(wasMoving||structural)stop(true);st.tier=st.candidateTier=tierFor(st.value);st.jitterX=st.jitterY=0;}
    else if(!wasMoving){lastClock=lastRendered=0;}
    resize();
    const canAnimate=primed&&st.moving&&visible&&!document.hidden,canFeedback=primed&&!thumbnail&&visible&&!document.hidden;
    const oldText=lastText;st.readoutAnimate=canAnimate;value.textContent=next.formattedValue;titleLabel.textContent=next.title;layout();
    if(canAnimate&&oldText!==next.formattedValue&&!embedded&&st.style!=='minimal'&&st.S>=80){
      const rolling=oldText.length===next.formattedValue.length;
      oldValue.textContent=oldText;
      const direction=st.value>=lastValue?-1:1,travel=.92*parseFloat(number.style.fontSize),duration=rolling?240:120;
      animations.push(oldValue.animate([{transform:'translateY(0)',opacity:1},{transform:'translateY('+(rolling?direction*travel:0)+'px)',opacity:0}],{duration,easing:'cubic-bezier(.2,.8,.2,1)'}));
      animations.push(value.animate([{transform:'translateY('+(rolling?-direction*travel:0)+'px)',opacity:0},{transform:'translateY(0)',opacity:1}],{duration,easing:'cubic-bezier(.2,.8,.2,1)'}));rollUntil=performance.now()+duration;
    }else oldValue.textContent='';
    if(canFeedback&&st.fx>0&&lastTitle!==next.title&&!embedded){animations.push(titleLabel.animate([{opacity:0,transform:'translateY('+(st.reduced||st.style==='minimal'?0:.06*st.S)+'px)'},{opacity:1,transform:'translateY(0)'}],{duration:st.reduced?300:st.style==='minimal'?250:350,easing:'cubic-bezier(.2,.8,.2,1)'}));titleUntil=performance.now()+(st.reduced?300:350);}
    if(canFeedback&&st.fx>0&&embedded&&(lastTitle!==next.title||lastTheme!==next.titleTheme))titleUntil=performance.now()+(st.reduced?300:750);
    // The renderer owns event qualification (measured, live, not catch-up/history/estimates). Never derive events here.
    if(canFeedback&&st.fx>0&&next.responsePulse){pulse();if(st.moving)effects.zap(next.formattedValue,oldText);}
    if(canFeedback&&next.newPeak)peak();
    if(hero){hero.update(canAnimate?next:{...next,responsePulse:false,newPeak:false},st,0);if(!visible||document.hidden)hero.pause();}
    lastText=next.formattedValue;lastTitle=next.title;lastTheme=next.titleTheme;lastValue=st.value;primed=true;
    if(visible&&!document.hidden){dirty=true;schedule();}
  }
  function setVisible(next){
    const changed=visible!==!!next;visible=!!next;
    if(!visible){stop(true);releaseThumbnail();return;}
    if(changed&&frame&&!document.hidden){snap();if(hero){hero.pause();hero.update({...frame,responsePulse:false,newPeak:false},st,0);}dirty=true;schedule();}
  }
  function visibility(){
    if(document.hidden){stop(true);releaseThumbnail();}else if(visible&&frame){snap();if(hero)hero.pause();dirty=true;schedule();}
  }
  function lost(event){event.preventDefault();contextLost=true;nativeGpu=null;programs=buffer=null;liquidText.reset(null);stop(true);if(hero)hero.pause();if(sharedPaint)sharedPaint.clearRect(0,0,glCanvas.width,glCanvas.height);gpuError=gpuError||'WebGL context lost';host.dataset.renderError=gpuError;showError(true);}
  function restored(){contextLost=false;programs=buffer=null;nativeGpu=null;gpuError=null;delete host.dataset.renderError;if(frame){snap();dirty=true;schedule();}}
  function windowResize(){if(frame&&visible&&!document.hidden){st.readoutAnimate=false;resize();layout();dirty=true;schedule();}}
  document.addEventListener('visibilitychange',visibility);window.addEventListener('resize',windowResize);if(!sharedGpu){glCanvas.addEventListener('webglcontextlost',lost);glCanvas.addEventListener('webglcontextrestored',restored);}
  function destroy(){
    if(destroyed)return;destroyed=true;stop(true);
    document.removeEventListener('visibilitychange',visibility);window.removeEventListener('resize',windowResize);if(!sharedGpu){glCanvas.removeEventListener('webglcontextlost',lost);glCanvas.removeEventListener('webglcontextrestored',restored);}
    if(sharedGpu)releaseThumbnail();else{liquidText.reset(contextLost?null:gl);disposeGpuResources(nativeGpu);loseOrbGl(gl);nativeGpu=null;}
    for(const node of [glCanvas,paintCanvas,fxCanvas,transitionCanvas,readout,pill,errorLabel])if(node)node.remove();
    host.classList.remove('as-orb-art');delete host.dataset.renderError;
  }
  return {update,setVisible,destroy};
}
return {styles,themes,title,heat,color,create,disposeSharedGpu:disposeThumbnailGpu};
})();
`;
