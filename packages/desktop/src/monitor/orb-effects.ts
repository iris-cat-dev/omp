// Adapted from zoefix/agent-speed v1.4.1 (MIT), frozen a94a67fcc78e5d8eea5f82d8d5e737bccf994e2c.
// Normative LED source: spec/prototypes/led-effects.html emitSpark/emitEmber/burst,
// makeArc/drawArc, jag/shapeBolt/makeBolt/zap, particle stepping and ray/bolt rendering.
// Other accents: Presentation/Orb/Styles/{NeedleSparks,ReactorLightning,LiquidParticles,LiquidModel}.cs; DESIGN §2a.
// No demonstration timeline, automatic response timer or peak inference is included. All event entry points are explicit.
export const ORB_EFFECTS_SCRIPT = String.raw`
function createEffects(st,valueEl,canvas){
  // Only LED uses the normative prototype's particle ramp; native styles use HeatPalette.Sample.
  const particleHeat=h=>st.style==='led'?prototypeHeatRgb(h):heatRgb(h);
  const parts=Array.from({length:512},()=>({x:0,y:0,vx:0,vy:0,life:0,age:99,size:0,heat:0,kind:'spark',drag:0,seed:0,streak:false,gravity:0}));
  const arcs=Array.from({length:8},()=>({a0:0,a1:0,r0:0,r1:0,life:0,age:99,regen:0,type:0,path:new Float32Array(20)}));
  const bolts=Array.from({length:16},()=>({x0:0,y0:0,x1:0,y1:0,len:0,nf:0,life:0,age:99,w:0,regen:0,main:new Float32Array(66),forks:[new Float32Array(34),new Float32Array(34)]}));
  const zaps=Array.from({length:16},()=>({x:0,y:0,r:0,age:99,life:0,power:0}));
  const scratchA=new Float32Array(66),scratchB=new Float32Array(66),lastZap=new Float64Array(24);lastZap.fill(-1);
  let arcT=0,sparkDebt=0,emberDebt=0,bubbleDebt=0,steamDebt=0;
  function spawn(x,y,vx,vy,life,size,h,kind,drag,streak=false,gravity=0){
    const cap=st.style==='needle'?(st.fx===3?80:48):st.style==='reactor'?(st.fx===3?64:40):st.S<120?192:512;let count=0;
    for(const p of parts)if(p.age<p.life)count++;
    if(count>=cap)return null;
    for(const p of parts)if(p.age>=p.life){p.x=x;p.y=y;p.vx=vx;p.vy=vy;p.life=life;p.age=0;p.size=size;p.heat=h;p.kind=kind;p.drag=drag;p.seed=Math.random()*100;p.streak=streak;p.gravity=gravity;return p;}
    return null;
  }
  function countKind(kind){let count=0;for(const p of parts)if(p.age<p.life&&p.kind===kind)count++;return count;}
  function spark(fromTip){
    const S=st.S,h=st.h,pos=fromTip?h:Math.random()*h,a=(135+pos*270)*Math.PI/180;
    const sp=(.3+Math.random()*.6)*S*(1+st.o*.8)*1.3,tg=(Math.random()-.35)*.6*S*1.3;
    spawn(Math.cos(a)*.41*S,Math.sin(a)*.41*S,Math.cos(a)*sp-Math.sin(a)*tg,Math.sin(a)*sp+Math.cos(a)*tg,.5+Math.random()*.7,1.2+Math.random()*1.6,Math.min(1,pos+.1),'spark',2.2,true);
  }
  function ember(){
    const S=st.S,a=(200+Math.random()*140)*Math.PI/180;
    spawn(Math.cos(a)*.47*S,Math.sin(a)*.47*S,(Math.random()-.5)*.1*S,-(.12+Math.random()*.2)*S,.9+Math.random()*1.1,1.2+Math.random()*1.8,.85+Math.random()*.15,'ember',.4);
  }
  function shapeArc(a){
    const steps=a.type===1?8:9,S=st.S;
    for(let i=0;i<=steps;i++){
      const k=i/steps,angle=lerp(a.a0,a.a1,k),r=lerp(a.r0,a.r1,k),j=i===0||i===steps?0:(Math.random()-.5)*S*(a.type===1?.096*Math.sin(Math.PI*k):.045);
      a.path[i*2]=Math.cos(angle)*r+(a.type===1?-Math.sin(angle)*j:j);a.path[i*2+1]=Math.sin(angle)*r+(a.type===1?Math.cos(angle)*j:j);
    }
    a.regen=.05;
  }
  function makeArc(reactor=false){
    const cap=reactor?(st.fx===3?4:3):8;let count=0;for(const a of arcs)if(a.age<a.life)count++;if(count>=cap)return;
    for(const a of arcs)if(a.age>=a.life){
      a.a0=(reactor?Math.random()*TAU:(135+Math.random()*st.h*270)*Math.PI/180);a.a1=a.a0+(Math.random()-.5)*(reactor?1.012:.9);
      const outer=reactor&&st.o>.3&&Math.random()<.4;
      a.r0=(reactor?(outer?.437:.306):.41)*st.S;a.r1=(reactor?(outer?.56+Math.random()*.10:.425):.5+Math.random()*.1)*st.S;
      a.age=0;a.life=reactor?.09+Math.random()*.09:.09+Math.random()*.1;a.type=reactor?1:0;shapeArc(a);
      if(reactor){for(let i=0;i<6;i++){const angle=Math.random()*TAU,sp=(.2+Math.random()*.4)*st.S;spawn(a.path[16],a.path[17],Math.cos(angle)*sp,Math.sin(angle)*sp,.15+Math.random()*.25,.6+Math.random()*.7,.92,'spark',3,true);}}
      return;
    }
  }
  function jag(x0,y0,x1,y1,rough,depth,out){
    let a=scratchA,b=scratchB,count=2,disp=Math.hypot(x1-x0,y1-y0)*rough;
    a[0]=x0;a[1]=y0;a[2]=x1;a[3]=y1;
    for(let d=0;d<depth;d++){
      b[0]=a[0];b[1]=a[1];let n=1;
      for(let i=1;i<count;i++){
        const ax=a[(i-1)*2],ay=a[(i-1)*2+1],bx=a[i*2],by=a[i*2+1],len=Math.hypot(bx-ax,by-ay)||1,off=(Math.random()-.5)*disp;
        b[n*2]=(ax+bx)/2-(by-ay)/len*off;b[n*2+1]=(ay+by)/2+(bx-ax)/len*off;n++;
        b[n*2]=bx;b[n*2+1]=by;n++;
      }
      count=n;const swap=a;a=b;b=swap;disp*=.55;
    }
    out.set(a.subarray(0,count*2));
  }
  function shapeBolt(b){
    jag(b.x0,b.y0,b.x1,b.y1,.3,5,b.main);
    for(let i=0;i<b.nf;i++){
      const k=3+Math.floor(Math.random()*25),sx=b.main[k*2],sy=b.main[k*2+1],a=Math.atan2(b.y1-b.y0,b.x1-b.x0)+(Math.random()-.5)*1.9,l=b.len*(.2+Math.random()*.3);
      jag(sx,sy,sx+Math.cos(a)*l,sy+Math.sin(a)*l,.35,4,b.forks[i]);
    }
  }
  function zap(text,prev){
    if(st.style!=='led'||!st.moving||st.fx<2||st.embedded||st.value<.5||!prev)return;
    const node=valueEl.firstChild;if(!node||node.nodeType!==Node.TEXT_NODE)return;
    const rect=canvas.getBoundingClientRect(),cx=rect.left+rect.width/2,cy=rect.top+rect.height/2,range=document.createRange(),boxes=[];
    for(let i=0;i<text.length;i++){range.setStart(node,i);range.setEnd(node,i+1);const r=range.getBoundingClientRect();boxes.push({x:r.left+r.width/2-cx,y:r.top+r.height/2-cy,w:r.width,h:r.height});}
    const same=text.length===prev.length;
    for(let i=0;i<text.length&&i<lastZap.length;i++){
      if(!/[0-9]/.test(text[i])||(same&&text[i]===prev[i])||st.time-lastZap[i]<.11)continue;
      const sig=text.slice(i+1).replace(/[^0-9]/g,'').length;
      if(Math.random()>Math.min(1,.3+.3*sig+.4*st.h))continue;
      lastZap[i]=st.time;const power=(.55+.22*sig)*(.6+.6*st.h+.6*st.o)*st.level,bx=boxes[i],gh=bx.h*.36,gw=bx.w*.42;
      for(const z of zaps)if(z.age>=z.life){z.x=bx.x;z.y=bx.y;z.r=bx.w*.9;z.age=0;z.life=.16+.06*power;z.power=power;break;}
      const n=1+(st.h>.55?1:0)+(st.tier>=4&&Math.random()<.6?1:0);
      let alive=0;for(const b of bolts)if(b.age<b.life)alive++;
      const cap=st.S<120?8:16;
      for(let k=0;k<n&&alive<cap;k++)for(const b of bolts)if(b.age>=b.life){
        const side=Math.random()<.5?-1:1;
        b.x0=bx.x+(Math.random()-.5)*gw*1.4;b.y0=bx.y+side*gh;
        const ni=i+(Math.random()<.5?-1:1),nb=boxes[ni],roll=Math.random();
        if(st.tier>=4&&roll<.3){const a=Math.atan2(b.y0,b.x0+(Math.random()-.5)*st.S*.3);b.x1=Math.cos(a)*.39*st.S;b.y1=Math.sin(a)*.39*st.S;}
        else if(nb&&/[0-9]/.test(text[ni])&&roll<.6){b.x1=nb.x+(Math.random()-.5)*gw;b.y1=nb.y+side*gh*(.6+Math.random()*.5);}
        else{const a=side*Math.PI/2+(Math.random()-.5)*1.7,l=st.S*(.05+.07*power);b.x1=b.x0+Math.cos(a)*l;b.y1=b.y0+Math.sin(a)*l;}
        alive++;
        b.len=Math.hypot(b.x1-b.x0,b.y1-b.y0);b.nf=power>.9?2:1;b.age=0;b.life=.14+.1*Math.random()+.05*power;b.w=st.S*.0032*(.7+.5*power);b.regen=.045;shapeBolt(b);break;
      }
    }
  }
  function liquidY(x){
    const S=st.S,A=st.moving&&st.tier>0?(.004+.02*st.h+.018*st.o)*(st.fx===1?.6:1)*S:0;
    let y=(.455-.91*clamp(st.liquid.value+st.liquidSurge.value,.04,.95))*S+A*(.55*Math.sin(TAU*x/(.9*S)+st.liquidPhases[0])+.3*Math.sin(TAU*x/(.47*S)-st.liquidPhases[1])+.15*Math.sin(TAU*x/(.23*S)+st.liquidPhases[2]));
    if(st.moving&&st.fx>=2&&st.tier>=4)y+=.006*(.5+.5*st.o)*(S<120?.5:1)*S*Math.sin(TAU*x/(.11*S)+st.liquidPhases[3])*(.7+.3*Math.sin(x/(.05*S)+1.7*st.liquidPhases[3]));
    for(const r of st.ripples)if(r.age<2.2){const d=Math.abs(x/S-r.x)-.42*r.age;y-=r.amplitude*S*Math.exp(-r.age/.75)*Math.exp(-Math.pow(d/.075,2))*Math.cos(TAU*d/.1);}
    return y;
  }
  function ripple(x,strength){
    let slot=st.ripples[0];for(const r of st.ripples){if(r.age>=2.2){slot=r;break;}if(r.age>slot.age)slot=r;}
    slot.age=0;slot.x=x/st.S;slot.amplitude=.022*(.6+.6*strength);
  }
  function bubble(x=null,y=null,gold=false){
    const cap=st.fx===1?6:st.S<120?16:st.fx===3?48:32;if(countKind('bubble')>=cap)return;
    const S=st.S,r=Math.max(.9,(.006+.01*st.h)*S*(.6+Math.random()*.8));
    const p=spawn(x===null?(Math.random()-.5)*.546*S:x,y===null?.43*S:y,0,-(.08+.35*st.h+.25*st.o)*S*(.7+Math.random()*.6),5,r,gold?1:st.h,'bubble',0);
    if(p)p.seed=gold?-1:Math.random()*100;
  }
  function splash(x,y,n){
    for(let i=0;i<n&&countKind('splash')<40;i++)spawn(x,y,(Math.random()-.5)*.5*st.S,-(.35+Math.random()*.35)*st.S,1,(.006+Math.random()*.005)*st.S,st.h,'splash',0,false,2.2*st.S);
  }
  function response(){
    if(st.style==='liquid'&&countKind('droplet')<3){const x=(Math.random()-.5)*.4*st.S,y=Math.min(-.3*st.S,Math.max(-.414*st.S,liquidY(x)-.16*st.S));spawn(x,y,0,0,2,.018*st.S,st.h,'droplet',0,false,2.6*st.S);}
  }
  function peak(){
    if(st.style==='minimal')return;
    if(st.style==='liquid'){
      st.liquidSurge.velocity+=.9;
      if(st.fx>=2)for(let i=0;i<22;i++)bubble((Math.random()-.5)*.5*st.S,.40*st.S,true);
      return;
    }
    if(st.fx<2||st.embedded)return;
    const S=st.S,n=Math.round(220*(S<120?.5:1));
    for(let i=0;i<n;i++){
      const a=Math.random()*TAU,sp=(.5+Math.random()*1.3)*S;
      spawn(Math.cos(a)*.48*S,Math.sin(a)*.48*S,Math.cos(a)*sp,Math.sin(a)*sp,.7+Math.random()*.9,1.4+Math.random()*2.2,.9+Math.random()*.1,Math.random()<.3?'gold':'spark',2.4,true);
    }
  }
  function clear(){
    for(const p of parts)p.age=99;for(const a of arcs)a.age=99;for(const b of bolts)b.age=99;for(const z of zaps)z.age=99;
    for(const r of st.ripples)r.age=99;sparkDebt=emberDebt=bubbleDebt=steamDebt=0;
  }
  function tick(dt){
    if(!st.moving)return;
    const S=st.S,h=st.h,o=st.o,lvl=st.level,lod=S<120?.5:1;
    if(st.style==='led'&&st.fx>=2&&!st.embedded){
      sparkDebt+=dt*(h>=.45?120*(h-.45)/.55*lvl*1.6*lod:0);while(sparkDebt>=1){spark(Math.random()<.6);sparkDebt--;}
      emberDebt+=dt*(st.tier>=4?90*Math.max(o,.3)*lvl*1.4*lod:0);while(emberDebt>=1){ember();emberDebt--;}
    }else if(st.style==='needle'&&st.fx>=2&&st.needle.value>=1.0105&&st.o>0){
      sparkDebt+=dt*(25+70*o)*lvl;
      while(sparkDebt>=1){const a=(135+270*1.024)*Math.PI/180,sp=(.35+Math.random()*.55)*S,angle=a+Math.PI/2+(Math.random()-.5)*Math.PI/3;spawn(Math.cos(a)*.405*S,Math.sin(a)*.405*S,Math.cos(angle)*sp+Math.cos(a)*.2*S,Math.sin(angle)*sp+Math.sin(a)*.2*S,.22+Math.random()*.33,.8+Math.random()*.8,.95,'spark',2,true,1.1*S);sparkDebt--;}
    }
    if((st.style==='led'||st.style==='reactor')&&st.fx>=2&&st.tier>=4&&!st.embedded){
      arcT-=dt;if(arcT<=0){makeArc(st.style==='reactor');arcT=st.style==='reactor'?1/((1.5+6*o)*lvl):(.28-.2*o)/lvl*(.5+Math.random());}
    }
    if(st.style==='liquid'&&st.value>=.5){
      let rate=st.fx===1?.6+3*h:1.5+12*h+(st.tier>=4?6+10*o:0);if(st.fx===3)rate*=1.6;
      bubbleDebt+=dt*rate;while(bubbleDebt>=1){bubble();bubbleDebt--;}
      if(st.fx>=2&&st.tier>=4&&S>=120){steamDebt+=dt*(2+4*o)*lvl;while(steamDebt>=1){if(countKind('steam')<12){const x=(Math.random()-.5)*.6*S;spawn(x,liquidY(x),0,-(.06+Math.random()*.06)*S,.8+Math.random()*.6,(.03+Math.random()*.03)*S,1,'steam',0);}steamDebt--;}}
    }
    for(const p of parts)if(p.age<p.life){
      p.age+=dt;
      if(p.kind==='ember'){p.vx+=Math.sin(st.time*3+p.seed)*.3*S*dt;p.vy-=.12*S*dt;}
      if(p.kind==='bubble')p.vy-=(.12+.2*h)*S*dt;
      p.vy+=p.gravity*dt;const drag=Math.exp(-p.drag*dt);p.vx*=drag;p.vy*=drag;p.x+=p.vx*dt;p.y+=p.vy*dt;
      if(p.kind==='bubble'&&p.y<=liquidY(p.x)){
        p.age=p.life;spawn(p.x,liquidY(p.x),0,0,.25,p.size,h,'pop',0);
        if(st.fx>=2&&st.tier>=4&&Math.random()<.55)splash(p.x,liquidY(p.x),1+Math.round(Math.random()));
      }else if((p.kind==='droplet'||p.kind==='splash')&&p.vy>0&&p.y>=liquidY(p.x)){
        if(p.kind==='droplet'){ripple(p.x,1);if(st.fx>=2)splash(p.x,liquidY(p.x),3+Math.round(Math.random()*3));for(let i=0;i<(st.fx===1?2:6);i++)bubble(p.x+(Math.random()-.5)*.08*S,liquidY(p.x)+.08*S);}
        p.age=p.life;
      }
    }
    for(const a of arcs)if(a.age<a.life){a.age+=dt;a.regen-=dt;if(a.regen<=0)shapeArc(a);}
    for(const b of bolts)if(b.age<b.life){b.age+=dt;b.regen-=dt;if(b.regen<=0){shapeBolt(b);b.regen=.045;}}
    for(const z of zaps)if(z.age<z.life)z.age+=dt;
    for(const r of st.ripples)r.age+=dt;
  }
  function poly(ctx,path,count,width,c,alpha){
    ctx.strokeStyle=rgba(c,alpha);ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(path[0],path[1]);for(let i=1;i<count;i++)ctx.lineTo(path[i*2],path[i*2+1]);ctx.stroke();
  }
  function draw(ctx,foreground=false){
    const S=st.S,dark=st.dark,h=st.h;ctx.save();ctx.globalCompositeOperation=dark?'lighter':'source-over';ctx.lineJoin=ctx.lineCap='round';
    if(!foreground){
    if(st.peakAge<1.3&&st.style!=='minimal'){
      const k=st.peakAge/1.3,rot=st.peakAge*.4;
      for(let i=0;i<24;i++){
        const a=rot+i/24*TAU,r0=.5*S,r1=(.55+.19*ease(k*1.4))*S,g=ctx.createLinearGradient(Math.cos(a)*r0,Math.sin(a)*r0,Math.cos(a)*r1,Math.sin(a)*r1);
        g.addColorStop(0,'rgba(255,217,89,0)');g.addColorStop(.3,'rgba(255,204,77,'+(.75*(1-k))+')');g.addColorStop(1,'rgba(255,179,51,0)');line(ctx,Math.cos(a)*r0,Math.sin(a)*r0,Math.cos(a)*r1,Math.sin(a)*r1,.014*S*(1-k*.5),g);
      }
    }
    const liquid=st.style==='liquid';
    if(liquid){ctx.beginPath();ctx.arc(0,0,.455*S,0,TAU);ctx.clip();}
    for(const p of parts)if(p.age<p.life){
      const life=1-p.age/p.life;
      let c=p.kind==='gold'||p.seed===-1?GOLD:dark?mix(particleHeat(p.heat),HOT,Math.min(1,(1-life)*.3+.4)):p.heat>.92?AMBER:darken(particleHeat(p.heat),.1);
      let alpha=Math.min(1,life*1.4)*(p.kind==='ember'?.8:1);
      const readout=Math.hypot(p.x/(.30*S),(p.y-.07*S)/(.19*S));if(!st.embedded)alpha*=1-.65*Math.exp(-readout*readout*2);
      if(p.kind==='bubble'){
        const gold=p.seed===-1,x=p.x+.006*S*Math.sin(TAU*2.3*p.age+p.seed),hot=gold?1:smooth(.35,.9,h);
        if(hot>.01)radial(ctx,x,p.y,p.size*2,gold?heatRgb(1):labMix(heatRgb(h),HOT,.9),(dark?.95:.90)*hot*alpha);
        if(hot<.99){ctx.strokeStyle=rgba([1,1,1],(dark?.5:.85)*(1-hot)*alpha);ctx.lineWidth=.28*p.size;ctx.beginPath();ctx.arc(x,p.y,p.size,0,TAU);ctx.stroke();dot(ctx,x-.3*p.size,p.y-.35*p.size,.2*p.size,rgba([1,1,1],.85*(1-hot)*alpha));}
      }else if(p.kind==='pop'){ctx.lineWidth=Math.max(.5,p.size*.2);ctx.strokeStyle=rgba(c,life*.6);ctx.beginPath();ctx.arc(p.x,p.y,p.size*(1+1.5*(1-life)),0,TAU);ctx.stroke();}
      else if(p.kind==='steam')radial(ctx,p.x,p.y,p.size*(2-life),dark?HOT:[1,1,1],(dark?.12:.18)*Math.sin(Math.PI*life));
      else if(p.kind==='droplet'||p.kind==='splash')dot(ctx,p.x,p.y,p.size,rgba(dark?mix(c,HOT,.6):labelRgb(h,false),alpha));
      else if(p.streak){
        const v=Math.hypot(p.vx,p.vy),fadeV=Math.min(1,v/(.12*S)),length=Math.max(.02,Math.min(.06,.06*fadeV)),a=alpha*(.25+.75*fadeV),tx=p.x-p.vx*length,ty=p.y-p.vy*length,g=ctx.createLinearGradient(tx,ty,p.x,p.y);
        g.addColorStop(0,rgba(c,0));g.addColorStop(1,rgba(c,a));line(ctx,tx,ty,p.x,p.y,p.size*(dark?.75:1),g);if(dark)dot(ctx,p.x,p.y,p.size*.55,rgba(mix(c,[1,1,1],.6),a));
      }else{const r=p.size*(dark?.8:1)*(p.kind==='ember'?.55+.45*Math.sin(p.age*18+p.seed):1);radial(ctx,p.x,p.y,r*2.2,c,alpha);}
    }
    const arcColor=dark?mix(particleHeat(h),[.75,.85,1],.5):darken(particleHeat(h),.15);
    for(const a of arcs)if(a.age<a.life){if(a.type===0)shapeArc(a);const fade=1-a.age/a.life,count=a.type===1?9:10;poly(ctx,a.path,count,S*(a.type===1?.03:.022),arcColor,(a.type===1?.28:.18)*fade);poly(ctx,a.path,count,S*(a.type===1?.011:.008),arcColor,(a.type===1?.75:.5)*fade);poly(ctx,a.path,count,S*(a.type===1?.0045:.0032),dark?[1,1,1]:AMBER,.95*fade);}
    }
    if(foreground){
    const bh=particleHeat(Math.max(h,.3)),glow=dark?mix(bh,[.7,.82,1],.45):[.42,.5,1],core=dark?[1,1,1]:[.2,.24,.85];
    for(const z of zaps)if(z.age<z.life){const k=1-z.age/z.life;radial(ctx,z.x,z.y,z.r*1.6,glow,k*k*Math.min(.8,.35*z.power)*(dark?1:.5));}
    for(const b of bolts)if(b.age<b.life){
      const a=Math.min(1,(1-b.age/b.life)*1.6)*(Math.random()<.22?.4:1);
      for(let j=0;j<=b.nf;j++){
        const path=j===0?b.main:b.forks[j-1],w=b.w*(j===0?1:.6),alpha=a*(j===0?1:.8),count=j===0?33:17;
        poly(ctx,path,count,w*5,glow,.16*alpha);poly(ctx,path,count,w*2,glow,.45*alpha);poly(ctx,path,count,w*.8,core,.95*alpha*(dark?1:.9));
      }
    }
    }
    ctx.restore();
  }
  function busy(){for(const p of parts)if(p.age<p.life)return true;for(const a of arcs)if(a.age<a.life)return true;for(const b of bolts)if(b.age<b.life)return true;return false;}
  return {tick,draw,zap,response,peak,clear,busy,liquidY,ripple,bubble};
}
`;
