// Adapted from zoefix/agent-speed v1.6.1 Windows, MIT, 384ce020cc655133e95aaad5cc085f3985f0ed99.
// Sources: Windows Orb/Gpu/Shaders/OrbLiquid.hlsl (volume, currents, meniscus),
// Presentation/Orb/Styles/LiquidModel.cs, LiquidColors.cs and spec/DESIGN.md §2a.3.
// Coordinates are normalized S, y down; HLSL pass 0+1 are composed in one WebGL2 pass.
export const ORB_LIQUID_FRAGMENT_SHADER = String.raw`#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uRes;
uniform float uS,uLogicalS,uThumbnail,uH,uO,uDark,uFx,uMoving,uReduced,uTime,uPeak,uLevel,uSurface,uTier;
uniform vec4 uPhases,uRipples[4],uLiquidColors[9];
uniform vec2 uMeniscus;
uniform vec3 uLiquidInk;
uniform vec3 uAuraColor;uniform float uAuraIntensity,uActivity;
uniform sampler2D uReadout,uReadoutOld,uDecorative,uPerfReadout;
uniform float uReadoutOn,uPerfReadoutOn,uPerfReadoutContrast;
uniform vec4 uReadoutRoll,uReadoutValue,uReadoutUnit,uReadoutTitle,uReadoutBelowTitle;
uniform vec4 uReadoutCells[24];
uniform float uReadoutCellCount,uReadoutPreviousShift;
uniform vec2 uReadoutBand,uReadoutPrefix;
uniform vec4 uReadoutLabelRoll,uReadoutOldTitle,uReadoutOldBelowTitle;
uniform float uReadoutLabelMoving,uReadoutLabelClipped,uReadoutPreviousLabelShift;
uniform vec2 uReadoutLabelBand;
const float TAU=6.283185307179586;
const vec3 HOT=vec3(1.,.96862745,.83921569);
// Preserve the native HLSL ramp, including decreasing edges undefined by GLSL smoothstep.
float liquid_smooth(float e0,float e1,float x){float t=clamp((x-e0)/(e1-e0),0.,1.);return t*t*(3.-2.*t);}
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
  float shadowSigma=dark?.05:.06,shadowRadius=.5-1.59*shadowSigma;
  float shadow=exp(-pow(max(0.,length(p-vec2(0.,dark?.03:.04))-shadowRadius)/(1.91*shadowSigma),2.))*(dark?.45:.16);
  over(vec3(0.),shadow*clamp((r-.5)/aa+1.,0.,1.));
  float auraT=clamp((r-.5)/.25,0.,1.);
  float aura=exp(-4.2*auraT*auraT)*(1.-auraT*auraT)*clamp((r-.5)/aa+.5,0.,1.)*(dark?.55:.32)*uAuraIntensity*(uThumbnail>.5?0.:1.);
  light(uAuraColor,aura);
  float disc=liquid_smooth(.5+aa,.5-aa,r);
  vec3 top=dark?vec3(27.,32.,48.)/255.:vec3(1.);
  vec3 bottom=dark?vec3(9.,11.,16.)/255.:vec3(231.,235.,243.)/255.;
  over(mix(top,bottom,clamp(p.y+.5,0.,1.)),disc*(dark?.88:.94));
  float innerShadow=exp(-pow(max(.5-r-.0023,0.)/.0573,2.));over(dark?vec3(0.):vec3(27.,35.,64.)/255.,innerShadow*(dark?.44:.128)*disc);
  float lens=max(0.,1.-length(p-vec2(-.2,-.3))/.55);over(vec3(1.),lens*(dark?.06:.7)*disc);
  float glass=liquid_smooth(.455+aa,.455-aa,r);
  if(glass>0.){
    vec4 outer=acc;acc=vec4(0.);
    float yLevel=.455-.91*uSurface,frontY=waveY(p.x,false);
    float spill=(p.y-(yLevel-.22))/.22;
    if(uThumbnail<.5&&spill>=0.&&spill<=1.)light(L,(dark?.16:.10)*(.4+.6*uH)*spill*uActivity);
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
      if(k<1.)over(vec3(0.),(k<.55?mix(.35,.30,k/.55):mix(.30,0.,(k-.55)/.45))*uActivity);
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
    vec4 decorative=textureLod(uDecorative,p/1.5+vec2(.5),0.);over(decorative.rgb,decorative.a);
    float slope=(waveY(p.x+aa*.5,false)-waveY(p.x-aa*.5,false))/aa;
    float d=abs(p.y-frontY)/sqrt(1.+slope*slope),halfWidth=uMeniscus.x*.5;
    vec3 meniscus=uLiquidColors[6].rgb;
    if(uThumbnail<.5){float q=max(d-halfWidth,0.)/uMeniscus.y,strength=min(1.,uLiquidColors[7].a*min(1.,uMeniscus.x/(uMeniscus.y*2.50662827463))*1.6);light(uLiquidColors[7].rgb,strength*exp(-.5*q*q));}
    over(meniscus,uLiquidColors[6].a*liquid_smooth(halfWidth+aa,halfWidth-aa,d));
    acc.rgb*=glass;acc.a*=glass;
    acc.rgb+=outer.rgb*(1.-acc.a);acc.a+=outer.a*(1.-acc.a);
  }
  float wallHalf=.5*max(1./uLogicalS,.006),wall=1.-smoothstep(wallHalf-.5*aa,wallHalf+.5*aa,abs(r-.455));over(dark?vec3(1.):vec3(0.),wall*(dark?.09:.06));
  float angle=atan(p.y,p.x);
  if(uThumbnail<.5){
    if(angle>.95993&&angle<2.18166){float d=abs(r-.475),core=1.-smoothstep(.01-.5*aa,.01+.5*aa,d),glow=exp(-.5*pow(d/.008,2.))*.7;light(uLiquidColors[8].rgb,max(core,glow)*uLiquidColors[8].a);}
    vec2 spec=p+vec2(.17,.22);float c=cos(-.593412),s=sin(-.593412);vec2 q=mat2(c,-s,s,c)*spec;
    float ellipse=1.-smoothstep(1.-aa/.12,1.+aa/.12,length(q/vec2(.2,.12)));over(vec3(1.),ellipse*max(0.,1.-length(q)/.24)*(dark?.13:.75));
    float deg=degrees(angle);if(deg<0.)deg+=360.;float halfWidth=.5*max(1./uLogicalS,.012),glintDistance=deg>=200.&&deg<=236.?abs(r-.42):min(length(p-.42*vec2(cos(3.4906585),sin(3.4906585))),length(p-.42*vec2(cos(4.1189770),sin(4.1189770))));
    over(vec3(1.),(1.-smoothstep(halfWidth-.5*aa,halfWidth+.5*aa,glintDistance))*(dark?.22:.95));
  }
  float rim=1.-smoothstep(.5/uLogicalS-.5*aa,.5/uLogicalS+.5*aa,abs(r-(.5-.5/uLogicalS)));over(vec3(1.),rim*(dark?.14:.95)*clamp((.375-p.y)/.75,0.,1.));
  if(!dark)over(vec3(0.),(1.-smoothstep(.5/uLogicalS-.5*aa,.5/uLogicalS+.5*aa,abs(r-(.5+.5/uLogicalS))))*.08);
  // The same analytical waveY used by the volume clips every glyph pixel into complementary palettes (OrbGpuOrb.Labels).
  if(uReadoutOn>.5&&abs(p.x)<.5&&abs(p.y)<.5){
    vec2 uv=p+vec2(.5);vec4 masks=textureLod(uReadout,uv,0.);
    float valueMask=masks.r;bool prefix=p.x>=uReadoutPrefix.x&&p.x<uReadoutPrefix.y;
    bool rolling=uReadoutCellCount<0.;
    for(int i=0;i<24;i++){if(float(i)>=uReadoutCellCount)break;vec4 cell=uReadoutCells[i];if(cell.z>.5&&p.x>=cell.x&&p.x<cell.y)rolling=true;}
    if(prefix)rolling=false;
    if(rolling){
      float fresh=textureLod(uReadout,uv-vec2(0.,uReadoutRoll.x),0.).r*uReadoutRoll.z,old=textureLod(uReadoutOld,uv-vec2(0.,uReadoutRoll.y+uReadoutPreviousShift),0.).r*uReadoutRoll.w;
      valueMask=max(fresh,old);if(uReadoutCellCount>0.)valueMask*=step(uReadoutBand.x,p.y)*step(p.y,uReadoutBand.y);
    }
    float below=step(waveY(p.x,false),p.y);
    if(dark&&below>.5)over(vec3(0.),masks.a*.55);
    vec4 valueColor=below>.5?(dark?vec4(1.,1.,1.,.97):vec4(11./255.,13./255.,18./255.,.94)):uReadoutValue;
    vec4 unitColor=below>.5?(dark?vec4(1.,1.,1.,.80):vec4(11./255.,13./255.,18./255.,.72)):uReadoutUnit;
    if(prefix)valueColor=unitColor;
    vec4 titleColor=below>.5?uReadoutBelowTitle:uReadoutTitle;
    over(valueColor.rgb,valueColor.a*valueMask);over(unitColor.rgb,unitColor.a*masks.g);
    if(uReadoutLabelMoving>.5){
      float fresh=textureLod(uReadout,uv-vec2(0.,uReadoutLabelRoll.x),0.).b*uReadoutLabelRoll.z,old=textureLod(uReadoutOld,uv-vec2(0.,uReadoutLabelRoll.y+uReadoutPreviousLabelShift),0.).b*uReadoutLabelRoll.w;
      float clip=uReadoutLabelClipped>.5?step(uReadoutLabelBand.x,p.y)*step(p.y,uReadoutLabelBand.y):1.;vec4 oldColor=below>.5?uReadoutOldBelowTitle:uReadoutOldTitle;over(oldColor.rgb,oldColor.a*old*clip);over(titleColor.rgb,titleColor.a*fresh*clip);
    }else over(titleColor.rgb,titleColor.a*masks.b);
  }
  // Performance/thinking use the identical surface split, with no output roll, heat color or glow.
  if(uPerfReadoutOn>.5&&abs(p.x)<.5&&abs(p.y)<.5){
    vec4 masks=textureLod(uPerfReadout,p+vec2(.5),0.);float below=step(waveY(p.x,false),p.y);
    if(dark&&below>.5)over(vec3(0.),masks.a*.55);
    vec3 ink=vec3(11./255.,13./255.,18./255.);
    vec3 number=dark?vec3(1.):ink,secondary=dark?vec3(1.):below>.5?ink:vec3(0.);
    float numberAlpha=below>.5?(dark?.94:.88):(dark?.78:.76),secondaryAlpha=below>.5?(dark?.72:.62):.50;
    if(uPerfReadoutContrast>.5){numberAlpha=max(numberAlpha,.92);secondaryAlpha=max(secondaryAlpha,.70);}
    over(number,numberAlpha*masks.r);over(secondary,secondaryAlpha*masks.g);
  }
  acc*=liquid_smooth(.74,.73,r);
  outColor=acc.a<.0005?vec4(0.):acc;
}`;
