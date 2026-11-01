// Agent Speed v1.6.1 Windows readout port, MIT; 384ce020cc655133e95aaad5cc085f3985f0ed99.
// Sources: OrbReadoutLayout, OrbReadoutDraw, GlyphAtlas, OrbLabelFit and OrbGpuOrb.Labels/OrbLiquid.hlsl.
// SVG alphabetic baselines and liquid glyph masks use the same native tabular cells, fit, typefaces and clipping.
export const ORB_READOUT_SCRIPT = String.raw`
const ORB_VALUE_FACE='"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif';
const ORB_TEXT_FACE='"Segoe UI Variable Text","Segoe UI","Microsoft JhengHei UI","Microsoft YaHei UI","Yu Gothic UI",system-ui,sans-serif';
const orbSegmenter=typeof Intl.Segmenter==='function'?new Intl.Segmenter(undefined,{granularity:'grapheme'}):null;
const orbGraphemes=text=>orbSegmenter?Array.from(orbSegmenter.segment(text),part=>part.segment):Array.from(text);
const digitWidths=new Map();
function valueRun(ctx,text,size,atLeast=false){
  size=Math.round(size*4)/4;ctx.font='700 '+size+'px '+ORB_VALUE_FACE;ctx.letterSpacing='0px';
  let digit=digitWidths.get(size);if(digit===undefined){digit=0;for(let i=0;i<10;i++)digit=Math.max(digit,ctx.measureText(String(i)).width);digitWidths.set(size,digit);}
  const cells=[];let width=0;
  for(const character of text){const w=/[0-9]/.test(character)?digit:ctx.measureText(character).width;cells.push({text:character,x:width+w/2,width:w});width+=w;}
  let prefix=null;if(atLeast){const prefixSize=Math.round(size*.6*4)/4;ctx.font='700 '+prefixSize+'px '+ORB_VALUE_FACE;const prefixWidth=ctx.measureText('≥').width;prefix={text:'≥',size:prefixSize,width:prefixWidth,x:-(width+prefixWidth)/2+prefixWidth/2};width+=prefixWidth;for(const cell of cells)cell.x+=prefixWidth;}
  for(const cell of cells)cell.x-=width/2;return {cells,width,size,prefix};
}
function fitValueRun(ctx,text,fullSize,maxWidth,atLeast=false){
  const natural=valueRun(ctx,text,fullSize,atLeast),fit=natural.width>maxWidth?Math.max(.4,Math.floor(maxWidth/natural.width*50)/50):1;
  const run=fit<1?valueRun(ctx,text,fullSize*fit,atLeast):natural;run.fullSize=fullSize;run.maxWidth=maxWidth;return run;
}
function createValueReadout(svgNode,value,oldValue,ctx){
  let text='',size=0,lastValue=0,prefixShown=false,active=[];
  function clear(){
    for(const animation of active)animation.cancel();active=[];oldValue.replaceChildren();value.style.opacity='';oldValue.style.opacity='0';
  }
  function draw(group,run,previous,clip){
    group.replaceChildren();const glyphs=[];
    for(let index=0;index<run.cells.length;index++){
      const cell=run.cells[index],viewport=svgNode('svg'),glyph=svgNode('text');
      viewport.setAttribute('x',cell.x-cell.width/2-2);viewport.setAttribute('y',-.92*run.size);viewport.setAttribute('width',cell.width+4);viewport.setAttribute('height',1.12*run.size);viewport.setAttribute('overflow',clip?'hidden':'visible');
      glyph.setAttribute('x',cell.width/2+2);glyph.setAttribute('y',.92*run.size);glyph.style.fontSize=run.size+'px';glyph.textContent=previous===null?cell.text:previous[index]||'';viewport.append(glyph);group.append(viewport);glyphs.push(glyph);
    }
    return glyphs;
  }
  function update(next,run,animate,animations,rawValue){
    const direction=rawValue>=lastValue?-1:1;lastValue=rawValue;if(next===text&&run.size===size&&prefixShown===!!run.prefix)return 0;
    const before=text,canAnimate=animate&&size>0&&before!==next&&before!=='';clear();
    const sameLength=before.length===next.length,current=draw(value,run,null,canAnimate&&sameLength);
    let duration=0;
    if(canAnimate){
      duration=sameLength?240:120;
      if(sameLength){
        const previous=draw(oldValue,run,before,true),travel=.92*run.size;oldValue.style.opacity='1';
        for(let index=0;index<current.length;index++){
          const old=previous[index],fresh=current[index];old.style.opacity='0';
          if(before[index]===next[index])continue;
          active.push(old.animate([{transform:'translateY(0)',opacity:1},{transform:'translateY('+(direction*travel)+'px)',opacity:0}],{duration,easing:'cubic-bezier(0,0,.58,1)'}));
          active.push(fresh.animate([{transform:'translateY('+(-direction*travel)+'px)',opacity:0},{transform:'translateY(0)',opacity:1}],{duration,easing:'cubic-bezier(0,0,.58,1)'}));
        }
      }else{
        const previous=fitValueRun(ctx,before,run.fullSize,run.maxWidth,!!run.prefix);draw(oldValue,previous,null,false);
        active.push(oldValue.animate([{opacity:1},{opacity:0}],{duration,easing:'linear'}),value.animate([{opacity:0},{opacity:1}],{duration,easing:'linear'}));
      }
      animations.push(...active);
    }
    text=next;size=run.size;prefixShown=!!run.prefix;return duration;
  }
  function cancel(){clear();size=0;}
  return {update,cancel};
}

function createLiquidReadout(st){
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');if(!ctx)throw new Error('Liquid readout requires Canvas 2D');
  let current=null,previous=null,currentTexture=null,previousTexture=null,decorativeTexture=null,uploaded=null,uploadedPrevious=null,lastKey='',lastText='',lastValue=0,rollStart=-99,rollDuration=0,rollTravel=0,rollDirection=0;
  const roll=new Float32Array([0,0,1,0]),cells=new Float32Array(24*4);let cellCount=0,baseline=0,previousBaseline=0,bandTop=0,bandBottom=0;
  const labelRoll=new Float32Array([0,0,1,0]);let labelText='',labelBaseline=0,previousLabelBaseline=0,labelStart=-99,labelDuration=0,labelTravel=0,labelRename=true,labelHoverTransition=false,labelHovered=false,previousLabelHovered=false,labelTop=0,labelBottom=0,maskSize=0;
  // DESIGN 10/12: Performance/TH have their own cached mask: never the output odometer or its colors.
  let perfCanvas=null,perfContext=null,perfShadow=null,perfShadowContext=null,perfCurrent=null,perfUnion=null,perfTexture=null,perfUploaded=null,perfKey='',perfContrast=false;
  function updatePerf(frame){
    const reading=frame.perfReadout;
    if(!reading||!reading.visible||!reading.glyphs.length){perfCurrent=null;perfUnion=null;perfUploaded=null;perfKey='';return;}
    const key=st.S+'|'+st.dpr+'|'+Number(!!reading.contrast)+'|'+reading.key;
    perfContrast=!!reading.contrast;
    if(key===perfKey)return;
    const S=st.S,pixels=Math.max(1,Math.ceil(S*st.dpr));
    if(!perfCanvas){
      perfCanvas=document.createElement('canvas');perfContext=perfCanvas.getContext('2d');perfShadow=document.createElement('canvas');perfShadowContext=perfShadow.getContext('2d');
      if(!perfContext||!perfShadowContext)throw new Error('Perf readout requires Canvas 2D');
    }
    if(perfCanvas.width!==pixels||perfCanvas.height!==pixels){perfCanvas.width=perfCanvas.height=perfShadow.width=perfShadow.height=pixels;perfCurrent=null;}
    if(!perfCurrent){perfCurrent=new ImageData(pixels,pixels);perfUnion=new ImageData(pixels,pixels);}
    const data=perfCurrent.data,union=perfUnion.data;data.fill(0);
    for(let role=0;role<2;role++){
      perfContext.setTransform(1,0,0,1,0,0);perfContext.clearRect(0,0,pixels,pixels);perfContext.setTransform(st.dpr,0,0,st.dpr,.5*S*st.dpr,.5*S*st.dpr);
      perfContext.fillStyle='#fff';perfContext.textAlign='left';perfContext.textBaseline='alphabetic';perfContext.letterSpacing='0px';
      for(const glyph of reading.glyphs){
        if(glyph.role!==role)continue;
        perfContext.font=glyph.weight+' '+glyph.size+'px '+ORB_TEXT_FACE;
        perfContext.globalAlpha=glyph.alpha===undefined?1:glyph.alpha;perfContext.fillText(glyph.text,glyph.x,glyph.y);
        if(glyph.provisional){
          const width=perfContext.measureText(glyph.text).width,diameter=Math.max(1,Math.round((Math.max(1/st.dpr,.1*glyph.size)+(perfContrast?.5:0))*st.dpr))/st.dpr,count=Math.max(2,Math.floor((width-diameter)/(2.4*diameter))+1),pitch=(width-diameter)/(count-1);
          perfContext.globalAlpha*=perfContrast?1:.7;perfContext.beginPath();
          for(let dot=0;dot<count;dot++){const x=glyph.x+diameter/2+dot*pitch;perfContext.moveTo(x+diameter/2,glyph.y+.22*glyph.size);perfContext.arc(x,glyph.y+.22*glyph.size,diameter/2,0,Math.PI*2);}
          perfContext.fill();
        }
      }
      perfContext.globalAlpha=1;
      const alpha=perfContext.getImageData(0,0,pixels,pixels).data;
      for(let index=0;index<data.length;index+=4)data[index+role]=alpha[index+3];
    }
    for(let index=0;index<data.length;index+=4){union[index]=union[index+1]=union[index+2]=255;union[index+3]=Math.max(data[index],data[index+1]);}
    perfContext.setTransform(1,0,0,1,0,0);perfContext.clearRect(0,0,pixels,pixels);perfContext.putImageData(perfUnion,0,0);
    perfShadowContext.clearRect(0,0,pixels,pixels);perfShadowContext.filter='blur('+(.015*S*st.dpr)+'px)';perfShadowContext.drawImage(perfCanvas,0,0);perfShadowContext.filter='none';
    const shadow=perfShadowContext.getImageData(0,0,pixels,pixels).data;for(let index=0;index<data.length;index+=4)data[index+3]=shadow[index+3];
    perfKey=key;perfUploaded=null;
  }
  function update(frame,metrics,animate){
    updatePerf(frame);const shownValue=frame.readoutValue===undefined?frame.value:frame.readoutValue;
    const key=st.S+'|'+st.dpr+'|'+st.thumbnail+'|'+frame.formattedValue+'|'+Number(!!frame.atLeast)+'|'+frame.unit+'|'+metrics.labelText+'|'+metrics.valueSize+'|'+metrics.unitSize+'|'+metrics.unitTracking+'|'+metrics.labelSize+'|'+metrics.labelWeight+'|'+metrics.labelTracking+'|'+metrics.valueY+'|'+metrics.unitY+'|'+metrics.labelY;
    if(key===lastKey){lastValue=shownValue===null?0:shownValue;return;}
    const S=st.S,pixels=Math.max(1,Math.ceil(S*st.dpr)),data=new ImageData(pixels,pixels),buffer=data.data;
    canvas.width=canvas.height=pixels;
    for(let role=0;role<3;role++){
      if(st.thumbnail&&role>0)continue;
      ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,pixels,pixels);ctx.setTransform(st.dpr,0,0,st.dpr,.5*S*st.dpr,.5*S*st.dpr);
      ctx.fillStyle='#fff';ctx.textAlign='center';ctx.textBaseline='alphabetic';
      const size=role===0?metrics.valueSize:role===1?metrics.unitSize:metrics.labelSize,weight=role===0?700:role===1?500:metrics.labelWeight;
      ctx.font=weight+' '+size+'px '+(role===0?ORB_VALUE_FACE:ORB_TEXT_FACE);ctx.letterSpacing=(role===0?0:role===1?metrics.unitTracking:metrics.labelTracking)+'px';
      if(role===0){for(const cell of metrics.cells)ctx.fillText(cell.text,cell.x,metrics.valueY*S);if(metrics.prefix){ctx.font='700 '+metrics.prefix.size+'px '+ORB_VALUE_FACE;ctx.fillText('≥',metrics.prefix.x,metrics.valueY*S);}}else ctx.fillText(role===1?frame.unit:metrics.labelText,0,(role===1?metrics.unitY:metrics.labelY)*S);
      const alpha=ctx.getImageData(0,0,pixels,pixels).data;
      for(let i=0;i<buffer.length;i+=4)buffer[i+role]=alpha[i+3];
    }
    // Cache the submerged glyph shadow along with the masks, not a per-frame blur pass.
    const union=new ImageData(pixels,pixels);
    for(let i=0;i<buffer.length;i+=4){union.data[i]=union.data[i+1]=union.data[i+2]=255;union.data[i+3]=Math.max(buffer[i],buffer[i+1],buffer[i+2]);}
    ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,pixels,pixels);ctx.putImageData(union,0,0);
    const shadow=document.createElement('canvas');shadow.width=shadow.height=pixels;const blur=shadow.getContext('2d');if(!blur)throw new Error('Liquid readout shadow requires Canvas 2D');blur.filter='blur('+(.015*S*st.dpr)+'px)';blur.drawImage(canvas,0,0);blur.filter='none';
    const alpha=blur.getImageData(0,0,pixels,pixels).data;for(let i=0;i<buffer.length;i+=4)buffer[i+3]=alpha[i+3];
    const now=performance.now(),outputChanged=lastText!==frame.formattedValue,labelChanged=labelText!==metrics.labelText||labelHovered!==st.hovered,sameSize=maskSize===S,before=current,oldPrevious=previous;
    if(!sameSize){rollDuration=labelDuration=0;cellCount=0;}
    bandTop=metrics.valueY-.92*metrics.valueSize/S;bandBottom=metrics.valueY+.2*metrics.valueSize/S;labelTop=metrics.labelY-1.25*metrics.labelBaseSize/S;labelBottom=metrics.labelY+.35*metrics.labelBaseSize/S;
    if(rollDuration===240)rollTravel=.92*metrics.valueSize/S;
    if(outputChanged){
      previous=before;previousBaseline=baseline;
      if(!labelChanged&&oldPrevious&&now-labelStart<labelDuration){for(let i=2;i<previous.data.length;i+=4)previous.data[i]=oldPrevious.data[i];uploadedPrevious=null;}
      if(animate&&previous&&sameSize&&S>=80){
        rollStart=now;rollDuration=lastText.length===frame.formattedValue.length?240:120;rollTravel=rollDuration===240?.92*metrics.valueSize/S:0;rollDirection=(shownValue===null?0:shownValue)>=lastValue?-1:1;
        cellCount=rollDuration===120?-1:Math.min(24,metrics.cells.length);cells.fill(0);
        for(let i=0;i<cellCount;i++){const cell=metrics.cells[i],k=i*4;cells[k]=(cell.x-cell.width/2)/S;cells[k+1]=(cell.x+cell.width/2)/S;cells[k+2]=lastText[i]===frame.formattedValue[i]?0:1;}
      }else{rollStart=-99;rollDuration=0;cellCount=0;}
    }
    if(labelChanged){
      previousLabelBaseline=labelBaseline;previousLabelHovered=labelHovered;labelHovered=st.hovered;
      if(metrics.labelAnimate&&before&&sameSize){
        if(!outputChanged){if(!previous)previous=before;else{for(let i=2;i<previous.data.length;i+=4)previous.data[i]=before.data[i];uploadedPrevious=null;}}
        labelStart=now;labelRename=metrics.labelRename;labelHoverTransition=metrics.labelHover;labelDuration=labelHoverTransition?500:labelRename||metrics.labelCrossfade?250:350;labelTravel=!labelRename&&!metrics.labelCrossfade&&metrics.labelMotion?1.1*metrics.labelBaseSize/S:0;
      }else labelDuration=0;
    }
    current=data;baseline=metrics.valueY;labelBaseline=metrics.labelY;labelText=metrics.labelText;maskSize=S;lastText=frame.formattedValue;lastValue=shownValue===null?0:shownValue;lastKey=key;
  }
  function texture(gl){
    const out=gl.createTexture();if(!out)throw new Error('Cannot allocate liquid glyph texture');gl.bindTexture(gl.TEXTURE_2D,out);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);return out;
  }
  function bind(gl,u,decorative){
    if(!current)return;
    if(!currentTexture)currentTexture=texture(gl);if(!previousTexture)previousTexture=texture(gl);
    if(!decorativeTexture)decorativeTexture=texture(gl);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,currentTexture);
    if(uploaded!==current){gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,current);uploaded=current;}
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,previousTexture);
    const old=previous||current;if(uploadedPrevious!==old){gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,old);uploadedPrevious=old;}
    gl.uniform1i(u.uReadout,0);gl.uniform1i(u.uReadoutOld,1);gl.uniform1f(u.uReadoutOn,1);
    gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,decorativeTexture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,decorative);gl.uniform1i(u.uDecorative,2);
    gl.uniform1f(u.uPerfReadoutOn,perfCurrent?1:0);gl.uniform1f(u.uPerfReadoutContrast,perfContrast?1:0);
    if(perfCurrent){
      if(!perfTexture)perfTexture=texture(gl);gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,perfTexture);
      if(perfUploaded!==perfCurrent){gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,perfCurrent);perfUploaded=perfCurrent;}
      gl.uniform1i(u.uPerfReadout,3);
    }
    const age=performance.now()-rollStart,q=rollDuration>0?clamp(age/rollDuration):1,k=ease(q);
    roll[0]=-rollDirection*rollTravel*(1-k);roll[1]=rollDirection*rollTravel*k;roll[2]=q<1?k:1;roll[3]=q<1?1-k:0;gl.uniform4fv(u.uReadoutRoll,roll);
    gl.uniform4fv(u.uReadoutCells,cells);gl.uniform1f(u.uReadoutCellCount,q<1?cellCount:0);gl.uniform2f(u.uReadoutBand,bandTop,bandBottom);gl.uniform1f(u.uReadoutPreviousShift,baseline-previousBaseline);
    gl.uniform2f(u.uReadoutPrefix,st.readoutPrefix?(st.readoutPrefix.x-st.readoutPrefix.width/2)/st.S:1,st.readoutPrefix?(st.readoutPrefix.x+st.readoutPrefix.width/2)/st.S:0);
    const lp=labelDuration>0?clamp((performance.now()-labelStart)/labelDuration):1,hoverTarget=st.hovered?1:0,labelMoving=labelDuration>0&&(labelHoverTransition?Math.abs(st.hoverBlend.value-hoverTarget)>.001||Math.abs(st.hoverBlend.velocity)>.01:lp<1);
    labelRoll[0]=labelTravel*(1-ease(Math.max(0,(lp-.35)/.65)));labelRoll[1]=-labelTravel*ease(Math.min(1,lp/.4));labelRoll[2]=labelHoverTransition?(labelHovered?clamp(st.hoverBlend.value):1-clamp(st.hoverBlend.value)):labelRename?smooth(0,1,lp):smooth(.35,.8,lp);labelRoll[3]=labelHoverTransition||labelRename?1-labelRoll[2]:1-smooth(0,.4,lp);
    gl.uniform4fv(u.uReadoutLabelRoll,labelRoll);gl.uniform1f(u.uReadoutLabelMoving,labelMoving?1:0);gl.uniform1f(u.uReadoutLabelClipped,labelTravel>0?1:0);gl.uniform2f(u.uReadoutLabelBand,labelTop,labelBottom);gl.uniform1f(u.uReadoutPreviousLabelShift,labelBaseline-previousLabelBaseline);
    const dark=st.dark,active=st.titleActive,title=st.hovered?(dark?[1,1,1]:[0,0,0]):active?labelRgb(Math.max(st.h,.08),dark):(dark?[1,1,1]:[0,0,0]),below=st.hovered?(dark?[1,1,1]:[11/255,13/255,18/255]):dark?[1,1,1]:labDarken(heatRgb(Math.max(st.h,.05)),.55);
    gl.uniform4f(u.uReadoutValue,dark?1:11/255,dark?1:13/255,dark?1:18/255,lerp(dark?.60:.55,dark?.96:.92,st.valueMuted?0:clamp(st.readoutActivity.value)));
    gl.uniform4f(u.uReadoutUnit,dark?1:0,dark?1:0,dark?1:0,dark?.55:.5);
    gl.uniform4f(u.uReadoutTitle,title[0],title[1],title[2],st.hovered?(dark?.55:.5):active?1:(dark?.55:.5));
    gl.uniform4f(u.uReadoutBelowTitle,below[0],below[1],below[2],st.hovered?(dark?.80:.72):dark?.94:1);
    const oldTitle=previousLabelHovered?(dark?[1,1,1]:[0,0,0]):active?labelRgb(Math.max(st.h,.08),dark):(dark?[1,1,1]:[0,0,0]),oldBelow=previousLabelHovered?(dark?[1,1,1]:[11/255,13/255,18/255]):dark?[1,1,1]:labDarken(heatRgb(Math.max(st.h,.05)),.55);
    gl.uniform4f(u.uReadoutOldTitle,oldTitle[0],oldTitle[1],oldTitle[2],previousLabelHovered?(dark?.55:.5):active?1:(dark?.55:.5));gl.uniform4f(u.uReadoutOldBelowTitle,oldBelow[0],oldBelow[1],oldBelow[2],previousLabelHovered?(dark?.80:.72):dark?.94:1);
  }
  function reset(gl){
    if(gl){if(currentTexture)gl.deleteTexture(currentTexture);if(previousTexture)gl.deleteTexture(previousTexture);if(decorativeTexture)gl.deleteTexture(decorativeTexture);if(perfTexture)gl.deleteTexture(perfTexture);}
    currentTexture=previousTexture=decorativeTexture=uploaded=uploadedPrevious=perfTexture=perfUploaded=null;
  }
  return {update,bind,reset};
}
`;
