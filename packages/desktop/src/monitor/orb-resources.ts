// Retained resources from frozen Agent Speed v1.4.1 (MIT), a94a67fcc78e5d8eea5f82d8d5e737bccf994e2c.
// Geometry/palettes: NeedleDraw.Configure, NeedlePalette, OrbSharedDraw.Body and DESIGN §§2a, 2a.2, 897–898.
// Raster resources are invalidated only by logical size, backing scale or appearance—not by an animation frame.
export const ORB_RESOURCES_SCRIPT = String.raw`
function instrumentResources(st){
  if(st.resources&&st.resources.S===st.S&&st.resources.dpr===st.dpr&&st.resources.dark===st.dark)return st.resources;
  const resources={S:st.S,dpr:st.dpr,dark:st.dark,bodies:{},needle:null};st.resources=resources;return resources;
}
function instrumentCanvas(st){
  const canvas=document.createElement('canvas');canvas.width=canvas.height=Math.max(1,Math.ceil(1.5*st.S*st.dpr));
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Instrument resources require Canvas 2D');
  ctx.setTransform(st.dpr,0,0,st.dpr,.75*st.S*st.dpr,.75*st.S*st.dpr);
  ctx.beginPath();ctx.arc(0,0,.74*st.S,0,TAU);ctx.clip();return {canvas,ctx};
}
function instrumentBody(st,style){
  const resources=instrumentResources(st);if(resources.bodies[style])return resources.bodies[style];
  const asset=instrumentCanvas(st),ctx=asset.ctx,S=st.S,dark=st.dark;
  const sh=ctx.createRadialGradient(0,(dark?.03:.04)*S,.46*S,0,(dark?.03:.04)*S,.62*S);
  sh.addColorStop(0,dark?'rgba(0,0,0,.45)':'rgba(0,0,0,.16)');sh.addColorStop(1,'rgba(0,0,0,0)');dot(ctx,0,(dark?.03:.04)*S,.62*S,sh);
  const body=ctx.createLinearGradient(0,-.5*S,0,.5*S);
  body.addColorStop(0,style==='reactor'?(dark?'#141824':'#FFFFFF'):(dark?'#1B2030':'#FFFFFF'));
  body.addColorStop(1,style==='reactor'?(dark?'#06070B':'#E5E9F1'):(dark?'#090B10':'#E7EBF3'));
  ctx.globalAlpha=dark?.88:.94;dot(ctx,0,0,.5*S,body);ctx.globalAlpha=1;
  ctx.save();ctx.beginPath();ctx.arc(0,0,.5*S,0,TAU);ctx.clip();
  const inner=ctx.createRadialGradient(0,0,.40*S,0,0,.50*S);
  inner.addColorStop(0,'rgba(0,0,0,0)');inner.addColorStop(.55,dark?'rgba(0,0,0,.09)':'rgba(27,35,64,.025)');inner.addColorStop(1,dark?'rgba(0,0,0,.44)':'rgba(27,35,64,.128)');dot(ctx,0,0,.5*S,inner);
  if(style!=='minimal')radial(ctx,-.16*S,-.19*S,.36*S,[1,1,1],dark?.06:.3);ctx.restore();
  const rim=ctx.createLinearGradient(0,-.5*S,0,.5*S);
  rim.addColorStop(0,dark?'rgba(255,255,255,.14)':'rgba(255,255,255,.95)');rim.addColorStop(1,'rgba(255,255,255,0)');arc(ctx,.495*S,Math.max(1,.008*S),0,360,rim);
  if(!dark)arc(ctx,.5*S,1,0,360,'rgba(0,0,0,.08)');
  resources.bodies[style]=asset.canvas;return asset.canvas;
}
function reactorStationary(st){
  const resources=instrumentResources(st);if(resources.reactorStationary)return resources.reactorStationary;
  const asset=instrumentCanvas(st),ctx=asset.ctx,S=st.S,dark=st.dark,notches=S<120?4:24;
  arc(ctx,.468*S,.006*S,0,360,dark?'rgba(255,255,255,.098)':'rgba(0,0,0,.112)');
  for(let i=0;i<notches;i++){const a=TAU*i/notches;line(ctx,Math.cos(a)*.456*S,Math.sin(a)*.456*S,Math.cos(a)*.474*S,Math.sin(a)*.474*S,.005*S,rgba(dark?[1,1,1]:[0,0,0],(dark?.07:.08)*(i%(notches/4)===0?2.6:1)));}
  arc(ctx,.425*S,.024*S,0,360,dark?'rgba(255,255,255,.07)':'rgba(0,0,0,.08)');arc(ctx,.338*S,.009*S,0,360,dark?'rgba(255,255,255,.07)':'rgba(0,0,0,.08)');
  resources.reactorStationary=asset.canvas;return asset.canvas;
}
function reactorCore(st){
  const resources=instrumentResources(st);if(resources.reactorCore)return resources.reactorCore;
  const asset=instrumentCanvas(st),ctx=asset.ctx,S=st.S,core=ctx.createRadialGradient(0,-.06*S,0,0,0,.30*S);
  core.addColorStop(0,st.dark?'#181C28':'#FFFFFF');core.addColorStop(1,st.dark?'#080A0F':'#EEF1F6');ctx.globalAlpha=st.dark?.97:1;dot(ctx,0,0,.30*S,core);
  resources.reactorCore=asset.canvas;return asset.canvas;
}
function needleBlur(st,path,sigma,paint){
  const S=st.S,pad=3*sigma+1/st.dpr,x=-.09*S-pad,y=-.031*S-pad,width=Math.ceil((.536*S+2*pad)*st.dpr),height=Math.ceil((.062*S+2*pad)*st.dpr);
  const mask=document.createElement('canvas'),out=document.createElement('canvas');mask.width=out.width=width;mask.height=out.height=height;
  const ink=mask.getContext('2d'),blur=out.getContext('2d');if(!ink||!blur)throw new Error('Needle blur cache requires Canvas 2D');
  ink.setTransform(st.dpr,0,0,st.dpr,-x*st.dpr,-y*st.dpr);ink.fillStyle='#fff';ink.fill(path);
  blur.filter='blur('+(sigma*st.dpr)+'px)';blur.drawImage(mask,0,0);blur.filter='none';blur.globalCompositeOperation='source-in';blur.fillStyle=paint;blur.fillRect(0,0,width,height);blur.globalCompositeOperation='source-over';
  return {canvas:out,x,y};
}
function needleResources(st){
  const resources=instrumentResources(st);if(resources.needle)return resources.needle;
  const S=st.S,dark=st.dark,white=[1,1,1],black=[0,0,0],red=dark?[244/255,63/255,94/255]:[225/255,29/255,72/255];
  const ticks=Array.from({length:41},(_,k)=>{
    const major=k%5===0,pos=k/40,angle=(135+270*pos)*Math.PI/180,outer=.445*S,length=(major?.062:.03)*S,width=(major?.014:.0075)*S,inner=outer-length;
    const lit=styleLabelRgb(pos,dark),tip=labMix(lit,dark?HOT:AMBER,dark?.75:.25),cold=pos>=RED_DIAL?red:dark?white:black;
    const alpha=pos>=RED_DIAL?(major?.85:.60):dark?(major?.5:.24):(major?.42:.20);
    const tick={pos,major,angle,x1:Math.cos(angle)*inner,y1:Math.sin(angle)*inner,x2:Math.cos(angle)*outer,y2:Math.sin(angle)*outer,width,cold,alpha,coldPaint:rgba(cold,alpha),litPaint:rgba(lit,.95),tipPaint:rgba(tip,.95),glow:null,tipGlow:null,pad:0,length};
    if(major&&dark&&S>=64){
      const sigma=.015*S,pad=3*sigma+width/2;tick.pad=pad;
      for(let kind=0;kind<2;kind++){
        const canvas=document.createElement('canvas');canvas.width=Math.ceil((length+2*pad)*st.dpr);canvas.height=Math.ceil(2*pad*st.dpr);
        const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Needle glow requires Canvas 2D');
        ctx.filter='blur('+(sigma*st.dpr)+'px)';ctx.lineWidth=width*st.dpr;ctx.lineCap='round';ctx.strokeStyle=rgba(kind===0?lit:tip,.45);ctx.beginPath();ctx.moveTo(pad*st.dpr,pad*st.dpr);ctx.lineTo((pad+length)*st.dpr,pad*st.dpr);ctx.stroke();ctx.filter='none';
        if(kind===0)tick.glow=canvas;else tick.tipGlow=canvas;
      }
    }
    return tick;
  });
  const pins=[-.034,1.034].map(pos=>{const a=(135+270*pos)*Math.PI/180;return {x:Math.cos(a)*.405*S,y:Math.sin(a)*.405*S};});
  const lamps=Array.from({length:5},(_,i)=>{const a=(-110+i*10)*Math.PI/180,threshold=i===4?RED_DIAL:.70+.035*i;return {x:Math.cos(a)*.33*S,y:Math.sin(a)*.33*S,threshold,color:dark?heatRgb(threshold):labDarken(heatRgb(threshold),.15)};});
  const hub=instrumentCanvas(st),ctx=hub.ctx,fill=ctx.createLinearGradient(0,-.235*S,0,.235*S);
  fill.addColorStop(0,dark?'#262C3C':'#FFFFFF');fill.addColorStop(1,dark?'#0C0E14':'#ECEFF5');ctx.shadowBlur=.025*S*st.dpr;ctx.shadowOffsetY=.012*S*st.dpr;ctx.shadowColor=dark?'rgba(0,0,0,.55)':'rgba(0,0,0,.16)';ctx.globalAlpha=dark?.95:.98;dot(ctx,0,0,.235*S,fill);ctx.globalAlpha=1;ctx.shadowBlur=ctx.shadowOffsetY=0;
  const bezel=ctx.createLinearGradient(-.16*S,-.16*S,.16*S,.16*S);bezel.addColorStop(0,dark?'rgba(255,255,255,.42)':'#FFFFFF');bezel.addColorStop(.5,dark?'rgba(255,255,255,.10)':'rgba(160,168,182,.55)');bezel.addColorStop(1,dark?'rgba(255,255,255,.22)':'rgba(120,128,142,.60)');arc(ctx,.235*S,.013*S,0,360,bezel);
  const blade=new Path2D();blade.moveTo(-.09*S,-.062*.9*.5*S);blade.lineTo(0,-.031*S);blade.lineTo(.434*S,-.006*S);blade.quadraticCurveTo(.446*S,0,.434*S,.006*S);blade.lineTo(0,.031*S);blade.lineTo(-.09*S,.062*.9*.5*S);blade.closePath();
  const bladeGlow=S>=64&&dark?needleBlur(st,blade,.0275*S,'#fff'):null,bladeGlowMax=S>=64&&dark?needleBlur(st,blade,.0275*S*1.25,'#fff'):null,bladeShadow=S>=64&&!dark?needleBlur(st,blade,.007*S,'rgba(0,0,0,.22)'):null;
  let bladeTint=null,bladeTintCtx=null;
  if(bladeGlowMax){bladeTint=document.createElement('canvas');bladeTint.width=bladeGlowMax.canvas.width;bladeTint.height=bladeGlowMax.canvas.height;bladeTintCtx=bladeTint.getContext('2d');if(!bladeTintCtx)throw new Error('Needle tint cache requires Canvas 2D');}
  const assets={ticks,pins,lamps,red,hub:hub.canvas,blade,bladeGlow,bladeGlowMax,bladeShadow,bladeTint,bladeTintCtx,flashLamp:dark?labMix(heatRgb(.97),HOT,.55):[245/255,158/255,11/255]};resources.needle=assets;return assets;
}
// Presentation/Orb/Styles/LiquidColors.cs: cached native OKLab colors, not per-fragment RGB approximations.
function liquidColors(st){
  const resources=instrumentResources(st),hq=Math.round(clamp(st.h)*128),oq=Math.round(clamp(st.o)*64),fq=Math.round(clamp(st.flash)*16),active=st.value>=.5,boost=st.reduced&&st.tier>=4;
  let cache=resources.liquidColors;
  if(cache&&cache.hq===hq&&cache.oq===oq&&cache.fq===fq&&cache.active===active&&cache.fx===st.fx&&cache.boost===boost)return cache;
  if(!cache){cache={values:new Float32Array(36)};resources.liquidColors=cache;}
  cache.hq=hq;cache.oq=oq;cache.fq=fq;cache.active=active;cache.fx=st.fx;cache.boost=boost;
  const h=hq/128,o=oq/64,a=active?1:0,dark=st.dark,max=st.fx===3,heat=heatRgb(h),L=dark?heat:labMix(heat,[1,1,1],.12),alpha=active?(dark?.46+.10*h:.80):(dark?.40:.55);
  const put=(slot,c,opacity)=>{const k=slot*4;cache.values[k]=c[0];cache.values[k+1]=c[1];cache.values[k+2]=c[2];cache.values[k+3]=opacity;};
  put(0,heat,1);put(1,L,alpha);put(2,labDarken(L,dark?.62:.14),Math.min(1,alpha+.2));put(3,labDarken(L,dark?.25:.08),alpha*.55);
  const glowScale=(max?1.25:1)*(boost?1.35:1)*a;
  put(4,dark?labMix(L,HOT,.25+.45*o):L,(dark?(.26+.2*o)*(.3+.7*h):.10*(.3+.7*h))*glowScale);
  put(5,dark?labMix(L,HOT,.35+.4*o):[1,1,1],(dark?.10:.22)*(.4+.6*h)*a);
  const meniscus=active?(dark?labMix(L,HOT,Math.min(1,.45+.5*o+(boost?.15:0))):labDarken(heat,.25)):(dark?[1,1,1]:labDarken(L,.25));
  put(6,energyBrighten(meniscus,.25*fq/16),active?.95:dark?.28:.5);put(7,L,dark?.9*a:0);put(8,L,(dark?.35:.3)*(.3+.7*h)*a);
  cache.ink=heroStroke(h,false);cache.width=Math.max(1/st.S,(.008+.004*h)*(boost?1.25:1));cache.sigma=(.015+.015*h)*(max?1.3:1)*(boost?1.25:1);
  return cache;
}
`;
