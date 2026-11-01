// Agent Speed v1.6.1 (MIT), frozen 384ce020cc655133e95aaad5cc085f3985f0ed99.
// Windows Settings/TitleThemes/{TitleThemesSection.xaml,TitleThemesStyles.xaml,TitleField.cs,
// TitleThemesSection.xaml.cs,TitleSetEditorViewModel.cs,TitleEditorPreviews.cs}; Presentation/Titles.
// Native creation order, immediate delete/reset with eight-second Undo, and explicit title-level previews are retained.
import {
  TITLE_EMOJI_PRESENTATION_RANGES,
  TITLE_EMOJI_RANGES,
  TITLE_PRESET_IDS,
  TITLE_PRESET_NAMES,
} from "./title-themes.js";

export const MONITOR_TITLE_THEMES_CSS = String.raw`
.tt-root{margin-top:20px;min-width:0}.tt-group{border:1px solid var(--card-line);border-radius:4px;background:var(--card);padding:14px 16px 16px;min-width:0}.tt-heading{display:flex;align-items:center;gap:18px;margin-bottom:14px}.tt-heading>.symbol{font-size:20px;margin-left:2px}.tt-heading h2{font-size:14px;font-weight:400;margin:0;line-height:20px}.tt-root p{margin:0;font-size:12px;color:var(--secondary);line-height:18px}.tt-heading p{margin-top:1px}.tt-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.tt-root[data-card-columns="2"] .tt-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.tt-custom-heading{font-size:12px;font-weight:600;color:var(--secondary);margin:14px 2px 8px}.tt-card{position:relative;min-width:0;height:64px}.tt-card-select,.tt-new{height:64px;min-height:64px;width:100%;padding:0 12px;border:0;border-radius:8px;background:var(--subtle);text-align:left;min-width:0;position:relative;transition:background-color .2s ease-out}.tt-card-select:hover{background:color-mix(in srgb,var(--hover) 60%,var(--subtle))}.tt-card-select[aria-checked="true"]{box-shadow:inset 0 0 0 2px var(--accent-fill);background:color-mix(in srgb,var(--accent-fill) 10%,var(--subtle))}.tt-card-select:focus-visible,.tt-new:focus-visible{outline-offset:3px;border-radius:8px}.tt-card-name{display:block;font-size:13px;font-weight:600;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tt-card-select[aria-checked="true"] .tt-card-name{margin-right:22px}.tt-card[data-custom="true"]:is(:hover,:focus-within) .tt-card-name{margin-right:30px}.tt-card[data-custom="true"]:is(:hover,:focus-within) .tt-card-select[aria-checked="true"] .tt-card-name{margin-right:50px}.tt-strip{display:block;height:16px;font-size:11px;font-weight:400;line-height:16px;margin-top:5px;white-space:nowrap;overflow:hidden;color:var(--tertiary)}.tt-card-select[aria-checked="true"]:after{content:'\E73E';font-family:'Segoe Fluent Icons','Segoe MDL2 Assets';position:absolute;right:8px;top:9px;width:16px;height:16px;border-radius:50%;background:var(--accent-fill);color:white;font-size:9px;line-height:16px;text-align:center;font-weight:700}body[data-appearance="dark"] .tt-card-select[aria-checked="true"]:after{color:#000}.tt-more{position:absolute;right:8px;top:7px;width:24px;height:20px;min-height:20px;padding:0;border:0;background:transparent;color:var(--secondary);opacity:0;transition:opacity .2s ease-out;font-size:14px;line-height:20px}.tt-card-select[aria-checked="true"]~.tt-more{right:28px}.tt-card:is(:hover,:focus-within) .tt-more{opacity:1}.tt-new{display:flex;align-items:center;justify-content:center;gap:8px;border:1px dashed var(--tertiary);background:transparent;color:var(--accent);font-size:13px;font-weight:600}.tt-new:hover:not(:disabled){border-color:var(--accent-fill);background:var(--hover)}.tt-new:disabled{opacity:.45}.tt-new .symbol{font-size:12px}.tt-undo{display:flex;align-items:center;gap:12px;margin-top:8px;padding:6px 8px 6px 16px;font-size:13px;min-height:40px}.tt-undo>.symbol{font-size:14px;color:var(--secondary)}.tt-undo-text{flex:1;min-width:0;overflow-wrap:anywhere}.tt-link{border:0;background:transparent;min-height:28px;padding:4px;font-size:13px;color:var(--accent);white-space:nowrap}.tt-link:hover{background:var(--hover)}.tt-undo .tt-link{font-weight:600}.tt-delete{color:#c42b1c}body[data-appearance="dark"] .tt-delete{color:#ff99a4}.tt-editor{margin-top:8px;overflow:clip}.tt-editor h2{font-size:17px;font-weight:600;font-family:'Segoe UI Variable Display','Segoe UI','Microsoft YaHei UI',sans-serif;line-height:23px;margin:0 0 14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tt-editor-grid{display:grid;grid-template-columns:minmax(0,1fr) 200px;gap:24px;align-items:start}.tt-form{min-width:0}.tt-meta{display:grid;grid-template-columns:minmax(64px,max-content) minmax(0,1fr);gap:8px 12px;align-items:center;font-size:13px}.tt-meta>label{color:var(--secondary)}.tt-meta input{width:100%;height:32px;min-width:0;padding:4px 11px;font-size:13px;border:1px solid var(--control-line);border-bottom-color:var(--tertiary);border-radius:4px;background:var(--control)}.tt-meta input:focus{outline:none;border-bottom:2px solid var(--accent-fill)}.tt-meta select{min-width:200px;max-width:100%;justify-self:start;font-size:13px}.tt-base-hint{margin-top:8px!important}.tt-vehicle-hint{margin-top:2px!important}.tt-table{margin-top:14px;min-width:0}.tt-table-head,.tt-field-row{display:grid;grid-template-columns:24px 80px 12px minmax(0,1fr) 4px 26px;align-items:center;padding-right:4px}.tt-table-head{height:26px;color:var(--secondary);font-size:12px;font-weight:600}.tt-table-head .tt-speed-heading{grid-column:1/3;text-align:right}.tt-table-head .tt-title-heading{grid-column:4;padding-left:10px}.tt-field-row{height:30px;border-top:1px solid var(--line);position:relative;transition:background-color .2s ease-out}.tt-field-row:last-child{border-bottom:1px solid var(--line)}.tt-field-row:focus-within{background:color-mix(in srgb,var(--accent-fill) 9%,transparent);border-radius:4px}.tt-level{grid-column:1;font-size:11px;text-align:right;color:var(--tertiary)}.tt-threshold{grid-column:2;font-size:13px;font-weight:600;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tt-field-row[data-level="0"] .tt-threshold{font-weight:400;color:var(--secondary)!important}.tt-field{grid-column:4;width:100%;min-width:0;height:26px;padding:0 11px;font-size:13px;border:1px solid var(--control-line);border-radius:4px;background:var(--control);color:var(--text);line-height:24px;caret-color:var(--text)}.tt-field::placeholder{color:var(--tertiary);opacity:1}.tt-field:focus{outline:none;border-bottom:2px solid var(--accent-fill)}.tt-reset{grid-column:6;width:26px;height:26px;min-height:26px;min-width:0;padding:0;border:0;background:transparent;color:var(--secondary);font-size:12px;opacity:1;transition:opacity .2s ease-out}.tt-reset:disabled{opacity:0}.tt-notice,.tt-error{padding:8px 12px;margin-top:12px;border-radius:4px;background:#fff4ce;color:var(--text);font-size:12px;line-height:18px;display:flex;gap:10px;align-items:start;overflow-wrap:anywhere}.tt-notice>.symbol,.tt-error>.symbol{font-size:14px;flex:none}body[data-appearance="dark"] .tt-notice,body[data-appearance="dark"] .tt-error{background:#433519}.tt-length-hint{margin-top:10px!important}.tt-footer{display:flex;align-items:center;gap:12px;margin:10px -4px 0}.tt-footer .tt-delete{margin-left:auto}.tt-previews{position:sticky;top:12px;min-width:0}.tt-preview-heading{font-size:12px;font-weight:600;color:var(--secondary);margin:0 2px 8px}.tt-preview-cards{display:grid;gap:8px}.tt-preview-card{padding:24px 0 10px;border-radius:8px;background:var(--subtle);min-width:0;overflow:hidden;text-align:center}.tt-preview-viewport{width:112px;height:112px;margin:0 auto;position:relative;overflow:visible;pointer-events:none}.tt-preview-orb-viewport{width:96px;height:96px}.tt-preview-orb-viewport>.as-orb-art{position:absolute;left:-24px;top:-24px}.tt-preview-caption{margin:20px 8px 0!important;font-size:12px!important;line-height:18px!important;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tt-root[data-editor-narrow="true"] .tt-editor-grid{grid-template-columns:minmax(0,1fr);gap:12px}.tt-root[data-editor-narrow="true"] .tt-previews{position:static;grid-row:1}.tt-root[data-editor-narrow="true"] .tt-preview-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.tt-root[data-editor-narrow="true"] .tt-form{grid-row:2}.tt-menu{position:fixed;z-index:110;min-width:164px;padding:4px;border:1px solid var(--control-line);border-radius:8px;background:var(--popup);color:var(--text);box-shadow:var(--shadow);font-size:13px;animation:tt-menu-open .167s cubic-bezier(.1,.8,.2,1)}.tt-menu button{display:block;width:100%;min-height:32px;border:0;background:transparent;padding:6px 10px;text-align:left;font-size:13px;border-radius:4px}.tt-menu button:hover,.tt-menu button:focus{outline:none;background:var(--hover)}.tt-menu button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.tt-appear{animation:tt-card-appear .35s linear}.tt-root[data-reduced="true"] .tt-appear{animation:tt-card-fade .2s ease-out}@keyframes tt-card-appear{0%{opacity:0;transform:scale(.85)}25%{opacity:1;transform:scale(.947)}50%{transform:scale(.994)}70%{transform:scale(1.002)}100%{opacity:1;transform:scale(1)}}@keyframes tt-card-fade{from{opacity:0}to{opacity:1}}@keyframes tt-menu-open{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}@media(prefers-reduced-motion:reduce){.tt-root *,.tt-menu{animation:none!important;transition:none!important}}@media(forced-colors:active){.tt-card-select[aria-checked="true"]{outline:2px solid Highlight;box-shadow:none}.tt-field:focus,.tt-meta input:focus{border-bottom-color:Highlight}.tt-strip span,.tt-threshold{color:CanvasText!important}.tt-new{border-color:ButtonText}}
.tt-editor-reveal{margin-top:8px;min-width:0}.tt-editor-reveal>.tt-editor{margin-top:0}
.tt-card-select{display:flex;flex-direction:column;justify-content:center;align-items:stretch}.tt-card-name,.tt-strip{flex-shrink:0;max-width:100%}.tt-strip{width:100%}
`;

