// Adapted from zoefix/agent-speed v1.4.1, MIT, a94a67fcc78e5d8eea5f82d8d5e737bccf994e2c.
// Sources: Windows Orb/Gpu/Shaders/OrbLiquid.hlsl (volume, currents, meniscus),
// Presentation/Orb/Styles/LiquidModel.cs, LiquidColors.cs and spec/DESIGN.md §2a.3.
// Coordinates are normalized S, y down; HLSL pass 0+1 are composed in one WebGL2 pass.
export const ORB_LIQUID_FRAGMENT_SHADER = String.raw`#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uRes;
uniform float uS,uLogicalS,uThumbnail,uH,uO,uDark,uFx,uMoving,uReduced,uTime,uPeak,uLevel,uSurface,uTier;
uniform vec4 uPhases,uRipples[4],uWaves[4],uWaveColors[4],uLiquidColors[9];
uniform vec2 uMeniscus;
uniform vec3 uLiquidInk;
uniform sampler2D uReadout,uReadoutOld,uDecorative,uTaskReadout;
uniform float uReadoutOn,uTaskReadoutOn,uTaskReadoutContrast;
uniform vec4 uReadoutRoll,uReadoutValue,uReadoutUnit,uReadoutTitle,uReadoutBelowTitle;
const float TAU=6.283185307179586;
const vec3 HOT=vec3(1.,.96862745,.83921569);
vec4 acc;
void over(vec3 rgb,float a){a=clamp(a,0.,1.);acc.rgb=rgb*a+acc.rgb*(1.-a);acc.a=a+acc.a*(1.-a);}
void light(vec3 rgb,float a){
  a=clamp(a,0.,1.);
  if(uDark>.5){acc.rgb+=rgb*a;acc.a=a+acc.a*(1.-a);}else over(rgb,a);
}
float ease(float t){return 1.-pow(1.-clamp(t,0.,1.),3.);}
float waveY(float x,bool back){
  float offset=back?1.7:0.;
  float amp=uMoving>.5&&uFx>.5?(.004+.02*uH+.018*uO)*(uFx<1.5?.6:1.):0.;
  if(uTier<.5)amp=0.;
  if(back)amp*=.75;
  float y=.455-.91*uSurface-(back?.008:0.);
  y+=amp*(.55*sin(x/.9*TAU+uPhases.x+offset)+.30*sin(x/.47*TAU-uPhases.y+offset*1.3)+.15*sin(x/.23*TAU+uPhases.z+offset*.7));
  float chop=uTier>3.5&&uMoving>.5&&uFx>=2.?.006*(.5+.5*uO)*(uLogicalS<120.?.5:1.):0.;
  y+=chop*sin(x/.11*TAU+uPhases.w+offset)*(.7+.3*sin(x/.05+uPhases.w*1.7));
  for(int i=0;i<4;i++){
    vec4 ripple=uRipples[i];
    if(ripple.w>.5){float q=abs(x-ripple.x)-ripple.y;float k=q/.075;y-=ripple.z*exp(-k*k)*cos(TAU*q/.1)*(back?.6:1.);}
  }
  return y;
}
void main(){
  vec2 p=(vec2(gl_FragCoord.x,uRes.y-gl_FragCoord.y)-uRes*.5)/uS;
  float r=length(p),aa=1./uS;
  if(r>=.74){outColor=vec4(0.);return;}
  bool dark=uDark>.5;vec3 h=uLiquidColors[0].rgb,L=uLiquidColors[1].rgb;
  vec3 ink=uLiquidInk;
  acc=vec4(0.);
  float shadow=smoothstep(.62,.46,length(p-vec2(0.,dark?.03:.04)))*(dark?.45:.16)*smoothstep(.49,.52,r);
  over(vec3(0.),shadow);
  float breathe=1.+uMoving*.15*sin(uTime*mix(1.57,9.,uH));
  float aura=smoothstep(.74,.5,r)*smoothstep(.46,.52,r)*(dark?.55:.32)*uH*breathe;
  light(dark?h:ink,aura);
  float disc=smoothstep(.5+aa,.5-aa,r);
  vec3 top=dark?vec3(24.,29.,43.)/255.:vec3(1.);
  vec3 bottom=dark?vec3(7.,9.,13.)/255.:vec3(228.,232.,240.)/255.;
  over(mix(top,bottom,clamp(p.y+.5,0.,1.)),disc*(dark?.88:.94));
  float volume=clamp((length(p+vec2(.12,.16))-.375)/.125,0.,1.);
  over(dark?vec3(0.):vec3(30.,40.,60.)/255.,volume*(dark?.42:.12)*disc);
  float glass=smoothstep(.455+aa,.455-aa,r);
  if(glass>0.){
    vec4 outer=acc;acc=vec4(0.);
    float yLevel=.455-.91*uSurface,frontY=waveY(p.x,false);
    float spill=(p.y-(yLevel-.22))/.22;
    if(uThumbnail<.5&&spill>=0.&&spill<=1.)light(L,(dark?.16:.10)*(.4+.6*uH)*spill*step(.5,uTier));
    float alpha=uLiquidColors[1].a;
    if(uLogicalS>=120.)over(uLiquidColors[3].rgb,uLiquidColors[3].a*smoothstep(-aa,aa,p.y-waveY(p.x,true)));
    float cover=smoothstep(-aa,aa,p.y-frontY);
    if(cover>0.){
      float t=clamp((p.y-(min(yLevel,.2)-.04))/(.455-(min(yLevel,.2)-.04)),0.,1.);
      over(mix(L,uLiquidColors[2].rgb,t),mix(alpha,uLiquidColors[2].a,t)*cover);
      float shade=clamp((length(p+vec2(.06,.08))-.35*.455)/(.455-.35*.455),0.,1.);
      over(dark?vec3(0.):vec3(40.,48.,66.)/255.,(dark?.50:.14)*shade*cover);
      vec2 gc=vec2(0.,max(yLevel+.08,.38));
      float inner=max(0.,1.-length(p-gc)/.32);
      light(uLiquidColors[4].rgb,uLiquidColors[4].a*inner*cover);
    }
    if(dark){
      float k=length((p-vec2(0.,.1))/vec2(.36,.26));
      if(k<1.)over(vec3(0.),k<.55?mix(.35,.30,k/.55):mix(.30,0.,(k-.55)/.45));
    }
    if(uLogicalS>=120.&&uMoving>.5&&uFx>.5&&cover>0.){
      float ux=(p.x+.455)/.91;
      for(int k=0;k<3;k++){
        float fk=float(k),depth=.25+.25*fk,phase=uPhases.x*(.35+.2*fk)+2.1*fk;
        float y=yLevel+(.455-yLevel)*depth+.03*sin(ux*7.+phase)+.015*sin(ux*13.-phase*1.7);
        float slope=(.03*7.*cos(ux*7.+phase)+.015*13.*cos(ux*13.-phase*1.7))/.91;
        float d=abs(p.y-y)/sqrt(1.+slope*slope),halfWidth=(.018-.004*fk)*.5;
        float profile=1.-smoothstep(max(halfWidth-1.5*.006,0.),halfWidth+1.5*.006,d);
        light(uLiquidColors[5].rgb,uLiquidColors[5].a*(1.-.25*fk)*profile*cover);
      }
    }
    if(uPeak<.9&&uMoving>.5){
      float center=mix(.455,yLevel,ease(uPeak/.9)),d=abs(p.y-center)/.06;
      if(d<1.)light(vec3(250.,204.,21.)/255.,.45*(1.-uPeak/.9)*(1.-d)*cover);
    }else if(uReduced>.5&&uPeak<.3){
      float center=(yLevel+.455)*.5,d=abs(p.y-center)/.06;
      if(d<1.)light(vec3(250.,204.,21.)/255.,.45*sin(3.14159265359*uPeak/.3)*(1.-d)*cover);
    }
    float slope=(waveY(p.x+aa*.5,false)-waveY(p.x-aa*.5,false))/aa;
    float d=abs(p.y-frontY)/sqrt(1.+slope*slope),halfWidth=uMeniscus.x*.5;
    vec3 meniscus=uLiquidColors[6].rgb;
    if(uThumbnail<.5){float q=max(d-halfWidth,0.)/uMeniscus.y;light(uLiquidColors[7].rgb,uLiquidColors[7].a*exp(-.5*q*q));}
    over(meniscus,uLiquidColors[6].a*smoothstep(halfWidth+aa,halfWidth-aa,d));
    acc.rgb*=glass;acc.a*=glass;
    acc.rgb+=outer.rgb*(1.-acc.a);acc.a+=outer.a*(1.-acc.a);
  }
  float wall=1.-smoothstep(.0015,.0035,abs(r-.455));over(dark?vec3(1.):vec3(0.),wall*(dark?.09:.06));
  float angle=atan(p.y,p.x);
  if(uThumbnail<.5&&angle>.95993&&angle<2.18166){float q=(r-.475)/.008;light(uLiquidColors[8].rgb,exp(-.5*q*q)*uLiquidColors[8].a);}
  vec2 spec=p+vec2(.17,.22);float c=cos(-.593412),s=sin(-.593412);vec2 q=mat2(c,-s,s,c)*spec;
  over(vec3(1.),max(0.,1.-length(q/vec2(.10,.06)))*(dark?.13:.75));
  float deg=degrees(angle);if(deg<0.)deg+=360.;
  if(deg>200.&&deg<236.)over(vec3(1.),(1.-smoothstep(.003,.007,abs(r-.42)))*(dark?.22:.95));
  float rim=smoothstep(.5,.49,r)*smoothstep(.473,.495,r)*clamp(.5-p.y*1.4,0.,1.);
  over(vec3(1.),rim*(dark?.14:.95));
  for(int i=0;i<4;i++){
    vec4 w=uWaves[i];if(w.x<0.||w.x>1.||uMoving<.5)continue;
    float rr=.5+.24*ease(w.x),wid=(.005+.005*w.y)*(1.-w.x)+.001;
    light(uWaveColors[i].rgb,exp(-pow((r-rr)/wid,2.))*(1.-w.x)*.7*w.y);
  }
  if(uPeak<1.4&&uMoving>.5){
    light(dark?HOT:vec3(1.,.69,.13),exp(-uPeak*4.5)*(dark?.75:.35)*smoothstep(.6,.15,r));
    float rr=.5+.24*ease(uPeak/1.4);light(vec3(1.,.78,.3),exp(-pow((r-rr)/(.012+.02*uPeak),2.))*(1.-uPeak/1.4));
  }
  vec4 decorative=texture(uDecorative,p/1.5+vec2(.5));over(decorative.rgb,decorative.a);
  // The same analytical waveY used by the volume clips every glyph pixel into complementary palettes (OrbGpuOrb.Labels).
  if(uReadoutOn>.5&&abs(p.x)<.5&&abs(p.y)<.5){
    vec2 uv=p+vec2(.5);vec4 masks=texture(uReadout,uv);
    float fresh=texture(uReadout,uv-vec2(0.,uReadoutRoll.x)).r*uReadoutRoll.z;
    float old=texture(uReadoutOld,uv-vec2(0.,uReadoutRoll.y)).r*uReadoutRoll.w;
    float valueMask=max(fresh,old),below=step(waveY(p.x,false),p.y);
    if(dark&&below>.5)over(vec3(0.),masks.a*.55);
    vec4 valueColor=below>.5?(dark?vec4(1.,1.,1.,.97):vec4(11./255.,13./255.,18./255.,.94)):uReadoutValue;
    vec4 unitColor=below>.5?(dark?vec4(1.,1.,1.,.80):vec4(11./255.,13./255.,18./255.,.72)):uReadoutUnit;
    vec4 titleColor=below>.5?uReadoutBelowTitle:uReadoutTitle;
    over(valueColor.rgb,valueColor.a*valueMask);over(unitColor.rgb,unitColor.a*masks.g);over(titleColor.rgb,titleColor.a*masks.b);
  }
  // Task score/thinking use the identical surface split, with no output roll, heat color or glow.
  if(uTaskReadoutOn>.5&&abs(p.x)<.5&&abs(p.y)<.5){
    vec4 masks=texture(uTaskReadout,p+vec2(.5));float below=step(waveY(p.x,false),p.y);
    if(dark&&below>.5)over(vec3(0.),masks.a*.55);
    vec3 ink=vec3(11./255.,13./255.,18./255.);
    vec3 number=dark?vec3(1.):ink,secondary=dark?vec3(1.):below>.5?ink:vec3(0.);
    float numberAlpha=below>.5?(dark?.94:.88):(dark?.78:.76),secondaryAlpha=below>.5?(dark?.72:.62):.50;
    if(uTaskReadoutContrast>.5){numberAlpha=max(numberAlpha,.92);secondaryAlpha=max(secondaryAlpha,.70);}
    over(number,numberAlpha*masks.r);over(secondary,secondaryAlpha*masks.g);
  }
  acc*=smoothstep(.74,.73,r);
  outColor=acc.a<.0005?vec4(0.):acc;
}`;
