// Agent Speed v1.5.0 board fx.js / DESIGN 2c (MIT), fixed 29dffc4e6fbe1da435071e40781b1571dd45ac22.
// The original particle geometry and timings, with bounded reusable pools and an explicit visibility lifetime.
export const MONITOR_BOARD_EFFECTS_SCRIPT = String.raw`
const boardEffects = (() => {
  function create(panel, style) {
    const canvas = document.createElement('canvas'); canvas.className = 'board-fx'; canvas.setAttribute('aria-hidden', 'true'); panel.append(canvas);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Agent Speed boards require Canvas 2D');
    const particleCount = 256, particles = new Float64Array(particleCount * 10), particleColors = new Array(particleCount).fill('#FFFFFF');
    const waves = new Float64Array(4 * 7), waveColors = new Array(4).fill('#FACC15');
    const bolts = new Float64Array(6 * 29), boltColors = new Array(6).fill('#FFFFFF');
    const stars = new Float64Array(90 * 3), point = new Float64Array(2);
    const cometCounts = style === 'timing' ? [1,1,2,2,3] : style === 'neon' ? [1,2,3,4,4] : [1,1,2,3,4];
    for (let i = 0; i < 90; i++) { stars[i * 3] = Math.random() * Math.PI * 2; stars[i * 3 + 1] = Math.random() * 40; }
    const radius = style === 'glass' ? 26 : style === 'timing' ? 20 : 22;
    let width = 340, height = 340, diagonal = Math.hypot(340,340), dpr = 1, path = null, perimeter = 0, raf = 0, clock = 0, painted = 0, elapsed = 0;
    let heat = 0, overdrive = 0, active = false, visible = false, reduced = false, contrast = false, intensity = 2, maxFps = 60, disposed = false;
    let goldUntil = 0, burstUntil = 0, lastEmber = 0, nextParticle = 0, nextWave = 0, nextBolt = 0, inFrame = false;
    const tailDash = [0,0], bodyDash = [0,0], coreDash = [0,0], emptyDash = [], emberColors = ['#FFF7D6','#7C8798'];
    let color = '#7C8798', headColor = '#7C8798', tailColor = '#7C8798', starColors = new Array(16).fill('#7C8798');
    function resize() {
      const bounds = panel.getBoundingClientRect(); if (!bounds.width || !bounds.height) return;
      const nextDpr = Math.min(2, window.devicePixelRatio || 1);
      if(path && width === bounds.width && height === bounds.height && dpr === nextDpr)return;
      width = bounds.width; height = bounds.height; diagonal = Math.hypot(width,height); dpr = nextDpr;
      const cw = Math.round((width + 80) * dpr), ch = Math.round((height + 80) * dpr);
      if (canvas.width !== cw) canvas.width = cw; if (canvas.height !== ch) canvas.height = ch;
      path = new Path2D(); path.roundRect(40.8, 40.8, width - 1.6, height - 1.6, radius - .8);
      perimeter = 2 * (width + height - 4 * radius) + Math.PI * 2 * radius;
      tailDash[0] = perimeter * .15; tailDash[1] = perimeter * .85;
      bodyDash[0] = perimeter * .046; bodyDash[1] = perimeter * .954;
      coreDash[0] = perimeter * .016; coreDash[1] = perimeter * .984;
      if (visible) kick();
    }
    const observer = new ResizeObserver(resize); observer.observe(panel); resize();
    function perimeterPoint(t) {
      let distance = ((t % 1) + 1) % 1 * perimeter;
      const sw = width - 2 * radius, sh = height - 2 * radius, arc = Math.PI * radius / 2;
      for (let segment = 0; segment < 8; segment++) {
        const length = segment % 2 ? arc : segment === 0 || segment === 4 ? sw : sh;
        if (distance <= length) {
          let x, y;
          if (segment === 0) { x = radius + distance; y = 0; }
          else if (segment === 2) { x = width; y = radius + distance; }
          else if (segment === 4) { x = width - radius - distance; y = height; }
          else if (segment === 6) { x = 0; y = height - radius - distance; }
          else {
            const angle = (segment - 3) * Math.PI / 4 + distance / radius;
            x = (segment === 1 || segment === 3 ? width - radius : radius) + Math.cos(angle) * radius;
            y = (segment === 1 || segment === 7 ? radius : height - radius) + Math.sin(angle) * radius;
          }
          point[0] = x; point[1] = y; return;
        }
        distance -= length;
      }
      point[0] = radius; point[1] = 0;
    }
    function burst(x, y, count, velocity, life, colors, gravity = 90, angle = null, spread = Math.PI * 2) {
      if (!visible || reduced || contrast || intensity < 2) return;
      count = Math.round(count * (intensity === 3 ? 1.5 : 1));
      for (let i = 0; i < count; i++) {
        const slot = nextParticle++ % particleCount, at = slot * 10;
        const direction = (angle === null ? Math.random() * Math.PI * 2 : angle) + (Math.random() - .5) * spread, speed = velocity * (.35 + Math.random() * .75);
        particles[at] = x; particles[at+1] = y; particles[at+2] = Math.cos(direction) * speed; particles[at+3] = Math.sin(direction) * speed;
        particles[at+4] = 0; particles[at+5] = life * (.6 + Math.random() * .6); particles[at+6] = 1.8 * (.6 + Math.random() * .8);
        particles[at+7] = gravity; particles[at+8] = 1.6; particleColors[slot] = colors[i % colors.length];
      }
      burstUntil = Math.max(burstUntil, elapsed + life * 1.2); kick();
    }
    function wave(x, y, color, scale, life) {
      if (!visible || reduced || contrast || intensity < 2) return;
      const slot = nextWave++ % 4, at = slot * 7;
      waves[at] = x; waves[at+1] = y; waves[at+2] = 0; waves[at+3] = life; waves[at+4] = Math.hypot(width,height) * scale; waveColors[slot] = color;
      burstUntil = Math.max(burstUntil, elapsed + life); kick();
    }
    function lightning(x0,y0,x1,y1,color) {
      if (!visible || reduced || contrast || intensity < 2) return;
      const slot = nextBolt++ % 6, at = slot * 29, dx = x1-x0, dy = y1-y0, length = Math.hypot(dx,dy) || 1;
      bolts[at] = 0; bolts[at+1] = .32; boltColors[slot] = color;
      for (let i = 0; i <= 12; i++) {
        const t = i/12, jitter = i && i < 12 ? (Math.random()-.5)*length*.18*(1-Math.abs(t-.5)) : 0;
        bolts[at+2+i*2] = x0+dx*t-dy/length*jitter; bolts[at+3+i*2] = y0+dy*t+dx/length*jitter;
      }
      burstUntil = Math.max(burstUntil, elapsed+.32); kick();
    }
    function celebrate(x,y) {
      if (!visible || reduced || contrast || intensity < 2) return;
      wave(x,y,'#FACC15',1.1,1.1); wave(x,y,'#FFF7D6',.6,.7);
      burst(x,y,70,260,1.3,['#FACC15','#FFF1A8','#FB923C','#FFFFFF'],160);
      goldUntil = elapsed+2.2; kick();
    }
    function streak(x,y,right,source) {
      if (!visible || reduced || contrast || intensity < 2) return;
      for (let i = 0; i < 26; i++) {
        const slot = nextParticle++ % particleCount, at = slot*10;
        particles[at] = x+Math.random()*(right-x); particles[at+1] = y+(Math.random()-.5)*8;
        particles[at+2] = 220+Math.random()*260; particles[at+3] = (Math.random()-.5)*30;
        particles[at+4] = 0; particles[at+5] = .35+Math.random()*.35; particles[at+6] = 1+Math.random()*1.2;
        particles[at+7] = 0; particles[at+8] = 2.5; particleColors[slot] = i%3 ? source : '#FFFFFF';
      }
      burstUntil = Math.max(burstUntil,elapsed+.7); kick();
    }
    function clear() { context.setTransform(1,0,0,1,0,0); context.clearRect(0,0,canvas.width,canvas.height); }
    function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; clock = 0; painted = 0; }
    function kick() {
      if (!disposed && visible && !reduced && !contrast && intensity > 0 && !raf && !inFrame) { clock = performance.now(); raf = requestAnimationFrame(frame); }
    }
    function frame(now) {
      raf = 0; if (disposed || !visible || reduced || contrast || !intensity) return;
      const urgent = elapsed < burstUntil || elapsed < goldUntil, target = Math.min(maxFps, urgent || heat >= .56 ? 60 : 30);
      if (painted && now-painted < 1000/target-1) { raf = requestAnimationFrame(frame); return; }
      const dt = Math.max(0,Math.min(.05,(now-clock)/1000)); clock=now; painted=now; elapsed+=dt;
      inFrame=true;
      context.setTransform(dpr,0,0,dpr,0,0); context.clearRect(0,0,width+80,height+80); context.save(); context.translate(40,40);
      context.globalCompositeOperation='lighter'; context.lineCap='round';
      let alive=false;
      const gold=elapsed<goldUntil, ring=Math.max(0,(heat-.55)/.45);
      context.save(); context.translate(-40,-40);
      context.setLineDash(emptyDash); context.shadowBlur=0;
      if (path && ring>0) { context.strokeStyle=gold?'#FACC15':color; context.globalAlpha=.12+ring*.55+overdrive*.3; context.lineWidth=style==='neon'?1.4:1.6; context.stroke(path); }
      const tier=heat<.05?0:heat<.32?1:heat<.56?2:heat<.78?3:4, count=Math.min(cometCounts[tier],intensity===1?1:4);
      if (path) for(let i=0;i<count;i++) {
        const phase=elapsed/((7-5.4*heat)/(gold?1.8:1))+i/count;
        context.lineDashOffset=-phase*perimeter;
        context.strokeStyle=gold?'#FACC15':tailColor; context.globalAlpha=(tier===0?.35:1)*.35; context.lineWidth=2; context.setLineDash(tailDash); context.stroke(path);
        context.strokeStyle=gold?'#FFE58A':headColor; context.globalAlpha=.35; context.lineWidth=5; context.lineDashOffset-=perimeter*.104; context.setLineDash(bodyDash); context.stroke(path);
        context.strokeStyle=gold||heat>.85?'#FFF7D6':headColor; context.globalAlpha=tier===0?.35:1; context.lineWidth=1.8; context.lineDashOffset-=perimeter*.03; context.setLineDash(coreDash); context.stroke(path);
        if (active && heat>.78 && elapsed-lastEmber>=.12 && intensity>=2) {
          perimeterPoint(phase+.016); const angle=Math.atan2(point[1]-height/2,point[0]-width/2);
          burst(point[0],point[1],3,70,.6,emberColors,40,angle,.9);
        }
      }
      if(elapsed-lastEmber>=.12)lastEmber=elapsed;
      context.restore(); context.setLineDash(emptyDash); context.shadowBlur=0;
      for(let slot=0;slot<particleCount;slot++) {
        const at=slot*10; if(particles[at+5]<=0)continue;
        const age=particles[at+4]+=dt, life=particles[at+5]; if(age>=life){particles[at+5]=0;continue;}
        alive=true; const vx=particles[at+2]*=1-particles[at+8]*dt; particles[at+3]=particles[at+3]*(1-particles[at+8]*dt)+particles[at+7]*dt;
        const vy=particles[at+3], x=particles[at]+=vx*dt,y=particles[at+1]+=vy*dt;
        context.globalAlpha=1-age/life; context.strokeStyle=particleColors[slot]; context.lineWidth=particles[at+6];
        context.beginPath(); context.moveTo(x-vx*dt*2.5,y-vy*dt*2.5); context.lineTo(x,y); context.stroke();
      }
      for(let slot=0;slot<4;slot++) {
        const at=slot*7;if(waves[at+3]<=0)continue; const age=waves[at+2]+=dt,life=waves[at+3];if(age>=life){waves[at+3]=0;continue;}
        alive=true;const t=age/life,e=1-Math.pow(1-t,3); context.globalAlpha=(1-t)*.85;context.strokeStyle=waveColors[slot];context.lineWidth=2.5*(1-t)+.5;
        context.beginPath();context.arc(waves[at],waves[at+1],4+(waves[at+4]-4)*e,0,Math.PI*2);context.stroke();
      }
      for(let slot=0;slot<6;slot++) {
        const at=slot*29;if(bolts[at+1]<=0)continue;const age=bolts[at]+=dt,life=bolts[at+1];if(age>=life){bolts[at+1]=0;continue;}
        alive=true; const flicker=(1-age/life)*(.65+.35*Math.sin(age*90));
        for(let layer=0;layer<3;layer++) {context.globalAlpha=flicker*(layer===0?.25:layer===1?.8:1);context.strokeStyle=layer===2?'#FFFFFF':boltColors[slot];context.lineWidth=layer===0?6:layer===1?2.2:1;context.lineJoin='round';context.beginPath();
          for(let i=0;i<=12;i++)if(i)context.lineTo(bolts[at+2+i*2],bolts[at+3+i*2]);else context.moveTo(bolts[at+2],bolts[at+3]);context.stroke();}
      }
      // Neon hyperspace is clipped to the rounded deck, beneath translucent cached DOM content.
      if(style==='neon'&&active&&heat>.2&&intensity>=2) {
        alive=true;context.save();context.beginPath();context.roundRect(0,0,width,height,radius);context.clip();
        const count=Math.min(90,Math.round((20+heat*70)*(intensity===3?1.5:1))),cx=width*.72,cy=height*.28,velocity=60+heat*520+overdrive*400;
        for(let i=0;i<count;i++){const at=i*3;let angle=stars[at],distance=stars[at+1]+=velocity*dt*(.4+stars[at+1]/140);if(distance>diagonal){distance=stars[at+1]=Math.random()*20;angle=stars[at]=Math.random()*Math.PI*2;}
          const cosine=Math.cos(angle),sine=Math.sin(angle),x=cx+cosine*distance,y=cy+sine*distance,tail=Math.min(60,6+distance*.18*(.3+heat));context.globalAlpha=Math.min(1,distance/120)*(.25+heat*.55)*.45;context.strokeStyle=starColors[i%16];context.lineWidth=.8+heat*.8;
          context.beginPath();context.moveTo(x-cosine*tail,y-sine*tail);context.lineTo(x,y);context.stroke();}
        context.restore();
      }
      context.restore();context.globalAlpha=1;
      inFrame=false;if(active||alive||gold)raf=requestAnimationFrame(frame);
    }
    return {
      update(frame) {
        const changed=heat!==frame.heat||overdrive!==frame.overdrive||active!==frame.active||reduced!==frame.reduced||contrast!==frame.contrast||intensity!==frame.intensity||color!==frame.color;
        heat=frame.heat;overdrive=frame.overdrive;active=frame.active;reduced=frame.reduced;contrast=frame.contrast;intensity=frame.intensity;maxFps=Math.max(1,frame.maxFps||60);
        color=frame.color;headColor=frame.headColor;tailColor=frame.tailColor;starColors=frame.starColors;emberColors[1]=color;
        panel.style.setProperty('--bloom',String(.15+heat*.6+overdrive*.4));
        if(!visible||reduced||contrast||!intensity){stop();clear();}else if(active||changed||elapsed<burstUntil||elapsed<goldUntil)kick();
      },
      setVisible(value) { if(visible===value)return;visible=value;if(!value){stop();particles.fill(0);waves.fill(0);bolts.fill(0);goldUntil=0;burstUntil=0;clear();}else{resize();kick();} },
      burst, wave, lightning, celebrate, streak,
      destroy() { disposed=true;visible=false;stop();observer.disconnect();canvas.remove();canvas.width=canvas.height=0; }
    };
  }
  return { create };
})();
`;
