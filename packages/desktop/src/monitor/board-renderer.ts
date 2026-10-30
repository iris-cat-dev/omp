// Agent Speed v1.6.0 board-metrics.js layout B / DESIGN 2c, MIT.
// Only OMP's safe, scope-filtered snapshot enters this renderer; no simulation or external source adapters.
export const MONITOR_BOARD_RENDERER_SCRIPT = String.raw`
const boardState = {
  bound:false, destroyed:false, abort:null, panel:null, ui:null, effects:null, key:'', scopeKey:'', ranking:boardModel.createRanking(),
  rows:new Map(), settingsRows:new Map(), pending:new Set(), animations:new Set(), scoreRaf:0, scoreValue:null,
  expanded:null, expandedAt:0, expansionTimer:0, showAll:false, zeroSince:null, thinkShown:true, thinkTimer:0,
  tooltipTimer:0, previousLive:null, previousPeak:null, lastAnnouncement:0, latest:null, liveKnown:false,
  subMeasure:null, wideAt:0, subWidth:0, perfMeasure:null, perfWidth:0, perfWideAt:0, reduced:false, contrast:false, titleTimer:0,
  title:{level:0,candidate:0,pending:null,pendingSince:0,belowFirstSince:null}, scoreShown:null, scoreProvisional:false, lastAriaAt:0, previousPeakSequence:null
};
const boardSizes = {small:{key:'S',side:280,groups:4,subs:[0,0,0,0]},medium:{key:'M',side:340,groups:6,subs:[2,1,1]},large:{key:'L',side:420,groups:8,subs:[3,3,3,2,2]}};
const boardContrastMedia=window.matchMedia('(forced-colors: active), (prefers-contrast: more)');
// spec/assets/currencies.json; rates always come from the accepted snapshot, never this display table.
const boardCurrencies={USD:[2,'US$'],CNY:[2,'CN¥'],TWD:[0,'NT$'],HKD:[2,'HK$'],JPY:[0,'JP¥'],EUR:[2,'€'],GBP:[2,'£'],KRW:[0,'₩'],SGD:[2,'S$'],AUD:[2,'A$'],CAD:[2,'CA$'],CHF:[2,'CHF'],NZD:[2,'NZ$'],INR:[2,'₹'],MYR:[2,'RM'],THB:[2,'฿'],IDR:[0,'Rp'],PHP:[2,'₱'],VND:[0,'₫'],MOP:[2,'MOP$'],SEK:[2,'SEK'],NOK:[2,'NOK'],DKK:[2,'DKK'],PLN:[2,'PLN'],CZK:[2,'CZK'],HUF:[0,'HUF'],TRY:[2,'₺'],ILS:[2,'₪'],AED:[2,'AED'],SAR:[2,'SAR'],ZAR:[2,'R'],BRL:[2,'R$'],MXN:[2,'MX$'],CLP:[0,'CLP$'],COP:[0,'COP$'],ARS:[2,'AR$'],RUB:[2,'₽'],UAH:[2,'₴']};
function boardTrackedTitle(value){
  clearTimeout(boardState.titleTimer);boardState.titleTimer=0;
  if(value===null){boardState.title={level:0,candidate:0,pending:null,pendingSince:0,belowFirstSince:null};return boardWord('unavailable');}
  const tracker=boardState.title,now=performance.now(),preferences=view.preferences,raw=agentSpeedVisuals.title(value,preferences.titleTheme,language,preferences.redline).level;
  if(value<.5){if(tracker.belowFirstSince===null)tracker.belowFirstSince=now;}else tracker.belowFirstSince=null;
  let candidate;
  if(value<.5)candidate=now-tracker.belowFirstSince>=3000||tracker.candidate===0?0:1;
  else if(raw>=tracker.candidate)candidate=raw;
  else{candidate=1;const thresholds=[0,0,.02,.03,.04,.06,.08,.12,.17,.24,.34,.5,.7,1];for(let level=tracker.candidate;level>1;level--)if(value>=thresholds[level]*preferences.redline*.9){candidate=level;break;}}
  tracker.candidate=candidate;
  if(candidate===tracker.level)tracker.pending=null;
  else{if(tracker.pending!==candidate){tracker.pending=candidate;tracker.pendingSince=now;}if(now-tracker.pendingSince>=(candidate===0?0:800)){tracker.level=candidate;tracker.pending=null;}}
  let deadline=tracker.pending===null?null:tracker.pendingSince+(tracker.pending===0?0:800);
  if(tracker.belowFirstSince!==null&&candidate!==0)deadline=deadline===null?tracker.belowFirstSince+3000:Math.min(deadline,tracker.belowFirstSince+3000);
  if(deadline!==null&&!document.hidden)boardState.titleTimer=setTimeout(()=>{boardState.titleTimer=0;if(!document.hidden&&!boardState.destroyed&&boardState.latest)renderBoardUI(boardState.latest);},Math.max(1,deadline-performance.now()));
  return agentSpeedVisuals.themes[preferences.titleTheme][language][tracker.level];
}
const boardWords = {
  en:{title:'Leaderboard boards',add:'Add board',empty:'No boards. Add one to rank this orb’s local OMP agents.',style:'Style',size:'Size',scope:'Use orb’s scope',readouts:'Board readouts',performance:'Perf',thinking:'TH',cost:'Cost',hint:'Independent readouts. Performance is the highest agent score, live before resting, not an average. Thinking folds away after three seconds at zero.',window:'Window',pin:'Always on top',clickThrough:'Click through',visible:'Show',remove:'Remove',confirm:'Confirm removal',limit:'Up to four boards',glass:'Flowing Glass',timing:'Timing Tower',neon:'Neon Cockpit',today:'Today',peak:'Peak',generating:'Generating',tools:'Tools',gap:'Gap',leader:'LEAD',moreGroups:'more agents',moreSubs:'sub-agents',sub:'sub-agents',noAgents:'No local OMP agents in this scope',scanning:'Scanning local logs',partial:'Limited coverage',perfScan:'Scanning performance scores',perfLimited:'Performance-score coverage limited',unavailable:'Statistics unavailable',estimate:'Estimated',newPeak:'NEW PEAK',newLeader:'NEW LEADER',idle:'Idle',provisional:'provisional',samples:'timed requests',resting:'idle score',top:'highest of',unknown:'Not recorded',profile:'Profile',project:'Project',speed:'Speed',group:'Group',share:'Sub-agent share',mode:'Speed mode',recorded:'recorded',selected:'selected',settings:'Board settings',dashboard:'Usage',hide:'Hide board',allScopes:'All local OMP',failed:'Could not save board settings',expand:'Expand sub-agents',collapse:'Collapse sub-agents',scroll:'Scroll for more',allShown:'Back to top groups',none:'No performance score',currencyUnavailable:'Currency conversion unavailable'},
  zh:{title:'排行看板',add:'新增看板',empty:'还没有看板。新增后可查看此悬浮球范围内的本地 OMP 主子代理排行。',style:'样式',size:'尺寸',scope:'使用悬浮球的范围',readouts:'看板显示',performance:'性能',thinking:'思考',cost:'费用',hint:'三个指标独立开关。性能显示最高代理分，优先活动代理而非空闲，不取平均；思考为零持续三秒后收起。',window:'窗口',pin:'置顶',clickThrough:'鼠标穿透',visible:'显示',remove:'删除',confirm:'确认删除',limit:'最多四个看板',glass:'流光玻璃',timing:'计时塔',neon:'霓虹座舱',today:'今日',peak:'峰值',generating:'生成中',tools:'工具',gap:'间隔',leader:'领先',moreGroups:'个 agent',moreSubs:'个子 agent',sub:'个子 agent',noAgents:'此范围内暂无本地 OMP agent',scanning:'正在扫描本地日志',partial:'覆盖有限',perfScan:'性能评分扫描中',perfLimited:'性能评分覆盖有限',unavailable:'统计暂不可用',estimate:'估算',newPeak:'新峰值',newLeader:'新的领先者',idle:'待机',provisional:'暂定',samples:'次计时请求',resting:'空闲保留分',top:'最高分，参与评分 agent 数',unknown:'未记录',profile:'配置',project:'项目',speed:'速度',group:'组速',share:'子代理占比',mode:'速度模式',recorded:'日志记录',selected:'已选择',settings:'看板设置',dashboard:'使用情况',hide:'隐藏看板',allScopes:'全部本地 OMP',failed:'看板设置保存失败',expand:'展开子代理',collapse:'收起子代理',scroll:'滚动查看更多',allShown:'返回前列分组',none:'暂无性能评分',currencyUnavailable:'汇率暂不可用'}
};
function boardWord(key) { return boardWords[language === 'zh' ? 'zh' : 'en'][key] || key; }
function boardElement(tag, cls, value) { const element=document.createElement(tag);if(cls)element.className=cls;if(value!==undefined)element.textContent=String(value);return element; }
function boardSvg(tag, attributes) { const element=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value]of Object.entries(attributes||{}))element.setAttribute(key,String(value));return element; }
function boardSetText(element,value) { const next=String(value);if(element.textContent===next)return;if(element.childNodes.length===1&&element.firstChild.nodeType===3)element.firstChild.data=next;else element.textContent=next; }
function boardSelected() { return view && view.board || null; }
function boardScopeLabel(orbId) { const orb=view&&view.orbs.find(item=>item.instanceId===orbId);return orb ? [orb.scope.profile,orb.scope.project].filter(Boolean).join(' · ') || boardWord('allScopes') : boardWord('unavailable'); }
function boardListen(element,type,listener) { element.addEventListener(type,listener,{signal:boardState.abort.signal}); }
function boardAnimate(element,frames,options) {
  if(!boardState.liveKnown||document.hidden)return null;
  if(boardState.reduced){if(!frames.some(frame=>frame.opacity!==undefined))return null;frames=frames.map(frame=>({opacity:frame.opacity===undefined?1:frame.opacity}));options={...options,duration:150,easing:'ease-out'};}
  const animation=element.animate(frames,options);boardState.animations.add(animation);
  const finish=()=>{boardState.animations.delete(animation);};animation.addEventListener('finish',finish,{once:true});animation.addEventListener('cancel',finish,{once:true});return animation;
}
function boardRoll(element,value,up,instant=false) {
  const text=String(value),old=element.dataset.boardText;if(old===text)return;element.dataset.boardText=text;
  if(element.hasAttribute('data-ghost'))element.setAttribute('data-ghost',text.replace(/[0-9]/g,'8'));
  if(instant||boardState.reduced||old===undefined||old.length!==text.length||/[^0-9.,kMB]/.test(old+text)) {
    const fragment=document.createDocumentFragment();for(const character of text){const slot=boardElement('span','slot'),ch=boardElement('span','ch',character);slot.append(ch);fragment.append(slot);}element.replaceChildren(fragment);
    if(!instant&&old!==undefined)boardAnimate(element,[{opacity:0},{opacity:1}],{duration:150,easing:'ease-out'});return;
  }
  for(let i=0;i<text.length;i++)if(text[i]!==old[i]) {
    const slot=element.children[i];for(const animation of slot.getAnimations({subtree:true}))animation.cancel();
    const previous=slot.lastElementChild;for(const stale of [...slot.children])if(stale!==previous)stale.remove();
    const next=boardElement('span','ch',text[i]);if(previous)previous.classList.add('out');slot.append(next);
    boardAnimate(next,[{transform:'translateY('+(up?100:-100)+'%)',opacity:0,filter:'blur(1.4px)'},{transform:'translateY(0)',opacity:1,filter:'blur(0)'}],{duration:240,easing:'cubic-bezier(.2,.8,.2,1)'});
    const outgoing=previous&&boardAnimate(previous,[{transform:'translateY(0)',opacity:1},{transform:'translateY('+(up?-100:100)+'%)',opacity:0}],{duration:240,easing:'cubic-bezier(.2,.8,.2,1)',fill:'forwards'});
    if(outgoing)outgoing.addEventListener('finish',()=>previous.remove(),{once:true});else if(previous)previous.remove();
  }
}
function boardScoreWords(score) {
  if(!score||score.value===null)return boardWord('none');
  const spoken=Math.round(score.value).toLocaleString('en-US');
  return boardWord('performance')+' '+spoken+(score.provisional?', '+boardWord('provisional')+' ('+score.n+' '+boardWord('samples')+')':'')+(score.form==='resting'?', '+boardWord('resting'):'')+(score.count>1?', '+boardWord('top')+' '+score.count:'');
}
function boardAttachPerf(element,score,fallback,facts) {
  const supplying=score&&score.agent||fallback;
  if(boardSelected().showPerformance&&supplying){element.dataset.perfAgentId=supplying.id;element.dataset.perfSetCount=String(score&&score.count||0);element.dataset.perfCardHost='board';element.boardPerfFacts=facts;}
  else{delete element.dataset.perfAgentId;delete element.dataset.perfSetCount;delete element.dataset.perfCardHost;element.boardPerfFacts=[];}
}
function boardCurrency(snapshot) {
  const currency=snapshot&&snapshot.pricing?snapshot.pricing.currency:'USD',definition=boardCurrencies[currency],rawRate=snapshot&&snapshot.pricing?snapshot.pricing.exchangeRate:null;
  const rate=definition?(currency==='USD'?1:typeof rawRate==='number'&&Number.isFinite(rawRate)&&rawRate>0?rawRate:null):null;
  const symbol=currency==='USD'&&language==='en'?'$':currency==='CNY'&&language==='zh'?'¥':definition?definition[1]:currency;
  return {currency,rate,symbol,digits:definition?definition[0]:0};
}
function boardCost(total,currency) { return {text:total.cost===null||currency.rate===null?'–':boardModel.rateNumber(total.cost*currency.rate,currency.digits),unit:currency.symbol+'/s',partial:total.costPartial&&total.cost!==null&&currency.rate!==null}; }
function boardScopeKey(snapshot) {return JSON.stringify([boardSelected().id,boardSelected().orbId,snapshot&&snapshot.scope.profile,snapshot&&snapshot.scope.project]);}
async function boardRequest(key,work) {
  if(boardState.pending.has(key)||boardState.destroyed)return;boardState.pending.add(key);boardSetText(node('board-settings-error'),'');boardRenderSettings();
  try{await work();}catch{boardSetText(node('board-settings-error'),boardWord('failed'));}
  finally{boardState.pending.delete(key);if(!boardState.destroyed)boardRenderSettings();}
}
function boardConfigure(id,patch) { return boardRequest(id,()=>bridge.configureBoard(id,patch)); }
function boardRenderSettings() {
  const root=node('board-settings');if(!root||!view)return;
  const boards=view.boards||[],selected=boardSelected();
  for(const [id,key]of [['board-settings-title','title'],['board-add','add'],['board-style-label','style'],['board-size-label','size'],['board-scope-label','scope'],['board-readouts-label','readouts'],['board-performance-label','performance'],['board-thinking-label','thinking'],['board-cost-label','cost'],['board-readouts-hint','hint'],['board-window-label','window'],['board-pin-label','pin'],['board-clickthrough-label','clickThrough'],['board-settings-empty','empty']])boardSetText(node(id),boardWord(key));
  boardSetText(node('board-settings-count'),boards.length+' / 4');node('board-add').disabled=boards.length>=4||boardState.pending.has('add');node('board-add').title=boards.length>=4?boardWord('limit'):boardWord('add');
  const footerAdd=node('new-board');if(footerAdd){footerAdd.disabled=boards.length>=4||boardState.pending.has('add');footerAdd.title=boards.length>=4?boardWord('limit'):boardWord('add');footerAdd.setAttribute('aria-label',boardWord('add'));}
  node('board-settings-empty').hidden=boards.length>0;node('board-settings-list').hidden=boards.length===0;node('board-settings-list').setAttribute('aria-label',boardWord('title'));
  const list=node('board-settings-list'),present=new Set(boards.map(board=>board.id));
  for(const [id,row]of boardState.settingsRows)if(!present.has(id)){row.remove();boardState.settingsRows.delete(id);}
  for(let index=0;index<boards.length;index++) {
    const board=boards[index];let row=boardState.settingsRows.get(board.id);
    if(!row){
      row=boardElement('div','board-settings-row');row.dataset.boardId=board.id;row.setAttribute('role','option');row.tabIndex=-1;
      const preview=boardElement('div','board-settings-preview');preview.setAttribute('aria-hidden','true');preview.append(boardElement('span','','OMP'),boardElement('i'),boardElement('i'),boardElement('i'));
      const copy=boardElement('div','board-settings-row-copy');copy.append(boardElement('strong'),boardElement('small'));
      const visible=boardElement('label','board-settings-toggle'),input=boardElement('input');input.type='checkbox';input.dataset.boardVisible=board.id;visible.append(input,boardElement('span'));
      const remove=boardElement('button','board-settings-remove');remove.type='button';remove.dataset.boardRemove=board.id;row.append(preview,copy,visible,remove);boardState.settingsRows.set(board.id,row);
    }
    const chosen=!!selected&&selected.id===board.id;row.setAttribute('aria-selected',String(chosen));row.tabIndex=chosen||!selected&&index===0?0:-1;row.setAttribute('aria-busy',String(boardState.pending.has(board.id)));
    row.children[0].dataset.style=board.style;row.children[0].dataset.performance=String(board.showPerformance);row.children[0].dataset.thinking=String(board.showThinking);row.children[0].dataset.cost=String(board.showCost);
    row.children[0].dataset.metrics=[board.showPerformance?boardWord('performance'):null,board.showThinking?boardWord('thinking'):null,board.showCost?boardWord('cost'):null].filter(Boolean).join('\n');
    boardSetText(row.children[1].firstElementChild,boardWord(board.style)+' · '+boardSizes[board.size].key);boardSetText(row.children[1].lastElementChild,boardScopeLabel(board.orbId));
    const toggle=row.querySelector('input');toggle.checked=board.visible;toggle.disabled=boardState.pending.has(board.id);toggle.setAttribute('aria-label',boardWord('visible')+' · '+boardWord(board.style));boardSetText(toggle.nextElementSibling,boardWord('visible'));
    const remove=row.lastElementChild;boardSetText(remove,boardWord('remove'));remove.disabled=boardState.pending.has(board.id);remove.setAttribute('aria-label',remove.textContent+' · '+boardWord(board.style));
    if(list.children[index]!==row)list.insertBefore(row,list.children[index]||null);
  }
  const editor=node('board-settings-editor');editor.hidden=!selected;if(!selected)return;
  for(const option of node('board-style').options)boardSetText(option,boardWord(option.value));
  for(const key of ['style','size','showPerformance','showThinking','showCost','pinned','clickThrough']) {
    const control=node('board-'+key);control.disabled=boardState.pending.has(selected.id);
    if(control.type==='checkbox')control.checked=selected[key];else control.value=selected[key];
  }
  const scope=node('board-scope'),orbs=view.orbs||[],signature=JSON.stringify(orbs.map(orb=>[orb.instanceId,orb.scope.profile,orb.scope.project]));
  if(scope.dataset.signature!==signature||scope.dataset.language!==language) {
    const fragment=document.createDocumentFragment();for(let i=0;i<orbs.length;i++){const option=boardElement('option','',(i+1)+' · '+boardScopeLabel(orbs[i].instanceId));option.value=orbs[i].instanceId;fragment.append(option);}scope.replaceChildren(fragment);scope.dataset.signature=signature;scope.dataset.language=language;
  }
  scope.value=selected.orbId;scope.disabled=boardState.pending.has(selected.id);
}
function boardMetric(key,main=false) {
  const cell=boardElement('div','m'+(main?' main':''));cell.dataset.boardMetric=key;
  const label=boardElement('span','ml',boardWord(key)),value=boardElement('span','mv'),ge=boardElement('span','ge','≥'),number=boardElement('span','mn'),unit=boardElement('span','mu');
  if(key==='performance')number.classList.add('board-perf-value');
  if(boardSelected().style==='timing')label.textContent=label.textContent.toUpperCase();
  if(boardSelected().style==='neon')number.setAttribute('data-ghost','');value.append(ge,number,unit);cell.append(label,value);
  return {cell,label,value,ge,number,unit};
}
function boardHistory(wide) {
  const style=boardSelected().style;
  if(style==='glass') {
    const svg=boardSvg('svg',{class:'spark',viewBox:wide?'0 0 300 16':'0 0 104 40','aria-hidden':'true',preserveAspectRatio:'none'});
    const defs=boardSvg('defs'),gradient=boardSvg('linearGradient',{id:'board-spark-gradient',x1:0,y1:0,x2:0,y2:1});
    gradient.append(boardSvg('stop',{offset:0,'stop-color':'currentColor','stop-opacity':wide?.28:.35}),boardSvg('stop',{offset:1,'stop-color':'currentColor','stop-opacity':0}));defs.append(gradient);
    const area=boardSvg('path',{class:'a',fill:'url(#board-spark-gradient)'}),line=boardSvg('path',{class:'l',fill:'none',stroke:'currentColor','stroke-width':wide?1.25:1.5,'stroke-linejoin':'round','vector-effect':'non-scaling-stroke'});svg.append(defs,area,line);
    return {node:svg,wide,width:wide?300:104,height:wide?16:40,area,line};
  }
  const bars=boardElement('div',style==='neon'?'led':'bars');for(let i=0;i<(style==='neon'?24:30);i++)bars.append(boardElement('i'));return {node:bars,wide};
}
function boardArcPath(fraction) {
  const start=150*Math.PI/180,end=(150+Math.max(0,Math.min(1,fraction))*240)*Math.PI/180;
  return 'M'+(33+29*Math.cos(start)).toFixed(3)+' '+(33+29*Math.sin(start)).toFixed(3)+' A29 29 0 '+(fraction>.75?1:0)+' 1 '+(33+29*Math.cos(end)).toFixed(3)+' '+(33+29*Math.sin(end)).toFixed(3);
}
function boardCreatePanel(snapshot) {
  boardDisposePanel();const config=boardSelected(),size=boardSizes[config.size],style=config.style;
  const panel=boardElement('section','board-panel '+style+' rows2'+(config.showPerformance?' cap-on':''));panel.dataset.size=size.key;panel.dataset.theme=appearance;panel.setAttribute('role','list');panel.tabIndex=0;
  boardState.panel=panel;boardState.ui={metrics:{},currency:boardCurrency(snapshot)};const ui=boardState.ui;
  const anyMetric=config.showPerformance||config.showThinking||config.showCost;if(anyMetric)panel.classList.add('optB');
  const ambient=boardElement('div','board-ambient');panel.append(ambient);
  if(style==='glass'){const aurora=boardElement('div','aurora');aurora.append(boardElement('i'),boardElement('i'));ambient.append(aurora);}
  if(style==='timing'){const rail=boardElement('div','rail');rail.append(boardElement('i'));ambient.append(rail);}
  const hero=boardElement('header','hero'),left=boardElement('div','hl'),right=boardElement('div','hr');ui.hero=hero;ui.right=right;
  if(style==='timing'){const live=boardElement('span','live');live.append(boardElement('i'),document.createTextNode('LIVE'));left.append(live);ui.live=live;}
  const value=boardElement('div','value'),number=boardElement('span','num'),unit=boardElement('span','unit',style==='timing'?'TOK/S':'tok/s');ui.number=number;ui.value=value;
  if(style==='neon'){const glow=boardElement('span','glow');glow.append(number);value.append(glow);}else value.append(number);value.append(unit);
  ui.peakBadge=boardElement('span','board-peak',boardWord('newPeak'));value.append(ui.peakBadge);
  const meta=boardElement('div','meta');ui.title=boardElement('span','title');ui.counts=boardElement('span','counts');meta.append(ui.title,ui.counts);left.append(value,meta);hero.append(left,right);panel.append(hero);
  const history=boardHistory(anyMetric&&style!=='neon');ui.history=history;
  if(style==='neon')hero.append(history.node);else if(!anyMetric)right.append(history.node);
  if(anyMetric) {
    const gauge=boardElement('div',style==='timing'?'dbox':'gauge');ui.gauge=gauge;
    if(config.showPerformance){
      const perf=boardMetric('performance',true);ui.metrics.performance=perf;const hit=style==='timing'?perf.cell:boardElement('div',style==='glass'?'dial board-perf-hit':'board-perf-hit');ui.perfHit=hit;hit.tabIndex=0;
      if(style==='glass') {
        const svg=boardSvg('svg',{viewBox:'0 0 66 66','aria-hidden':'true'}),defs=boardSvg('defs'),gradient=boardSvg('linearGradient',{id:'board-pearl',x1:0,y1:1,x2:1,y2:0});
        for(const [offset,color]of [[0,'var(--pearl-c)'],[.5,'var(--pearl-a)'],[1,'var(--pearl-b)']])gradient.append(boardSvg('stop',{offset,'stop-color':color}));defs.append(gradient);
        const track=boardSvg('path',{class:'trk',d:boardArcPath(1)}),arc=boardSvg('path',{class:'arc',d:boardArcPath(1),pathLength:100,'stroke-dasharray':'100 100','stroke-dashoffset':100,style:'stroke:url(#board-pearl)'}),tip=boardSvg('circle',{class:'tip',r:2.3,cx:(33+29*Math.cos(150*Math.PI/180)),cy:(33+29*Math.sin(150*Math.PI/180)),style:'transform-origin:33px 33px;transform-box:view-box'});
        svg.append(defs,track,arc,tip);hit.append(svg,perf.cell);ui.arc=arc;ui.tip=tip;gauge.append(hit);
      }else if(style==='neon'){
        hit.append(perf.cell);const segments=boardElement('div','segs');for(let i=0;i<12;i++)segments.append(boardElement('i'));hit.append(segments);ui.segments=segments;gauge.append(hit);
      }else gauge.append(perf.cell);
    }
    const subs=style==='timing'?gauge:boardElement('div','subs');ui.subs=subs;
    if(config.showThinking){ui.metrics.thinking=boardMetric('thinking');subs.append(ui.metrics.thinking.cell);}
    if(config.showCost){ui.metrics.cost=boardMetric('cost');subs.append(ui.metrics.cost.cell);}
    if(style!=='timing'&&subs.childElementCount)gauge.append(subs);right.append(gauge);
    if(style!=='neon'){const strip=boardElement('div','strip');strip.append(history.node);panel.append(strip);}
  }
  const viewport=boardElement('div','board'),rows=boardElement('div','board-rows');ui.viewport=viewport;ui.rows=rows;
  if(config.showPerformance){const columns=boardElement('div','cols');columns.append(boardElement('i','ln'));if(style==='timing')columns.append(boardElement('span','g',boardWord('gap')));columns.append(boardElement('span','',boardWord('performance')),boardElement('span','',style==='timing'?'TOK/S':'tok/s'));rows.append(columns);ui.columns=columns;}
  ui.empty=boardElement('div','board-empty');rows.append(ui.empty);viewport.append(rows);panel.append(viewport);
  const footer=boardElement('footer','foot'),today=boardElement('span'),todayValue=boardElement('b'),cost=boardElement('span'),peak=boardElement('span','peak'),peakValue=boardElement('b');
  today.append(document.createTextNode((style==='timing'?boardWord('today').toUpperCase():boardWord('today'))+' '),todayValue,document.createTextNode(style==='timing'?' TOK':' tok'));
  peak.append(document.createTextNode((style==='timing'?boardWord('peak').toUpperCase():boardWord('peak'))+' '),peakValue);footer.append(today,cost,peak);panel.append(footer);ui.today=todayValue;ui.todayCost=cost;ui.peak=peakValue;
  ui.coverage=boardElement('span','board-coverage');panel.append(ui.coverage);ui.leaderBanner=boardElement('span','board-new-leader',boardWord('newLeader'));panel.append(ui.leaderBanner);
  const contrastSegment=boardSvg('svg',{class:'board-contrast-segment',viewBox:'0 0 '+size.side+' '+size.side,'aria-hidden':'true'});
  contrastSegment.append(boardSvg('rect',{x:.8,y:.8,width:size.side-1.6,height:size.side-1.6,rx:(style==='glass'?26:style==='timing'?20:22)-.8,fill:'none',stroke:'currentColor','stroke-width':2,pathLength:1000,'stroke-dasharray':'150 850','stroke-linecap':'round'}));panel.append(contrastSegment);
  node('board-panel-host').replaceChildren(panel);boardState.effects=boardEffects.create(panel,style);boardState.effects.setVisible(true);
  boardState.zeroSince=null;boardState.thinkShown=true;boardState.scoreValue=null;boardState.scoreShown=null;boardState.previousLive=null;boardState.previousPeak=null;boardState.previousPeakSequence=null;boardState.subMeasure=null;boardState.subWidth=0;boardState.wideAt=0;
  boardMeasureMetrics();
}
function boardMeasureMetrics() {
  const ui=boardState.ui;if(!ui||!ui.gauge)return;
  function width(host,cls,text){const probe=boardElement('span',cls+' probe',text);host.append(probe);const bounds=probe.getBoundingClientRect(),style=getComputedStyle(probe),value=bounds.width+parseFloat(style.marginLeft||'0')+parseFloat(style.marginRight||'0');probe.remove();return Math.ceil(value);}
  if(boardSelected().showPerformance){
    const probe=boardElement('div','item group probe'),row=boardElement('div','row'),value=boardElement('span','performance'),cell=boardElement('span','perf-score-cell','8,888');value.append(cell);row.append(value);probe.append(row);boardState.panel.append(probe);
    const measured=Math.ceil(cell.getBoundingClientRect().width);probe.remove();boardState.perfMeasure=measured;boardState.perfWidth=measured;boardState.perfWideAt=0;boardState.panel.style.setProperty('--perfw',measured+'px');
  }
  const config=boardSelected(),keys=[config.showThinking?'thinking':null,config.showCost?'cost':null].filter(Boolean),unit=ui.currency.symbol+'/s';
  if(config.style==='timing') {
    const labels=[config.showPerformance?'performance':null,...keys].filter(Boolean);ui.gauge.style.setProperty('--tabw',Math.max(0,...labels.map(key=>width(ui.gauge,'ml',boardWord(key))))+'px');
  }else if(ui.subs&&keys.length) {
    boardState.subMeasure=width(ui.subs,'mn','0.00088');boardState.subWidth=boardState.subMeasure;
    ui.subs.style.setProperty('--subnum',boardState.subWidth+'px');ui.subs.style.setProperty('--sublabel',Math.max(...keys.map(key=>width(ui.subs,'ml',boardWord(key))))+'px');
    ui.subs.style.setProperty('--subunit',Math.max(...keys.map(key=>width(ui.subs,'mu',key==='thinking'?'tok/s':unit)))+'px');
  }
}
function boardCapsule(agent) {
  const capsule=boardElement('span','cap'),mode=agent.speedMode,word=mode&&String(mode.value).toLowerCase(),bolts=word==='ultrafast'?2:word==='fast'||word==='highspeed'?1:0;
  // OMP has no verified per-request effort DTO: preserve the original capsule's bolts, never infer an effort rung.
  if(!bolts){capsule.classList.add('none');return capsule;}
  const boltBox=boardElement('span','bolts');for(let i=0;i<bolts;i++){const svg=boardSvg('svg',{viewBox:'0 0 8 10','aria-hidden':'true'});svg.append(boardSvg('path',{d:'M4.8 0 0.6 5.6h2.7L2.6 10 7.4 4.1H4.6z'}));boltBox.append(svg);}capsule.append(boltBox);
  capsule.title=(bolts===2?'Ultrafast':'Fast')+' · '+boardWord(mode.evidence);capsule.setAttribute('aria-label',boardWord('mode')+' '+capsule.title);return capsule;
}
function boardCreateRow(kind,key) {
  const item=boardElement('div','item '+kind),row=boardElement('div','row');item.dataset.boardKey=key;item.setAttribute('role','listitem');
  const timing=boardSelected().style==='timing';let rank,badge;
  if(kind!=='more') {
    if(timing){row.append(boardElement('span','wipe'));rank=boardElement('span','pos');rank.append(boardElement('span'));badge=boardElement('span','stripe');}
    else{row.append(boardElement('span','bar'),boardElement('span','sweep'));rank=boardElement('span','rank');rank.append(boardElement('span'));badge=boardElement('span','badge');}
    row.append(rank,badge);
  }else row.append(boardElement('span'),boardElement('span'));
  const name=boardElement('span','name');if(kind==='more')name.append(boardElement('span','label'));else name.append(boardElement('b'),boardElement('small'));
  const capsule=boardElement('span','cap none');row.append(name,capsule);let gap=null;if(timing){gap=boardElement('span','gap');row.append(gap);}
  const perf=boardElement('span','performance'),value=boardElement('span','speed');row.append(perf,value);const chip=boardElement('span','chip');if(kind!=='more')row.append(chip);
  row.tabIndex=kind==='group'||kind==='more'?0:-1;item.append(row);boardState.ui.rows.append(item);
  return {item,row,rank,badge,name,capsule,gap,perf,value,chip,y:null,live:null,phase:null,modeKey:null,entry:null};
}
function boardPaintRow(record,entry,total,rank,ahead) {
  const config=boardSelected(),group=entry.group,agent=entry.agent||group.root,isGroup=entry.kind==='group',live=isGroup?group.live:boardModel.rate(agent),shownLive=boardState.liveKnown?live:null;
  const score=isGroup?group.score:boardModel.score([agent],boardState.latest.performance&&boardState.latest.performance.current),heat=agentSpeedVisuals.heat(live,view.preferences.redline),color=agentSpeedVisuals.color(Math.max(.12,heat),appearance);
  record.entry=entry;record.item.dataset.boardGroup=group.id;record.row.style.setProperty('--src',getComputedStyle(document.body).getPropertyValue('--source').trim()||'#84cc16');
  record.row.style.setProperty('--share',String(total.live>0?Math.min(1,live/total.live):0));record.row.style.setProperty('--rowheat',color);record.row.classList.toggle('gen',boardState.liveKnown&&(isGroup?group.generating>0:agent.phase==='generating'));
  if(config.style!=='timing') {
    const phase=boardState.liveKnown?(isGroup&&group.generating>0?'generating':agent.phase):'idle';
    if(record.phase!==phase){record.phase=phase;record.badge.className='badge '+(phase==='generating'?'gen':phase);record.badge.replaceChildren();if(phase==='generating')record.badge.append(boardElement('i'),boardElement('i'),boardElement('i'));}
  }
  const label=isGroup?agent.project||agent.name||'OMP':agent.name||agent.model||'OMP',detail=isGroup?[agent.model,group.subs.length?group.subs.length+' '+boardWord('sub'):null].filter(Boolean).join(' · '):'';
  boardSetText(record.name.firstElementChild,label);boardSetText(record.name.lastElementChild,detail);boardSetText(record.value,shownLive===null?'–':live>=.05?boardModel.formatSpeed(live):'–');record.value.classList.toggle('dim',shownLive===null||live<.05);
  record.value.style.color=config.style!=='timing'&&shownLive!==null&&heat>.45?color:'';
  if(record.live!==null&&shownLive!==null&&record.live>0&&Math.abs(live/record.live-1)>.05&&!boardState.reduced) {
    record.value.classList.remove('board-number-flash','board-number-dim');boardAnimate(record.value,live>record.live?[{filter:'brightness(1.8)'},{filter:'brightness(1)'}]:[{opacity:.55},{opacity:1}],{duration:live>record.live?800:500,easing:'ease-out'});
  }
  record.live=shownLive;record.perf.classList.toggle('quiet',score.form!=='live');
  const perfKey=JSON.stringify([score.agent&&score.agent.id,score.value,score.form,score.provisional,score.n,language,boardState.contrast]);
  if(config.showPerformance&&record.perfKey!==perfKey){
    const cell=createPerfScoreCell(score.agent||agent,'board');record.perf.replaceChildren(cell);record.perfKey=perfKey;
  }
  record.row.tabIndex=config.showPerformance||isGroup?0:-1;
  const modeKey=JSON.stringify(agent.speedMode);if(record.modeKey!==modeKey){record.modeKey=modeKey;const capsule=boardCapsule(agent);record.capsule.replaceWith(capsule);record.capsule=capsule;}
  if(isGroup) {
    const previous=Number(record.rank.firstElementChild.textContent);if(previous!==rank){boardSetText(record.rank.firstElementChild,rank);if(previous)boardAnimate(record.rank.firstElementChild,[{transform:'translateY('+(rank<previous?100:-100)+'%)'},{transform:'translateY(0)'}],{duration:350,easing:'cubic-bezier(.2,.8,.2,1)'});}
    record.item.classList.toggle('lead',rank===1);record.row.setAttribute('aria-expanded',String(boardState.expanded===group.id));
    if(record.gap)boardSetText(record.gap,!ahead?boardWord('leader'):(ahead.live-live>=0?'−':'+')+boardModel.formatSpeed(Math.abs(ahead.live-live)));
  }else if(record.rank)record.rank.style.visibility='hidden';
  const facts=[label+' · OMP',agent.model||boardWord('unknown'),boardWord(isGroup?'group':'speed')+': '+boardModel.formatSpeed(shownLive)+' tok/s'];
  if(isGroup&&group.subs.length){const own=boardModel.rate(group.root);facts.push(group.subs.length+' '+boardWord('sub'),boardWord('share')+': '+(group.live>0?number((group.live-own)/group.live*100,1)+'%':'–'));}
  if(agent.speedMode)facts.push(boardWord('mode')+': '+agent.speedMode.value+' · '+boardWord(agent.speedMode.evidence));
  const estimated=isGroup?group.estimated:agent.liveEstimatedTps;if(boardState.liveKnown&&estimated>0)facts.push(boardWord('estimate')+': '+boardModel.formatSpeed(estimated)+' tok/s');
  boardAttachPerf(record.row,score,agent,facts);record.row.boardTooltipFacts=facts;
  if(record.perf.firstElementChild)boardAttachPerf(record.perf.firstElementChild,score,agent,facts);
  record.row.setAttribute('aria-label',(isGroup?(language==='zh'?'第 '+rank+' 名，':'Rank '+rank+', '):'')+label+', '+boardModel.formatSpeed(shownLive)+' tok/s'+(config.showPerformance?', '+boardScoreWords(score):'')+(isGroup&&group.subs.length?', '+group.subs.length+' '+boardWord('sub')+', '+boardWord(boardState.expanded===group.id?'collapse':'expand'):''));
}
function boardPlan(groups) {
  const config=boardSelected(),size=boardSizes[config.size],timing=config.style==='timing',style=getComputedStyle(boardState.panel);
  const rowHeight=parseFloat(style.getPropertyValue('--row'))+(size.key==='S'?(timing?0:2):8),subHeight=parseFloat(style.getPropertyValue('--sub')),moreHeight=timing?19:20;
  const top=config.showPerformance?(timing?16:14):timing?0:6,room=Math.max(0,boardState.ui.viewport.clientHeight-top);
  let visible=groups.slice(0,size.groups);if(boardState.showAll)visible=groups;
  else while(visible.length&&visible.length*rowHeight+(groups.length>visible.length?moreHeight:0)>room)visible=visible.slice(0,-1);
  let free=Math.max(0,room-visible.length*rowHeight-(groups.length>visible.length?moreHeight:0));
  const plans=visible.map((group,index)=>({group,subs:[],more:false,wanted:boardState.expanded?boardState.expanded===group.id?8:0:size.subs[index]||0}));
  if(boardState.expanded)plans.sort((a,b)=>(a.group.id===boardState.expanded?-1:b.group.id===boardState.expanded?1:0));
  for(const plan of plans) {
    if(size.key==='S'&&!boardState.showAll)continue;
    const candidates=plan.group.subs.filter(agent=>boardState.expanded===plan.group.id||boardModel.rate(agent)>.05).slice(0,plan.wanted);
    for(const agent of candidates) {
      const stillHidden=plan.group.subs.length-plan.subs.length-1>0,extra=stillHidden&&!plan.more?moreHeight:0;
      if(boardState.showAll||free>=subHeight+extra){plan.subs.push(agent);free-=subHeight+extra;if(extra)plan.more=true;}
    }
    if(plan.more&&plan.subs.length===plan.group.subs.length){plan.more=false;free+=moreHeight;}
  }
  plans.sort((a,b)=>visible.indexOf(a.group)-visible.indexOf(b.group));const result=[];let y=top;
  for(const plan of plans) {
    result.push({key:'group:'+plan.group.id,kind:'group',group:plan.group,y});y+=rowHeight;
    for(const agent of plan.subs){result.push({key:'sub:'+agent.id,kind:'sub',agent,group:plan.group,y});y+=subHeight;}
    if(plan.more){const shown=new Set(plan.subs.map(agent=>agent.id)),rest=plan.group.subs.filter(agent=>!shown.has(agent.id));result.push({key:'more:'+plan.group.id,kind:'more',group:plan.group,rest:rest.length,live:rest.reduce((sum,agent)=>sum+boardModel.rate(agent),0),y});y+=moreHeight;}
  }
  if(groups.length>visible.length){const hidden=groups.slice(visible.length);result.push({key:'rest',kind:'more',rest: hidden.length,live:hidden.reduce((sum,group)=>sum+group.live,0),y,allGroups:true});y+=moreHeight;}
  if(boardState.showAll&&groups.length){result.push({key:'collapse',kind:'more',rest:0,live:0,y,collapse:true});y+=moreHeight;}
  return {rows:result,height:y};
}
function boardSetThinking(show,instant=false) {
  const ui=boardState.ui,metric=ui&&ui.metrics.thinking;if(!metric||show===boardState.thinkShown)return;
  const gauge=ui.gauge,oldHeight=gauge.getBoundingClientRect().height,oldTop=gauge.getBoundingClientRect().top;
  const cost=ui.metrics.cost,below=cost?[cost.label,cost.ge,cost.number,cost.unit]:[],before=below.map(element=>element.getBoundingClientRect().top);
  const parts=boardSelected().style==='timing'?[metric.label,metric.value]:[metric.label,metric.ge,metric.number,metric.unit];
  if(!show&&!instant&&!boardState.reduced){
    for(const part of parts){const rect=part.getBoundingClientRect(),clone=part.cloneNode(true);clone.classList.add('board-fold-clone');clone.style.cssText+=';position:fixed;left:'+rect.left+'px;top:'+rect.top+'px;width:'+rect.width+'px;z-index:5;pointer-events:none';boardState.panel.append(clone);const animation=boardAnimate(clone,[{opacity:1},{opacity:0}],{duration:250,easing:'ease-out'});if(animation)animation.addEventListener('finish',()=>clone.remove(),{once:true});else clone.remove();}
  }
  metric.cell.classList.toggle('off',!show);boardState.thinkShown=show;
  if(!instant&&!boardState.reduced){const height=gauge.getBoundingClientRect().height,top=gauge.getBoundingClientRect().top;boardAnimate(gauge,[{height:oldHeight+'px',transform:'translateY('+(oldTop-top)+'px)'},{height:height+'px',transform:'none'}],{duration:300,easing:'cubic-bezier(.33,0,.67,1)'});below.forEach((element,index)=>{const delta=before[index]-element.getBoundingClientRect().top;if(Math.abs(delta)>.01)boardAnimate(element,[{transform:'translateY('+delta+'px)'},{transform:'none'}],{duration:300,easing:'cubic-bezier(.33,0,.67,1)'});});if(show)parts.forEach(part=>boardAnimate(part,[{opacity:0},{opacity:1}],{duration:250,easing:'ease-out'}));}
}
function boardPaintScore(score,instant=false) {
  const ui=boardState.ui,metric=ui.metrics.performance;if(!metric)return;
  const previous=boardState.scoreShown,target=score.value,crossfade=!instant&&target!==previous&&(boardState.reduced||previous===null||target===null);
  let outgoing=null;
  if(crossfade){const rect=metric.number.getBoundingClientRect(),style=getComputedStyle(metric.number);outgoing=metric.number.cloneNode(true);outgoing.classList.add('board-score-outgoing');outgoing.style.cssText+=';position:fixed;left:'+rect.left+'px;top:'+rect.top+'px;width:'+rect.width+'px;font:'+style.font+';letter-spacing:'+style.letterSpacing+';line-height:'+style.lineHeight+';color:'+style.color+';text-shadow:'+style.textShadow+';pointer-events:none';boardState.panel.append(outgoing);}
  metric.cell.classList.toggle('none',score.value===null);metric.cell.classList.toggle('resting',score.form==='resting');metric.number.classList.toggle('board-provisional',score.provisional);
  ui.gauge.classList.toggle('board-resting',score.form==='resting');ui.gauge.classList.toggle('board-provisional-shape',score.provisional);
  boardAttachPerf(ui.perfHit,score,null,[score.agent?score.agent.project||score.agent.name:'',boardScoreWords(score)].filter(Boolean));ui.perfHit.setAttribute('aria-label',boardScoreWords(score));
  boardState.scoreProvisional=score.provisional;
  if(boardState.scoreRaf&&boardState.scoreValue===score.value)return;
  if(boardState.scoreRaf){cancelAnimationFrame(boardState.scoreRaf);boardState.scoreRaf=0;}
  boardState.scoreValue=target;
  const draw=value=>{
    boardState.scoreShown=value;const shown=perfNumber(value,boardSelected().style==='glass');boardSetText(metric.number,shown);
    if(metric.number.hasAttribute('data-ghost')){const ghost=shown.replace(/[0-9]/g,'8');if(metric.number.getAttribute('data-ghost')!==ghost)metric.number.setAttribute('data-ghost',ghost);}
    const fraction=value===null||value<=0?0:Math.max(0,Math.min(1,Math.log2(value/250)/4));
    if(ui.arc){
      if(boardState.scoreProvisional){ui.arc.removeAttribute('pathLength');ui.arc.setAttribute('d',fraction>0?boardArcPath(fraction):'');ui.arc.setAttribute('stroke-dasharray','0 6');ui.arc.setAttribute('stroke-dashoffset','0');}
      else{ui.arc.setAttribute('pathLength','100');ui.arc.setAttribute('d',boardArcPath(1));ui.arc.setAttribute('stroke-dasharray','100 100');ui.arc.setAttribute('stroke-dashoffset',String(100-fraction*100));}
      ui.arc.style.opacity=value===null?'0':'';ui.tip.style.transform='rotate('+(fraction*240)+'deg)';ui.tip.style.opacity=value===null?'0':'';
    }
    if(ui.segments){const lit=value===null?0:Math.round(fraction*12);for(let i=0;i<12;i++)ui.segments.children[i].classList.toggle('on',i<lit);}
  };
  const delta=previous!==null&&target!==null?Math.abs(target-previous):0,counts=delta>=3&&delta>=.01*Math.max(Math.abs(previous||0),1);
  if(!instant&&!boardState.reduced&&previous!==null&&target!==null&&counts) {
    const started=performance.now(),duration=(previous<=0||target<=0?.7:Math.max(.3,Math.min(.7,.3+.35*Math.abs(Math.log2(target/previous)))))*1000;
    const frame=now=>{if(document.hidden||boardState.destroyed){boardState.scoreRaf=0;return;}const fraction=Math.max(0,Math.min(1,(now-started)/duration));draw(Math.round(previous+(target-previous)*(1-Math.pow(1-fraction,3))));boardState.scoreRaf=fraction<1?requestAnimationFrame(frame):0;};boardState.scoreRaf=requestAnimationFrame(frame);
  }else{
    draw(target);
    if(crossfade){boardAnimate(metric.number,[{opacity:0},{opacity:1}],{duration:150,easing:'ease-out'});const fade=boardAnimate(outgoing,[{opacity:1},{opacity:0}],{duration:150,easing:'ease-out'});if(fade)fade.addEventListener('finish',()=>outgoing.remove(),{once:true});else outgoing.remove();}
  }
}
function boardPaintMetrics(total,instant) {
  const ui=boardState.ui,config=boardSelected();boardPaintScore(total.score,instant);
  if(ui.metrics.thinking){const metric=ui.metrics.thinking,value=boardState.liveKnown?total.thinking:null;boardRoll(metric.number,boardModel.formatSpeed(value),value!==null&&value>=(metric.previous||0),instant);metric.previous=value;boardSetText(metric.unit,config.style==='timing'?'TOK/S':'tok/s');metric.cell.classList.toggle('none',value===null);metric.cell.classList.toggle('zero',value===0);}
  if(ui.metrics.cost){const metric=ui.metrics.cost,cost=boardState.liveKnown?boardCost(total,ui.currency):{text:'–',unit:ui.currency.symbol+'/s',partial:false};boardRoll(metric.number,cost.text,total.cost!==null&&total.cost>=(metric.previous||0),instant);metric.previous=total.cost;boardSetText(metric.unit,config.style==='timing'?cost.unit.toUpperCase():cost.unit);metric.cell.classList.toggle('partial',cost.partial);metric.cell.classList.toggle('unknown',cost.text==='–');metric.cell.classList.toggle('zero',cost.text==='0');}
  clearTimeout(boardState.thinkTimer);boardState.thinkTimer=0;
  if(config.showThinking&&(config.showPerformance||config.showCost)&&boardState.liveKnown&&total.thinking!==null) {
    if(Number(boardModel.formatSpeed(total.thinking))===0){if(boardState.zeroSince===null)boardState.zeroSince=performance.now();const remaining=3000-(performance.now()-boardState.zeroSince);if(remaining<=0)boardSetThinking(false,instant);else if(boardState.thinkShown)boardState.thinkTimer=setTimeout(()=>{boardState.thinkTimer=0;if(!document.hidden&&boardState.latest)renderBoardUI(boardState.latest);},remaining+1);}
    else{boardState.zeroSince=null;boardSetThinking(true,instant);}
  }else boardState.zeroSince=null;
  if(ui.subs&&boardState.subMeasure!==null){let need=boardState.subMeasure;for(const number of ui.subs.querySelectorAll('.mn'))need=Math.max(need,Math.ceil(number.scrollWidth));const now=performance.now();if(need>boardState.subWidth){boardState.subWidth=need;boardState.wideAt=now;}else if(need>boardState.subMeasure)boardState.wideAt=now;else if(now-boardState.wideAt>=6000)boardState.subWidth=boardState.subMeasure;ui.subs.style.setProperty('--subnum',boardState.subWidth+'px');}
}
function boardDrawHistory(snapshot,total,heatColor,heat) {
  const history=boardState.ui.history,style=boardSelected().style;
  if(style==='neon'){const lit=Math.round(heat*24),peak=snapshot?Math.min(23,Math.round(agentSpeedVisuals.heat(snapshot.today.peakOutputTps,view.preferences.redline)*24)-1):-1;for(let i=0;i<24;i++){const segment=history.node.children[i];segment.classList.toggle('on',i<lit&&boardState.liveKnown);segment.classList.toggle('pk',i===peak&&i>=lit);segment.style.setProperty('--c',agentSpeedVisuals.color((i+1)/24,appearance));}return;}
  const end=snapshot?snapshot.updatedAt:0,points=snapshot?snapshot.series.filter(point=>point.timestamp>=end-60000&&point.timestamp<=end):[];
  if(style==='glass') {
    const max=Math.max(10,...points.map(point=>point.measuredTps+point.estimatedTps))*1.12,W=history.width,H=history.height;history.node.style.color=heatColor;let path='',last=null;
    for(const point of points){const x=(point.timestamp-(end-60000))/60000*W,y=H-(history.wide?1.5:2)-(point.measuredTps+point.estimatedTps)/max*(H-(history.wide?3:6));
      if(!last||point.timestamp-last.time>1500)path+=' M'+x.toFixed(1)+','+y.toFixed(1);else path+=' Q'+last.x.toFixed(1)+','+last.y.toFixed(1)+' '+((last.x+x)/2).toFixed(1)+','+((last.y+y)/2).toFixed(1);last={x,y,time:point.timestamp};}
    if(last)path+=' T'+last.x.toFixed(1)+','+last.y.toFixed(1);history.line.setAttribute('d',path);history.area.setAttribute('d',last?path+' L'+last.x.toFixed(1)+','+H+' L'+(points.length?(points[0].timestamp-(end-60000))/60000*W:0).toFixed(1)+','+H+' Z':'');return;
  }
  const bins=new Array(30).fill(null),counts=new Uint16Array(30),base=Math.floor(end/1000)-29;
  for(const point of points){const index=Math.floor(point.timestamp/1000)-base;if(index>=0&&index<30){bins[index]=(bins[index]||0)+point.measuredTps+point.estimatedTps;counts[index]++;}}
  for(let i=0;i<30;i++)if(counts[i])bins[i]/=counts[i];const max=Math.max(10,...bins.filter(value=>value!==null)),height=history.wide?(boardSelected().size==='small'?10:12):38;
  for(let i=0;i<30;i++){const bar=history.node.children[i];bar.style.height=Math.max(history.wide?1.5:2,bins[i]===null?0:bins[i]/max*height)+'px';bar.style.visibility=bins[i]===null?'hidden':'visible';}
}
function boardAccent(event) {
  const record=boardState.rows.get('group:'+event.id);if(!record||boardState.reduced||view.preferences.effects==='off')return;
  const sweep=record.row.querySelector('.sweep,.wipe');if(sweep){sweep.classList.remove('go');void sweep.offsetWidth;sweep.classList.add('go');}boardSetText(record.chip,'▲'+(event.from-event.to));record.chip.classList.remove('go');void record.chip.offsetWidth;record.chip.classList.add('go');
  const panel=boardState.panel.getBoundingClientRect(),row=record.row.getBoundingClientRect(),rank=record.rank.getBoundingClientRect(),x=rank.left-panel.left+rank.width/2,y=rank.top-panel.top+rank.height/2,source=getComputedStyle(record.row).getPropertyValue('--src').trim();
  boardState.effects.streak(row.left-panel.left,row.top-panel.top+row.height/2,row.right-panel.left,source);
  if(event.type==='newLeader'){
    boardState.effects.celebrate(x,y);if(boardSelected().style==='neon')boardState.effects.lightning(x+60,-6,x,y,'#FACC15');
    if(boardSelected().style==='timing'){boardState.ui.leaderBanner.classList.remove('board-pop');void boardState.ui.leaderBanner.offsetWidth;boardState.ui.leaderBanner.classList.add('board-pop');}
    const now=performance.now();if(now-boardState.lastAnnouncement>=10000){boardState.lastAnnouncement=now;boardSetText(node('board-announcement'),boardWord('newLeader')+': '+(record.entry.group.root.project||record.entry.group.root.name));}
  }else{boardState.effects.burst(x,y,14,130,.7,[source,'#FFFFFF'],60);if(boardSelected().style==='neon')boardState.effects.lightning(x,y,Math.min(panel.width-30,x+100),y-20,source);}
}
function boardRenderRows(groups,total,events,instant) {
  const plan=boardPlan(groups),present=new Set(plan.rows.map(entry=>entry.key));boardState.ui.rows.style.height=plan.height+'px';
  for(const [key,record]of boardState.rows)if(!present.has(key)&&!record.leaving){
    if(record.item.contains(document.activeElement))boardState.panel.focus({preventScroll:true});
    const animation=instant?null:boardAnimate(record.item,[{opacity:1},{opacity:0}],{duration:300,easing:'ease-out',fill:'forwards'});
    if(animation){record.leaving=true;record.leaveAnimation=animation;animation.addEventListener('finish',()=>{if(record.leaving){record.item.remove();boardState.rows.delete(key);}},{once:true});}
    else{record.item.remove();boardState.rows.delete(key);}
  }
  for(const entry of plan.rows) {
    let record=boardState.rows.get(entry.key),fresh=false;if(!record){fresh=true;record=boardCreateRow(entry.kind,entry.key);boardState.rows.set(entry.key,record);}
    if(record.leaving){record.leaving=false;if(record.leaveAnimation)record.leaveAnimation.cancel();record.leaveAnimation=null;}
    const domIndex=(boardState.ui.columns?2:1)+plan.rows.indexOf(entry),at=boardState.ui.rows.children[domIndex];
    if(at!==record.item)boardState.ui.rows.insertBefore(record.item,at||null);
    if(entry.kind==='more'){
      record.entry=entry;record.row.dataset.boardMore=entry.allGroups?'all':entry.collapse?'collapse':entry.group.id;record.item.dataset.boardGroup=entry.group?entry.group.id:'';
      boardSetText(record.name.firstElementChild,entry.collapse?boardWord('allShown'):entry.allGroups?(language==='zh'?'还有 ':'')+entry.rest+' '+boardWord('moreGroups'):(language==='zh'?'+':'+')+entry.rest+' '+boardWord('moreSubs'));
      boardSetText(record.value,boardState.liveKnown&&entry.live>=.05?boardModel.formatSpeed(entry.live):'');record.row.setAttribute('aria-label',record.name.textContent+', '+(entry.collapse?boardWord('collapse'):boardWord('expand')));
    }else{const index=groups.indexOf(entry.group);boardPaintRow(record,entry,total,index+1,index>0?groups[index-1]:null);}
    if(record.y!==entry.y){record.item.style.transform='translate3d(0,'+entry.y+'px,0)';record.y=entry.y;}
    if(fresh&&!instant)boardAnimate(record.item,[{opacity:0,translate:'0 10px'},{opacity:1,translate:'0 0'}],{duration:300,easing:'ease-out'});
  }
  boardState.ui.empty.hidden=groups.length>0;boardSetText(boardState.ui.empty,boardWord(boardState.latest?'noAgents':'scanning'));
  let capsuleWidth=0;for(const record of boardState.rows.values())if(record.entry.kind!=='more'&&!record.capsule.classList.contains('none'))capsuleWidth=Math.max(capsuleWidth,record.capsule.scrollWidth);boardState.panel.style.setProperty('--capw',Math.ceil(capsuleWidth)+'px');
  if(boardSelected().showPerformance&&boardState.perfMeasure!==null){
    let need=boardState.perfMeasure;
    for(const record of boardState.rows.values())if(!record.leaving&&record.perf.firstElementChild)need=Math.max(need,Math.ceil(record.perf.firstElementChild.scrollWidth));
    const now=performance.now();
    if(need>boardState.perfWidth){boardState.perfWidth=need;boardState.perfWideAt=now;}
    else if(need>boardState.perfMeasure)boardState.perfWideAt=now;
    else if(now-boardState.perfWideAt>=6000)boardState.perfWidth=boardState.perfMeasure;
    boardState.panel.style.setProperty('--perfw',boardState.perfWidth+'px');
  }
  if(!instant)for(const event of events)boardAccent(event);
}
function boardCloseTooltip(){clearTimeout(boardState.tooltipTimer);boardState.tooltipTimer=0;const tooltip=node('board-tooltip');if(tooltip)tooltip.hidden=true;}
function boardShowTooltip(row){boardCloseTooltip();if(boardSelected().showPerformance||!row.boardTooltipFacts)return;boardState.tooltipTimer=setTimeout(()=>{boardState.tooltipTimer=0;if(document.hidden)return;const tooltip=node('board-tooltip');boardSetText(tooltip,row.boardTooltipFacts.join('\n'));tooltip.hidden=false;const bounds=row.getBoundingClientRect(),tip=tooltip.getBoundingClientRect();tooltip.style.left=Math.max(8,Math.min(window.innerWidth-tip.width-8,bounds.left))+'px';tooltip.style.top=Math.max(8,Math.min(window.innerHeight-tip.height-8,bounds.bottom+6))+'px';},350);}
function boardTouchExpansion(){
  boardState.expandedAt=performance.now();clearTimeout(boardState.expansionTimer);boardState.expansionTimer=0;
  if((boardState.expanded||boardState.showAll)&&!document.hidden)boardState.expansionTimer=setTimeout(()=>{boardState.expansionTimer=0;boardState.expanded=null;boardState.showAll=false;if(!document.hidden&&boardState.latest)renderBoardUI(boardState.latest);},60000);
}
function boardToggleGroup(id){boardState.expanded=boardState.expanded===id?null:id;boardTouchExpansion();if(boardState.latest)renderBoardUI(boardState.latest);}
function boardActivateRow(row){const more=row.dataset.boardMore;if(more==='all'){boardState.showAll=true;boardTouchExpansion();if(boardState.latest)renderBoardUI(boardState.latest);}else if(more==='collapse'){boardState.showAll=false;boardState.expanded=null;boardTouchExpansion();if(boardState.latest)renderBoardUI(boardState.latest);}else{const item=row.closest('[data-board-group]');if(item&&item.dataset.boardGroup)boardToggleGroup(item.dataset.boardGroup);}}
function boardPause(){
  clearTimeout(boardState.thinkTimer);clearTimeout(boardState.expansionTimer);clearTimeout(boardState.titleTimer);boardState.thinkTimer=boardState.expansionTimer=boardState.titleTimer=0;boardCloseTooltip();
  if(boardState.scoreRaf)cancelAnimationFrame(boardState.scoreRaf);boardState.scoreRaf=0;
  boardState.scoreShown=boardState.scoreValue;
  for(const animation of boardState.animations)animation.cancel();boardState.animations.clear();if(boardState.effects)boardState.effects.setVisible(false);
  if(boardState.panel)for(const outgoing of boardState.panel.querySelectorAll('.ch.out'))outgoing.remove();
  for(const [key,record]of boardState.rows)if(record.leaving){record.item.remove();boardState.rows.delete(key);}
  if(boardState.panel)for(const clone of boardState.panel.querySelectorAll('.board-fold-clone,.board-score-outgoing'))clone.remove();node('board-surface').dataset.paused='true';
}
function boardDisposePanel(){
  boardPause();if(boardState.effects)boardState.effects.destroy();boardState.effects=null;if(boardState.panel){if(typeof perfHideCard==='function')perfHideCard();boardState.panel.remove();}boardState.panel=null;boardState.ui=null;boardState.rows.clear();
}
function bindBoardUI(){
  if(boardState.bound||boardState.destroyed)return;boardState.bound=true;boardState.abort=new AbortController();
  const orbPage=node('page-orb'),settings=node('board-settings');if(orbPage&&settings.parentElement!==orbPage)orbPage.append(settings);
  if(settings)monitorSelectPicker.install(settings);
  boardListen(node('board-add'),'click',()=>void boardRequest('add',()=>bridge.newBoard()));
  const footerAdd=node('new-board');if(footerAdd)boardListen(footerAdd,'click',()=>void boardRequest('add',()=>bridge.newBoard()));
  const list=node('board-settings-list');boardListen(list,'click',event=>{const remove=event.target.closest('[data-board-remove]');if(remove){const id=remove.dataset.boardRemove;void boardRequest(id,()=>bridge.removeBoard(id));return;}if(event.target.closest('label,input'))return;const row=event.target.closest('[data-board-id]');if(row)void boardRequest('select',()=>bridge.selectBoard(row.dataset.boardId));});
  boardListen(list,'change',event=>{const input=event.target.closest('[data-board-visible]');if(input){const desired=input.checked;boardRenderSettings();void boardConfigure(input.dataset.boardVisible,{visible:desired});}});
  boardListen(list,'keydown',event=>{const row=event.target.closest('[data-board-id]');if(!row||event.target!==row)return;const rows=[...list.querySelectorAll('[data-board-id]')],index=rows.indexOf(row);if(['ArrowUp','ArrowDown','Home','End'].includes(event.key)){event.preventDefault();const target=event.key==='Home'?rows[0]:event.key==='End'?rows[rows.length-1]:rows[(index+(event.key==='ArrowDown'?1:rows.length-1))%rows.length];target.focus();}else if(event.key==='Enter'||event.key===' '){event.preventDefault();void boardRequest('select',()=>bridge.selectBoard(row.dataset.boardId));}});
  for(const key of ['style','size','showPerformance','showThinking','showCost','pinned','clickThrough'])boardListen(node('board-'+key),'change',event=>{const selected=boardSelected();if(!selected)return;const value=event.target.type==='checkbox'?event.target.checked:event.target.value;boardRenderSettings();void boardConfigure(selected.id,{[key]:value});});
  boardListen(node('board-scope'),'change',event=>{const selected=boardSelected();if(!selected)return;const orbId=event.target.value;boardRenderSettings();void boardConfigure(selected.id,{orbId});});
  const surface=node('board-surface');boardListen(surface,'click',event=>{const row=event.target.closest('.item.group .row,.item.more .row');if(row)boardActivateRow(row);});
  boardListen(surface,'keydown',event=>{if(event.key==='Enter'){const row=event.target.closest('.item.group .row,.item.more .row');if(row){event.preventDefault();boardActivateRow(row);}}else if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();boardCloseTooltip();void action(()=>bridge.showMenu());}else if(event.key==='Escape'){boardCloseTooltip();if(boardState.expanded||boardState.showAll){boardState.expanded=null;boardState.showAll=false;if(boardState.latest)renderBoardUI(boardState.latest);}}else if(['ArrowDown','ArrowUp','Home','End','PageDown','PageUp'].includes(event.key)&&!event.defaultPrevented&&!document.querySelector('[data-perf-card-open=true]')){
    const rows=[...surface.querySelectorAll('.item.group .row,.item.sub .row,.item.more .row')],index=rows.indexOf(event.target),next=event.key==='Home'?0:event.key==='End'?rows.length-1:Math.max(0,Math.min(rows.length-1,index+(event.key==='ArrowUp'?-1:event.key==='PageUp'?-5:event.key==='PageDown'?5:1)));if(rows[next]){event.preventDefault();rows[next].focus({preventScroll:true});rows[next].scrollIntoView({block:'nearest'});}}
  });
  boardListen(surface,'contextmenu',event=>{event.preventDefault();boardCloseTooltip();void action(()=>bridge.showMenu());});
  boardListen(surface,'pointerover',event=>{const row=event.target.closest('.item .row');if(row&&!row.contains(event.relatedTarget))boardShowTooltip(row);});boardListen(surface,'pointerout',event=>{const row=event.target.closest('.item .row');if(row&&!row.contains(event.relatedTarget))boardCloseTooltip();});
  boardListen(surface,'focusin',event=>{const row=event.target.closest('.item .row');if(row)boardShowTooltip(row);});boardListen(surface,'focusout',boardCloseTooltip);
  boardListen(surface,'wheel',()=>{if(boardState.expanded||boardState.showAll)boardTouchExpansion();});
  boardListen(surface,'pointerdown',()=>{if(boardState.expanded||boardState.showAll)boardTouchExpansion();});
  boardListen(document,'visibilitychange',()=>{if(document.hidden)boardPause();else if(!boardState.destroyed&&view)renderBoardUI(view.snapshot);});
  boardListen(boardContrastMedia,'change',()=>{if(!boardState.destroyed&&view)renderBoardUI(view.snapshot);});
  boardListen(window,'resize',()=>{boardCloseTooltip();if(!document.hidden&&boardState.latest)renderBoardUI(boardState.latest);});
  boardListen(window,'pagehide',destroyBoardUI);
  boardRenderSettings();
}
function renderBoardUI(snapshot){
  if(boardState.destroyed||!view)return;boardRenderSettings();const surface=node('board-surface'),config=boardSelected(),isBoard=view.surface==='board';surface.hidden=!isBoard;
  if(!isBoard||!config||!config.visible||document.hidden){boardPause();if(boardState.panel&&typeof perfHideCard==='function')perfHideCard();return;}
  const reduce=reducedMotion.matches;if(reduce&&!boardState.reduced)boardPause();
  boardState.latest=snapshot||null;boardState.liveKnown=!!snapshot&&!!liveFacts();boardState.reduced=reduce;boardState.contrast=boardContrastMedia.matches;
  const scope=boardScopeKey(snapshot);if(scope!==boardState.scopeKey){boardDisposePanel();boardState.scopeKey=scope;boardState.ranking.reset();boardState.expanded=null;boardState.showAll=false;boardState.previousLive=null;boardState.previousPeak=null;boardState.scoreValue=null;boardState.scoreShown=null;boardState.zeroSince=null;boardState.thinkShown=true;boardState.title={level:0,candidate:0,pending:null,pendingSince:0,belowFirstSince:null};boardCloseTooltip();}
  const key=JSON.stringify([config.id,config.style,config.size,config.showPerformance,config.showThinking,config.showCost,language,snapshot&&snapshot.pricing.currency]);const fresh=key!==boardState.key||!boardState.panel;
  if(fresh){boardState.key=key;boardCreatePanel(snapshot);}const panel=boardState.panel,ui=boardState.ui,size=boardSizes[config.size];
  surface.style.setProperty('--board-side',size.side+'px');surface.dataset.clickThrough=String(config.clickThrough);surface.dataset.effects=view.preferences.effects;surface.dataset.paused='false';surface.classList.toggle('board-motion-reduced',boardState.reduced);panel.dataset.theme=appearance;ui.currency=boardCurrency(snapshot);
  if((boardState.expanded||boardState.showAll)&&performance.now()-boardState.expandedAt>=60000){boardState.expanded=null;boardState.showAll=false;}
  const agents=snapshot?snapshot.agents:[],values=snapshot&&snapshot.performance?snapshot.performance.current:null,total=boardModel.aggregate(agents,values),grouped=boardModel.groups(agents,values),ranked=boardState.ranking.tick(grouped,scope,snapshot?Math.floor(snapshot.updatedAt/500):0);
  const live=boardState.liveKnown?total.live:null,heat=agentSpeedVisuals.heat(live||0,view.preferences.redline),color=agentSpeedVisuals.color(Math.max(config.style==='timing'?.1:.06,heat),appearance),softColor=agentSpeedVisuals.color(heat,appearance);
  const active=boardState.liveKnown&&(total.generating>0||total.live>=.05);surface.dataset.idle=String(!active);panel.dataset.redline=String(heat>.85);
  panel.style.setProperty('--heat',color);panel.style.setProperty('--heat-2',agentSpeedVisuals.color(Math.min(1,heat+.18),appearance));panel.style.setProperty('--heat-soft','color-mix(in srgb,'+softColor+' 55%,transparent)');panel.style.setProperty('--heat-amount',String(heat));panel.style.setProperty('--maxc',agentSpeedVisuals.color(.82,appearance));panel.style.setProperty('--topa',agentSpeedVisuals.color(.72,appearance));panel.style.setProperty('--topb',agentSpeedVisuals.color(1,appearance));panel.style.setProperty('--breath',(3.2-2.2*heat).toFixed(2)+'s');
  boardState.effects.setVisible(true);boardState.effects.update({heat,overdrive:Math.min(1,Math.max(0,((live||0)/view.preferences.redline-1)/.5)),active,reduced:boardState.reduced,contrast:boardState.contrast,intensity:{off:0,soft:1,standard:2,max:3}[view.preferences.effects],maxFps:view.maxFps,color,headColor:agentSpeedVisuals.color(Math.min(1,heat+.12),appearance),tailColor:agentSpeedVisuals.color(Math.max(.1,heat-.15),appearance),starColors:Array.from({length:16},(_,index)=>agentSpeedVisuals.color(Math.min(1,heat+(index%5)*.06),appearance))});
  boardRoll(ui.number,boardModel.formatSpeed(live),live!==null&&live>=(boardState.previousLive||0),fresh);boardSetText(ui.title,boardTrackedTitle(live));
  boardSetText(ui.counts,boardState.liveKnown?(config.style==='timing'?(language==='zh'?'生成 ':'GEN '):'· '+boardWord('generating')+' ')+total.generating+' · '+(config.style==='timing'?(language==='zh'?'工具 ':'TOOL '):boardWord('tools')+' ')+total.tools:'');if(ui.live)ui.live.classList.toggle('idle',!active);
  ui.value.title=boardState.liveKnown&&total.estimated>0?boardWord('estimate')+': '+boardModel.formatSpeed(total.estimated)+' tok/s':'';
  boardSetText(ui.today,snapshot?boardModel.formatSpeed(snapshot.today.outputTokens):'–');boardSetText(ui.peak,snapshot?boardModel.formatSpeed(snapshot.today.peakOutputTps):'–');
  const usage=snapshot&&snapshot.today,knownCost=usage&&!(usage.requests>0&&usage.unpricedRequests>=usage.requests)&&ui.currency.rate!==null;
  const amount=knownCost?boardModel.amountNumber(usage.costUsd*ui.currency.rate,ui.currency.digits):'–';
  boardSetText(ui.todayCost,knownCost?(usage.unpricedRequests>0?'≥':'')+ui.currency.symbol+(/[A-Za-z]$/.test(ui.currency.symbol)?'\u00a0':'')+amount:'–');
  const coverage=[];if(!boardState.liveKnown)coverage.push(boardWord(snapshot&&snapshot.status==='scanning'?'scanning':'unavailable'));if(snapshot&&(snapshot.coverage.limited||snapshot.status==='partial'))coverage.push(boardWord('partial'));if(config.showPerformance&&snapshot&&snapshot.performance){if(snapshot.performance.scanning)coverage.push(boardWord('perfScan'));if(snapshot.performance.limited)coverage.push(boardWord('perfLimited'));}boardSetText(ui.coverage,coverage.join(' · '));ui.coverage.hidden=coverage.length===0;
  boardDrawHistory(snapshot,total,color,heat);boardPaintMetrics(total,fresh);boardRenderRows(ranked.groups,total,ranked.events,fresh);
  if(!fresh&&live!==null&&boardState.previousLive!==null&&live>boardState.previousLive*1.08+20&&!boardState.reduced&&view.preferences.effects!=='off') {
    boardAnimate(ui.number,[{scale:1},{scale:1.06},{scale:1}],{duration:400,easing:'cubic-bezier(.2,.8,.2,1)'});const bounds=ui.number.getBoundingClientRect(),root=panel.getBoundingClientRect(),x=bounds.left-root.left+bounds.width/2,y=bounds.top-root.top+bounds.height/2;boardState.effects.burst(x,y,22,150,.9,[color,'#FFF7D6'],-40);if(config.style==='neon')boardState.effects.lightning(x-30,y,x+30,y,color);
  }
  const peak=snapshot?snapshot.today.peakOutputTps:null,peakSequence=view.activity.peakSequence;if(!fresh&&peak!==null&&boardState.previousPeak!==null&&peak>boardState.previousPeak&&boardState.previousPeakSequence!==null&&peakSequence>boardState.previousPeakSequence&&boardState.liveKnown&&!boardState.reduced&&view.preferences.effects!=='off') {
    ui.peakBadge.classList.remove('board-pop');void ui.peakBadge.offsetWidth;ui.peakBadge.classList.add('board-pop');const bounds=ui.number.getBoundingClientRect(),root=panel.getBoundingClientRect();boardState.effects.wave(bounds.left-root.left+bounds.width/2,bounds.top-root.top+bounds.height/2,'#FACC15',.65,1.1);boardAnimate(ui.number,[{filter:'brightness(1.8)',color:'#FFE58A'},{filter:'brightness(1)',color:'var(--ink)'}],{duration:800,easing:'ease-out'});
  }
  boardState.previousLive=live;boardState.previousPeak=peak;boardState.previousPeakSequence=peakSequence;
  if(fresh||performance.now()-boardState.lastAriaAt>=1000){const cost=boardCost(total,ui.currency);panel.setAttribute('aria-label',boardWord('title')+', '+boardScopeLabel(config.orbId)+': '+boardModel.formatSpeed(live)+' tok/s, '+ui.title.textContent+(config.showPerformance?', '+boardScoreWords(total.score):'')+(config.showThinking&&boardState.thinkShown?', '+boardWord('thinking')+' '+boardModel.formatSpeed(boardState.liveKnown?total.thinking:null)+' tok/s':'')+(config.showCost?', '+boardWord('cost')+' '+(boardState.liveKnown?(cost.partial?'≥':'')+cost.text+' '+cost.unit:'–'):'')+(coverage.length?', '+coverage.join(', '):''));boardState.lastAriaAt=performance.now();}
}
function destroyBoardUI(){
  if(boardState.destroyed)return;boardState.destroyed=true;boardDisposePanel();if(boardState.abort)boardState.abort.abort();boardState.abort=null;boardState.settingsRows.clear();boardState.pending.clear();boardState.latest=null;boardState.ranking.reset();boardCloseTooltip();if(typeof perfHideCard==='function')perfHideCard();
}
`;
