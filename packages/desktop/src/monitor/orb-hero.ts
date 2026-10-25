// Adapted from zoefix/agent-speed v1.4.1 (MIT), a94a67fcc78e5d8eea5f82d8d5e737bccf994e2c.
// Sources: spec/assets/vehicles.json; spec/DESIGN.md §4c; Presentation/Hero/{HeroStage,HeroRig,HeroMath}.cs;
// Presentation/Hero/Badge/{BadgeStage.Frame,BadgePalette}.cs; Orb/Hero/HeroPainter{,.Actor,.Scenery}.cs.
// Original vector paths are compiled once in orb-vehicle-data.ts; rig geometry is generated from its actual limb lengths.
export const ORB_HERO_SCRIPT = String.raw`
const VEHICLES=VEHICLE_ART.vehicles.map(v=>{
  const parts=v.parts.map(p=>({...p,path:p.d?new Path2D(p.d):null})),rear=parts.find(p=>p.role==='wheel'&&p.circle);
  return {...v,parts,pivot:rear?[rear.circle[0],v.groundY]:[50,50]};
});
const CLOUD_PATHS=VEHICLE_ART.scenery.sky.clouds.map(d=>new Path2D(d));
const MOTE_ORDER=[0,6,3,9,1,7,4,10,2,8,5,11];
const HERO_FONT='"Segoe UI Variable Display","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif';
const fract=x=>x-Math.floor(x);
const heroBump=(t,start,peak,end)=>t<start?0:t<peak?smooth(start,peak,t):1-smooth(peak,end,t);
function heroSpringAt(t,from,to,velocity,response,damping){
  if(t<=0)return from;
  const w=TAU/response,wd=w*Math.sqrt(1-damping*damping),a=from-to,b=(velocity+damping*w*a)/wd;
  return to+Math.exp(-damping*w*t)*(a*Math.cos(wd*t)+b*Math.sin(wd*t));
}
function heroKnee(hx,hy,fx,fy,l1,l2,out){
  const dx=fx-hx,dy=fy-hy,d=clamp(Math.hypot(dx,dy),Math.max(.001,Math.abs(l1-l2)+.001),l1+l2-.001);
  const a=Math.atan2(dy,dx)-Math.acos(clamp((l1*l1+d*d-l2*l2)/(2*l1*d),-1,1));
  out[0]=hx+l1*Math.cos(a);out[1]=hy+l1*Math.sin(a);
}
function heroLayout(ctx,text,language){
  const chars=Array.from(text),han=/^[\p{Script=Han}]+$/u.test(text),cjk=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
  let size=chars.length===1?34:cjk?28:chars.length===2?26:22,tracking=cjk?.04:.05;
  if(language==='zh'&&han&&chars.length===4)return {lines:[chars.slice(0,2).join(''),chars.slice(2).join('')],size:21,tracking:.04,advance:1.04,width:43.7,height:43.7};
  for(;size>9;size-=.5){ctx.font='800 '+size+'px '+HERO_FONT;ctx.letterSpacing=(size<14?0:tracking*size)+'px';if(ctx.measureText(text).width<=72)break;}
  const s1=size,breaks=[];
  if(text.includes(' ')){for(let i=0;i<text.length;i++)if(text[i]===' ')breaks.push(i);}
  else if(han&&chars.length>=5)breaks.push(chars.length===5?2:Math.floor(chars.length/2));
  let lines=[text],advance=1.1;
  for(let candidate=cjk?22:20;candidate>=13&&candidate>=1.15*s1;candidate-=.5){
    let best=null,balance=Infinity;
    ctx.font='800 '+candidate+'px '+HERO_FONT;ctx.letterSpacing=tracking*candidate+'px';
    for(const split of breaks){
      const a=text.slice(0,split).trim(),b=text.slice(split).trim(),wa=ctx.measureText(a).width,wb=ctx.measureText(b).width;
      if(Math.max(wa,wb)<=72&&Math.abs(wa-wb)<balance){best=[a,b];balance=Math.abs(wa-wb);}
    }
    if(best){lines=best;size=candidate;break;}
  }
  ctx.font='800 '+size+'px '+HERO_FONT;ctx.letterSpacing=(size<14?0:tracking*size)+'px';
  let width=0;for(const l of lines)width=Math.max(width,ctx.measureText(l).width);
  return {lines,size,tracking:size<14?0:tracking,advance,width,height:size*(1+(lines.length-1)*advance)};
}
function createHero(){
  const layer=document.createElement('canvas'),mask=document.createElement('canvas'),glyph=document.createElement('canvas'),previousThemeLayer=document.createElement('canvas');
  const ctx=layer.getContext('2d'),maskCtx=mask.getContext('2d'),glyphCtx=glyph.getContext('2d'),previousThemeCtx=previousThemeLayer.getContext('2d');
  if(!ctx||!maskCtx||!glyphCtx||!previousThemeCtx)throw new Error('Agent Speed hero requires Canvas 2D');
  let pixels=0,scale=1,current=0,previous=-1,lastLevel=0,lastTheme='vehicles',initialized=false,changed=-99;
  let lastTitle='',previousTitle='',badgeLayout=null,previousLayout=null,fromLevel=0,startupAt=-99,themeBlendAt=-99;
  const layouts=new Map(),speed={value:0,velocity:0},wake={value:0,velocity:0},knee=new Float64Array(2),particles=Array.from({length:64},()=>({age:99,life:0,x:0,y:0,vx:0,vy:0,r:0,kind:0}));
  const streaks=Array.from({length:16},()=>({age:99,life:0,x:0,y:0,dx:1,dy:0,length:0,speed:0,alpha:0}));
  const stars=Array.from({length:14},(_,i)=>({x:fract((i+1)*.61803398875)*100,y:fract((i+1)*.41421356237)*100,depth:.5+.7*fract(i*.75487766)}));
  const vehiclePaint={h:-1,o:-1,w:-1,dark:null,version:0},badgePaint={h:-1,o:-1,w:-1,dark:null,version:0};
  const badgePips=Array.from({length:13},(_,i)=>{const a=(216+9*i)*Math.PI/180;return {x:50+37.5*Math.cos(a),y:50+37.5*Math.sin(a),color:null};});
  let pipRedline=NaN,pipDark=null;
  let distance=0,b=0,coast=0,heading=0,bobPhase=0,bobPhase2=0,stand=1,particleDebt=0,streakDebt=0,transitionEvent=false,snapNext=true,sheenPhase=0,haloPhase=0,breathPhase=0;
  const bandProfiles={};
  function fit(st){
    const next=Math.max(1,Math.ceil(.72*st.S*st.dpr));if(next===pixels)return;
    pixels=next;scale=pixels/100;layer.width=layer.height=mask.width=mask.height=glyph.width=glyph.height=previousThemeLayer.width=previousThemeLayer.height=pixels;themeBlendAt=-99;
    maskCtx.setTransform(scale,0,0,scale,0,0);
    const g=maskCtx.createRadialGradient(50,50,42,50,50,49);g.addColorStop(0,'rgba(255,255,255,1)');g.addColorStop(1,'rgba(255,255,255,0)');maskCtx.fillStyle=g;maskCtx.fillRect(0,0,100,100);
  }
  // DESIGN 4c: each title mask and its σ1.6/4.2 glow copies are rasterized once per logical glyph size/backing scale.
  function prepareGlyph(layout){
    if(layout.glyphPixels===pixels)return;
    const mask=document.createElement('canvas');mask.width=mask.height=pixels;
    const ink=mask.getContext('2d');if(!ink)throw new Error('Badge glyph cache requires Canvas 2D');
    ink.setTransform(scale,0,0,scale,0,0);ink.font='800 '+layout.size+'px '+HERO_FONT;ink.letterSpacing=layout.size*layout.tracking+'px';ink.textAlign='center';ink.textBaseline='alphabetic';
    let top=Infinity,bottom=-Infinity;
    for(let i=0;i<layout.lines.length;i++){
      const metrics=ink.measureText(layout.lines[i]),baseline=(i-(layout.lines.length-1)/2)*layout.size*layout.advance;
      top=Math.min(top,baseline-metrics.actualBoundingBoxAscent);bottom=Math.max(bottom,baseline+metrics.actualBoundingBoxDescent);
    }
    const shift=50-(top+bottom)/2;ink.fillStyle='#fff';
    for(let i=0;i<layout.lines.length;i++)ink.fillText(layout.lines[i],50,shift+(i-(layout.lines.length-1)/2)*layout.size*layout.advance);
    layout.inkTop=top+shift;layout.inkBottom=bottom+shift;layout.height=bottom-top;layout.glyphMask=mask;layout.glyphPixels=pixels;
    for(let i=0;i<2;i++){
      const glow=document.createElement('canvas');glow.width=glow.height=pixels;const blurred=glow.getContext('2d');if(!blurred)throw new Error('Badge glow cache requires Canvas 2D');
      blurred.filter='blur('+((i===0?1.6:4.2)*scale)+'px)';blurred.drawImage(mask,0,0);blurred.filter='none';
      if(i===0)layout.glowSmall=glow;else layout.glowLarge=glow;
    }
  }
  function tintGlyph(texture){
    glyphCtx.setTransform(1,0,0,1,0,0);glyphCtx.clearRect(0,0,pixels,pixels);glyphCtx.drawImage(texture,0,0);
    glyphCtx.globalCompositeOperation='source-in';glyphCtx.setTransform(scale,0,0,scale,0,0);
  }
  // HeroStage.Paint quantizes at 128; BadgePalette.Resolve at 256. Neither repeats an OKLab contrast search per frame.
  function resolvePaint(st,badge){
    const cache=badge?badgePaint:vehiclePaint,steps=badge?256:128,h=Math.round(clamp(st.h)*steps),o=Math.round(clamp(st.o)*steps),w=Math.round(clamp(wake.value)*steps);
    if(cache.h!==h||cache.o!==o||cache.w!==w||cache.dark!==st.dark){
      cache.h=h;cache.o=o;cache.w=w;cache.dark=st.dark;cache.version++;
      const hh=h/steps,oo=o/steps,ww=w/steps,idle=heroStroke(0,st.dark),awake=heroStroke(hh,st.dark);
      cache.idle=idle;cache.C=labMix(idle,awake,ww);cache.H=labMix(idle,st.dark?labMix(heatRgb(hh),HOT,.65+.35*oo):labMix(awake,AMBER,.45),ww);
      cache.glow=labMix(heatRgb(0),st.dark?awake:heatRgb(hh),ww);
      cache.top=st.dark?labMix(labMix(cache.C,cache.H,.45),HOT,.35*oo):cache.C;cache.bottom=st.dark?labMix(cache.C,HOT,.2*oo):cache.C;
      cache.core=st.dark?(badge?HOT:labMix(HOT,[1,1,1],oo)):AMBER;
    }
    const idle=(st.dark?.55:.5)*(st.moving?.86+.14*Math.sin(TAU*st.time/4.8):1);
    cache.presence=idle+(1-idle)*clamp(wake.value);cache.wake=clamp(wake.value);return cache;
  }
  function resolvePips(frame,st){
    if(pipRedline===frame.redline&&pipDark===st.dark)return;
    pipRedline=frame.redline;pipDark=st.dark;
    for(let i=0;i<13;i++){const h=i===0?heat(.5,frame.redline):Math.pow(TITLE_FRACTIONS[i+1],.6);badgePips[i].color=st.dark?heatRgb(h):heroLegible(labDarken(heatRgb(h),.18),false,3);}
  }
  // BadgeTitleSlot.SetBand's triangular profile, cached once; a shear retains its exact slope without rebuilding a brush.
  function titleBand(x,halfWidth,slope,alpha,idle,st){
    const key=st.dark?'dark':idle?'idle-light':'light';let profile=bandProfiles[key];
    if(!profile||profile.pixels!==pixels){
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.ceil(36*scale));canvas.height=Math.max(1,Math.ceil(120*scale));
      const ink=canvas.getContext('2d');if(!ink)throw new Error('Badge band cache requires Canvas 2D');
      ink.setTransform(scale,0,0,scale,0,0);const color=st.dark?HOT:idle?heatRgb(0):[1,1,1],gradient=ink.createLinearGradient(0,0,36,0);
      gradient.addColorStop(0,rgba(color,0));gradient.addColorStop(.5,rgba(color));gradient.addColorStop(1,rgba(color,0));ink.fillStyle=gradient;ink.fillRect(0,0,36,120);
      profile={canvas,pixels};bandProfiles[key]=profile;
    }
    glyphCtx.save();glyphCtx.globalCompositeOperation='source-atop';glyphCtx.globalAlpha=alpha;glyphCtx.transform(1,0,slope,1,x-halfWidth-60*slope,-10);
    glyphCtx.drawImage(profile.canvas,0,0,profile.canvas.width,profile.canvas.height,0,0,2*halfWidth,120);glyphCtx.restore();
  }
  function text(l,alpha,dy,zoom,st,colors,active){
    if(!l||alpha<=0)return;
    ctx.save();ctx.translate(50,50+dy);ctx.scale(zoom,zoom);ctx.translate(-50,-50);
    if(active){
      const sigma=(1+1.6*st.h+.6*st.o)*(st.fx===3?1.2:1),blend=clamp((sigma-1.6)/(4.2-1.6));
      const strength=(st.fx===0?(st.dark?.30:.20):(st.dark?.30+.45*st.h+.15*st.o:.16+.22*st.h))*colors.wake;
      ctx.globalCompositeOperation=st.dark?'lighter':'source-over';
      for(let i=0;i<2;i++){
        const weight=i===0?1-blend:blend;if(weight<=0)continue;
        tintGlyph(i===0?l.glowSmall:l.glowLarge);glyphCtx.fillStyle=rgba(colors.glow);glyphCtx.fillRect(0,0,100,100);glyphCtx.globalCompositeOperation='source-over';
        ctx.globalAlpha=alpha*strength*weight;ctx.drawImage(glyph,0,0,pixels,pixels,0,0,100,100);
      }
    }
    ctx.globalCompositeOperation='source-over';ctx.globalAlpha=alpha;tintGlyph(l.glyphMask);
    if(l.gradientPalette!==colors||l.gradientVersion!==colors.version||l.gradientPixels!==pixels){
      const gradient=glyphCtx.createLinearGradient(0,l.inkTop,0,l.inkBottom);gradient.addColorStop(0,rgba(colors.top));gradient.addColorStop(1,rgba(colors.bottom));
      l.gradient=gradient;l.gradientPalette=colors;l.gradientVersion=colors.version;l.gradientPixels=pixels;
    }
    glyphCtx.fillStyle=l.gradient;glyphCtx.fillRect(0,0,100,100);glyphCtx.globalCompositeOperation='source-over';
    if(st.fx>=2&&st.moving&&active&&st.h>=.45){
      const interval=Math.max(1.4,5-3.5*st.h),p=fract(sheenPhase)*interval/.7;
      if(p<1){const width=l.width+28;titleBand(50-width/2+(-.2+1.4*p)*width,18,-.45,st.dark?.4:.5,false,st);}
    }
    if(!active&&lastLevel===0&&st.moving&&st.sweepAge>=.63&&st.sweepAge<1.53){const p=(st.sweepAge-.63)/.9;titleBand(-10+120*(.5-.5*Math.cos(Math.PI*p)),9,0,st.dark?.75:.6,true,st);}
    ctx.drawImage(glyph,0,0,pixels,pixels,0,0,100,100);ctx.restore();
  }
  function emit(x,y,vx,vy,r,life,kind){
    for(const p of particles)if(p.age>=p.life){p.x=x;p.y=y;p.vx=vx;p.vy=vy;p.r=r;p.life=life;p.age=0;p.kind=kind;return;}
  }
  function spawnStreak(st,v,badge){
    const cap=st.fx===1?5:st.fx===3?14:9;let live=0;for(const line of streaks)if(line.age<line.life)live++;
    if(live>=cap)return;
    for(const line of streaks)if(line.age>=line.life){
      let y=badge?(Math.random()<.5?16+Math.random()*17:67+Math.random()*17):16+Math.random()*68;
      let tail=10;
      if(!badge&&y>30&&y<70){for(const em of v.emitters)if(em.type==='trail'){tail=em.at[0];break;}}
      line.x=tail===10?98:tail;line.y=y;line.length=(6+20*st.h)*(.7+Math.random()*.6)+1.5*speed.value/60;
      line.dx=badge?1:Math.cos(heading);line.dy=badge?0:Math.sin(heading);line.speed=1.25*Math.max(speed.value,40)*(.85+Math.random()*.3);line.alpha=(.16+.32*st.h)*(.7+Math.random()*.6);
      line.life=(line.x+line.length+10)/line.speed;line.age=0;return;
    }
  }
  function update(frame,st,dt){
    fit(st);
    const lookup=(themes[frame.titleTheme]||themes.vehicles)[frame.language==='zh'?'zh':'en'],index=lookup.indexOf(frame.title);
    const level=index<0?title(frame.value,frame.titleTheme,frame.language,frame.redline).level:index;
    if(!initialized){current=Math.max(0,level-1);lastLevel=level;lastTheme=frame.titleTheme;lastTitle=frame.title;distance=VEHICLES[current].motion.rest||0;wake.value=level>0?1:0;stand=level===0?1:0;initialized=true;}
    if(level!==lastLevel||frame.titleTheme!==lastTheme||frame.title!==lastTitle){
      if(frame.titleTheme!==lastTheme){previousThemeCtx.clearRect(0,0,pixels,pixels);previousThemeCtx.drawImage(layer,0,0);themeBlendAt=st.time;}
      previous=current;previousTitle=lastTitle;previousLayout=badgeLayout;changed=st.time;transitionEvent=!!frame.responsePulse;fromLevel=lastLevel;
      if(lastLevel===0&&level>0)startupAt=st.time+(Math.max(0,level-1)===current?.15:.30);
      if(level>0)current=level-1;
      if(frame.titleTheme!==lastTheme)previous=-1;
      lastLevel=level;lastTheme=frame.titleTheme;lastTitle=frame.title;badgeLayout=null;
    }
    if(!badgeLayout&&frame.titleTheme!=='vehicles'){
      const key=frame.language+'|'+frame.title;
      badgeLayout=layouts.get(key);
      if(!badgeLayout){badgeLayout=heroLayout(ctx,frame.title,frame.language);if(layouts.size>=96)layouts.clear();layouts.set(key,badgeLayout);}
    }
    if(badgeLayout)prepareGlyph(badgeLayout);
    if(previousLayout)prepareGlyph(previousLayout);
    const v=VEHICLES[current],low=current===0?.5:TITLE_FRACTIONS[current+1]*frame.redline,high=current===12?frame.redline*2:TITLE_FRACTIONS[current+2]*frame.redline;
    const smoothValue=st.h<1?frame.redline*Math.pow(st.h,1/.6):frame.redline*(1+st.o);
    b=current===12?st.o:clamp(Math.log(Math.max(.001,smoothValue)/Math.max(.001,low))/Math.log(Math.max(1.001,high/Math.max(.001,low))));
    coast=clamp(smoothValue/Math.max(.5,low));heading=(v.heading||0)*Math.PI/180;
    let target=level===0?0:frame.titleTheme==='vehicles'?lerp(v.motion.speed[0],v.motion.speed[1],b)*Math.sqrt(coast):lerp(60,900,st.h)+300*st.o;
    if(snapNext){speed.value=target;speed.velocity=0;wake.value=level>0?1:0;wake.velocity=0;stand=level===0?1:0;previous=-1;changed=startupAt=themeBlendAt=-99;transitionEvent=false;snapNext=false;}
    if(!st.moving){speed.value=target;speed.velocity=0;wake.value=level>0?1:0;wake.velocity=0;stand=level===0?1:0;return;}
    settle(speed,target,dt,.9);settle(wake,level>0?1:0,dt,.5);distance+=speed.value*dt;
    const bobRate=TAU*(1+.5*b)*dt;bobPhase=(bobPhase+1.7*bobRate)%TAU;bobPhase2=(bobPhase2+3.3*bobRate)%TAU;
    haloPhase=(haloPhase+TAU/lerp(4,.7,st.h)*dt)%TAU;breathPhase=(breathPhase+TAU/4.8*dt)%TAU;sheenPhase=(sheenPhase+dt/Math.max(1.4,5-3.5*st.h))%1000;
    const standTarget=level===0&&speed.value<6?1:0;stand+=(standTarget-stand)*(1-Math.exp(-dt/.18));
    const badge=frame.titleTheme!=='vehicles';
    if(level>0){
      const cap=st.fx===1?5:st.fx===3?14:9;
      const n=Math.min(cap,Math.round((2+8*st.h)*clamp(speed.value/(badge?60:v.motion.speed[0]))*(st.fx===1?.6:st.fx===3?1.4:1)));
      streakDebt+=dt*n/.9;
      while(streakDebt>=1){spawnStreak(st,v,badge);streakDebt--;}
      if(st.fx>=2){
        let rate=0,em=null,kind=0;
        if(badge&&st.tier>=3){rate=6+26*st.o;kind=2;}
        else for(const e of v.emitters){
          if(e.type==='sparks'&&(v.key==='rocket'||b>.55)){rate=v.key==='rocket'?26+60*st.o:30*(b-.55)/.45;em=e;kind=1;break;}
          if(e.type==='afterburner'&&st.tier>=3){rate=6+14*b;em=e;kind=1;break;}
        }
        particleDebt+=dt*rate*(st.fx===3?1.6:1);
        while(particleDebt>=1){
          if(badge){const a=(30+Math.random()*120)*Math.PI/180;emit(50+33*Math.cos(a),50+33*Math.sin(a),0,-18-Math.random()*16,.6,.6+Math.random()*.5,2);}
          else if(em){const sp=30+Math.random()*60;emit(em.at[0],em.at[1],em.dir[0]*sp+(Math.random()-.5)*15,em.dir[1]*sp+(Math.random()-.5)*15,.5+Math.random()*.5,.25+Math.random()*.2,kind);}
          particleDebt--;
        }
      }
    }
    for(const line of streaks)if(line.age<line.life){line.age+=dt;line.x-=line.dx*line.speed*dt;line.y-=line.dy*line.speed*dt;}
    for(const p of particles)if(p.age<p.life){p.age+=dt;if(p.kind===2)p.vx=6*Math.sin(p.x+7*p.age);else if(v.key==='raceCar')p.vy+=260*dt;p.vx*=Math.exp(-2.5*dt);p.x+=p.vx*dt;p.y+=p.vy*dt;}
  }
  function scenery(st,v,alpha,ground=v.groundY||70){
    const C=resolvePaint(st,false).C,D=st.moving?distance:0,G=st.moving?speed.value:0,g=ground;
    ctx.save();ctx.globalAlpha=alpha;ctx.strokeStyle=rgba(C,st.dark?.30:.34);ctx.lineWidth=1.1;ctx.lineCap='round';
    const type=v.scenery;
    if(type==='road'){
      const smear=clamp(G/60/12/.45),dash=7+.85*smear*5,offset=D%12;
      ctx.globalAlpha*=1-.35*smear;
      for(let x=-12-offset;x<110;x+=12)line(ctx,x,g,x+dash,g,1.1,rgba(C,st.dark?.30:.34));
    }else if(type==='rail'){
      line(ctx,-10,g,110,g,1.1,rgba(C,(st.dark?.30:.34)*1.3));
      const smear=clamp(G/60/9/.4),offset=D%9;
      for(let x=-9-offset;x<110;x+=9)line(ctx,x,g,x-1.2-4*smear,g+2.6,1.1,rgba(C,(st.dark?.30:.34)*(1-.55*smear)));
    }else if(type==='guideway'){
      line(ctx,-10,g,110,g,1.1,rgba(C,st.dark?.30:.34));line(ctx,-10,g+3.4,110,g+3.4,1.1,rgba(C,st.dark?.30:.34));
      for(let x=-38-D%38;x<110;x+=38)line(ctx,x,g+3.4,x,g+12.4,1.1,rgba(C,st.dark?.30:.34));
    }else if(type==='sky'){
      for(let i=0;i<2;i++){
        const l=VEHICLE_ART.scenery.sky.layers[i];
        for(let x=-72-(D*l.parallax)%72;x<110;x+=72){ctx.save();ctx.translate(x,l.y);ctx.scale(l.scale,l.scale);ctx.strokeStyle=rgba(C,l.opacity);ctx.stroke(CLOUD_PATHS[i]);ctx.restore();}
      }
    }else if(type==='stratosphere'){
      ctx.beginPath();ctx.arc(50,178,108,207*Math.PI/180,333*Math.PI/180);ctx.stroke();
    }else if(type==='space'){
      const a=(v.heading||-48)*Math.PI/180,dx=Math.cos(a),dy=Math.sin(a);
      for(const s of stars){
        const x=(s.x-D*.5*s.depth*dx%100+200)%100,y=(s.y-D*.5*s.depth*dy%100+200)%100,len=Math.max(.3,.5*G/60*1.3)*s.depth;
        line(ctx,x,y,x-dx*len,y-dy*len,.7,rgba(C,.30*s.depth));
      }
    }
    ctx.restore();
  }
  function rig(st,v,pass,C,sigma,opacity,farLayer,brush){
    const r=v.rig;if(!r)return;
    const D=st.moving?distance:v.motion.rest||0;
    ctx.lineJoin='round';ctx.lineCap='round';
    const base=2,extra=pass===2?0:pass===0?2.6*sigma:1.2*sigma;
    const paint=(far)=>{ctx.lineWidth=base+extra;ctx.strokeStyle=brush||rgba(C,opacity*(far?.42:1));ctx.globalAlpha=brush?opacity:1;};
    if(r.type==='walk'){
      const p=fract(D/r.cycle),bob=-r.bob*Math.cos(4*Math.PI*(p-r.stance/2))*(1-stand),hy=lerp(r.hip[1]+bob,v.groundY-.6-(r.thigh+r.shin)*.97,stand),hx=r.hip[0],sx=hx+r.torso[0],sy=hy+r.torso[1];
      for(let i=farLayer?0:1;i<(farLayer?1:2);i++){
        const phase=fract(p+(i===0?.5:0)),far=i===0,a=r.cycle*r.stance/2;let fx,fy;
        if(phase<r.stance){fx=hx+a-2*a*phase/r.stance;fy=v.groundY-.6;}
        else{const q=(phase-r.stance)/(1-r.stance);fx=hx-a+2*a*smooth(0,1,q);fy=v.groundY-.6-r.lift*Math.sin(Math.PI*q);}
        fx=lerp(fx,hx+(far?-1.6:1.6),stand);fy=lerp(fy,v.groundY-.6,stand);heroKnee(hx,hy,fx,fy,r.thigh,r.shin,knee);paint(far);
        ctx.beginPath();ctx.moveTo(hx,hy);ctx.lineTo(knee[0],knee[1]);ctx.lineTo(fx,fy);ctx.lineTo(fx+r.foot,fy);ctx.stroke();
        const theta=lerp(-r.armSwing*Math.cos(TAU*phase),far?-4:4,stand)*Math.PI/180,ex=sx+r.upperArm*Math.sin(theta),ey=sy+r.upperArm*Math.cos(theta),t2=theta+r.elbow*lerp(1,.5,stand)*Math.PI/180;
        ctx.beginPath();ctx.moveTo(sx,sy);ctx.lineTo(ex,ey);ctx.lineTo(ex+r.forearm*Math.sin(t2),ey+r.forearm*Math.cos(t2));ctx.stroke();
      }
      if(!farLayer){paint(false);ctx.beginPath();ctx.moveTo(hx,hy);ctx.lineTo(sx,sy);ctx.stroke();ctx.beginPath();ctx.arc(sx+r.head[0],sy+r.head[1],r.head[2],0,TAU);ctx.stroke();}
    }else{
      const phi=D/r.crank.radius,lift=st.moving?1.3*heroBump(st.time-startupAt,0,.18,.6):0,hy=r.hip[1]+r.bob*Math.cos(2*phi)-lift,hx=r.hip[0]+.6*lift;
      for(let i=farLayer?0:1;i<(farLayer?1:2);i++){
        const sign=i===0?-1:1,fx=r.crank.pivot[0]-sign*r.crank.length*Math.sin(phi),fy=r.crank.pivot[1]+sign*r.crank.length*Math.cos(phi);
        heroKnee(hx,hy,fx,fy,r.thigh,r.shin,knee);paint(i===0);ctx.beginPath();ctx.moveTo(hx,hy);ctx.lineTo(knee[0],knee[1]);ctx.lineTo(fx,fy);ctx.stroke();
        line(ctx,fx-r.pedal/2,fy,fx+r.pedal/2,fy,1.5+extra,rgba(C,opacity*(i===0?.42:1)));
      }
    }
  }
  function actor(st,v,alpha,offset,brush=null){
    const active=lastLevel>0,dark=st.dark,h=st.h,o=st.o,t=st.time,m=v.motion;
    const colors=resolvePaint(st,false),C=colors.C,H=colors.H,sigma=(1+1.4*h+.6*o)*(st.fx===3?1.2:1);
    const moving=st.moving,G=moving?speed.value:0,D=moving?distance:m.rest||0;
    let bob=0,pitch=0,lurch=0,flameStart=1,lightStart=0;const startAge=t-startupAt;
    if(moving){
      if(m.bob){bob=m.bob*(.6*Math.sin(bobPhase)+.4*Math.sin(bobPhase2+1.3))*(.4+.6*b)*wake.value;pitch=clamp(-.0035*speed.velocity,-1,1);lurch=clamp(.008*speed.velocity,-1.2,1.2);}
      if(m.float){bob=m.float*Math.sin(TAU*(v.key==='rocket'?.55:.32)*t);if(v.key!=='rocket')pitch=.8*(m.float/.7)*Math.cos(TAU*.32*t);}
      if(m.hover)bob=-m.hover*(.75+.25*Math.sin(TAU*.7*t));
      if(startAge>=0&&startAge<1.3&&v===VEHICLES[current]){
        if(v.key==='bicycle'||v.key==='ebike'){lurch+=1.6*heroBump(startAge,0,.22,.9);if(v.key==='ebike')lightStart=heroBump(startAge,0,.08,.5);}
        else if(v.key==='motorcycle'){pitch-=3*heroBump(startAge,.12,.34,.8);lurch+=1.4*heroBump(startAge,.1,.35,.9);bob+=.35*Math.sin(TAU*23*startAge)*(1-smooth(0,.3,startAge));}
        else if(v.key==='car'||v.key==='sportsCar'){lightStart=heroBump(startAge,0,.04,.12)+heroBump(startAge,.16,.2,.3);pitch-=1.3*heroBump(startAge,.05,.25,.7);lurch+=1.2*heroBump(startAge,.08,.3,.9);}
        else if(v.key==='raceCar'){pitch-=1.1*heroBump(startAge,0,.2,.6);lurch+=2*heroBump(startAge,.05,.28,.9);}
        else if(v.key==='bulletTrain'){lightStart=heroBump(startAge,0,.15,.7);lurch+=heroBump(startAge,.1,.45,1.1);}
        else if(v.key==='maglev'){lightStart=heroBump(startAge,0,.3,.8);bob*=smooth(.2,.7,startAge);}
        else if(v.key==='jetliner'){lightStart=heroBump(startAge,0,.2,.8);bob-=2*heroBump(startAge,.1,.5,1.2);}
        else if(v.key==='fighterJet'||v.key==='hypersonic'){flameStart=heroSpringAt(startAge,0,1,9,.32,.55);lightStart=heroBump(startAge,0,.06,.35);lurch+=1.4*heroBump(startAge,0,.2,.8);}
        else if(v.key==='rocket'){flameStart=heroSpringAt(startAge,0,1,8,.36,.5);lightStart=heroBump(startAge,0,.06,.35);offset-=6*(1-Math.pow(clamp(startAge/.9),3));bob+=.8*Math.sin(TAU*29*startAge)*(1-smooth(0,.6,startAge));}
      }
    }
    const presence=colors.presence;
    for(let pass=brush?2:0;pass<3;pass++){
      if(pass<2&&(wake.value<=.01||st.fx===0&&pass===0))continue;
      const glow=(st.fx===0?(dark?.30:.12):dark?.30+.45*h+.15*o:.14+.18*h)*(pass===0?.2:.5)*wake.value;
      const extra=pass===2?0:(pass===0?2.6:1.2)*sigma;
      ctx.save();ctx.translate(offset*Math.cos((v.heading||0)*Math.PI/180),offset*Math.sin((v.heading||0)*Math.PI/180));rig(st,v,pass,C,sigma,alpha*presence*(pass===2?1:glow*.8),true,brush);ctx.restore();
      for(const p of v.parts){
        const role=VEHICLE_ART.roles[p.role],flame=p.role==='flame'||p.role==='flameCore';
        if(flame&&wake.value<.02)continue;
        ctx.save();ctx.translate(offset*Math.cos((v.heading||0)*Math.PI/180)+lurch,offset*Math.sin((v.heading||0)*Math.PI/180));
        const sprung=p.sprung===undefined?role.sprung:p.sprung;
        if(sprung){ctx.translate(v.pivot[0],v.pivot[1]+bob);ctx.rotate(pitch*Math.PI/180);ctx.translate(-v.pivot[0],-v.pivot[1]);}
        if(v.rig&&v.rig.type==='pedal'&&p.role==='rider'){const lift=moving?1.3*heroBump(startAge,0,.18,.6):0;ctx.translate(.6*lift,v.rig.bob*Math.cos(2*D/v.rig.crank.radius)-lift);}
        let opacity=alpha*presence*role.opacity*(pass===2?1:glow*role.glow);
        if(role.color==='hot')opacity*=1+2*lightStart;
        if(p.role==='glow'){ctx.translate(0,(m.hover||0)/2);opacity*=(.5+.5*b)*wake.value*(v.key==='maglev'&&moving&&startAge>=0&&startAge<.7?smooth(.2,.7,startAge):1);}
        if(p.spin){
          const spin=p.spin,blur=smooth(14,26,G/(TAU*spin.radius)*spin.symmetry);opacity*=1-blur;
          ctx.translate(spin.pivot[0],spin.pivot[1]);ctx.rotate(D/spin.radius);ctx.translate(-spin.pivot[0],-spin.pivot[1]);
        }
        if(p.nozzle){
          const n=p.nozzle,a=Math.atan2(n.dir[1],n.dir[0]),flicker=moving?1+.1*(Math.sin(TAU*17*t)+Math.sin(TAU*23*t+1.1)+Math.sin(TAU*31*t+2.3))/3:1,len=(.55+.45*b+.35*o)*flicker*Math.max(0,flameStart)*wake.value;
          ctx.translate(n.at[0],n.at[1]);ctx.rotate(a);ctx.scale(len,(moving?1+.06*Math.sin(TAU*13*t):1)*Math.min(1,.6+.4*len));ctx.rotate(-a);ctx.translate(-n.at[0],-n.at[1]);
        }
        if(p.role==='shock'){ctx.translate(89.66,50.19);ctx.scale(1,1.15-.35*b);ctx.translate(-89.66,-50.19);opacity*=(.4+.6*b)*(moving?.7+.3*Math.sin(TAU*11*t):1);}
        const color=p.role==='flameCore'?colors.core:role.color==='hot'?H:C;
        ctx.lineWidth=2*role.weight+extra;ctx.lineCap=ctx.lineJoin='round';ctx.strokeStyle=brush||rgba(color,opacity);ctx.globalAlpha=brush?alpha*presence:1;
        if(role.fill&&!brush){ctx.fillStyle=rgba(role.fill==='hot'?(p.role==='flameCore'?colors.core:dark?HOT:AMBER):C,alpha*presence*role.fillOpacity*(pass===2?1:glow));if(p.path)ctx.fill(p.path);}
        if(role.weight>0&&(!brush||opacity>.004)){if(p.path)ctx.stroke(p.path);else if(p.circle){ctx.beginPath();ctx.arc(p.circle[0],p.circle[1],p.circle[2],0,TAU);ctx.stroke();}}
        ctx.restore();
        if(p.spin&&pass===2&&moving&&!brush){
          const sp=p.spin,blur=smooth(14,26,G/(TAU*sp.radius)*sp.symmetry);
          if(blur>.001){ctx.save();ctx.translate(sp.pivot[0],sp.pivot[1]);for(let j=0;j<2;j++)arc(ctx,(j===0?.72:.45)*(sp.radius-2),.9,t*216+j*180,120,rgba(C,alpha*.5*blur));ctx.restore();}
        }
      }
      ctx.save();ctx.translate(offset*Math.cos((v.heading||0)*Math.PI/180),offset*Math.sin((v.heading||0)*Math.PI/180));rig(st,v,pass,C,sigma,alpha*presence*(pass===2?1:glow*.8),false,brush);ctx.restore();
    }
    if(active&&!brush){
      for(const e of v.emitters){
        if(e.type==='trail'){
          const count=st.moving?e.lanes.length:1+(b>=.34?1:0)+(b>=.67?1:0);
          for(let i=0;i<Math.min(count,e.lanes.length);i++){
            const x=e.at[0]-1.5-2.5*(i%2),y=e.at[1]+e.lanes[i]+bob,len=e.length*(.45+.55*b+.25*h)*(moving?1+.18*Math.sin(TAU*(5.3+1.7*i)*t+i):1)*(st.moving?Math.min(1,G/20):1);
            const g=ctx.createLinearGradient(x-len,y,x,y);g.addColorStop(0,rgba(C,0));g.addColorStop(1,rgba(C,.55*alpha));line(ctx,x-len,y,x,y,1,g);
          }
        }else if(e.type==='contrail'&&moving){
          const length=e.weak?22:46;
          for(let d=2;d<length;d+=2){
            const y=e.at[1]+(m.float||0)*Math.sin(TAU*.32*(t-d/90))+.35*Math.sin((e.at[0]-d+.05*D)/7)*d/40;
            const yy=e.at[1]+(m.float||0)*Math.sin(TAU*.32*(t-(d+2)/90))+.35*Math.sin((e.at[0]-d-2+.05*D)/7)*(d+2)/40;
            line(ctx,e.at[0]-d,y,e.at[0]-d-2,yy,e.weak?.9:1.6,rgba(C,(e.weak?.26:.55*(.5+.5*b))*(1-d/length)*alpha));
          }
        }
      }
      if(st.fx>=2&&b>.35&&moving){for(const p of v.parts)if(p.nozzle&&p.role==='flame'){
        const n=p.nozzle,a=Math.atan2(n.dir[1],n.dir[0]);ctx.save();ctx.translate(n.at[0],n.at[1]);ctx.rotate(a);
        for(let i=0;i<3;i++){const x=[3,5.8,8.6][i]*(.55+.45*b+.35*o),hh=[1,.82,.64][i];ctx.strokeStyle=rgba(H,.75*(b-.35)/.65*(.75+.25*Math.sin(TAU*19*t)));ctx.lineWidth=.7;ctx.beginPath();ctx.moveTo(x-.9*hh,0);ctx.lineTo(x,hh);ctx.lineTo(x+.9*hh,0);ctx.lineTo(x,-hh);ctx.closePath();ctx.stroke();}ctx.restore();
      }}
    }
  }
  function badge(st,frame){
    const layout=badgeLayout;if(!layout)return;
    const active=lastLevel>0,colors=resolvePaint(st,true),C=colors.C,H=colors.H,wake=colors.wake;
    const age=st.time-changed,transition=(st.moving||st.reduced)&&age>=0&&age<(st.reduced?.3:.75)&&previousTitle!==frame.title;
    if(active&&st.fx>0){const breath=st.moving?1+.1*Math.sin(haloPhase):1;radial(ctx,50,50,34,C,(st.dark?.10+.22*st.h:.05+.08*st.h)*breath*wake);}
    ctx.save();ctx.beginPath();ctx.rect(-10,-10,120,120);ctx.rect(50-layout.width/2-2.5,50-layout.height/2-2.5,layout.width+5,layout.height+5);ctx.clip('evenodd');ctx.translate(50,50);
    const drawOn=st.moving&&fromLevel===0&&lastLevel!==0&&age>=0&&age<.45?ease(age/.45):1;
    arc(ctx,33,.8,-90,360*drawOn,rgba(C,(st.dark?.34:.42)*(.6+.4*wake)));arc(ctx,30.5,.5,-90,360,rgba(C,(st.dark?.16:.22)*(.6+.4*wake)));ctx.restore();
    const level=lastLevel;
    resolvePips(frame,st);
    for(let i=1;i<=13;i++){
      const pip=badgePips[i-1],lit=i<=level,x=pip.x,y=pip.y;
      const pop=st.moving&&i>fromLevel&&lit&&age<.75?Math.max(0,heroSpringAt(age-.1-.045*(i-fromLevel-1),0,1,0,.3,.5)):1,r=(i===level?1.45:1.05)*pop;
      const c=lit?pip.color:st.dark?[1,1,1]:[0,0,0];
      if(i===level&&st.dark&&st.fx>0)radial(ctx,x,y,r+2.4,c,.3);dot(ctx,x,y,r,rgba(c,lit?1:.12));
    }
    if(active&&st.moving){
      const count=Math.min(st.fx===1?4:st.fx===3?12:8,(2+6*st.h)*(st.fx===3?1.5:1));
      for(let i=0;i<Math.ceil(count);i++){
        const angle=(st.heroMotePhase||0)+TAU*MOTE_ORDER[i]/12,alpha=clamp(count-i)*wake,length=8+40*st.h;
        ctx.save();ctx.translate(50,50);gradientArc(ctx,33,1.2,angle*180/Math.PI-length,length,C,H,alpha,.01);dot(ctx,33*Math.cos(angle),33*Math.sin(angle),1,rgba(H,alpha));ctx.restore();
      }
    }
    if(st.moving&&transitionEvent&&transition&&lastLevel>fromLevel&&age>.06){
      const startup=fromLevel===0;
      if(!startup&&age<.56){const p=(age-.06)/.5;ctx.save();ctx.translate(50,50);arc(ctx,33+11*ease(p),1.6*(1-p),0,360,rgba(H,.7*(1-ease(p))));ctx.restore();}
      if(age<.41)radial(ctx,50,50,8+32*ease((age-.06)/.35),H,(st.dark?.42:.26)*Math.pow(1-(age-.06)/.35,2)*(st.fx===1||startup?.6:1));
    }
    const idleAlpha=(st.dark?.55:.70)*(st.moving?.86+.14*Math.sin(breathPhase):1),presence=active?1:idleAlpha;
    if(transition&&previousLayout){
      if(st.reduced){const q=smooth(0,.3,age);text(previousLayout,presence*(1-q),0,1,st,colors,active);text(layout,presence*q,0,1,st,colors,active);}
      else
      if(fromLevel===0){
        const q=smooth(0,.25,age);text(previousLayout,idleAlpha*(1-q),0,1,st,colors,false);text(layout,q,0,heroSpringAt(age,.85,1,0,.42,.6),st,colors,active);
      }else if(lastLevel>fromLevel){
        text(previousLayout,1-smooth(0,.16,age),0,1+.12*ease(age/.22),st,colors,active);
        text(layout,smooth(.08,.20,age),0,heroSpringAt(age-.08,.72,1,0,.42,.6),st,colors,active);
      }else if(lastLevel===0){
        const q=smooth(0,.4,age);text(previousLayout,1-q,0,1,st,colors,true);text(layout,presence*q,0,1,st,colors,false);
      }else{
        const q=smooth(0,.3,age);text(previousLayout,1-q,5*(.5-.5*Math.cos(Math.PI*clamp(age/.3))),1,st,colors,active);text(layout,smooth(.12,.47,age),-3*(1-ease(Math.max(0,age-.12)/.35)),1,st,colors,active);
      }
    }else text(layout,presence,0,1,st,colors,active);
  }
  function draw(target,st,frame){
    fit(st);ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,pixels,pixels);ctx.setTransform(scale,0,0,scale,0,0);ctx.lineCap=ctx.lineJoin='round';
    const v=VEHICLES[current],badgeTheme=frame.titleTheme!=='vehicles',age=st.time-changed;
    ctx.save();
    if(st.fx>=2&&st.moving&&st.tier>=4&&st.value>=.5){const A=(.2+.5*st.o)*(st.fx===3?1.4:1),t=st.time;ctx.translate(A*(.5*Math.sin(TAU*23*t)+.3*Math.sin(TAU*31*t+1)+.2*Math.sin(TAU*41*t+2)),A*(.5*Math.sin(TAU*19*t+.5)+.3*Math.sin(TAU*29*t+2)+.2*Math.sin(TAU*37*t+1)));}
    if(badgeTheme)badge(st,frame);
    else{
      if(previous>=0&&previous!==current&&(st.moving||st.reduced)&&age<(st.reduced?.3:.75)){
        const prior=VEHICLES[previous],q=smooth(0,.55,age);
        if(prior.scenery===v.scenery){const glide=.5-.5*Math.cos(Math.PI*clamp(age/.45));scenery(st,v,1,lerp(prior.groundY||70,v.groundY||70,glide));}
        else{scenery(st,prior,1-q);scenery(st,v,q);}
        if(st.reduced){const fade=smooth(0,.3,age);actor(st,prior,1-fade,0);actor(st,v,fade,0);}
        else
        if(lastLevel>fromLevel){
          actor(st,VEHICLES[previous],1-smooth(.12,.30,age),90*Math.pow(clamp(age/.34),3));
          actor(st,v,smooth(.12,.26,age),heroSpringAt(age-.12,-62,0,140,.5,.8));
        }else{
          actor(st,VEHICLES[previous],1-smooth(0,.45,age),-46*(.5-.5*Math.cos(Math.PI*clamp(age/.55))));
          actor(st,v,smooth(.10,.45,age),8*(1-ease(Math.max(0,age-.1)/.55)));
        }
      }else{scenery(st,v,1);actor(st,v,1,0);}
    }
    const colors=resolvePaint(st,badgeTheme),C=colors.C,H=colors.H;
    if(st.moving){
      for(const l of streaks)if(l.age<l.life){
        const tx=l.x-l.dx*l.length,ty=l.y-l.dy*l.length,alpha=l.alpha*smooth(0,.12,l.age)*smooth(l.life,l.life-.12,l.age),g=ctx.createLinearGradient(tx,ty,l.x,l.y);g.addColorStop(0,rgba(C,0));g.addColorStop(1,rgba(st.tier>=4&&st.dark?H:C,alpha));line(ctx,tx,ty,l.x,l.y,1,g);
      }
      for(const p of particles)if(p.age<p.life)line(ctx,p.x-p.vx*.022,p.y-p.vy*.022,p.x,p.y,p.r,rgba(labMix(H,C,p.age/p.life),1-p.age/p.life));
    }
    // HeroStage.Sweep / HeroPainter.Paint: the parked actor alone receives the gauge-synchronized 18-unit light band.
    if(!badgeTheme&&lastLevel===0&&st.moving&&1-wake.value>=.05&&st.sweepAge>=.63&&st.sweepAge<1.53){
      const u=(st.sweepAge-.63)/.9,x=-10+120*(.5-.5*Math.cos(Math.PI*u)),color=st.dark?HOT:colors.idle,band=ctx.createLinearGradient(x-9,0,x+9,0),alpha=(st.dark?.75:.6)*(1-wake.value);
      band.addColorStop(0,rgba(color,0));band.addColorStop(.5,rgba(color,alpha));band.addColorStop(1,rgba(color,0));actor(st,v,1,0,band);
    }
    ctx.restore();ctx.setTransform(1,0,0,1,0,0);ctx.globalCompositeOperation='destination-in';ctx.drawImage(mask,0,0);ctx.globalCompositeOperation='source-over';
    target.save();
    if((st.moving||st.reduced)&&st.time-themeBlendAt<.3){
      const q=smooth(0,.3,st.time-themeBlendAt);
      target.globalAlpha=1-q;target.drawImage(previousThemeLayer,-.36*st.S,-.36*st.S,.72*st.S,.72*st.S);
      target.globalAlpha=q;target.drawImage(layer,-.36*st.S,-.36*st.S,.72*st.S,.72*st.S);
    }else target.drawImage(layer,-.36*st.S,-.36*st.S,.72*st.S,.72*st.S);
    target.restore();
  }
  function demanding(st){
    return lastLevel>0||speed.value>.01||Math.abs(speed.velocity)>.01||Math.abs(wake.value-(lastLevel>0?1:0))>.002||Math.abs(stand-(lastLevel===0&&speed.value<6?1:0))>.002||st.time-changed<.75||st.time-startupAt<1.3;
  }
  function pause(){
    previous=-1;changed=-99;startupAt=-99;themeBlendAt=-99;transitionEvent=false;snapNext=true;
    for(const p of particles)p.age=99;for(const l of streaks)l.age=99;
  }
  return {update,draw,pause,demanding};
}
`;
