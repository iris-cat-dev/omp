// Adapted from zoefix/agent-speed v1.4.1 (MIT), a94a67fcc78e5d8eea5f82d8d5e737bccf994e2c.
// Sources: Presentation/Orb/Styles/{NeedleGeometry,NeedleDynamics,ReactorModel,MinimalModel}.cs,
// Presentation/Orb/Gpu/OrbStyleDraws.cs and Gpu/Styles/{NeedleDraw,NeedleDrawNeedle,ReactorDrawRotors,MinimalDraw}.cs;
// geometry, colors and dynamics are the normative spec/DESIGN.md §2a, not the superseded local SVG design.
export const ORB_STYLES_SCRIPT = String.raw`
const RED_DIAL = Math.pow(.75,.6);
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
  const count=Math.max(2,Math.ceil(sweep/4));
  for(let i=0;i<count;i++){
    const t=(i+.5)/count;
    arc(ctx,r,w,start+sweep*i/count,sweep/count+.08,rgba(mix(tail,head,t),alpha*lerp(tailAlpha,1,t)),round&&(i===0||i===count-1));
  }
}
function paintBody(ctx,st,style){
  const S=st.S,h=st.h;
  if(!st.thumbnail&&style!=='minimal'&&h>.001){
    const breathe=st.moving?1+.15*Math.sin(st.time*lerp(1.57,9,h)):1,c=st.dark?heatRgb(h):labelRgb(h,false);
    const aura=ctx.createRadialGradient(0,0,.5*S,0,0,.74*S);
    aura.addColorStop(0,rgba(c,(st.dark?.55:.32)*h*breathe));aura.addColorStop(1,rgba(c,0));dot(ctx,0,0,.74*S,aura);
  }
  ctx.drawImage(instrumentBody(st,style),-.75*S,-.75*S,1.5*S,1.5*S);
}
function paintNeedle(ctx,st){
  const S=st.S,h=st.h,o=st.o,dark=st.dark,t=st.time,fx=st.fx,active=st.value>=.5;
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
  const last=Math.floor(clamp(n)*40);
  for(let k=0;k<resources.ticks.length;k++){
    const tick=resources.ticks[k];if(!tick.major&&S<120)continue;
    const lit=active&&tick.pos<=n,isTip=k===last&&lit;
    if(lit&&tick.major&&fx>0&&dark&&!st.thumbnail){
      const glow=isTip?tick.tipGlow:tick.glow;
      ctx.save();ctx.translate(tick.x1,tick.y1);ctx.rotate(tick.angle);ctx.drawImage(glow,-tick.pad,-tick.pad,glow.width/st.dpr,glow.height/st.dpr);ctx.restore();
    }
    let paint=lit?(isTip?tick.tipPaint:tick.litPaint):tick.coldPaint;
    if(!active&&st.idleSweep>=0)paint=rgba(tick.cold,tick.alpha+Math.exp(-90*Math.pow(tick.pos-st.idleSweep,2))*(dark?.35:.25));
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
    ctx.save();ctx.globalCompositeOperation=dark?'lighter':'source-over';
    for(let i=0;i<12;i++){
      const a=135+270*n-Math.sign(omega)*width*i/12;
      ctx.fillStyle=rgba(styleLabelRgb(h,dark),.32*(1-i/12)/12);ctx.beginPath();ctx.arc(0,0,.43*S,(a-width/12)*Math.PI/180,a*Math.PI/180);ctx.arc(0,0,.235*S,a*Math.PI/180,(a-width/12)*Math.PI/180,true);ctx.closePath();ctx.fill();
    }ctx.restore();
  }
  const blade=active?(dark?labMix(heatRgb(h),HOT,.05+.45*o):styleLabelRgb(h,false)):[158/255,168/255,186/255];
  ctx.save();ctx.rotate(angle);
  if(fx>0&&!st.thumbnail){
    if(dark){
      const glow=fx===3?resources.bladeGlowMax:resources.bladeGlow,tint=resources.bladeTint,ink=resources.bladeTintCtx;
      ink.clearRect(0,0,tint.width,tint.height);ink.drawImage(glow.canvas,0,0);ink.globalCompositeOperation='source-in';ink.fillStyle=rgba(blade,.45+.35*h);ink.fillRect(0,0,tint.width,tint.height);ink.globalCompositeOperation='source-over';
      ctx.drawImage(tint,glow.x,glow.y,tint.width/st.dpr,tint.height/st.dpr);
    }else{
      const shadow=resources.bladeShadow,dx=.006*S,dy=.01*S;
      ctx.drawImage(shadow.canvas,shadow.x+dx*Math.cos(angle)+dy*Math.sin(angle),shadow.y-dx*Math.sin(angle)+dy*Math.cos(angle),shadow.canvas.width/st.dpr,shadow.canvas.height/st.dpr);
    }
  }
  ctx.fillStyle=rgba(blade,active?1:.75);ctx.fill(resources.blade);
  ctx.shadowBlur=0;ctx.shadowOffsetX=ctx.shadowOffsetY=0;line(ctx,.21*S,0,.44*S,0,.0045*S,rgba(dark?HOT:[1,1,1],dark?.75:.55));
  if(st.pulseAge<.35&&fx>0)radial(ctx,.44*S,0,.06*S,dark?HOT:AMBER,.7*(1-st.pulseAge/.35));
  ctx.restore();
  if(!st.thumbnail)ctx.drawImage(resources.hub,-.75*S,-.75*S,1.5*S,1.5*S);
}
function paintReactor(ctx,st){
  const S=st.S,h=st.h,o=st.o,dark=st.dark,active=st.value>=.5,fx=st.fx;
  const c=active?(dark?heatRgb(Math.max(h,.02)):heroStroke(Math.max(h,.05),false)):(dark?[.6,.65,.72]:[.35,.40,.48]),hot=styleHot(h,o,dark);
  const gold=fx===0?0:st.reduced?(st.peakAge<.3?Math.min(1,Math.min(st.peakAge,.3-st.peakAge)/.15):0):st.peakAge<.57?clamp(1-Math.abs(st.peakAge/.42-1)/.35):0;
  const head=active?energyBrighten(labMix(hot,[250/255,204/255,21/255],gold),.25*st.flash):c,tail=c;
  if(!st.thumbnail){
  ctx.drawImage(reactorStationary(st),-.75*S,-.75*S,1.5*S,1.5*S);
  if(active){
    const breath=st.moving?1+.15*Math.sin(TAU*(.3+1.7*h)*st.time):1;
    const pulse=st.pulseAge<.35?.25*(1-st.pulseAge/.35):0;
    const g=ctx.createRadialGradient(0,0,.30*S,0,0,.40*S);g.addColorStop(0,rgba(dark?labMix(c,HOT,.2*o):c,((dark?.10+.42*h:.06+.2*h)*breath+pulse)*(fx===3?1.2:1)));g.addColorStop(1,rgba(c,0));dot(ctx,0,0,.40*S,g);
  }
  }
  const rotor=st.rotors,alpha=active?1:dark?.38:.45;
  ctx.save();ctx.globalCompositeOperation=dark?'lighter':'source-over';
  if(dark&&active&&fx>0&&!st.thumbnail){ctx.shadowColor=rgba(head,.45);ctx.shadowBlur=.015*S*(fx===3?1.3:1);}
  const lengthA=Math.min(120,20+90*h+10*o);
  for(let i=0;i<3;i++)gradientArc(ctx,.425*S,.024*S*(active?1:.6),rotor[0]*180/Math.PI+120*i-lengthA,lengthA,tail,head,alpha,dark?.25:.5);
  ctx.shadowBlur=0;
  if(!st.thumbnail){
  const coils=S<120?12:24,coilSweep=S<120?13:7.5;
  for(let i=0;i<coils;i++){
    const a=rotor[1]+TAU*i/coils;
    let e=active?.18+.82*Math.pow(.5+.5*Math.cos(3*TAU*i/coils-st.bandPhase),2.2)*(.35+.65*h):.25;
    if(!active&&st.idleSweep>=0){const d=(i/coils-st.idleSweep+1)%1;e+=.6*Math.exp(-50*Math.pow(Math.min(d,1-d),2));}
    arc(ctx,.383*S,.018*S,a*180/Math.PI-coilSweep/2,coilSweep,rgba(labMix(labMix(c,[250/255,204/255,21/255],gold),hot,gold>0?0:smooth(.75,1,e)),e));
  }
  }
  const lengthC=Math.min(175,14+130*h+20*o);
  for(let i=0;i<2;i++)gradientArc(ctx,.338*S,.009*S,rotor[2]*180/Math.PI+180*i-lengthC,lengthC,tail,head,alpha,dark?.25:.5);
  ctx.restore();
  if(st.pulseAge<.32&&fx>0)arc(ctx,(.30+.20*ease(st.pulseAge/.32))*S,.012*S*(1-st.pulseAge/.32),0,360,rgba(c,.55*(1-st.pulseAge/.32)));
  ctx.drawImage(reactorCore(st),-.75*S,-.75*S,1.5*S,1.5*S);
  ctx.save();if(active&&fx>0&&dark&&!st.thumbnail){ctx.shadowColor=rgba(c,.45);ctx.shadowBlur=(.015+.015*h)*S;}
  arc(ctx,.30*S,.009*S,0,360,rgba(active?labMix(c,gold>0?[250/255,204/255,21/255]:hot,gold>0?gold:.4*o):(dark?[1,1,1]:[0,0,0]),active?.60+.40*h:(dark?.07:.08)*2.2));ctx.restore();
}
function paintMinimal(ctx,st){
  const S=st.S,h=st.h,o=st.o,dark=st.dark,fx=st.fx,w=Math.max(2.5,.034*S);
  arc(ctx,.425*S,w,0,360,dark?'rgba(255,255,255,.0805)':'rgba(0,0,0,.092)');
  if(st.value<.5)return;
  const gold=fx>0&&st.peakAge<.7?(st.reduced?Math.min(1,Math.min(st.peakAge,.7-st.peakAge)/.2):Math.sin(Math.PI*st.peakAge/.7)):0;
  let head=styleLabelRgb(Math.max(Math.round(h*255)/255,.04),dark),start=labDarken(head,dark?.28:.10);
  if(gold>0){const tint=Math.round(gold*32)/32,color=dark?[250/255,204/255,21/255]:[201/255,151/255,0];head=labMix(head,color,tint);start=labMix(start,color,tint);}
  const flash=Math.round(st.flash*8)/8;if(flash>0){head=styleLift(head,.25*flash);start=styleLift(start,.25*flash);}
  const p=h+o,lap1=clamp(p)*360,lap2=clamp(p-1)*360;
  ctx.save();
  const breath=st.tier>=4?(st.moving?.5+.5*Math.sin(TAU*st.time):1):0;
  const blink=fx>0&&st.pulseAge<.4?(st.reduced?Math.min(1,Math.min(st.pulseAge,.4-st.pulseAge)/.2):1-st.pulseAge/.4):0;
  if(fx>0&&dark&&st.tier>=2&&!st.thumbnail){ctx.shadowColor=rgba(head,Math.min(1,.35+.35*breath+.3*blink));ctx.shadowBlur=(lerp(.0125,.025,breath)+.01*blink)*S*(fx===3?1.3:1);}
  gradientArc(ctx,.425*S,w,-90,lap1,start,head,1,1,true);ctx.shadowBlur=0;
  if(lap2>.18){
    const a=(-90+lap2)*Math.PI/180,x=Math.cos(a)*.425*S,y=Math.sin(a)*.425*S;
    radial(ctx,x,y,.9*w,[0,0,0],dark?.55:.22);arc(ctx,.425*S,w,-90,lap2,rgba(head),true);
  }
  if(!st.thumbnail&&(st.tier>=4||blink>0)){
    const a=(-90+(p%1)*360)*Math.PI/180;
    dot(ctx,Math.cos(a)*.425*S,Math.sin(a)*.425*S,.32*w,rgba(dark?labMix(head,HOT,.6):head,Math.max(blink,.6*breath)));
  }
  ctx.restore();
}
`;