/** A template, so html.ts can inject it once without placing settings controls on the other surfaces. */
export const MONITOR_TITLE_THEMES_MARKUP = String.raw`
<template id="title-themes-template"><section class="tt-root" aria-labelledby="tt-heading">
  <div class="tt-group tt-cards-group"><header class="tt-heading"><span class="symbol" aria-hidden="true">&#xE8EC;</span><div><h2 id="tt-heading" data-tt-text="theme"></h2><p data-tt-text="hint"></p></div></header><div class="tt-card-group" role="radiogroup" aria-labelledby="tt-heading"><div class="tt-grid tt-presets"></div><h3 class="tt-custom-heading" data-tt-text="custom"></h3><div class="tt-grid tt-customs"><button class="tt-new" data-tt-action="new" data-theme-card="new" type="button"><span class="symbol" aria-hidden="true">&#xE710;</span><span data-tt-text="new"></span></button></div></div></div>
  <div class="tt-group tt-undo" hidden><span class="symbol" aria-hidden="true">&#xE7A7;</span><span class="tt-undo-text" role="status" aria-live="polite"></span><button class="tt-link" type="button" data-tt-action="undo" data-tt-text="undo"></button></div>
  <div class="tt-error" role="status" aria-live="polite" hidden><span class="symbol" aria-hidden="true">&#xE7BA;</span><span class="tt-error-text"></span></div>
  <section class="tt-group tt-editor" aria-labelledby="tt-editor-heading" hidden><h2 id="tt-editor-heading"></h2><div class="tt-editor-grid"><div class="tt-form"><div class="tt-meta"><label for="tt-name" data-tt-text="name"></label><input id="tt-name" maxlength="64" autocomplete="off" spellcheck="false"><label for="tt-base" data-tt-text="base"></label><select id="tt-base" aria-describedby="tt-base-hint"></select></div><p id="tt-base-hint" class="tt-base-hint"></p><p class="tt-vehicle-hint" data-tt-text="vehicleArt"></p><div class="tt-table" role="group" aria-labelledby="tt-title-column"><div class="tt-table-head"><span class="tt-speed-heading"></span><span id="tt-title-column" class="tt-title-heading" data-tt-text="titleColumn"></span></div><div class="tt-rows"></div></div><div class="tt-notice" role="status" aria-live="polite" hidden><span class="symbol" aria-hidden="true">&#xE7BA;</span><span class="tt-notice-text"></span></div><p class="tt-length-hint" data-tt-text="lengthHint"></p><footer class="tt-footer"><button class="tt-link" type="button" data-tt-action="resetAll" data-tt-text="resetAll"></button><button class="tt-link" type="button" data-tt-action="duplicate" data-tt-text="duplicate"></button><button class="tt-link tt-delete" type="button" data-tt-action="delete" data-tt-text="delete"></button></footer></div><aside class="tt-previews" aria-labelledby="tt-preview-heading"><h3 id="tt-preview-heading" class="tt-preview-heading" data-tt-text="preview"></h3><div class="tt-preview-cards"><div class="tt-preview-card" data-title-preview="dashboard"><div class="tt-preview-viewport tt-preview-hero"></div><p class="tt-preview-caption" data-tt-text="dashboard"></p></div><div class="tt-preview-card" data-title-preview="orb"><div class="tt-preview-viewport tt-preview-orb-viewport"><div class="tt-preview-orb"></div></div><p class="tt-preview-caption tt-orb-caption"></p></div></div></aside></div></section>
  <div class="tt-menu" role="menu" hidden></div>
</section></template>
`;

