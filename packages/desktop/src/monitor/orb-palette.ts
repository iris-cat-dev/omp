// Adapted from zoefix/agent-speed v1.4.1 (MIT), frozen a94a67fcc78e5d8eea5f82d8d5e737bccf994e2c.
// Sources: spec/strings.json, spec/DESIGN.md §§1–2, Presentation/Colors/{HeatPalette,OkLab,OrbTokens}.cs,
// Presentation/Orb/Styles/StyleColors.cs, Presentation/Hero/HeroPalette.cs, and the normative LED prototype palette.
export const ORB_PALETTE_SCRIPT = String.raw`
const styles = {"led":["LED 仪表","LED Gauge"],"needle":["指针转速表","Needle Tachometer"],"liquid":["能量液球","Liquid Energy"],"reactor":["反应堆","Reactor"],"minimal":["极简圆环","Minimal Ring"]};
const themes = {"vehicles":{"name":["交通工具","Vehicles"],"zh":["待机","步行","自行车","电动车","摩托车","汽车","跑车","高铁","赛车","磁悬浮列车","喷气客机","战斗机","高超音速飞机","火箭"],"en":["IDLE","WALKING","BICYCLE","E-BIKE","MOTORCYCLE","CAR","SPORTS CAR","BULLET TRAIN","RACE CAR","MAGLEV","JETLINER","FIGHTER JET","HYPERSONIC","ROCKET"]},"animals":{"name":["动物","Animals"],"zh":["打盹","蜗牛","乌龟","刺猬","老鼠","松鼠","猫","兔子","袋鼠","马","猎豹","蝙蝠","金雕","游隼"],"en":["NAPPING","SNAIL","TORTOISE","HEDGEHOG","MOUSE","SQUIRREL","CAT","RABBIT","KANGAROO","HORSE","CHEETAH","BAT","EAGLE","FALCON"]},"wind":{"name":["蒲福风级","Beaufort Scale"],"zh":["风平浪静","无风","软风","轻风","微风","和风","清劲风","强风","疾风","大风","烈风","狂风","暴风","飓风"],"en":["BECALMED","FORCE 0","FORCE 1","FORCE 2","FORCE 3","FORCE 4","FORCE 5","FORCE 6","FORCE 7","FORCE 8","FORCE 9","FORCE 10","FORCE 11","FORCE 12"]},"space":{"name":["宇宙","Cosmos"],"zh":["休眠","星尘","流星","彗星","月球","行星","恒星","红巨星","超新星","中子星","黑洞","星系","类星体","大爆炸"],"en":["DORMANT","STARDUST","METEOR","COMET","MOON","PLANET","STAR","RED GIANT","SUPERNOVA","PULSAR","BLACK HOLE","GALAXY","QUASAR","BIG BANG"]},"cultivation":{"name":["修真境界","Cultivation"],"zh":["闭关","凡人","炼气","筑基","金丹","元婴","化神","炼虚","合体","大乘","渡劫","真仙","金仙","道祖"],"en":["SECLUSION","MORTAL","QI REFINING","FOUNDATION","GOLD CORE","NASCENT","SPIRIT","VOID","INTEGRATION","MAHAYANA","TRIBULATION","IMMORTAL","CELESTIAL","DAO LORD"]},"wuxia":{"name":["武学境界","Martial Arts"],"zh":["打坐","初学乍练","粗通皮毛","略知一二","渐入佳境","略有小成","驾轻就熟","融会贯通","炉火纯青","出类拔萃","出神入化","登峰造极","一代宗师","天下无双"],"en":["AT REST","NOVICE","DABBLER","LEARNER","PROMISING","CAPABLE","SKILLED","ADEPT","EXPERT","ELITE","VIRTUOSO","PARAGON","LEGEND","PEERLESS"]},"mage":{"name":["魔法位阶","Arcane Ranks"],"zh":["冥想","学徒","见习法师","法师","大法师","魔导师","大魔导师","贤者","大贤者","传奇","半神","神","主神","创世神"],"en":["MEDITATING","NOVICE","APPRENTICE","MAGE","HIGH MAGE","MAGUS","ARCHMAGE","SAGE","GREAT SAGE","LEGEND","DEMIGOD","DEITY","HIGH GOD","CREATOR"]},"gameRank":{"name":["游戏段位","Game Ranks"],"zh":["挂机","菜鸟","黑铁","青铜","白银","黄金","铂金","翡翠","钻石","大师","宗师","王者","传奇","榜首"],"en":["AFK","ROOKIE","IRON","BRONZE","SILVER","GOLD","PLATINUM","EMERALD","DIAMOND","MASTER","ELITE","CHAMPION","LEGEND","#1"]},"engineer":{"name":["工程师生涯","Engineer Career"],"zh":["下班","实习生","初级工程师","工程师","资深工程师","技术主管","主任工程师","架构师","首席工程师","技术总监","技术副总","CTO","传奇工程师","10x 工程师"],"en":["OFF DUTY","INTERN","JUNIOR","ENGINEER","SENIOR","TECH LEAD","STAFF","ARCHITECT","PRINCIPAL","DIRECTOR","VP ENG","CTO","LEGEND","10X DEV"]}};
const TITLE_FRACTIONS = [0,0,.02,.03,.04,.06,.08,.12,.17,.24,.34,.5,.7,1];
const TAU = Math.PI * 2;
const clamp = (v, lo=0, hi=1) => Math.max(lo, Math.min(hi,v));
const smooth = (a,b,v) => { const t = clamp((v-a)/(b-a)); return t*t*(3-2*t); };
const ease = v => 1-Math.pow(1-clamp(v),3);
const lerp = (a,b,t) => a+(b-a)*t;
const mix = (a,b,t) => [lerp(a[0],b[0],t),lerp(a[1],b[1],t),lerp(a[2],b[2],t)];
const darken = (c,t) => [c[0]*(1-t),c[1]*(1-t),c[2]*(1-t)];
const rgba = (c,a=1) => 'rgba('+Math.round(clamp(c[0])*255)+','+Math.round(clamp(c[1])*255)+','+Math.round(clamp(c[2])*255)+','+clamp(a)+')';
const HOT=[1,247/255,214/255], AMBER=[1,176/255,32/255], GOLD=[1,209/255,89/255];
const STOPS=[[0,[124/255,135/255,152/255]],[.1,[45/255,212/255,191/255]],[.3,[56/255,189/255,248/255]],[.48,[129/255,140/255,248/255]],[.64,[232/255,121/255,249/255]],[.78,[251/255,113/255,133/255]],[.9,[251/255,146/255,60/255]],[1,[250/255,204/255,21/255]]];
const lin = c => c <= .04045 ? c/12.92 : Math.pow((c+.055)/1.055,2.4);
const srgb = c => c <= .0031308 ? c*12.92 : 1.055*Math.pow(Math.max(0,c),1/2.4)-.055;
function prototypeHeatRgb(h){
  h=clamp(h);
  for(let i=1;i<STOPS.length;i++) if(h<=STOPS[i][0]){
    const a=STOPS[i-1],b=STOPS[i],t=(h-a[0])/(b[0]-a[0]);
    return [0,1,2].map(k=>srgb(lerp(lin(a[1][k]),lin(b[1][k]),t)));
  }
  return STOPS[7][1];
}
function oklab(c){
  const r=lin(c[0]),g=lin(c[1]),b=lin(c[2]);
  const l=Math.cbrt(.4122214708*r+.5363325363*g+.0514459929*b);
  const m=Math.cbrt(.2119034982*r+.6806995451*g+.1073969566*b);
  const s=Math.cbrt(.0883024619*r+.2817188376*g+.6299787005*b);
  return [.2104542553*l+.793617785*m-.0040720468*s,1.9779984951*l-2.428592205*m+.4505937099*s,.0259040371*l+.7827717662*m-.808675766*s];
}
function fromLab(lab){
  const l=Math.pow(lab[0]+.3963377774*lab[1]+.2158037573*lab[2],3);
  const m=Math.pow(lab[0]-.1055613458*lab[1]-.0638541728*lab[2],3);
  const s=Math.pow(lab[0]-.0894841775*lab[1]-1.291485548*lab[2],3);
  return [clamp(srgb(4.0767416621*l-3.3077115913*m+.2309699292*s)),clamp(srgb(-1.2684380046*l+2.6097574011*m-.3413193965*s)),clamp(srgb(-.0041960863*l-.7034186147*m+1.707614701*s))];
}
function labDarken(c,amount){const q=oklab(c);q[0]*=1-clamp(amount);return fromLab(q);}
function labMix(a,b,t){
  const x=oklab(a),y=oklab(b),k=clamp(t);x[0]=lerp(x[0],y[0],k);x[1]=lerp(x[1],y[1],k);x[2]=lerp(x[2],y[2],k);return fromLab(x);
}
// Native HeatPalette.Sample uses a 256-entry OKLab table; the normative LED prototype keeps its own linear-light ramp.
let nativeHeatTable=null,nativeStyleLabels=null;
function sampleColorTable(table,h){
  const p=clamp(h)*255,i=Math.floor(p);return i>=255?table[255]:mix(table[i],table[i+1],p-i);
}
function heatRgb(h){
  if(!nativeHeatTable){
    const labs=STOPS.map(stop=>oklab(stop[1]));
    nativeHeatTable=Array.from({length:256},(_,i)=>{
      const h=i/255;let k=1;while(k<STOPS.length-1&&h>STOPS[k][0])k++;
      const t=(h-STOPS[k-1][0])/(STOPS[k][0]-STOPS[k-1][0]),a=labs[k-1],b=labs[k];
      return fromLab([lerp(a[0],b[0],t),lerp(a[1],b[1],t),lerp(a[2],b[2],t)]);
    });
  }
  return sampleColorTable(nativeHeatTable,h);
}
function heroLegible(c,dark,minimum){
  const surface=dark?58/255:230/255,ls=luminance([surface,surface,surface]),lab=oklab(c);let candidate=c;
  for(let i=0;i<40;i++){
    const l=luminance(candidate);if((Math.max(l,ls)+.05)/(Math.min(l,ls)+.05)>=minimum)return candidate;
    lab[0]=clamp(lab[0]+(dark?.015:-.015));candidate=fromLab(lab);
  }
  return candidate;
}
function heroStroke(h,dark,minimum=4.5){const c=heatRgb(h);return dark?c:heroLegible(labDarken(c,.18),false,minimum);}
function styleLabelRgb(h,dark){
  if(dark)return heatRgb(h);
  if(!nativeStyleLabels)nativeStyleLabels=Array.from({length:256},(_,i)=>heroStroke(i/255,false));
  return sampleColorTable(nativeStyleLabels,h);
}
function styleHot(h,o,dark){return dark?labMix(heatRgb(h),HOT,.55+.45*clamp(o)):labMix(styleLabelRgb(h,false),AMBER,.3);}
function styleLift(c,amount){if(amount<=0)return c;const q=oklab(c);q[0]+=(1-q[0])*clamp(amount);return fromLab(q);}
function energyBrighten(c,amount){if(amount<=0)return c;const q=oklab(c);q[0]=Math.min(1,q[0]*(1+amount));return fromLab(q);}
function luminance(c){return .2126*lin(clamp(c[0]))+.7152*lin(clamp(c[1]))+.0722*lin(clamp(c[2]));}
function labelRgb(h,dark,contrast=3){
  const c=heatRgb(h); if(dark)return c;
  for(let amount=.18;amount<.9;amount+=.02){
    const candidate=labDarken(c,amount),l=luminance(candidate);
    if((1.05/(l+.05))>=contrast && ((luminance([231/255,235/255,243/255])+.05)/(l+.05))>=contrast)return candidate;
  }
  return labDarken(c,.9);
}
function heat(value,redline){return Math.min(1,Math.pow(Math.max(0,value)/Math.max(1,redline),.6));}
function title(value,theme,language,redline){
  const preset=themes[theme]||themes.vehicles,lang=language==='zh'?'zh':'en';
  let level=0;
  if(value!==null && Number.isFinite(value) && value>=.5){level=1;for(let i=2;i<14;i++)if(value>=TITLE_FRACTIONS[i]*Math.max(1,redline))level=i;}
  return {label:preset[lang][level],level};
}
const color=(h,appearance)=>rgba(labelRgb(h,appearance!=='light'));
function spring(state,target,dt,hz,damping){
  const steps=Math.max(1,Math.ceil(dt*480)),step=dt/steps,w=TAU*hz;
  for(let i=0;i<steps;i++){state.velocity+=(w*w*(target-state.value)-2*damping*w*state.velocity)*step;state.value+=state.velocity*step;}
}
// Presentation/Hero/HeroMath.cs SettleSpring: exact critical spring, independent of frame rate.
function settle(state,target,dt,seconds){
  const omega=6.2/seconds,c1=state.value-target,c2=state.velocity+omega*c1,e=Math.exp(-omega*dt);
  state.value=target+(c1+c2*dt)*e;state.velocity=(c2-omega*(c1+c2*dt))*e;
}
`;
