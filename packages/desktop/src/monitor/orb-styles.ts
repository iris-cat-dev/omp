// Adapted from zoefix/agent-speed v1.6.1 Windows (MIT), 384ce020cc655133e95aaad5cc085f3985f0ed99.
// Sources: Presentation/Orb/Styles/{NeedleGeometry,NeedleModel,ReactorModel,ReactorColors,MinimalModel}.cs
// and Orb/Gpu/Styles/{NeedleDraw,NeedleDrawNeedle,ReactorDrawRotors,MinimalDraw}.cs.
// Native continuous arc gradients, layer order, fixed-DIP floors and per-style idle/peak policies are retained.
export const ORB_STYLES_SCRIPT = String.raw`
const RED_DIAL = Math.pow(.75,.6);
let REACTOR_MEAN_BAND=0;for(let i=0;i<4096;i++)REACTOR_MEAN_BAND+=Math.pow(.5+.5*Math.cos(TAU*(i+.5)/4096),2.2);REACTOR_MEAN_BAND/=4096;
function arc(ctx,r,width,start,sweep,paint,round=false){
  if(Math.abs(sweep)<.001)return;
  ctx.lineWidth=width;ctx.strokeStyle=paint;ctx.lineCap=round?'round':'butt';
  ctx.beginPath();ctx.arc(0,0,r,start*Math.PI/180,(start+sweep)*Math.PI/180,sweep<0);ctx.stroke();
}
function dot(ctx,x,y,r,paint){ctx.fillStyle=paint;ctx.beginPath();ctx.arc(x,y,Math.max(0,r),0,TAU);ctx.fill();}
function line(ctx,x,y,xx,yy,width,paint){ctx.lineWidth=width;ctx.strokeStyle=paint;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(xx,yy);ctx.stroke();}
function radial(ctx,x,y,r,c,alpha){
  if(r<=0||alpha<=0)return;
  const g=ctx.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,rgba(c,alpha));g.addColorStop(1,rgba(c,0));dot(ctx,x,y,r,g);
}
function gradientArc(ctx,r,w,start,sweep,tail,head,alpha,tailAlpha,round=false){
  if(sweep<.001)return;
  const gradient=ctx.createConicGradient(start*Math.PI/180,0,0),end=Math.min(1,sweep/360);
  gradient.addColorStop(0,rgba(tail,alpha*tailAlpha));gradient.addColorStop(end,rgba(head,alpha));if(end<1)gradient.addColorStop(1,rgba(head,alpha));
  arc(ctx,r,w,start,sweep,gradient,round);
}
function paintBody(ctx,st,style){
  const S=st.S,h=st.unavailable?0:st.h;
  if(!st.thumbnail&&style!=='minimal'&&st.auraIntensity>.001){
    const c=st.dark?heatRgb(Math.max(h,.12)):labelRgb(Math.max(h,.12),false),aura=ctx.createRadialGradient(0,0,.5*S,0,0,.75*S);
    for(let i=0;i<=16;i++){const t=i/16;aura.addColorStop(t,rgba(c,(st.dark?.55:.32)*st.auraIntensity*Math.exp(-4.2*t*t)*(1-t*t)));}dot(ctx,0,0,.75*S,aura);
  }
  ctx.drawImage(instrumentBody(st,style),-.75*S,-.75*S,1.5*S,1.5*S);
}
function paintNeedle(ctx,st){
  const S=st.S,h=st.h,o=st.o,dark=st.dark,t=st.time,fx=st.fx,active=st.tier!==0&&!st.unavailable;
  const m=st.needle,resources=needleResources(st),red=resources.red;
  let n=m.value;
  if(st.peakAge<1&&st.moving)n+=(1.012-n)*(smooth(0,.38,st.peakAge)-smooth(.5,1,st.peakAge));
  if(fx>=2&&st.moving){
    const A=smooth(.55,1,h)*(.3+o)*(fx===3?1.4:1);
    n+=A*(.5*Math.sin(TAU*11.3*t)+.3*Math.sin(TAU*17.9*t+1.3)+.2*Math.sin(TAU*26.1*t+2.1))/270;
  }
  n=clamp(n,-.012,1.012);st.needleShown=n;
  arc(ctx,.41*S,.075*S,135-1.08,272.16,dark?'rgba(255,255,255,.028)':'rgba(0,0,0,.035)');
  let redAlpha=dark?.62:.8;
  if(st.tier>=4&&st.moving&&fx>0)redAlpha*=.8+.2*(.5+.5*Math.sin(TAU*(2+o)*t));
  ctx.save();
  if(fx>=2&&st.tier>=4){ctx.shadowColor=rgba(red,.6);ctx.shadowBlur=.025*S*(.6+.4*o)*(fx===3?1.3:1);}
  arc(ctx,.4655*S,.017*S,135+270*RED_DIAL,270*(1-RED_DIAL),rgba(red,redAlpha));ctx.restore();
  if(st.dialUnit){const legend=st.dialUnit;ctx.font='500 '+legend.size+'px '+ORB_TEXT_FACE;ctx.letterSpacing=legend.tracking+'px';ctx.textAlign='center';ctx.textBaseline='alphabetic';ctx.fillStyle=dark?'rgba(255,255,255,.4125)':'rgba(0,0,0,.375)';ctx.fillText(legend.text,0,legend.y);ctx.letterSpacing='0px';}
  const last=Math.floor(clamp(n)*40);
  for(let k=0;k<resources.ticks.length;k++){
    const tick=resources.ticks[k];if(!tick.major&&S<120)continue;
    const lit=active&&tick.pos<=n,isTip=k===last&&lit;
    if(lit&&tick.major&&fx>0&&dark&&!st.thumbnail){
      const glow=isTip?tick.tipGlow:tick.glow;
      ctx.save();ctx.translate(tick.x1,tick.y1);ctx.rotate(tick.angle);ctx.drawImage(glow,-tick.pad,-tick.pad,glow.width/st.dpr,glow.height/st.dpr);ctx.restore();
    }
    let paint=lit?(isTip?tick.tipPaint:tick.litPaint):tick.coldPaint;
    if(!active&&!st.unavailable&&st.idleProgress>=0)paint=rgba(tick.cold,tick.alpha+Math.exp(-90*Math.pow(tick.pos-st.idleSweep,2))*(dark?.35:.25));
    line(ctx,tick.x1,tick.y1,tick.x2,tick.y2,tick.width,paint);
  }
  if(active&&!st.thumbnail){
    // NeedleDraw.AddTrace: heat(position), not a slate-to-endpoint two-color ramp.
    const end=clamp(n),runs=Math.max(2,Math.ceil(end*16)),scale=dark?.70:.85;
    let previous=styleLabelRgb(0,dark);
    for(let i=0;i<runs;i++){
      const p0=end*i/runs,p1=end*(i+1)/runs,current=styleLabelRgb(p1,dark),a0=lerp(.3,1,i/runs),a1=lerp(.3,1,(i+1)/runs);
      gradientArc(ctx,.366*S,.011*S,135+270*p0,270*(p1-p0),previous,current,scale*a1,a0/a1);previous=current;
    }
  }
  if(!st.thumbnail)for(const pin of resources.pins)dot(ctx,pin.x,pin.y,.011*S,dark?'rgba(255,255,255,.32)':'rgba(0,0,0,.28)');
  if(S>=120){
    for(let i=0;i<5;i++){
      const lamp=resources.lamps[i],x=lamp.x,y=lamp.y;
      dot(ctx,x,y,.019*S,dark?'rgba(255,255,255,.08)':'rgba(0,0,0,.09)');
      if(active&&n>=lamp.threshold){
        const flashing=st.tier>=4&&st.moving&&fx>0;
        const c=flashing?resources.flashLamp:lamp.color;
        const a=flashing?.28+.72*smooth(-.35,.35,Math.sin(TAU*3*t)):1;
        if(dark&&fx>0)radial(ctx,x,y,.045*S,c,.40*a);
        dot(ctx,x,y,.019*.86*S,rgba(c,a));
      }
    }
  }
  const angle=(135+270*n)*Math.PI/180;
  const omega=m.velocity*270;
  if(st.moving&&fx>0&&Math.abs(omega)>12){
    const width=Math.min(55,4+.085*Math.abs(omega));
    const opacity=.32*smooth(12,30,Math.abs(omega));ctx.save();ctx.globalCompositeOperation=dark?'lighter':'source-over';
    for(let i=0;i<12;i++){
      const head=135+270*n-Math.sign(omega)*width*i/12,tail=head-Math.sign(omega)*width/12;
      arc(ctx,(.43+.235)/2*S,(.43-.235)*S,Math.min(head,tail),Math.abs(head-tail),rgba(styleLabelRgb(h,dark),opacity*(1-(i+.5)/12)));
    }ctx.restore();
  }
  const a=Math.round(clamp(st.styleActivity.value)*16)/16,bladeHeat=dark?labMix(heatRgb(Math.max(h,.04)),HOT,.05+.45*o):styleLabelRgb(Math.max(h,.05),false),blade=labMix([158/255,168/255,186/255],bladeHeat,a),flare=fx>0&&st.pulseAge<.35?Math.round((1-st.pulseAge/.35)*16)/16:0;
  ctx.save();ctx.rotate(angle);
  if(fx>0&&!st.thumbnail){
    if(dark){
      const glow=fx===3?resources.bladeGlowMax:resources.bladeGlow,tint=resources.bladeTint,ink=resources.bladeTintCtx,scale=fx===3?1.25:1,sigma=(.0275+.0175*flare)*S*scale,baseSigma=.0275*S*scale;
      ink.clearRect(0,0,tint.width,tint.height);ink.drawImage(glow.canvas,(glow.x-resources.bladeTintX)*st.dpr,(glow.y-resources.bladeTintY)*st.dpr);ink.globalCompositeOperation='source-in';ink.fillStyle=rgba(heatRgb(Math.max(.1,h)),Math.min(1,.45+.35*h+.6*flare));ink.fillRect(0,0,tint.width,tint.height);ink.globalCompositeOperation='source-over';
      if(flare>0)ctx.filter='blur('+(Math.sqrt(Math.max(0,sigma*sigma-baseSigma*baseSigma))*st.dpr)+'px)';ctx.drawImage(tint,resources.bladeTintX,resources.bladeTintY,tint.width/st.dpr,tint.height/st.dpr);ctx.filter='none';
    }else{
      const shadow=resources.bladeShadow,dx=.006*S,dy=.01*S;
      ctx.drawImage(shadow.canvas,shadow.x+dx*Math.cos(angle)+dy*Math.sin(angle),shadow.y-dx*Math.sin(angle)+dy*Math.cos(angle),shadow.canvas.width/st.dpr,shadow.canvas.height/st.dpr);
    }
  }
  ctx.fillStyle=rgba(blade,.75+.25*a);ctx.fill(resources.blade);
  ctx.shadowBlur=0;ctx.shadowOffsetX=ctx.shadowOffsetY=0;line(ctx,.21*S,0,.44*S,0,.0045*S,rgba(dark?HOT:[1,1,1],dark?Math.min(1,.75+.25*flare):.55));
  if(flare>0)radial(ctx,.44*S,0,.06*S,dark?HOT:AMBER,.7*flare);
  ctx.restore();
  if(!st.thumbnail)ctx.drawImage(resources.hub,-.75*S,-.75*S,1.5*S,1.5*S);
}
function paintReactor(ctx,st){
  const S=st.S,a=clamp(st.styleActivity.value),h=st.h*a,o=st.o*a,dark=st.dark,active=a>.004,fx=st.fx,dim=dark?.38:.45,idle=1-a;
  const heatColor=dark?heatRgb(Math.max(h,.02)):heroStroke(Math.max(h,.05),false),slate=dark?[.6,.65,.72]:[.35,.40,.48],c=labMix(heatColor,slate,idle),hot=styleHot(h,o,dark);
  const gold=fx===0?0:st.reduced?(st.peakAge<.3?Math.sin(Math.PI*st.peakAge/.3):0):st.peakAge<.57?clamp(1-Math.abs(st.peakAge/.42-1)/.35):0;
  const head=labMix(energyBrighten(labMix(hot,[250/255,204/255,21/255],gold),.25*st.flash),slate,idle),tail=c;
  if(!st.thumbnail){
  ctx.drawImage(reactorStationary(st),-.75*S,-.75*S,1.5*S,1.5*S);
  if(active){
    const breath=st.moving?1+.15*Math.sin(TAU*(.3+1.7*h)*st.time):1;
    const pulse=st.pulseAge<.35?.25*(1-st.pulseAge/.35):0;
    const g=ctx.createRadialGradient(0,0,.30*S,0,0,.42*S);for(let i=0;i<=16;i++){const t=i/16;g.addColorStop(t,rgba(dark?labMix(heatColor,HOT,.2*o):heatColor,(((dark?.10+.42*h:.06+.2*h)*breath+pulse)*(fx===3?1.2:1)*(1+.25*st.flash))*a*Math.exp(-4.2*t*t)*(1-t*t)));}dot(ctx,0,0,.42*S,g);
  }
  }
  const rotor=st.rotors,alphaA=1+(dim*.55-1)*idle,alphaC=.95+(dim*.5-.95)*idle;
  ctx.save();ctx.globalCompositeOperation=dark?'lighter':'source-over';
  if(dark&&active&&fx>0&&!st.thumbnail){ctx.shadowColor=rgba(heatColor,.7*a*(fx===3?1.3:1));ctx.shadowBlur=.03*S*(fx===3?1.3:1);}
  const lengthA=Math.min(120,20+90*h+10*o);
  for(let i=0;i<3;i++)gradientArc(ctx,.425*S,.024*S*(1-.4*idle),rotor[0]*180/Math.PI+120*i-lengthA,lengthA,tail,head,alphaA,dark?.25:.5);
  ctx.shadowBlur=0;
  if(!st.thumbnail){
  const coils=S<120?12:24,coilSweep=S<120?13:7.5;
  for(let i=0;i<coils;i++){
    const angle=rotor[1]+TAU*i/coils,band=fx===0||st.thumbnail?REACTOR_MEAN_BAND:Math.pow(.5+.5*Math.cos(3*TAU*i/coils-st.bandPhase),2.2),energy=.18+.82*band*(.35+.65*h);let e=lerp(.25,energy,a);
    if(st.tier===0&&!st.unavailable&&st.idleProgress>=0){const d=(i/coils-st.idleProgress+1)%1;e+=.6*Math.exp(-49*Math.pow(Math.min(d,1-d),2));}if(gold>0)e=Math.max(e,gold);
    const coil=labMix(c,[250/255,204/255,21/255],gold),coilColor=gold>0?coil:mix(coil,hot,clamp((e-.75)*3)*a);arc(ctx,.383*S,.018*S,angle*180/Math.PI-coilSweep/2,coilSweep,rgba(coilColor,Math.min(1,e)*(1+(dim*.8-1)*idle)));
  }
  }
  const lengthC=Math.min(175,14+130*h+20*o);
  for(let i=0;i<2;i++)gradientArc(ctx,.338*S,.009*S,rotor[2]*180/Math.PI+180*i-lengthC,lengthC,tail,head,alphaC,dark?.25:.5);
  ctx.restore();
  if(st.pulseAge<.32&&fx>0&&!st.reduced)arc(ctx,(.30+.20*ease(st.pulseAge/.32))*S,.012*S*(1-st.pulseAge/.32)+.5,0,360,rgba(c,.55*(1-st.pulseAge/.32)));
  ctx.drawImage(reactorCore(st),-.75*S,-.75*S,1.5*S,1.5*S);
  ctx.save();if(active&&fx>0&&dark&&!st.thumbnail){ctx.shadowColor=rgba(heatColor,.9*a*(fx===3?1.3:1));ctx.shadowBlur=2*(.015+.015*h)*S*(fx===3?1.3:1);}
  const rim=labMix(labMix(heatColor,gold>0?[250/255,204/255,21/255]:hot,gold>0?gold:.4*o),dark?[1,1,1]:[0,0,0],idle);arc(ctx,.30*S,Math.max(1,.009*S),0,360,rgba(rim,(.60+.40*h)*a+(dark?.07:.08)*2.2*idle));ctx.restore();
}
function paintMinimal(ctx,st){
  const S=st.S,h=st.h,o=st.o,a=clamp(st.styleActivity.value),dark=st.dark,fx=st.fx,w=Math.max(2.5,.034*S);
  arc(ctx,.425*S,w,0,360,dark?'rgba(255,255,255,.0805)':'rgba(0,0,0,.092)');
  if((h+o)*a<=.002)return;
  const gold=fx>0&&st.peakAge<.7?(st.reduced?Math.min(1,Math.min(st.peakAge,.7-st.peakAge)/.2):Math.sin(Math.PI*st.peakAge/.7)):0;
  let head=styleLabelRgb(Math.max(Math.round(h*255)/255,.04),dark),start=labDarken(head,dark?.28:.10);
  if(gold>0){const tint=Math.round(gold*32)/32,color=dark?[250/255,204/255,21/255]:[201/255,151/255,0];head=labMix(head,color,tint);start=labMix(start,color,tint);}
  const flash=Math.round(st.flash*8)/8;if(flash>0){head=styleLift(head,.25*flash);start=styleLift(start,.25*flash);}
  const p=(h+o)*a,lap1=clamp(p)*360,lap2=clamp(p-1)*360;
  ctx.save();
  const breath=st.tier>=4?(st.moving?.5+.5*Math.sin(TAU*st.time):1):0;
  const blink=fx>0&&st.pulseAge<.4?(st.reduced?Math.min(1,Math.min(st.pulseAge,.4-st.pulseAge)/.2):1-st.pulseAge/.4):0;
  if(fx>0&&dark&&st.tier>=2&&!st.thumbnail){ctx.shadowColor=rgba(head,Math.min(1,(.35+.35*breath+.3*blink)*(1+.25*flash)));ctx.shadowBlur=2*(lerp(.0125,.025,breath)+.01*blink)*S*(fx===3?1.3:1);}
  gradientArc(ctx,.425*S,w,-90,lap1,start,head,1,1,true);ctx.shadowBlur=0;
  if(lap2>.18){
    const degrees=-90+lap2;ctx.save();ctx.shadowColor=dark?'rgba(0,0,0,.55)':'rgba(0,0,0,.22)';ctx.shadowBlur=.7*w;arc(ctx,.425*S,w,degrees-.02*180/Math.PI,.09*180/Math.PI,dark?'rgba(0,0,0,.55)':'rgba(0,0,0,.22)');ctx.restore();arc(ctx,.425*S,w,-90,lap2,rgba(head),true);
  }
  if(!st.thumbnail&&(st.tier>=4||blink>0)){
    const a=(-90+(p%1)*360)*Math.PI/180;
    dot(ctx,Math.cos(a)*.425*S,Math.sin(a)*.425*S,.32*w,rgba(dark?labMix(head,HOT,.6):head,Math.max(blink,.6*breath)));
  }
  ctx.restore();
}
// The original Windows high-contrast instrument is flat system-colored geometry, not the luminous shader with a filter.
function paintHighContrast(ctx,st,style,frame){
  const S=st.S,C=st.contrast,active=st.tier!==0&&!st.unavailable,h=st.unavailable?0:st.h,activity=clamp(st.styleActivity.value);
  dot(ctx,0,0,.5*S,C.window);arc(ctx,.5*S-.75,1.5,0,360,C.text);
  if(style==='led'){
    const span=(270-2.2*35)/36,step=span+2.2,half=.41*Math.PI/180*span/2,corner=Math.min(.0225,half)*.48,lit=h*36;
    for(let i=0;i<36;i++){
      const angle=(135+i*step+span/2)*Math.PI/180;ctx.save();ctx.translate(Math.cos(angle)*.41*S,Math.sin(angle)*.41*S);ctx.rotate(angle);ctx.beginPath();ctx.roundRect(-.0225*S,-half*S,.045*S,2*half*S,corner*S);
      if(lit-i<1){ctx.globalAlpha=.6;ctx.fillStyle=C.gray;ctx.fill();}if(lit>i){ctx.globalAlpha=clamp(lit-i);ctx.fillStyle=C.highlight;ctx.fill();}ctx.restore();
    }
    if(!st.thumbnail)for(const threshold of [Math.pow(.5/frame.redline,.6),Math.pow(.15,.6),Math.pow(.375,.6),RED_DIAL]){const a=(135+270*threshold)*Math.PI/180;ctx.save();ctx.globalAlpha=h>=threshold?.95:.55;dot(ctx,Math.cos(a)*.452*S,Math.sin(a)*.452*S,.0085*S,C.text);ctx.restore();}
    return;
  }
  if(style==='liquid'){
    const R=.455*S,y=(.455-.91*clamp(st.liquid.value,.04,.95))*S;ctx.save();ctx.beginPath();ctx.arc(0,0,R,0,TAU);ctx.clip();ctx.fillStyle=C.highlight;ctx.globalAlpha=.35;ctx.fillRect(-R,y,2*R,R-y);ctx.globalAlpha=1;line(ctx,-R,y,R,y,Math.max(1,(.008+.004*h)*S),C.highlight);ctx.restore();arc(ctx,R,Math.max(1,.003*S),0,360,C.gray);return;
  }
  if(style==='needle'){
    const resources=needleResources(st),n=clamp(st.needle.value,-.012,1.012),angle=(135+270*n)*Math.PI/180;
    arc(ctx,.4655*S,.017*S,135+270*RED_DIAL,270*(1-RED_DIAL),C.highlight);
    if(st.dialUnit){const legend=st.dialUnit;ctx.font='500 '+legend.size+'px '+ORB_TEXT_FACE;ctx.textAlign='center';ctx.textBaseline='alphabetic';ctx.fillStyle=C.gray;ctx.fillText(legend.text,0,legend.y);}
    for(const tick of resources.ticks)if(tick.major||S>=120)line(ctx,tick.x1,tick.y1,tick.x2,tick.y2,tick.width,C.text);
    if(active&&!st.thumbnail)arc(ctx,.366*S,.011*S,135,270*clamp(n),C.text);
    if(!st.thumbnail)for(const pin of resources.pins)dot(ctx,pin.x,pin.y,.011*S,C.text);
    if(S>=120)for(const lamp of resources.lamps){ctx.save();ctx.translate(lamp.x,lamp.y);arc(ctx,.019*S-.5,1,0,360,C.gray);if(active&&n>=lamp.threshold)dot(ctx,0,0,.019*.86*S,C.highlight);ctx.restore();}
    ctx.save();ctx.rotate(angle);ctx.fillStyle=C.text;ctx.fill(resources.blade);ctx.restore();
    if(!st.thumbnail){dot(ctx,0,0,.235*S,C.window);arc(ctx,.235*S,.013*S,0,360,C.text);}return;
  }
  if(style==='reactor'){
    const rotors=st.rotors,notches=S<120?4:24;
    if(!st.thumbnail){arc(ctx,.468*S,Math.max(1,.006*S),0,360,C.text);for(let i=0;i<notches;i++){const a=TAU*i/notches;ctx.save();ctx.globalAlpha=notches===4||i%6===0?1:.5;line(ctx,Math.cos(a)*.456*S,Math.sin(a)*.456*S,Math.cos(a)*.474*S,Math.sin(a)*.474*S,Math.max(.8,.005*S),C.text);ctx.restore();}ctx.save();ctx.globalAlpha=.6;arc(ctx,.425*S,.024*S,0,360,C.gray);arc(ctx,.338*S,.009*S,0,360,C.gray);ctx.restore();}
    for(const [radius,width,count,length,phase] of [[.425,.024*(.6+.4*activity),3,Math.min(120,20+90*h*activity+10*st.o*activity),rotors[0]],[.338,.009,2,Math.min(175,14+130*h*activity+20*st.o*activity),rotors[2]]]){
      for(let i=0;i<count;i++){const end=phase*180/Math.PI+360*i/count,lead=Math.min(length,Math.max(4,length*.25));arc(ctx,radius*S,width*S,end-length,length,C.text);arc(ctx,radius*S,width*S,end-lead,lead,C.highlight);}
    }
    if(!st.thumbnail){const coils=S<120?12:24;for(let i=0;i<coils;i++){const angle=rotors[1]*180/Math.PI+360*i/coils;arc(ctx,.383*S,.018*S,angle-(S<120?6.5:3.75),S<120?13:7.5,C.text);}}
    dot(ctx,0,0,.30*S,C.window);arc(ctx,.30*S,Math.max(1,.009*S),0,360,C.text);return;
  }
  const width=Math.max(2.5,.034*S),p=(h+st.o)*activity;arc(ctx,.425*S,width,0,360,C.gray);
  if(p>.002){arc(ctx,.425*S,width,-90,clamp(p)*360,C.highlight,true);if(p>1)arc(ctx,.425*S,width,-90,clamp(p-1)*360,C.text,true);if(st.tier>=4){const a=(-90+p%1*360)*Math.PI/180;dot(ctx,Math.cos(a)*.425*S,Math.sin(a)*.425*S,.32*width,C.window);}}
}
`;