export const MONITOR_TITLE_THEMES_SCRIPT =
  `const monitorTitleThemes = (() => {\n'use strict';\n` +
  `const presetIds=${JSON.stringify(TITLE_PRESET_IDS)},presetNames=${JSON.stringify(TITLE_PRESET_NAMES)};\n` +
  `const emojiPresentation=${JSON.stringify(TITLE_EMOJI_PRESENTATION_RANGES)},emojiRanges=${JSON.stringify(TITLE_EMOJI_RANGES)};\n` +
  String.raw`
const strings={en:{theme:'Title Theme',hint:"The orbs, the dashboard and screen readers use this theme's speed titles.",custom:'Custom',new:'New Custom Titles',copyName:'%@ (Custom)',duplicateEdit:'Duplicate and Edit',edit:'Edit',duplicate:'Duplicate',delete:'Delete',didDelete:'Deleted “%@”',didReset:'Reset all titles of “%@”',limit:'You can have up to 8 custom title sets',editing:'Editing “%@”',name:'Name',base:'Based On',baseHint:'Empty fields use the %@ titles and follow the language.',idleRow:'When Idle',speedColumn:'Speed (%@)',titleColumn:'Title',reset:'Reset to “%@”',resetAll:'Reset All',lengthHint:'Each title fits about 7 Chinese characters or 10 Latin letters, so it stays readable on the orb.',tooLong:'That title was too long for the orb, so it was shortened.',noEmoji:"Titles are drawn in the speed color, so color emoji can't be used.",vehicleArt:'The dashboard keeps showing the vehicle of each level.',preview:'Preview',rowLabel:'Level %d title, from %@; empty uses “%@”',idleLabel:'Idle title; empty uses “%@”',more:'More Actions',undo:'Undo',dashboard:'Dashboard',orb:'Floating orb · 96 pt',storage:'Unable to save custom title changes.',invalid:'This title change is invalid.',missing:'This custom title set is no longer available.',expired:'The undo period has ended.'},zh:{theme:'称号主题',hint:'悬浮窗、面板和屏幕阅读器都会使用这个主题的速度称号。',custom:'自定义',new:'新建自定义称号',copyName:'%@（自定义）',duplicateEdit:'复制并编辑',edit:'编辑',duplicate:'复制',delete:'删除',didDelete:'已删除“%@”',didReset:'已还原“%@”的所有称号',limit:'最多可以有 8 组自定义称号',editing:'编辑“%@”',name:'名称',base:'基于',baseHint:'留空的字段会使用“%@”的称号，并随语言切换。',idleRow:'待机时',speedColumn:'速度（%@）',titleColumn:'称号',reset:'还原为“%@”',resetAll:'全部还原',lengthHint:'每个称号最多约 7 个汉字或 10 个英文字母，才放得进悬浮窗。',tooLong:'称号太长，已缩短到悬浮窗放得下的长度。',noEmoji:'称号以速度颜色显示，无法使用彩色表情符号。',vehicleArt:'面板会继续显示各级对应的交通工具动画。',preview:'预览',rowLabel:'第 %d 级称号，%@ 以上；留空时为“%@”',idleLabel:'待机时的称号；留空时为“%@”',more:'更多操作',undo:'撤销',dashboard:'面板',orb:'悬浮窗 · 96 pt',storage:'未能保存自定义称号更改。',invalid:'这次称号更改无效。',missing:'这组自定义称号已不存在。',expired:'撤销时限已结束。'}};
const fractions=[0,0,.02,.03,.04,.06,.08,.12,.17,.24,.34,.5,.7,1],stripLevels=[1,5,9,13],stripChoices=[[0,1,2,3],[0,2,3],[0,1,3],[0,3],[3],[0]];
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'}),measureCanvas=document.createElement('canvas'),measure=measureCanvas.getContext('2d');
let binding=null,view=null,look={language:'en',appearance:'light',reducedMotion:false,visible:false},resultState=null,localDraft=null,selection=null,selectionFrom=null,selectedSetId=null,focusedLevel=null,pending=Promise.resolve(),draftTimer=0,noticeTimer=0,expiryTimer=0,renderFrame=0,shown=false,closing=false,menuReturn=null;
const cards=new Map(),rows=[];let heroArt=null,orbArt=null,resizeObserver=null,intersectionObserver=null,previewsIntersect=false,previewsActive=false,previewSignature=null,errorCode=null;
function tr(key,value){return (strings[look.language==='zh'?'zh':'en'][key]||key).replace('%@',value===undefined?'':String(value));}
function elements(text){return Array.from(segmenter.segment(text),part=>part.segment);}
function contains(ranges,value){let lo=0,hi=ranges.length/2-1;while(lo<=hi){const mid=(lo+hi)>>>1;if(value<ranges[mid*2])hi=mid-1;else if(value>ranges[mid*2+1])lo=mid+1;else return true;}return false;}
function sanitize(value,limit=24){let raw='',space=true;for(const original of String(value||'').slice(0,4096).normalize('NFC')){const scalar=original.length===1&&original.charCodeAt(0)>=0xD800&&original.charCodeAt(0)<=0xDFFF?'\uFFFD':original;if(/^[\p{Zs}\u0009-\u000D\u0085]$/u.test(scalar)){if(!space)raw+=' ';space=true;}else if(!/^[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]$/u.test(scalar)){raw+=scalar;space=false;}}let text='',removedEmoji=false,count=0;for(const part of elements(raw)){let color=false,variation=false,emoji=false;for(const scalar of part){const point=scalar.codePointAt(0);if(contains(emojiPresentation,point)){color=true;break;}variation=variation||point===0xFE0F||point===0x20E3;emoji=emoji||contains(emojiRanges,point);}if(color||variation&&emoji){removedEmoji=true;continue;}if(count>=limit)break;text+=part;count++;}return {text:text.split(' ').filter(Boolean).join(' '),removedEmoji};}
function font(size,weight){return weight+' '+size+'px "Segoe UI Variable Text","Segoe UI",'+(look.language==='zh'?'"Microsoft YaHei UI","Microsoft JhengHei UI"':'"Microsoft JhengHei UI","Microsoft YaHei UI"')+',"Yu Gothic UI",sans-serif';}
function fitted(text){if(!measure)throw new Error('Title measurement unavailable');measure.font=font(7,600);measure.letterSpacing='0px';const shown=value=>look.language==='en'?value.toUpperCase():value;if(measure.measureText(shown(text)).width<=51.5)return {text,cut:false};const parts=elements(text);let lo=0,hi=parts.length;while(lo<hi){const mid=(lo+hi+1)>>>1;if(measure.measureText(shown(parts.slice(0,mid).join(''))).width<=51.5)lo=mid;else hi=mid-1;}return {text:parts.slice(0,lo).join('').trim(),cut:true};}
function state(){const incoming=view&&view.titleThemes;if(resultState&&(!incoming||resultState.revision>=incoming.revision))return resultState;resultState=null;return incoming||{version:1,revision:0,custom:[],draft:null,undo:null,error:false};}
function currentSelection(){return selection||(view&&view.preferences.titleTheme)||'vehicles';}
function resolve(source,id,language){const presets=(binding&&binding.visuals||agentSpeedVisuals).themes,custom=source&&source.custom&&source.custom.find(set=>set.id===id)||null,base=custom&&custom.base||((presetIds.includes(id))?id:'vehicles'),preset=presets[base]||presets.vehicles,lang=language==='zh'?'zh':'en',draft=localDraft&&localDraft.id===id?localDraft:source&&source.draft&&source.draft.id===id?source.draft:null;const texts=Array.from({length:14},(_,level)=>{let value=custom?(level===0?custom.idle:custom.titles[level-1]):'';if(draft&&draft.level===level)value=sanitize(draft.text).text;return value||preset[lang][level]||'';});const presetName=preset.name[lang==='zh'?0:1];return {id:custom?custom.id:base,base,name:custom&&(custom.name||(lang==='zh'?presetName+'（自定义）':presetName+' (Custom)'))||presetName,texts,labels:lang==='en'?texts.map(text=>text.toUpperCase()):texts.slice(),showsVehicleArt:base==='vehicles',custom};}
function threshold(level){return level===0?0:level===1?.5:fractions[level]*(view&&view.preferences.redline||2000);}
function thresholdText(level){const value=threshold(level);return value>=1000?(value/1000).toFixed(2)+'k':value<1?value.toFixed(1):String(Math.round(value));}
function heatColor(level){const visuals=binding.visuals;return visuals.color(visuals.heat(threshold(level),view.preferences.redline),look.appearance);}
function announceError(code){errorCode=code||'storage';if(binding){const error=binding.root.querySelector('.tt-error');error.hidden=false;error.querySelector('.tt-error-text').textContent=tr(errorCode);}}
function changed(){if(binding&&binding.onDraft)binding.onDraft();scheduleRender();}
function scheduleRender(){if(renderFrame||!binding)return;renderFrame=requestAnimationFrame(()=>{renderFrame=0;if(binding&&view)paint();});}
function send(command) {
  const active=binding;
  const request=pending.then(async()=>{
    if(!active||closing)return null;
    let result;
    try {
      if(typeof active.bridge.commandTitleTheme!=='function')throw new Error('Missing title theme bridge');
      result=await active.bridge.commandTitleTheme(command);
    } catch {
      announceError('storage');
      return null;
    }
    if(binding!==active)return result;
    if(!result||!result.ok) {
      if(result&&result.state)resultState=result.state;
      announceError(result&&result.error||'storage');
      scheduleRender();
      return result;
    }
    resultState=result.state;
    errorCode=null;
    if(result.selected){selection=result.selected;selectionFrom=view&&view.preferences.titleTheme;}
    changed();
    return result;
  });
  pending=request.catch(()=>{});
  return request;
}
async function select(id,focusName=false) {
  try { await flush(); } catch { return; }
  if(!binding)return;
  const active=binding;
  try {
    await active.bridge.configure({titleTheme:id});
    if(binding!==active)return;
    selection=id;selectionFrom=view&&view.preferences.titleTheme;errorCode=null;localDraft=null;focusedLevel=null;
    paint();changed();
    if(focusName)focusNameBox();
  } catch { announceError('storage'); }
}
async function duplicate(id) {
  try { await flush(); } catch { return; }
  const result=await send({type:'copy',sourceId:id,language:look.language});
  if(result&&result.ok&&result.selected&&binding) {
    selectedSetId=null;
    paint();focusNameBox();
  }
}
function focusNameBox(){if(!binding)return;const input=binding.root.querySelector('#tt-name');input.focus();input.select();input.scrollIntoView({block:'nearest'});}
function showNotice(key){clearTimeout(noticeTimer);if(!binding)return;const box=binding.root.querySelector('.tt-notice');box.hidden=false;box.querySelector('.tt-notice-text').textContent=tr(key);noticeTimer=setTimeout(()=>{noticeTimer=0;if(binding)binding.root.querySelector('.tt-notice').hidden=true;},4000);}
function stage(row,restart=true){if(!binding||!row.id)return;row.version++;localDraft={id:row.id,level:row.level,text:row.input.value};row.reset.disabled=!row.input.value;clearTimeout(draftTimer);draftTimer=setTimeout(()=>{draftTimer=0;if(localDraft)send({type:'setDraft',id:localDraft.id,level:localDraft.level,text:localDraft.text.slice(0,4096)});},16);clearTimeout(row.timer);if(restart&&!row.composing)row.timer=setTimeout(()=>commitRow(row),800);changed();}
function commitRow(row) {
  clearTimeout(row.timer);row.timer=0;
  if(!row.id||row.input.value===row.model)return Promise.resolve(true);
  if(row.composing)return Promise.resolve(false);
  if(row.commitPromise&&row.pendingText===row.input.value)return row.commitPromise;
  const id=row.id,version=row.version,typed=row.input.value,language=look.language,clean=sanitize(typed);
  let fit;
  try { fit=fitted(clean.text); } catch { announceError('invalid');return Promise.resolve(false); }
  row.committing++;row.pendingText=typed;
  const operation=send({type:'setField',id,level:row.level,text:fit.text,language}).then(result=>{
    if(!result||!result.ok)return false;
    const stored=result.commit?result.commit.text:fit.text;
    if(row.id===id) {
      row.model=stored;
      if(row.version===version&&!row.composing)row.input.value=stored;
      row.reset.disabled=!row.input.value;
    }
    if(localDraft&&localDraft.id===id&&localDraft.level===row.level&&row.version===version)localDraft=null;
    if(fit.cut||result.commit&&result.commit.cut)showNotice('tooLong');
    else if(clean.removedEmoji||result.commit&&result.commit.removedEmoji)showNotice('noEmoji');
    changed();
    return true;
  }).finally(()=>{
    row.committing--;
    if(row.commitPromise===operation){row.commitPromise=null;row.pendingText=null;}
  });
  row.commitPromise=operation;
  return operation;
}
async function commitName() {
  if(!binding||!selectedSetId)return true;
  const input=binding.root.querySelector('#tt-name'),id=selectedSetId,set=state().custom.find(item=>item.id===id);
  if(!set||input.value===set.name)return true;
  const typed=input.value,result=await send({type:'rename',id,name:typed.slice(0,4096)});
  if(!result||!result.ok)return false;
  if(binding&&selectedSetId===id&&input.value===typed) {
    const stored=result.state.custom.find(item=>item.id===id);
    if(stored)input.value=stored.name;
  }
  return true;
}
async function flush() {
  if(!binding)return;
  clearTimeout(draftTimer);draftTimer=0;
  const committed=await Promise.all(rows.map(row=>commitRow(row))),nameSaved=await commitName();
  await pending;
  if(!nameSaved||committed.some(saved=>!saved))throw new Error('Title editor has an uncommitted field');
}
function insertUndoable(input,text){input.focus();input.select();if(!document.execCommand('insertText',false,text)){input.setRangeText(text,0,input.value.length,'end');input.dispatchEvent(new Event('input',{bubbles:true}));}}
function buildRows(){const target=binding.root.querySelector('.tt-rows');for(let level=0;level<=13;level++){const container=document.createElement('div');container.className='tt-field-row';container.dataset.level=String(level);const number=document.createElement('span');number.className='tt-level';number.textContent=level?String(level):'';const speed=document.createElement('span');speed.className='tt-threshold';const input=document.createElement('input');input.className='tt-field';input.maxLength=256;input.autocomplete='off';input.spellcheck=false;const reset=document.createElement('button');reset.type='button';reset.className='tt-reset symbol';reset.textContent='\uE7A7';reset.disabled=true;container.append(number,speed,input,reset);target.append(container);const row={level,container,speed,input,reset,id:null,model:'',focusText:'',composing:false,committing:0,version:0,timer:0};rows.push(row);input.addEventListener('focus',()=>{row.focusText=input.value;focusedLevel=level;changed();});input.addEventListener('input',()=>stage(row));input.addEventListener('compositionstart',()=>{row.composing=true;clearTimeout(row.timer);});input.addEventListener('compositionend',()=>{row.composing=false;stage(row);});input.addEventListener('blur',()=>{row.composing=false;commitRow(row);queueMicrotask(()=>{if(!binding)return;if(!rows.some(item=>item.input===document.activeElement)){focusedLevel=null;localDraft=null;send({type:'clearDraft'});changed();}});});input.addEventListener('keydown',event=>{if(row.composing||event.isComposing||event.ctrlKey||event.altKey||event.metaKey)return;let next=null;if(event.key==='Enter'){commitRow(row);next=Math.min(13,level+1);}else if(event.key==='ArrowUp')next=Math.max(0,level-1);else if(event.key==='ArrowDown')next=Math.min(13,level+1);else if(event.key==='Escape'&&input.value!==row.focusText){insertUndoable(input,row.focusText);stage(row,false);event.preventDefault();return;}if(next!==null){event.preventDefault();rows[next].input.focus();rows[next].input.select();rows[next].input.scrollIntoView({block:'nearest'});}});reset.addEventListener('mousedown',event=>event.preventDefault());reset.addEventListener('click',()=>{insertUndoable(input,'');stage(row,false);commitRow(row);});}}
function createCard(id,isCustom) {
  const outer=document.createElement('div');outer.className='tt-card';outer.dataset.custom=String(isCustom);outer.dataset.themeId=id;
  const button=document.createElement('button');button.type='button';button.className='tt-card-select';button.setAttribute('role','radio');
  button.dataset.themeCard=id;button.dataset.ttAction='select';button.dataset.themeId=id;
  const name=document.createElement('strong');name.className='tt-card-name';
  const strip=document.createElement('span');strip.className='tt-strip';strip.setAttribute('aria-hidden','true');
  button.append(name,strip);outer.append(button);
  let more=null;
  if(isCustom) {
    more=document.createElement('button');more.type='button';more.className='tt-more symbol';more.textContent='\uE712';more.tabIndex=-1;
    more.dataset.ttAction='more';more.dataset.themeId=id;more.setAttribute('aria-haspopup','menu');outer.append(more);
  }
  const card={outer,button,name,strip,more,signature:null};cards.set(id,card);
  (isCustom?binding.root.querySelector('.tt-customs'):binding.root.querySelector('.tt-presets')).insertBefore(outer,isCustom?binding.root.querySelector('.tt-new'):null);
  if(isCustom&&shown)outer.classList.add('tt-appear');
  return card;
}
function paintCards(source) {
  const selected=resolve(source,currentSelection(),look.language).id,ids=presetIds.concat(source.custom.map(set=>set.id));
  const group=binding.root.querySelector('.tt-card-group'),customGrid=binding.root.querySelector('.tt-customs');
  for(const [id,card] of cards)if(!ids.includes(id)){card.outer.remove();cards.delete(id);}
  for(const id of ids) {
    const theme=resolve(source,id,look.language),card=cards.get(id)||createCard(id,!!theme.custom);
    card.name.textContent=theme.name;
    card.button.setAttribute('aria-checked',String(id===selected));
    card.button.tabIndex=group.contains(document.activeElement)?card.button===document.activeElement?0:-1:id===selected?0:-1;
    const stripTitles=stripLevels.map(level=>theme.texts[level]);
    card.button.setAttribute('aria-label',theme.name+' · '+stripTitles.join(' · '));
    card.button.title=theme.texts.slice(1).map((text,index)=>text+' '+thresholdText(index+1)).join(' · ');
    if(card.more){card.more.title=tr('more');card.more.setAttribute('aria-label',tr('more'));}
    const width=card.strip.clientWidth,signature=stripTitles.join('\u0000')+'|'+width+'|'+view.preferences.redline+'|'+look.language+'|'+look.appearance;
    if(card.signature!==signature) {
      card.signature=signature;
      let choice=stripChoices[stripChoices.length-1];
      if(measure&&width>0) {
        measure.font=font(11,400);measure.letterSpacing='0px';
        choice=stripChoices.find(indices=>Math.ceil(measure.measureText(indices.map(index=>stripTitles[index]).join(' · ')).width)<=width)||choice;
      }
      const fragment=document.createDocumentFragment();
      choice.forEach((index,position)=>{
        if(position)fragment.append(document.createTextNode(' · '));
        const span=document.createElement('span');span.textContent=stripTitles[index];span.style.color=heatColor(stripLevels[index]);fragment.append(span);
      });
      card.strip.replaceChildren(fragment);
    }
  }
  // Undo restores native creation order, not the order in which DOM nodes happened to be remounted.
  source.custom.forEach((set,index)=>{
    const card=cards.get(set.id).outer,atIndex=customGrid.children[index];
    if(atIndex!==card)customGrid.insertBefore(card,atIndex);
  });
  const fresh=binding.root.querySelector('.tt-new');
  fresh.disabled=source.custom.length>=8;fresh.title=fresh.disabled?tr('limit'):'';
  fresh.setAttribute('aria-label',tr('new'));fresh.tabIndex=document.activeElement===fresh&&!fresh.disabled?0:-1;
}
function layout() {
  if(!binding)return;
  const root=binding.root,content=root.querySelector('.tt-cards-group'),editor=root.querySelector('.tt-editor-grid');
  root.dataset.cardColumns=content.clientWidth-34<560?'2':'3';
  if(editor.clientWidth>0)root.dataset.editorNarrow=editor.clientWidth<600?'true':'false';
  for(const card of cards.values())card.signature=null;
  scheduleRender();
}
function revealEditor(show) {
  if(binding.editorShown===show)return;
  const reveal=binding.reveal,editor=binding.root.querySelector('.tt-editor'),fromHeight=reveal.hidden?0:reveal.getBoundingClientRect().height;
  binding.editorShown=show;
  if(binding.revealAnimation)binding.revealAnimation.cancel();
  reveal.hidden=false;reveal.inert=!show;
  binding.root.dataset.editorNarrow=binding.root.querySelector('.tt-editor-grid').clientWidth<600?'true':'false';
  const fullHeight=editor.getBoundingClientRect().height;
  if(!shown||!look.visible) {
    reveal.hidden=!show;reveal.style.height='';
    return;
  }
  let frames,duration;
  if(look.reducedMotion) {
    frames=[{opacity:show?0:1},{opacity:show?1:0}];duration=200;
  } else {
    const omega=2*Math.PI/.35,damping=.8,root=Math.sqrt(1-damping*damping);
    duration=Math.log(1/(.002*root))/(damping*omega)*1000;
    frames=Array.from({length:31},(_,index)=>{
      const seconds=index/30*duration/1000,spring=1-Math.exp(-damping*omega*seconds)*(Math.cos(omega*root*seconds)+damping/root*Math.sin(omega*root*seconds));
      return {height:Math.max(0,Math.min(fullHeight,fromHeight+((show?fullHeight:0)-fromHeight)*spring))+'px'};
    });
  }
  reveal.style.overflow='clip';
  const animation=reveal.animate(frames,{duration,easing:look.reducedMotion?'cubic-bezier(.2,.8,.2,1)':'linear'});
  binding.revealAnimation=animation;
  animation.onfinish=()=>{
    if(!binding||binding.revealAnimation!==animation)return;
    reveal.hidden=!show;reveal.style.height='';reveal.style.overflow='';
    binding.revealAnimation=null;
  };
}
function paintEditor(source) {
  const theme=resolve(source,currentSelection(),look.language),set=theme.custom;
  if(!set) {
    revealEditor(false);selectedSetId=null;focusedLevel=null;
    if(heroArt)heroArt.setVisible(false);
    if(orbArt)orbArt.setVisible(false);
    previewsActive=false;
    return;
  }
  const switched=selectedSetId!==set.id;
  selectedSetId=set.id;
  if(switched){focusedLevel=null;binding.root.querySelector('.tt-notice').hidden=true;}
  binding.root.querySelector('#tt-editor-heading').textContent=tr('editing',theme.name);
  const name=binding.root.querySelector('#tt-name');
  if(switched||name!==document.activeElement)name.value=set.name;
  const base=binding.root.querySelector('#tt-base');
  for(const option of base.options)option.textContent=presetNames[option.value][look.language==='zh'?0:1];
  base.value=set.base;
  binding.root.querySelector('#tt-base-hint').textContent=tr('baseHint',presetNames[set.base][look.language==='zh'?0:1]);
  binding.root.querySelector('.tt-vehicle-hint').hidden=!theme.showsVehicleArt;
  binding.root.querySelector('.tt-speed-heading').textContent=tr('speedColumn','tok/s');
  const preset=binding.visuals.themes[set.base][look.language];
  for(const row of rows) {
    const value=row.level===0?set.idle:set.titles[row.level-1],changedModel=row.model!==value;
    if(switched||changedModel&&!row.composing&&!row.committing) {
      row.input.value=value;row.focusText=value;row.version++;clearTimeout(row.timer);
    }
    row.id=set.id;row.model=value;row.input.placeholder=preset[row.level]||'';
    row.input.setAttribute('aria-label',row.level===0?tr('idleLabel',preset[0]):tr('rowLabel',thresholdText(row.level)+' tok/s').replace('%d',String(row.level)).replace('%@',preset[row.level]));
    row.speed.textContent=row.level===0?tr('idleRow'):thresholdText(row.level);
    if(row.level)row.speed.style.color=heatColor(row.level);
    row.reset.title=tr('reset',preset[row.level]);row.reset.setAttribute('aria-label',row.reset.title);row.reset.disabled=!row.input.value;
  }
  const duplicateButton=binding.root.querySelector('[data-tt-action="duplicate"]');
  duplicateButton.disabled=source.custom.length>=8;duplicateButton.title=duplicateButton.disabled?tr('limit'):'';
  binding.root.querySelector('[data-tt-action="resetAll"]').disabled=!set.idle&&!set.titles.some(Boolean);
  revealEditor(true);
  paintPreviews(theme);
}
function paintPreviews(theme) {
  if(!binding||!view)return;
  const active=!!look.visible&&!document.hidden&&previewsIntersect,level=focusedLevel===null?13:focusedLevel,redline=view.preferences.redline,value=threshold(level)*1.05;
  const signature=JSON.stringify([theme.id,theme.base,theme.labels,level,redline,view.preferences.style,look.language,look.appearance,look.reducedMotion]);
  let created=false;
  if(active&&!heroArt){heroArt=binding.visuals.create(binding.root.querySelector('.tt-preview-hero'),{embedded:true,sharedGpu:true});created=true;}
  if(active&&!orbArt){orbArt=binding.visuals.create(binding.root.querySelector('.tt-preview-orb'),{embedded:false,sharedGpu:true});created=true;}
  if(signature!==previewSignature||created) {
    previewSignature=signature;
    // The original editor's explicitly labelled 1.05 × threshold script, never a fabricated runtime observation.
    const frame={value,formattedValue:value>=1000?(value/1000).toFixed(2)+'k':value<1?value.toFixed(1):String(Math.round(value)),unit:'tok/s',title:theme.labels[level],titleTheme:theme.id,titleBase:theme.base,titleLabels:theme.labels,titleLevel:level,showsVehicleArt:theme.showsVehicleArt,language:look.language,redline,appearance:look.appearance,effects:'standard',reduceMotion:look.reducedMotion,maxFps:30,size:112,opacity:1,hovered:false,activeAgents:0,toolsAgents:0,responsePulse:false,newPeak:false,hoverLabel:''};
    if(heroArt)heroArt.update(frame);
    if(orbArt)orbArt.update({...frame,size:96,style:view.preferences.style});
    const accessible=tr('preview')+' · '+theme.texts[level];
    for(const node of binding.root.querySelectorAll('.tt-preview-card')) {
      node.setAttribute('aria-label',accessible);node.dataset.previewLevel=String(level);node.dataset.previewValue=String(value);
    }
  }
  if(previewsActive!==active||created) {
    if(heroArt)heroArt.setVisible(active);
    if(orbArt)orbArt.setVisible(active);
    previewsActive=active;
  }
  binding.root.querySelector('.tt-orb-caption').textContent=tr('orb');
}
function paint() {
  if(!binding||!view)return;
  const source=state(),root=binding.root;
  root.dataset.reduced=String(!!look.reducedMotion);
  for(const item of root.querySelectorAll('[data-tt-text]'))item.textContent=tr(item.dataset.ttText);
  paintCards(source);paintEditor(source);
  const undo=root.querySelector('.tt-undo'),remaining=source.undo?source.undo.expiresAt-Date.now():0;
  undo.hidden=remaining<=0;
  if(!undo.hidden)undo.querySelector('.tt-undo-text').textContent=tr(source.undo.kind==='delete'?'didDelete':'didReset',source.undo.name);
  clearTimeout(expiryTimer);expiryTimer=remaining>0?setTimeout(scheduleRender,remaining):0;
  const error=root.querySelector('.tt-error');
  error.hidden=!errorCode&&!source.error;
  if(!error.hidden)error.querySelector('.tt-error-text').textContent=tr(errorCode||'storage');
  shown=true;
}
function closeMenu(restore=false){if(!binding)return;const menu=binding.menu;menu.hidden=true;menu.replaceChildren();if(restore&&menuReturn&&menuReturn.isConnected)menuReturn.focus();menuReturn=null;}
function openMenu(id,anchor,event){if(!binding)return;closeMenu();const source=state(),custom=source.custom.some(set=>set.id===id),menu=binding.menu;menuReturn=anchor;const items=custom?[['edit',true,()=>select(id,true)],['duplicate',source.custom.length<8,()=>duplicate(id)],['delete',true,()=>remove(id)]]:[['duplicateEdit',source.custom.length<8,()=>duplicate(id)]];for(const [key,enabled,run] of items){const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.textContent=tr(key);button.disabled=!enabled;if(key==='delete')button.className='tt-delete';button.addEventListener('click',()=>{closeMenu();run();});menu.append(button);}menu.hidden=false;const rect=anchor.getBoundingClientRect(),left=event?event.clientX:rect.right,top=event?event.clientY:rect.bottom;menu.style.left=Math.max(4,Math.min(window.innerWidth-menu.offsetWidth-4,left))+'px';menu.style.top=Math.max(4,Math.min(window.innerHeight-menu.offsetHeight-4,top))+'px';const first=menu.querySelector('button:not(:disabled)');if(first)first.focus();}
async function remove(id) {
  try { await flush(); } catch { return; }
  if(!binding)return;
  const order=focusOrder(),index=order.findIndex(item=>item.dataset.themeCard===id),result=await send({type:'delete',id});
  if(result&&result.ok&&binding) {
    localDraft=null;paint();
    const next=focusOrder();
    if(next.length)next[Math.max(0,Math.min(index,next.length-1))].focus();
  }
}
function focusOrder(){if(!binding)return [];return [...binding.root.querySelectorAll('[data-theme-card]')].filter(button=>!button.disabled);}
function cardMove(index,key,total,columns){const presetCount=9,inPresets=index<presetCount,start=inPresets?0:presetCount,column=(index-start)%columns;if(key==='ArrowLeft')return Math.max(0,index-1);if(key==='ArrowRight')return Math.min(total-1,index+1);if(key==='ArrowDown'&&inPresets&&index+columns>=presetCount)return presetCount<total?Math.min(presetCount+column,total-1):index;if(key==='ArrowDown')return index+columns<total?index+columns:index;if(key==='ArrowUp'&&!inPresets&&index-columns<presetCount)return Math.min(Math.floor((presetCount-1)/columns)*columns+column,presetCount-1);return index-columns>=0?index-columns:index;}
function onClick(event) {
  const action=event.target.closest('[data-tt-action]');
  if(!action||!binding.root.contains(action)||action.disabled)return;
  const id=action.dataset.themeId||selectedSetId;
  switch(action.dataset.ttAction) {
    case 'select':select(id);break;
    case 'new':duplicate(currentSelection());break;
    case 'more':openMenu(id,action);break;
    case 'duplicate':if(id)duplicate(id);break;
    case 'delete':if(id)remove(id);break;
    case 'resetAll':if(id)flush().then(()=>send({type:'resetAll',id})).catch(()=>{});break;
    case 'undo':
      flush().then(()=>send({type:'undo'})).then(result=>{
        if(result&&result.ok&&binding){paint();const card=cards.get(currentSelection());if(card)card.button.focus();}
      }).catch(()=>{});
      break;
  }
}
function onKeyDown(event){const card=event.target.closest('[data-theme-card]');if(!card)return;const order=focusOrder(),index=order.indexOf(card),id=card.dataset.themeCard;if(index<0)return;if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)&&!event.ctrlKey&&!event.altKey&&!event.metaKey){event.preventDefault();const next=order[cardMove(index,event.key,order.length,Number(binding.root.dataset.cardColumns)||3)];for(const item of order)item.tabIndex=item===next?0:-1;next.focus();next.scrollIntoView({block:'nearest'});}else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='d'){event.preventDefault();duplicate(id==='new'?currentSelection():id);}else if((event.key==='Delete'||event.key==='Backspace')&&id.startsWith('custom:')&&!event.ctrlKey&&!event.altKey&&!event.metaKey){event.preventDefault();remove(id);}else if((event.shiftKey&&event.key==='F10')||event.key==='ContextMenu'){if(id!=='new'){event.preventDefault();openMenu(id,card);}}}
function bind(options) {
  if(binding)throw new Error('Title editor already bound');
  if(!options||!options.host||!options.bridge||!options.visuals)throw new Error('Title editor requires its owned host and bridge');
  const template=document.getElementById('title-themes-template');
  if(!template)throw new Error('Title editor template missing');
  options.host.append(template.content.cloneNode(true));
  const root=options.host.querySelector('.tt-root'),menu=root.querySelector('.tt-menu'),editor=root.querySelector('.tt-editor'),reveal=document.createElement('div');
  reveal.className='tt-editor-reveal';reveal.hidden=true;editor.before(reveal);reveal.append(editor);editor.hidden=false;
  document.body.append(menu);
  binding={...options,root,menu,reveal,editorShown:false,revealAnimation:null};closing=false;
  const base=root.querySelector('#tt-base');
  for(const id of presetIds){const option=document.createElement('option');option.value=id;base.append(option);}
  buildRows();
  root.addEventListener('click',onClick);root.addEventListener('keydown',onKeyDown);root.addEventListener('contextmenu',onContextMenu);
  root.querySelector('.tt-card-group').addEventListener('focusout',onCardFocusOut);
  root.querySelector('#tt-name').addEventListener('blur',commitName);root.querySelector('#tt-name').addEventListener('keydown',onNameKeyDown);
  base.addEventListener('change',onBaseChange);menu.addEventListener('keydown',onMenuKeyDown);
  document.addEventListener('pointerdown',onOutsidePointer,true);document.addEventListener('visibilitychange',onVisibility);document.addEventListener('scroll',onScroll,true);
  let observedWidth=-1;
  resizeObserver=new ResizeObserver(entries=>{
    const width=entries[0]&&entries[0].contentRect.width;
    if(width===observedWidth)return;
    observedWidth=width;layout();
  });resizeObserver.observe(root);
  intersectionObserver=new IntersectionObserver(entries=>{previewsIntersect=entries.some(entry=>entry.isIntersecting);scheduleRender();});
  intersectionObserver.observe(root.querySelector('.tt-previews'));
  layout();
  return {render,flush,destroy};
}
function onContextMenu(event){const card=event.target.closest('[data-theme-card]');if(!card||card.dataset.themeCard==='new')return;event.preventDefault();openMenu(card.dataset.themeCard,card,event);}
function onCardFocusOut(){queueMicrotask(()=>{if(binding&&!binding.root.querySelector('.tt-card-group').contains(document.activeElement))scheduleRender();});}
function onNameKeyDown(event){if(event.isComposing)return;if(event.key==='Enter'){event.preventDefault();commitName().then(()=>{if(binding)binding.root.querySelector('#tt-name').select();});}else if(event.key==='Escape'&&selectedSetId){const set=state().custom.find(item=>item.id===selectedSetId);if(set){event.preventDefault();event.target.value=set.name;}}}
function onBaseChange(event){if(selectedSetId)send({type:'setBase',id:selectedSetId,base:event.target.value});}
function onOutsidePointer(event){if(binding&&!binding.menu.hidden&&!binding.menu.contains(event.target)&&!event.target.closest('.tt-more'))closeMenu();}
function onScroll(){if(binding&&!binding.menu.hidden)closeMenu();}
function onMenuKeyDown(event){if(event.key==='Escape'){event.preventDefault();closeMenu(true);return;}if(event.key==='Tab'){closeMenu();return;}const options=[...binding.menu.querySelectorAll('button:not(:disabled)')],index=options.indexOf(document.activeElement);if(event.key==='ArrowDown'||event.key==='ArrowUp'||event.key==='Home'||event.key==='End'){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?options.length-1:(index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;if(options[next])options[next].focus();}}
function onVisibility() {
  if(document.hidden){if(heroArt)heroArt.setVisible(false);if(orbArt)orbArt.setVisible(false);previewsActive=false;closeMenu();}
  else scheduleRender();
}
function render(next,options) {
  view=next;look={...look,...options,language:options&&options.language==='zh'?'zh':'en'};
  if(selection&&(next.preferences.titleTheme===selection||next.preferences.titleTheme!==selectionFrom))selection=selectionFrom=null;
  if(!look.visible){if(heroArt)heroArt.setVisible(false);if(orbArt)orbArt.setVisible(false);previewsActive=false;}
  paint();
}
async function destroy() {
  if(!binding)return;
  try { await flush(); } catch { /* The owning close path awaits flush before destroying its window. */ }
  closing=true;
  const active=binding;binding=null;
  clearTimeout(draftTimer);clearTimeout(noticeTimer);clearTimeout(expiryTimer);cancelAnimationFrame(renderFrame);renderFrame=0;
  for(const row of rows)clearTimeout(row.timer);
  if(active.revealAnimation)active.revealAnimation.cancel();
  if(heroArt)heroArt.destroy();
  if(orbArt)orbArt.destroy();
  heroArt=orbArt=null;
  resizeObserver.disconnect();intersectionObserver.disconnect();resizeObserver=intersectionObserver=null;
  active.root.removeEventListener('click',onClick);active.root.removeEventListener('keydown',onKeyDown);active.root.removeEventListener('contextmenu',onContextMenu);
  active.root.querySelector('.tt-card-group').removeEventListener('focusout',onCardFocusOut);
  document.removeEventListener('pointerdown',onOutsidePointer,true);document.removeEventListener('visibilitychange',onVisibility);document.removeEventListener('scroll',onScroll,true);
  active.menu.remove();active.root.remove();
  rows.length=0;cards.clear();localDraft=resultState=null;view=null;selection=selectionFrom=selectedSetId=null;focusedLevel=null;shown=false;pending=Promise.resolve();
  previewsIntersect=previewsActive=false;previewSignature=null;errorCode=null;
}
return {bind,render,flush,destroy,resolve};
})();
`;
