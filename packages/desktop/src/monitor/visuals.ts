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

// Agent Speed v1.6.1, zoefix/agent-speed, MIT, frozen 384ce020cc655133e95aaad5cc085f3985f0ed99.
// Windows OrbReadoutLayout/GlyphAtlas/OrbReadoutDraw, Presentation/GPU style geometry and original shader effects.
// Original vehicles.json paths/rigs/scenery and title badge are retained; per-module comments identify exact sources.
// Deliberate functional curation: OMP frames and explicitly selected real units only; no collectors/network/invented events.
export const MONITOR_ORB_CSS = String.raw`
.as-orb-art{position:relative;isolation:isolate;overflow:visible;background:transparent!important;user-select:none;touch-action:none;--as-size:148px;--as-value:rgba(255,255,255,.96);--as-secondary:rgba(255,255,255,.55);--as-label:#7c8798;--as-hover:1}
.as-orb-art[data-appearance="light"]{--as-value:rgba(11,13,18,.92);--as-secondary:rgba(0,0,0,.5)}
.as-orb-art>canvas{position:absolute;display:block;pointer-events:none;background:transparent!important;transform:scale(var(--as-hover));transform-origin:center}
.as-orb-transition{z-index:2;opacity:0}
.as-orb-gl{z-index:0}.as-orb-paint{z-index:1}.as-orb-fx{z-index:4}
.as-orb-readout{position:absolute;left:50%;top:50%;width:var(--as-size);height:var(--as-size);overflow:visible;transform:translate(-50%,-50%) scale(var(--as-hover));transform-origin:center;pointer-events:none;z-index:3;font-family:"Segoe UI Variable Text","Segoe UI","Microsoft JhengHei UI","Microsoft YaHei UI","Yu Gothic UI",system-ui,sans-serif}
.as-orb-readout text{dominant-baseline:alphabetic;text-anchor:middle;white-space:pre}
.as-orb-number{font-family:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;font-weight:700;font-variant-numeric:tabular-nums;fill:var(--as-value);color:var(--as-value)}
.as-orb-value,.as-orb-old-value{pointer-events:none}
.as-orb-prefix{fill:var(--as-secondary);color:var(--as-secondary)}
.as-orb-unit{font-weight:500;fill:var(--as-secondary);color:var(--as-secondary)}
.as-orb-title-line{font-weight:600;fill:var(--as-label);color:var(--as-label)}
.as-orb-title-stack,.as-orb-info{white-space:pre}.as-orb-old-title{opacity:0}.as-orb-info{font-weight:500;opacity:0;fill:var(--as-secondary);color:var(--as-secondary)}
.as-orb-art[data-hovered="true"] .as-orb-title-stack{opacity:0}.as-orb-art[data-hovered="true"] .as-orb-info{opacity:1}
.as-orb-peak{position:absolute;left:50%;transform:translate(-50%,-50%);overflow:visible;z-index:5;opacity:0;white-space:nowrap;pointer-events:none;font-family:"Segoe UI Variable Text","Segoe UI","Microsoft JhengHei UI","Microsoft YaHei UI","Yu Gothic UI",system-ui,sans-serif;font-weight:700}
.as-orb-peak text{fill:rgb(26,18,5);text-anchor:middle;dominant-baseline:alphabetic}
.as-orb-art[data-embedded="true"] .as-orb-readout{display:none}
.as-orb-art[data-style="liquid"] .as-orb-readout{visibility:hidden}
.as-orb-art[data-thumbnail="true"] .as-orb-unit,.as-orb-art[data-thumbnail="true"] .as-orb-title-line,.as-orb-art[data-thumbnail="true"] .as-orb-peak{display:none}
.as-orb-art[data-static="true"]>canvas,.as-orb-art[data-static="true"] .as-orb-readout,.as-orb-art[data-static="true"] .as-orb-title-stack,.as-orb-art[data-static="true"] .as-orb-info{transition:none}
.as-orb-render-error{position:absolute;inset:25%;display:grid;place-items:center;border-radius:50%;background:#141824;color:#e8ebf4;font:11px/1.4 "Segoe UI",sans-serif;text-align:center;pointer-events:none;z-index:6}
.as-orb-art[data-appearance="light"] .as-orb-render-error{background:#e7ebf3;color:#0b0d12}
@media(prefers-reduced-motion:reduce){.as-orb-art>canvas,.as-orb-readout,.as-orb-title-stack,.as-orb-info{transition:none!important}}
@media(forced-colors:active){.as-orb-art[data-style="liquid"] .as-orb-readout{visibility:visible}.as-orb-readout text{fill:CanvasText!important}.as-orb-peak rect{fill:Canvas!important;filter:none!important}.as-orb-peak text{fill:CanvasText!important}.as-orb-number{text-shadow:none!important}}
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
let orbReadoutSerial=0;
const VERTEX_SHADER='#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
function create(host,options){
  const thumbnail=!!options.thumbnail,sharedGpu=thumbnail||!!options.sharedGpu,embedded=!!options.embedded&&!thumbnail;
  host.classList.add('as-orb-art');host.dataset.embedded=String(embedded);host.dataset.thumbnail=String(thumbnail);host.dataset.hovered='false';
  const glCanvas=document.createElement('canvas'),paintCanvas=document.createElement('canvas'),fxCanvas=document.createElement('canvas'),transitionCanvas=document.createElement('canvas');
  glCanvas.className='as-orb-gl';paintCanvas.className='as-orb-paint';fxCanvas.className='as-orb-fx';transitionCanvas.className='as-orb-transition';
  for(const c of [glCanvas,paintCanvas,fxCanvas,transitionCanvas])c.setAttribute('aria-hidden','true');
  const svgNode=name=>document.createElementNS('http://www.w3.org/2000/svg',name);
  const readout=svgNode('svg'),number=svgNode('g'),prefix=svgNode('text'),value=svgNode('g'),oldValue=svgNode('g'),unit=svgNode('text'),titleLine=svgNode('g'),titleStack=svgNode('g'),oldTitle=svgNode('text'),titleLabel=svgNode('text'),info=svgNode('text'),pill=svgNode('svg'),pillBody=svgNode('rect'),pillText=svgNode('text'),defs=svgNode('defs'),titleClip=svgNode('clipPath'),titleClipRect=svgNode('rect');
  for(const [node,name] of [[readout,'as-orb-readout'],[number,'as-orb-number'],[prefix,'as-orb-prefix'],[value,'as-orb-value'],[oldValue,'as-orb-old-value'],[unit,'as-orb-unit'],[titleLine,'as-orb-title-line'],[titleStack,'as-orb-title-stack'],[oldTitle,'as-orb-old-title'],[titleLabel,'as-orb-title'],[info,'as-orb-info'],[pill,'as-orb-peak']])node.setAttribute('class',name);
  const clipId='as-orb-title-clip-'+(++orbReadoutSerial);titleClip.setAttribute('id',clipId);titleClip.append(titleClipRect);defs.append(titleClip);titleStack.setAttribute('clip-path','url(#'+clipId+')');
  readout.setAttribute('aria-hidden','true');pill.setAttribute('aria-hidden','true');pill.append(pillBody,pillText);
  number.append(prefix,oldValue,value);titleStack.append(oldTitle,titleLabel);titleLine.append(titleStack,info);readout.append(defs,number,unit,titleLine);host.append(glCanvas,paintCanvas,transitionCanvas,readout,fxCanvas,pill);
  const forcedColors=window.matchMedia('(forced-colors: active)'),contrastProbe=document.createElement('span');contrastProbe.style.cssText='position:absolute;visibility:hidden;pointer-events:none;color:CanvasText;background:Canvas;border-color:Highlight;outline-color:GrayText';host.append(contrastProbe);
  const paint=paintCanvas.getContext('2d'),fx=fxCanvas.getContext('2d'),transitionPaint=transitionCanvas.getContext('2d'),sharedPaint=sharedGpu?glCanvas.getContext('2d'):null;
  if(!paint||!fx||!transitionPaint||sharedGpu&&!sharedPaint)throw new Error('Agent Speed instruments require Canvas 2D');
  const st={S:148,dpr:1,dark:true,embedded,thumbnail,reduced:false,maxFps:60,resources:null,style:'led',fx:2,level:1,moving:true,value:0,h:0,o:0,targetH:0,targetO:0,time:0,tier:0,candidateTier:0,tierHold:0,flash:0,peakAge:99,pulseAge:99,comet:0,flow:0,silk:0,silkNoise:0,silkClock:0,phase:0,phase2:0,warp:0,corona:0,heroMotePhase:0,idleSweep:-1,sweepAge:99,hovered:false,jitterX:0,jitterY:0,jitterAt:0,needleShown:0,readoutAnimate:false,
    heatSpring:{value:0,velocity:0},overSpring:{value:0,velocity:0},needle:{value:0,velocity:0},liquid:{value:.08,velocity:0},liquidSurge:{value:0,velocity:0},liquidPhases:new Float32Array(4),rotors:new Float64Array([.3,1.1,2]),rotorFrom:new Float64Array(3),rotorTo:new Float64Array(3),bandPhase:0,kick:0,waves:Array.from({length:4},()=>({age:99,strength:1,heat:0})),ripples:Array.from({length:4},()=>({age:99,x:0,amplitude:0}))};
  Object.assign(st,{hoverScale:1,breathPhase:0,auraFlare:0,auraIntensity:0,readoutShift:0,idleProgress:-1,hoverSpring:{value:0,velocity:0},hoverBlend:{value:0,velocity:0},styleActivity:{value:0,velocity:0},readoutActivity:{value:0,velocity:0},readoutGlow:{value:0,velocity:0},skewSpring:{value:0,velocity:0}});
  const effects=createEffects(st),hero=embedded?createHero():null,liquidText=createLiquidReadout(st),readoutMetrics={},valueText=createValueReadout(svgNode,value,oldValue,paint),waveUniforms=new Float32Array(16),rippleUniforms=new Float32Array(16),ledUniforms=new Float32Array(36*4),cometUniforms=new Float32Array(8);
  let frame=null,visible=true,destroyed=false,primed=false,dirty=false,raf=0,idleTimer=0,lastRendered=0,lastClock=0,idleAt=performance.now(),idleSweepAt=-Infinity,lastResponse=-Infinity,rollUntil=0,titleUntil=0,lastText='',lastTitle='',lastTheme='',lastLanguage='',lastTitleLevel=-1,lastHovered=false,lastVehicleArt=true,lastValue=0,animations=[],titleAnimations=[];
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
    readout.setAttribute('viewBox','0 0 '+S+' '+S);readout.style.width=readout.style.height=S+'px';
  }
  function fitText(node,text,size,maxWidth,weight,tracking,minScale,minFont=7){
    paint.font=weight+' '+size+'px '+ORB_TEXT_FACE;paint.letterSpacing='0px';
    const width=paint.measureText(text).width,gaps=Math.max(1,orbGraphemes(text).length-1);
    let actual=size,track=Math.max(0,tracking);
    if(width+track*gaps>maxWidth){if(width<=maxWidth)track=Math.max(0,Math.floor((maxWidth-width)/gaps*20)/20);else{track=0;actual=Math.max(Math.min(minFont,size),Math.floor(size*Math.max(minScale,maxWidth/Math.max(1,width))*4)/4);}}
    actual=Math.round(actual*4)/4;node.style.fontSize=actual+'px';node.style.letterSpacing=track+'px';return actual;
  }
  function layout(){
    const L=READOUTS[st.style],S=st.S,perf=frame.perfReadout,hasPerf=!!(perf&&perf.visible),shift=hasPerf?perf.stackOffset:0,legend=st.style==='needle'&&hasPerf&&perf.needleLegend;
    const fullSize=L.value*S,run=fitValueRun(paint,frame.formattedValue,fullSize,L.max*S,!!frame.atLeast),size=run.size,valueY=L.baseline*S+shift,shownValue=frame.readoutValue===undefined?frame.value:frame.readoutValue;
    st.readoutShift=shift;
    number.style.fontSize=size+'px';number.setAttribute('transform','translate('+(.5*S)+' '+(.5*S+valueY)+')');prefix.textContent=run.prefix?'≥':'';if(run.prefix){prefix.setAttribute('x',run.prefix.x);prefix.style.fontSize=run.prefix.size+'px';}
    const duration=valueText.update(frame.formattedValue,run,st.readoutAnimate&&!embedded&&st.style!=='minimal'&&st.S>=80,animations,shownValue===null?0:shownValue);st.readoutCells=run.cells;st.readoutPrefix=run.prefix;st.readoutValueY=valueY;st.readoutValueSize=size;
    unit.textContent=frame.unit;unit.style.display=L.unit>0&&!legend?'':'none';const unitSize=Math.round(Math.max(7,(legend?.046:L.unit)*S)*4)/4,unitY=legend?-.254*S:L.unitY*S+shift,unitTracking=frame.language==='en'?(legend?.4:.5)*S/148:0;unit.style.fontSize=unitSize+'px';unit.style.letterSpacing=unitTracking+'px';unit.setAttribute('x',.5*S);unit.setAttribute('y',.5*S+unitY);st.dialUnit=legend?{text:frame.unit,size:unitSize,tracking:unitTracking,y:unitY}:null;
    const titleSize=Math.max(7,L.title*S),ts=fitText(titleLabel,frame.title,titleSize,L.titleMax*S,600,frame.language==='en'?1.6*S/148*titleSize/(.062*S):0,.8);
    titleLine.setAttribute('transform','translate('+(.5*S)+' '+(.5*S+L.titleY*S+shift)+')');titleLabel.textContent=frame.title;info.textContent=frame.hoverLabel;
    titleClipRect.setAttribute('x',-.5*S);titleClipRect.setAttribute('y',-1.25*titleSize);titleClipRect.setAttribute('width',S);titleClipRect.setAttribute('height',1.6*titleSize);
    const infoSize=fitText(info,frame.hoverLabel,Math.max(7,titleSize*L.infoScale),L.infoMax*S,500,0,.7);
    readoutMetrics.valueSize=size;readoutMetrics.unitSize=unitSize;readoutMetrics.valueY=valueY/S;readoutMetrics.unitY=unitY/S;readoutMetrics.labelY=L.titleY+shift/S;readoutMetrics.cells=run.cells;readoutMetrics.prefix=run.prefix;readoutMetrics.unitTracking=frame.language==='en'?.5*S/148:0;
    readoutMetrics.labelText=st.hovered?frame.hoverLabel:frame.title;readoutMetrics.labelSize=st.hovered?infoSize:ts;readoutMetrics.labelTracking=parseFloat((st.hovered?info:titleLabel).style.letterSpacing)||0;readoutMetrics.labelWeight=st.hovered?500:600;
    readoutMetrics.labelAnimate=primed&&!thumbnail&&visible&&!document.hidden;readoutMetrics.labelBaseSize=titleSize;readoutMetrics.labelHover=st.hovered!==lastHovered;readoutMetrics.labelRename=readoutMetrics.labelHover||frame.titleTheme!==lastTheme||frame.language!==lastLanguage||frame.titleLevel===lastTitleLevel;readoutMetrics.labelCrossfade=st.style==='minimal';readoutMetrics.labelMotion=st.moving;
    if(st.style==='liquid'&&!st.highContrast)liquidText.update(frame,readoutMetrics,st.readoutAnimate);
    const pillSize=Math.round(Math.max(7,.056*S)*4)/4,pillTracking=frame.language==='en'?.9*S/148:0,pillLabel=frame.language==='zh'?'新纪录':'NEW PEAK';
    paint.font='700 '+pillSize+'px '+ORB_TEXT_FACE;paint.letterSpacing=pillTracking+'px';const pillWidth=paint.measureText(pillLabel).width+.085*S,pillHeight=.082*S,cap=paint.measureText('H').actualBoundingBoxAscent;
    pill.setAttribute('width',pillWidth);pill.setAttribute('height',pillHeight);pill.style.top=((embedded?.5:.75)*S+L.pill*S+shift)+'px';pill.style.fontSize=pillSize+'px';pill.style.letterSpacing=pillTracking+'px';
    pillBody.setAttribute('width',pillWidth);pillBody.setAttribute('height',pillHeight);pillBody.setAttribute('rx',pillHeight/2);pillBody.setAttribute('fill',rgba(labMix(labMix(GOLD,HOT,.2),heatRgb(.92),.25)));pillBody.style.filter='drop-shadow(0 0 '+(st.dark?.025:.012)*S+'px '+rgba(GOLD,st.dark?.55:.3)+')';
    pillText.textContent=pillLabel;pillText.setAttribute('x',pillWidth/2);pillText.setAttribute('y',pillHeight/2+(Number.isFinite(cap)?cap:0)/2);paint.letterSpacing='0px';
    return duration;
  }
  function cancelAnimations(){for(const animation of animations)animation.cancel();animations=[];titleAnimations=[];valueText.cancel();oldTitle.textContent='';titleLabel.style.opacity='';titleLabel.style.transform='';pill.style.opacity='0';}
  function snap(){
    st.h=st.heatSpring.value=st.targetH;st.o=st.overSpring.value=st.targetO;st.heatSpring.velocity=st.overSpring.velocity=0;
    const a=st.tier!==0&&!st.unavailable?1:0;st.styleActivity.value=a;st.styleActivity.velocity=0;st.needle.value=Math.min(1.012,st.targetH+(st.targetO>0?.02+.05*st.targetO:0))*a;st.needle.velocity=0;st.liquid.value=.08+.74*st.h*a+.06*st.o*a;st.liquid.velocity=0;st.liquidSurge.value=st.liquidSurge.velocity=0;
    st.auraFlare=0;
  }
  function stop(clearEvents){
    if(raf)cancelAnimationFrame(raf);raf=0;if(idleTimer)clearTimeout(idleTimer);idleTimer=0;lastClock=lastRendered=0;
    if(clearEvents){effects.clear();for(const w of st.waves)w.age=99;st.peakAge=st.pulseAge=99;st.flash=st.auraFlare=0;st.sweepAge=99;st.idleProgress=st.idleSweep=-1;cancelAnimations();}
  }
  function idleWake(){
    if(idleTimer||thumbnail||!st.moving&&!(st.reduced&&st.style==='led'&&st.fx>0)||st.tier!==0||st.unavailable||st.style==='minimal'||!visible||document.hidden||destroyed)return;
    const now=performance.now(),next=embedded?Math.max(idleAt,idleSweepAt)+6000:(Math.floor(now/6000)+1)*6000;
    idleTimer=setTimeout(()=>{
      idleTimer=0;if(!visible||document.hidden||destroyed||!st.moving&&!(st.reduced&&st.style==='led'&&st.fx>0)||st.tier!==0||st.unavailable)return;
      if(performance.now()-idleAt<2000){idleWake();return;}
      idleSweepAt=performance.now();st.sweepAge=0;st.idleProgress=0;st.idleSweep=-.15;if(st.style==='liquid'&&st.moving)effects.bubble(-.15*st.S,.43*st.S);schedule();
    },Math.max(1,next-now));
  }
  function pulse(){
    const now=performance.now();if(now-lastResponse<150)return;lastResponse=now;
    let slot=st.waves[0];for(const w of st.waves){if(w.age>=1){slot=w;break;}if(w.age>slot.age)slot=w;}
    slot.age=0;slot.strength=1;slot.heat=st.h;st.pulseAge=0;st.auraFlare=Math.min(1,st.auraFlare+.35*slot.strength);if(st.moving){st.kick+=.25;effects.response();}
  }
  function peak(){
    st.peakAge=0;if(st.moving)effects.peak();
    for(let i=0;i<3;i++){
      const symmetry=i===0?TAU/3:i===1?TAU/(st.S<120?12:24):Math.PI,n=(st.rotors[i]+Math.PI/2)/symmetry;
      st.rotorFrom[i]=st.rotors[i];st.rotorTo[i]=-Math.PI/2+(i===1?Math.floor(n):Math.ceil(n))*symmetry;
    }
    // OrbReadoutDraw.AddPill: cap-centered gold plate, 0.45 s / 0.62 damping pop, final 0.32 s smooth fade.
    const keyframes=[],reduce=st.reduced,noPop=reduce||st.fx===0,omega=TAU/.45,wd=omega*Math.sqrt(1-.62*.62);
    for(let i=0;i<=108;i++){
      const age=i/60,fade=smooth(1.48,1.8,age),pop=noPop?1:(.55+.45*(1-Math.exp(-.62*omega*age)*(Math.cos(wd*age)+.62*omega/wd*Math.sin(wd*age))))*(1-.04*fade);
      keyframes.push({offset:age/1.8,transform:'translate(-50%,-50%) scale('+pop+')',opacity:Math.min(1,age/(reduce?.2:.12))*(1-fade)});
    }
    const animation=pill.animate(keyframes,{duration:1800,easing:'linear'});
    animations.push(animation);
  }
  function tierFor(v){
    const thresholds=[0,.5,.15*frame.redline,.375*frame.redline,.75*frame.redline];let tier=0;
    for(let i=1;i<5;i++)if(v>=thresholds[i]||(st.tier>=i&&v>=.9*thresholds[i]))tier=i;return tier;
  }
  function step(dt){
    st.time+=dt;st.peakAge+=dt;st.pulseAge+=dt;st.flash=Math.max(0,st.flash-dt/.4);st.sweepAge+=dt;const sweepDuration=embedded?1.6:st.style==='liquid'?1.2:.9;st.idleProgress=st.sweepAge<sweepDuration?st.sweepAge/sweepDuration:-1;st.idleSweep=st.idleProgress>=0?lerp(-.15,1.15,st.style==='needle'?Math.round(st.idleProgress*255)/255:st.idleProgress):-1;
    for(const w of st.waves)w.age+=dt/.85;
    nativeCritical(st.heatSpring,st.targetH,dt,.6);nativeCritical(st.overSpring,st.targetO,dt,.6);st.h=clamp(st.heatSpring.value);st.o=clamp(st.overSpring.value);
    st.breathPhase=(st.breathPhase+dt/lerp(4,.7,st.h))%1;st.auraFlare*=Math.exp(-dt/.25);if(st.auraFlare<.002)st.auraFlare=0;
    const candidate=tierFor(st.value);if(candidate!==st.candidateTier){st.candidateTier=candidate;st.tierHold=0;}else st.tierHold+=dt;
    if(candidate!==st.tier&&st.tierHold>=(candidate===0?3:.8)){st.tier=candidate;if(candidate===0)idleAt=performance.now();if(st.fx>0)st.flash=1;}
    nativeCritical(st.styleActivity,st.tier!==0&&!st.unavailable?1:0,dt,.5);const activity=clamp(st.styleActivity.value);
    if(st.reduced||thumbnail){st.hoverSpring.value=st.hovered?1:0;st.hoverSpring.velocity=0;}else nativeLayoutSpring(st.hoverSpring,st.hovered?1:0,dt);
    nativeCritical(st.hoverBlend,st.hovered?1:0,dt,.25);nativeCritical(st.readoutActivity,frame.value!==null&&(st.tier!==0||st.value>0)?1:0,dt,.4);nativeCritical(st.readoutGlow,st.fx>0&&st.tier>=2&&!st.valueMuted&&frame.value!==null?1:0,dt,.3);nativeCritical(st.skewSpring,st.fx>=2&&st.tier>=3?(st.style==='led'?7.5:6)*st.h:0,dt,.35);
    if(!st.moving){st.needle.value=Math.min(1.012,(st.h+(st.o>0?.02+.05*st.o:0))*activity);st.needle.velocity=0;nativeCritical(st.liquid,.08+.74*st.h*activity+.06*st.o*activity,dt,.9);if(hero)hero.update(frame,st,0);return;}
    const rate=st.fx===1?.5:1;
    if(st.h>.005)st.comet+=dt/(6+(.7-6)*st.h)*(1+.6*st.o);
    const phaseDt=Math.min(dt,1/15);st.silk+=phaseDt*(.12+1.4*st.h+2.2*st.o)*rate;st.phase=st.silk%(TAU*100);st.silkNoise=(st.silk*.07)%867;st.silkClock=(st.silkClock+phaseDt)%(10*Math.PI);st.phase2=(st.phase2+phaseDt*(.05+.5*st.h+1.2*st.o)*rate)%(TAU*20);if(st.fx>=2){st.flow=(st.flow+phaseDt*(.35+1.9*st.h+1.6*st.o))%1;st.warp=(st.warp+phaseDt*(.2+1.1*st.h+1.2*st.o))%4096;st.corona=(st.corona+phaseDt*(.5+1.7*st.h+1.8*st.o))%17340;}
    const target=st.tier===0||st.unavailable?0:st.targetH+(st.targetO>0?.02+.05*st.targetO:0);
    spring(st.needle,target,dt,1.5,.55);
    if(st.needle.value<-.012){st.needle.value=-.012;st.needle.velocity*=-.32;}else if(st.needle.value>1.012){st.needle.value=1.012;st.needle.velocity*=-.32;}
    spring(st.liquid,.08+.74*st.h*activity+.06*st.o*activity,dt,.75,.62);spring(st.liquidSurge,0,dt,.9,.45);
    st.liquidPhases[0]+=dt*TAU*(.25+.5*st.h+.3*st.o);st.liquidPhases[1]+=dt*TAU*(.4+.8*st.h+.4*st.o);st.liquidPhases[2]+=dt*TAU*(.9+1.6*st.h);st.liquidPhases[3]+=dt*TAU*3.1;
    const p=Math.pow(st.h,1.3),k=st.kick;st.kick*=Math.exp(-dt/.5);
    if(activity>.001){
      const lock=st.peakAge<.57;
      if(lock){const x=Math.min(1,st.peakAge/.42)-1,q=1+2.2*x*x*x+1.2*x*x;for(let i=0;i<3;i++)st.rotors[i]=lerp(st.rotorFrom[i],st.rotorTo[i],q);}
      else{st.rotors[0]+=dt*TAU*(activity*(.03+.45*p+.35*st.o)+k);st.rotors[1]-=dt*TAU*(activity*(.02+.30*p+.25*st.o)+.6*k);st.rotors[2]+=dt*TAU*(activity*(.05+1.1*p+.7*st.o)+1.2*k);}
      st.bandPhase+=dt*TAU*(.15+1.4*st.h*activity+.6*st.o*activity);st.heroMotePhase+=dt*TAU*(.06+.9*st.h+.5*st.o);
    }
    if(st.time>=st.jitterAt){st.jitterAt=st.time+1/30;const j=(st.tier>=4&&st.fx>=2?(st.style==='led'?.9+1.2*st.o:.6):0)*st.S/148;st.jitterX=(Math.random()-.5)*2*j;st.jitterY=(Math.random()-.5)*2*j;}
    effects.tick(dt);if(hero)hero.update(frame,st,dt);
  }
  function drawGpu(){
    if(!gpu())return false;
    const resources=sharedGpu?thumbnailLease.pool.resources:nativeGpu,renderCanvas=sharedGpu?thumbnailLease.pool.canvas:glCanvas;
    if(renderCanvas.width!==glCanvas.width||renderCanvas.height!==glCanvas.height){renderCanvas.width=glCanvas.width;renderCanvas.height=glCanvas.height;}
    const p=programs[st.style],u=p.locations;gl.useProgram(p.program);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);gl.enableVertexAttribArray(0);gl.viewport(0,0,glCanvas.width,glCanvas.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    const peakAge=st.fx>0&&(st.moving||st.style==='liquid'&&st.reduced)?st.peakAge:99,activity=st.style==='liquid'?clamp(st.styleActivity.value):1,h=st.unavailable&&st.style==='led'?0:st.h*activity,o=st.unavailable&&st.style==='led'?0:st.o*activity,sweep=st.moving&&st.peakAge<.5?ease(st.peakAge/.5):1;
    gl.uniform2f(u.uRes,glCanvas.width,glCanvas.height);gl.uniform1f(u.uS,st.S*st.dpr);gl.uniform1f(u.uLogicalS,st.S);gl.uniform1f(u.uThumbnail,thumbnail?1:0);gl.uniform1f(u.uReduced,st.reduced?1:0);gl.uniform1f(u.uTime,st.time);gl.uniform1f(u.uH,h);gl.uniform1f(u.uO,o);gl.uniform1f(u.uDark,st.dark?1:0);gl.uniform1f(u.uNew,1);gl.uniform1f(u.uLevel,embedded?1:st.level);gl.uniform1f(u.uFlash,st.flash);gl.uniform1f(u.uPeak,peakAge);gl.uniform1f(u.uSweep,sweep);gl.uniform1f(u.uTier,st.tier);gl.uniform1f(u.uComet,st.comet);gl.uniform1f(u.uFlow,st.flow);gl.uniform1f(u.uPhase,st.phase);gl.uniform1f(u.uPhase2,st.phase2);gl.uniform1f(u.uWarp,st.warp);gl.uniform1f(u.uCorona,st.corona);
    const baseAura=st.dark?heatRgb(Math.max(st.h,.12)):labelRgb(Math.max(st.h,.12),false),auraColor=st.style==='led'?labMix(baseAura,HOT,.25*st.o):baseAura;gl.uniform3fv(u.uAuraColor,auraColor);gl.uniform1f(u.uAuraIntensity,st.auraIntensity*(st.style==='led'?.8:1));gl.uniform1f(u.uActivity,activity);gl.uniform1f(u.uSilkNoise,st.silkNoise);gl.uniform1f(u.uSilkClock,st.silkClock);
    gl.uniform1f(u.uFx,embedded?Math.min(st.fx,1):st.fx);gl.uniform1f(u.uMoving,st.moving?1:0);gl.uniform1f(u.uEmbedded,embedded?1:0);gl.uniform1f(u.uIdleSweep,st.idleSweep);gl.uniform1f(u.uIdleProgress,st.tier===0&&!st.unavailable?st.idleProgress:-1);gl.uniform1f(u.uSurface,clamp(st.liquid.value+st.liquidSurge.value,.04,.95));gl.uniform4fv(u.uPhases,st.liquidPhases);
    gl.uniform4f(u.uTicks,Math.pow(.5/frame.redline,.6),Math.pow(.15,.6),Math.pow(.375,.6),Math.pow(.75,.6));
    waveUniforms.fill(-1);rippleUniforms.fill(0);
    for(let i=0;i<4;i++){
      const w=st.waves[i];if(st.moving&&w.age<1){waveUniforms[i*4]=w.age;waveUniforms[i*4+1]=w.strength;waveUniforms[i*4+2]=w.heat;waveUniforms[i*4+3]=0;}
      const r=st.ripples[i];if(r.age<2.2){rippleUniforms[i*4]=r.x;rippleUniforms[i*4+1]=.42*r.age;rippleUniforms[i*4+2]=r.amplitude*Math.exp(-r.age/.75);rippleUniforms[i*4+3]=1;}
    }
    if(st.style==='led'){prepareLedColors(ledUniforms,st,h,o,sweep,thumbnail,embedded);prepareCometArcs(cometUniforms,st,h,thumbnail,embedded);gl.uniform4fv(u.uLedColors,ledUniforms);gl.uniform4fv(u.uCometArcs,cometUniforms);bindHeatPalette(resources,u.uHeatPalette);gl.uniform2f(u.uReadoutBoxes,.05-st.readoutValueY/st.S,-readoutMetrics.unitY-.034);}
    if(st.style==='liquid'){const c=liquidColors(st);gl.uniform4fv(u.uLiquidColors,c.values);gl.uniform3fv(u.uLiquidInk,c.ink);gl.uniform2f(u.uMeniscus,c.width,c.sigma);liquidText.bind(gl,u,paintCanvas);}
    gl.uniform4fv(u.uWaves,waveUniforms);gl.uniform4fv(u.uRipples,rippleUniforms);gl.drawArrays(gl.TRIANGLES,0,3);
    if(sharedGpu){sharedPaint.clearRect(0,0,glCanvas.width,glCanvas.height);sharedPaint.drawImage(renderCanvas,0,0);}
    return true;
  }
  function shared(ctx){
    if(thumbnail)return;
    if(st.reduced&&st.fx>0&&st.style!=='minimal'){
      ctx.save();ctx.globalCompositeOperation=st.dark?'lighter':'source-over';
      for(const w of st.waves)if(w.age<1){const eased=ease(w.age),width=Math.max(.3,2*st.S/148*(1-eased)*(.55+.45*w.strength));ctx.save();ctx.shadowColor=rgba(heatRgb(w.heat),.35);ctx.shadowBlur=6*st.S/148;arc(ctx,.53*st.S,width,0,360,rgba(st.dark?mix(heatRgb(Math.max(.15,w.heat)),HOT,.18):labelRgb(Math.max(.15,w.heat),false),.5*Math.sin(Math.PI*w.age)*w.strength));ctx.restore();}
      if(st.peakAge<1.3)arc(ctx,.54*st.S,3*st.S/148,0,360,rgba(st.dark?labMix(GOLD,HOT,.25):labDarken(GOLD,.1),.45*Math.sin(Math.PI*st.peakAge/1.3)));
      ctx.restore();
    }
    if(st.moving&&st.style!=='led'&&st.style!=='minimal'){
      ctx.save();ctx.globalCompositeOperation=st.dark?'lighter':'source-over';
      for(const w of st.waves)if(w.age<1){const eased=ease(w.age),rr=.5+.24*eased,width=Math.max(.3,2*st.S/148*(1-eased)*(.55+.45*w.strength)),c=st.dark?mix(heatRgb(Math.max(.15,w.heat)),HOT,.18):labelRgb(Math.max(.15,w.heat),false);ctx.save();ctx.shadowColor=rgba(c,.35);ctx.shadowBlur=6*st.S/148;arc(ctx,rr*st.S,width,0,360,rgba(c,.6*(1-eased)*(.45+.55*w.strength)));ctx.restore();}
      if(st.peakAge<1.3){const p=st.peakAge/1.3,travel=ease(p),alpha=Math.pow(1-p,1.3),gold=st.dark?labMix(GOLD,HOT,.25):labDarken(GOLD,.1);for(let i=0;i<24;i++){const long=i%2===0,a=(i*15+3.75)*Math.PI/180,reach=long?.23:.16,r1=(.515+reach*travel)*st.S,r0=(.505+reach*Math.max(0,travel-.42)*1.25)*st.S;ctx.save();ctx.shadowColor=rgba(gold,alpha*.25);ctx.shadowBlur=4.4*st.S/148;line(ctx,Math.cos(a)*r0,Math.sin(a)*r0,Math.cos(a)*r1,Math.sin(a)*r1,(long?1.7:1.2)*st.S/148,rgba(gold,alpha));ctx.restore();}}
      ctx.restore();
    }
    const L=READOUTS[st.style];if(L.dots===null||st.tier===0||st.unavailable)return;
    const count=Math.max(0,Math.floor(frame.activeAgents));if(count===0)return;
    const unit=st.S/148,diameter=4*unit,spacing=3.2*unit,overflow=count>6?count-5:0,shown=overflow?5:count,total=shown*diameter+(shown-1)*spacing+(overflow?spacing+.075*st.S:0),y=L.dots*st.S,start=-total/2,c=st.dark?[132/255,204/255,22/255]:labDarken([132/255,204/255,22/255],.12);
    for(let i=0;i<shown;i++){
      const x=start+i*(diameter+spacing)+diameter/2,pulse=st.moving?.62+.38*(.5+.5*Math.sin(TAU*(st.time*.9+i*.19))):1;
      if(st.style==='liquid'&&!st.highContrast)dot(ctx,x,y,diameter/2+1.2*unit,st.dark?'rgba(6,8,12,.55)':'rgba(255,255,255,.75)');
      ctx.save();if(st.dark&&!st.highContrast){ctx.shadowColor=rgba(c,.45*pulse);ctx.shadowBlur=diameter*1.4;}if(st.highContrast)dot(ctx,x,y,diameter/2,st.contrast.text);else dot(ctx,x,y,diameter/2,rgba(c,pulse));ctx.restore();
    }
    if(overflow){const size=Math.round(Math.max(7,.05*st.S)*4)/4;ctx.font='500 '+size+'px '+ORB_TEXT_FACE;ctx.fillStyle=st.dark?'rgba(255,255,255,.55)':'rgba(0,0,0,.5)';ctx.textAlign='left';ctx.textBaseline='alphabetic';const cap=ctx.measureText('H').actualBoundingBoxAscent;ctx.fillText('+'+Math.min(99,overflow),start+shown*(diameter+spacing),y+(Number.isFinite(cap)?cap:0)/2);}
  }
  function readoutEffects(){
    const S=st.S,active=st.titleActive,dark=st.dark,h=st.h,style=st.style,shadows=[],activity=st.valueMuted?0:clamp(st.readoutActivity.value),glow=st.valueMuted?0:clamp(st.readoutGlow.value);
    host.style.setProperty('--as-value',st.highContrast?'CanvasText':rgba(dark?[1,1,1]:[11/255,13/255,18/255],lerp(dark?.60:.55,dark?.96:.92,activity)));
    host.style.setProperty('--as-label',st.highContrast?'CanvasText':active?color(Math.max(h,.08),dark?'dark':'light'):(dark?'rgba(255,255,255,.55)':'rgba(0,0,0,.50)'));
    if(glow>.01&&style!=='minimal'){const blur=.0334*S*(st.fx===3?1.5:1)*(style==='led'?1+.8*Math.round(st.o*4)/4:1);shadows.push('0 0 '+blur+'px '+rgba(dark?heatRgb(Math.max(h,.2)):labelRgb(Math.max(h,.2),false),glow*(dark?.85:.45)));if(style==='led'&&st.tier>=3)shadows.push('0 0 '+blur*2.4+'px '+rgba(heatRgb(h),glow*(dark?.45:.2)));}
    if(!st.valueMuted&&style==='led'&&dark&&st.tier>=4&&st.fx>=2&&st.moving){const off=(.6+1.6*st.o)*S/300;shadows.push(-off+'px 0 0 rgba(255,60,140,.55)',off+'px 0 0 rgba(60,210,255,.55)');}
    if(!st.valueMuted&&style==='led'&&dark&&active)shadows.push('0 0 '+.025*S+'px rgba(0,0,0,.7)','0 '+.006*S+'px '+.012*S+'px rgba(0,0,0,.6)');
    // Liquid glyphs are rendered by the GPU through complementary analytical surface clips, including the submerged unit.
    number.style.color='';titleLabel.style.color='';
    number.style.textShadow=shadows.length?shadows.join(','):'none';
    const skew=st.valueMuted||style==='minimal'?0:-st.skewSpring.value;
    number.setAttribute('transform','translate('+(.5*S+(st.valueMuted?0:st.jitterX))+' '+(.5*S+st.readoutValueY+(st.valueMuted?0:st.jitterY))+') skewX('+skew+')');
    const scale=thumbnail?1:Math.round((1+.03*(st.reduced?(st.hovered?1:0):st.hoverSpring.value))*2000)/2000,blend=clamp(st.hoverBlend.value);
    host.style.setProperty('--as-hover',String(scale));titleStack.style.opacity=String(1-blend);info.style.opacity=String(blend);
    if(scale!==st.hoverScale){st.hoverScale=scale;host.dispatchEvent(new window.CustomEvent('orb-hover-scale',{detail:scale}));}
  }
  function render(){
    if(!frame||!visible||document.hidden||destroyed)return;
    dirty=false;
    st.auraIntensity=st.unavailable?0:clamp(st.h*(st.fx>0&&!thumbnail?1+.15*Math.sin(TAU*st.breathPhase):1)+st.auraFlare*Math.max(.35,st.h),0,1.4);
    for(const ctx of [paint,fx]){ctx.restore();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,paintCanvas.width,paintCanvas.height);ctx.setTransform(st.dpr,0,0,st.dpr,.75*st.S*st.dpr,.75*st.S*st.dpr);ctx.save();ctx.beginPath();ctx.arc(0,0,.74*st.S,0,TAU);ctx.clip();}
    const usesGpu=!st.highContrast&&(st.style==='led'||st.style==='liquid');glCanvas.style.display=usesGpu?'block':'none';paintCanvas.style.visibility=st.style==='liquid'&&!st.highContrast?'hidden':'visible';
    if(st.highContrast){showError(false);paintHighContrast(paint,st,st.style,frame);if(hero)hero.draw(paint,st,frame);shared(paint);}
    else if(st.style==='liquid'){if(st.moving)effects.draw(paint);shared(fx);const okay=drawGpu();showError(!okay);}
    else{
      if(usesGpu){const okay=drawGpu();showError(!okay);}else{showError(false);paintBody(paint,st,st.style);if(st.style==='needle')paintNeedle(paint,st);else if(st.style==='reactor')paintReactor(paint,st);else paintMinimal(paint,st);}
      if(hero)hero.draw(paint,st,frame);if(st.moving){effects.draw(paint);effects.draw(fx,true);}shared(paint);
    }
    readoutEffects();
    for(let i=animations.length-1;i>=0;i--)if(animations[i].playState==='finished'||animations[i].playState==='idle')animations.splice(i,1);
  }
  function settling(){
    const activity=st.tier!==0&&!st.unavailable?1:0,valueActivity=frame.value!==null&&(st.tier!==0||st.value>0)?1:0,glow=st.fx>0&&st.tier>=2&&!st.valueMuted&&frame.value!==null?1:0,skew=st.fx>=2&&st.tier>=3?(st.style==='led'?7.5:6)*st.h:0;
    return Math.abs(st.heatSpring.value-st.targetH)>.0005||Math.abs(st.overSpring.value-st.targetO)>.0005||Math.abs(st.heatSpring.velocity)>.001||Math.abs(st.overSpring.velocity)>.001||Math.abs(st.styleActivity.value-activity)>.001||Math.abs(st.styleActivity.velocity)>.01||Math.abs(st.readoutActivity.value-valueActivity)>.001||Math.abs(st.readoutActivity.velocity)>.01||Math.abs(st.readoutGlow.value-glow)>.001||Math.abs(st.readoutGlow.velocity)>.01||Math.abs(st.skewSpring.value-skew)>.001||Math.abs(st.skewSpring.velocity)>.01||(st.style==='needle'&&Math.abs(st.needle.velocity)>.001)||(st.style==='liquid'&&(Math.abs(st.liquid.velocity)>.001||Math.abs(st.liquidSurge.velocity)>.001));
  }
  function animating(){
    if(thumbnail)return false;
    if(!st.highContrast&&(st.style==='led'||st.style==='liquid')&&(gpuError||contextLost))return false;
    const hoverTarget=st.hovered?1:0;if(Math.abs(st.hoverSpring.value-hoverTarget)>.001||Math.abs(st.hoverSpring.velocity)>.01||Math.abs(st.hoverBlend.value-hoverTarget)>.001||Math.abs(st.hoverBlend.velocity)>.01)return true;
    if(!st.moving)return settling()||st.candidateTier!==st.tier||st.peakAge<1.8||performance.now()<titleUntil||st.reduced&&st.fx>0&&(st.pulseAge<.85||st.idleProgress>=0||st.style==='led'&&st.tier!==0&&!st.unavailable);
    if(settling()||st.peakAge<1.8||st.pulseAge<.85||st.idleProgress>=0||effects.busy()||performance.now()<rollUntil||performance.now()<titleUntil)return true;
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
    const heroBand=hero&&!lastVehicleArt&&st.sweepAge>=.63&&st.sweepAge<1.53;
    const preferred=!st.moving?30:hero?(hero.demanding(st)||transition||settling()?60:heroBand?30:15):st.style==='minimal'&&!transition&&!settling()?15:transition||st.h>=.45&&!(st.style==='liquid'&&st.fx===1)||st.style==='needle'&&Math.abs(st.needle.velocity)*270>90?60:30;
    // Native controller computes the cross-window budget; each isolated renderer consumes only its assigned cap.
    const fps=Math.min(st.maxFps,thumbnail?15:60,preferred);
    if(lastRendered&&now-lastRendered<1000/fps){raf=requestAnimationFrame(tick);return;}
    const dt=Math.min(.1,Math.max(0,(now-lastClock)/1000));lastClock=lastRendered=now;
    step(dt);render();if(dirty||animating())raf=requestAnimationFrame(tick);else{lastClock=0;idleWake();}
  }
  function update(next){
    if(destroyed)return;
    const wasMoving=st.moving,oldStyle=st.style,oldSize=st.S,oldAppearance=st.dark,oldContrast=st.highContrast;
    const crossfade=primed&&!embedded&&oldStyle!==next.style&&wasMoving&&!next.reduceMotion&&next.effects!=='off'&&visible&&!document.hidden&&oldSize===next.size;
    if(crossfade){
      render();transitionPaint.clearRect(0,0,transitionCanvas.width,transitionCanvas.height);
      if(oldStyle==='led'||oldStyle==='liquid')transitionPaint.drawImage(glCanvas,0,0);
      transitionPaint.drawImage(paintCanvas,0,0);transitionPaint.drawImage(fxCanvas,0,0);
    }
    frame=next;st.style=embedded?'led':next.style;st.S=thumbnail?clamp(next.size,1,63):clamp(next.size,64,240);st.dark=next.appearance!=='light';st.reduced=!!next.reduceMotion;st.maxFps=next.maxFps===30?30:60;
    st.highContrast=forcedColors.matches;
    if(st.highContrast){const colors=window.getComputedStyle(contrastProbe);st.contrast={window:colors.backgroundColor,text:colors.color,highlight:colors.borderTopColor,gray:colors.outlineColor};}
    if(sharedGpu&&(st.highContrast||st.style!=='led'&&st.style!=='liquid'))releaseThumbnail();
    const requested=FX_LEVELS[next.effects];st.fx=st.highContrast?0:st.reduced||thumbnail?Math.min(requested,1):requested;st.level=st.fx===3?1.6:1;st.moving=st.fx>0&&!st.reduced&&!thumbnail;
    st.value=next.value===null?0:Math.max(0,next.value);st.targetH=heat(st.value,next.redline);st.targetO=clamp((st.value-next.redline)/next.redline);
    st.unavailable=next.value===null;st.valueMuted=!!next.valueMuted;st.titleActive=!st.unavailable&&(next.titleLevel===undefined?st.value>=.5:next.titleLevel!==0);
    host.dataset.style=st.style;host.dataset.appearance=st.dark?'dark':'light';host.dataset.static=String(!st.moving);host.style.opacity=String(clamp(next.opacity,0,1));host.setAttribute('aria-label',(next.atLeast?'≥':'')+next.formattedValue+' '+next.unit+' · '+next.title);
    st.hovered=!!next.hovered;host.dataset.hovered=String(st.hovered);if(!primed||!visible||document.hidden){st.hoverSpring.value=st.hoverBlend.value=st.hovered?1:0;st.hoverSpring.velocity=st.hoverBlend.velocity=0;}
    const structural=oldStyle!==st.style||oldSize!==st.S||oldAppearance!==st.dark||oldContrast!==st.highContrast;
    if(!primed){st.tier=st.candidateTier=tierFor(st.value);st.tierHold=0;}
    if(!primed||structural||thumbnail||!visible||document.hidden)snap();
    if(structural){effects.clear();for(const w of st.waves)w.age=99;st.peakAge=st.pulseAge=99;cancelAnimations();}
    if(crossfade)animations.push(transitionCanvas.animate([{opacity:1},{opacity:0}],{duration:250,easing:'ease-out'}));
    if(!st.moving){if(wasMoving||structural||st.fx===0&&idleTimer)stop(true);st.jitterX=st.jitterY=0;}
    else if(!wasMoving){lastClock=lastRendered=0;}
    if(!primed||structural||thumbnail||!visible||document.hidden){st.readoutActivity.value=frame.value!==null&&(st.tier!==0||st.value>0)?1:0;st.readoutGlow.value=st.fx>0&&st.tier>=2&&!st.valueMuted&&frame.value!==null?1:0;st.skewSpring.value=st.fx>=2&&st.tier>=3?(st.style==='led'?7.5:6)*st.h:0;st.readoutActivity.velocity=st.readoutGlow.velocity=st.skewSpring.velocity=0;}
    resize();
    const canAnimate=primed&&st.moving&&visible&&!document.hidden,canFeedback=primed&&!thumbnail&&visible&&!document.hidden;
    const oldText=lastText;st.readoutAnimate=canAnimate;titleLabel.textContent=next.title;const duration=layout();if(duration)rollUntil=performance.now()+duration;
    if(canFeedback&&lastTitle!==next.title&&!embedded){
      for(const animation of titleAnimations)animation.cancel();titleAnimations=[];oldTitle.textContent=lastTitle;
      const L=READOUTS[st.style],baseSize=Math.max(7,L.title*st.S),tracking=next.language==='en'?1.6*st.S/148*baseSize/(.062*st.S):0;fitText(oldTitle,lastTitle,baseSize,L.titleMax*st.S,600,tracking,.8);
      const rename=lastTheme!==next.titleTheme||lastLanguage!==next.language||next.titleLevel===lastTitleLevel,duration=rename||st.style==='minimal'?250:350,travel=!rename&&st.moving&&st.style!=='minimal'?1.1*baseSize:0,outgoing=[],incoming=[];
      for(let i=0;i<=20;i++){const p=i/20,k=smooth(0,1,p);outgoing.push({offset:p,opacity:rename?1-k:1-smooth(0,.4,p),transform:'translateY('+(-travel*ease(Math.min(1,p/.4)))+'px)'});incoming.push({offset:p,opacity:rename?k:smooth(.35,.8,p),transform:'translateY('+(travel*(1-ease(Math.max(0,(p-.35)/.65))))+'px)'});}
      titleAnimations.push(oldTitle.animate(outgoing,{duration,easing:'linear'}),titleLabel.animate(incoming,{duration,easing:'linear'}));animations.push(...titleAnimations);titleUntil=performance.now()+duration;
    }
    if(canFeedback&&st.style==='liquid'&&lastHovered!==st.hovered)titleUntil=performance.now()+200;
    if(canFeedback&&st.fx>0&&embedded&&(lastTitle!==next.title||lastTheme!==next.titleTheme))titleUntil=performance.now()+(st.reduced?300:750);
    // The renderer owns event qualification (measured, live, not catch-up/history/estimates). Never derive events here.
    if(canFeedback&&st.fx>0&&next.responsePulse){pulse();if(st.moving)effects.zap(next.formattedValue,oldText);}
    if(canFeedback&&next.newPeak)peak();
    if(hero){hero.update(canAnimate?next:{...next,responsePulse:false,newPeak:false},st,0);if(!visible||document.hidden)hero.pause();}
    lastText=next.formattedValue;lastTitle=next.title;lastTheme=next.titleTheme;lastLanguage=next.language;lastTitleLevel=next.titleLevel;lastHovered=st.hovered;lastVehicleArt=next.showsVehicleArt??(next.titleBase||next.titleTheme)==='vehicles';lastValue=st.value;primed=true;
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
  // Performance-only event frames update cached masks/layout without recreating an instrument or replaying feedback.
  function perfReadoutChange(event){if(destroyed||!frame)return;frame.perfReadout=event.detail;if(visible&&!document.hidden){layout();dirty=true;schedule();}}
  function contrastChanged(){if(frame&&!destroyed)update({...frame,responsePulse:false,newPeak:false});}
  forcedColors.addEventListener('change',contrastChanged);
  document.addEventListener('visibilitychange',visibility);window.addEventListener('resize',windowResize);if(!sharedGpu){glCanvas.addEventListener('webglcontextlost',lost);glCanvas.addEventListener('webglcontextrestored',restored);}
  host.addEventListener('perf-readout-change',perfReadoutChange);
  function destroy(){
    if(destroyed)return;destroyed=true;stop(true);
    document.removeEventListener('visibilitychange',visibility);window.removeEventListener('resize',windowResize);if(!sharedGpu){glCanvas.removeEventListener('webglcontextlost',lost);glCanvas.removeEventListener('webglcontextrestored',restored);}
    forcedColors.removeEventListener('change',contrastChanged);
    host.removeEventListener('perf-readout-change',perfReadoutChange);
    if(sharedGpu)releaseThumbnail();else{liquidText.reset(contextLost?null:gl);disposeGpuResources(nativeGpu);loseOrbGl(gl);nativeGpu=null;}
    for(const node of [glCanvas,paintCanvas,fxCanvas,transitionCanvas,readout,pill,errorLabel,contrastProbe])if(node)node.remove();
    host.classList.remove('as-orb-art');delete host.dataset.renderError;
  }
  return {update,setVisible,destroy};
}
return {styles,themes,title,heat,color,create,disposeSharedGpu:disposeThumbnailGpu};
})();
`;
