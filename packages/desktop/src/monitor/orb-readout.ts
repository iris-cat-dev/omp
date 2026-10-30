// Adapted from frozen Agent Speed v1.4.1 (MIT), a94a67fcc78e5d8eea5f82d8d5e737bccf994e2c.
// Sources: OrbGpuOrb.Labels complementary OrbTextClip.Liquid passes, OrbReadoutLayout and OrbLiquid.hlsl.
// Glyph masks are cached on frame text/layout changes; the fragment shader clips every glyph pixel with its actual waveY(x).
export const ORB_READOUT_SCRIPT = String.raw`
function createLiquidReadout(st){
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');if(!ctx)throw new Error('Liquid readout requires Canvas 2D');
  let current=null,previous=null,currentTexture=null,previousTexture=null,decorativeTexture=null,uploaded=null,uploadedPrevious=null,lastKey='',lastText='',lastValue=0,rollStart=-99,rollDuration=0,rollTravel=0,rollDirection=0;
  const roll=new Float32Array([0,0,1,0]);
  // DESIGN 10/12: IQ/TH have their own cached mask: never the output odometer or its colors.
  let taskCanvas=null,taskContext=null,taskShadow=null,taskShadowContext=null,taskCurrent=null,taskUnion=null,taskTexture=null,taskUploaded=null,taskKey='',taskContrast=false;
  function updateTask(frame){
    const reading=frame.taskReadout;
    if(!reading||!reading.visible||!reading.glyphs.length){taskCurrent=null;taskUnion=null;taskUploaded=null;taskKey='';return;}
    const key=st.S+'|'+st.dpr+'|'+reading.key;
    taskContrast=!!reading.contrast;
    if(key===taskKey)return;
    const S=st.S,pixels=Math.max(1,Math.ceil(S*st.dpr));
    if(!taskCanvas){
      taskCanvas=document.createElement('canvas');taskContext=taskCanvas.getContext('2d');taskShadow=document.createElement('canvas');taskShadowContext=taskShadow.getContext('2d');
      if(!taskContext||!taskShadowContext)throw new Error('Task readout requires Canvas 2D');
    }
    if(taskCanvas.width!==pixels||taskCanvas.height!==pixels){taskCanvas.width=taskCanvas.height=taskShadow.width=taskShadow.height=pixels;taskCurrent=null;}
    if(!taskCurrent){taskCurrent=new ImageData(pixels,pixels);taskUnion=new ImageData(pixels,pixels);}
    const data=taskCurrent.data,union=taskUnion.data;data.fill(0);
    for(let role=0;role<2;role++){
      taskContext.setTransform(1,0,0,1,0,0);taskContext.clearRect(0,0,pixels,pixels);taskContext.setTransform(st.dpr,0,0,st.dpr,.5*S*st.dpr,.5*S*st.dpr);
      taskContext.fillStyle='#fff';taskContext.textAlign='left';taskContext.textBaseline='alphabetic';taskContext.letterSpacing='0px';
      for(const glyph of reading.glyphs){
        if(glyph.role!==role)continue;
        taskContext.font=glyph.weight+' '+glyph.size+'px "Segoe UI Variable Display","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif';
        taskContext.globalAlpha=glyph.alpha===undefined?1:glyph.alpha;taskContext.fillText(glyph.text,glyph.x,glyph.y);
        if(glyph.proof){
          const width=taskContext.measureText(glyph.text).width,diameter=Math.max(1/st.dpr,.1*glyph.size),count=Math.max(2,Math.floor((width-diameter)/(2.4*diameter))+1),pitch=(width-diameter)/(count-1);
          taskContext.globalAlpha*=taskContrast?1:.7;taskContext.beginPath();
          for(let dot=0;dot<count;dot++){const x=glyph.x+diameter/2+dot*pitch;taskContext.moveTo(x+diameter/2,glyph.y+.22*glyph.size);taskContext.arc(x,glyph.y+.22*glyph.size,diameter/2,0,Math.PI*2);}
          taskContext.fill();
        }
      }
      taskContext.globalAlpha=1;
      const alpha=taskContext.getImageData(0,0,pixels,pixels).data;
      for(let index=0;index<data.length;index+=4)data[index+role]=alpha[index+3];
    }
    for(let index=0;index<data.length;index+=4){union[index]=union[index+1]=union[index+2]=255;union[index+3]=Math.max(data[index],data[index+1]);}
    taskContext.setTransform(1,0,0,1,0,0);taskContext.clearRect(0,0,pixels,pixels);taskContext.putImageData(taskUnion,0,0);
    taskShadowContext.clearRect(0,0,pixels,pixels);taskShadowContext.filter='blur('+(.015*S*st.dpr)+'px)';taskShadowContext.drawImage(taskCanvas,0,0);taskShadowContext.filter='none';
    const shadow=taskShadowContext.getImageData(0,0,pixels,pixels).data;for(let index=0;index<data.length;index+=4)data[index+3]=shadow[index+3];
    taskKey=key;taskUploaded=null;
  }
  function update(frame,metrics,animate){
    updateTask(frame);
    const key=st.S+'|'+st.dpr+'|'+st.thumbnail+'|'+frame.formattedValue+'|'+frame.unit+'|'+metrics.labelText+'|'+metrics.valueSize+'|'+metrics.labelSize+'|'+metrics.labelTracking+'|'+metrics.valueY+'|'+metrics.unitY+'|'+metrics.labelY;
    if(key===lastKey)return;
    const S=st.S,pixels=Math.max(1,Math.ceil(S*st.dpr)),data=new ImageData(pixels,pixels),buffer=data.data;
    canvas.width=canvas.height=pixels;
    for(let role=0;role<3;role++){
      if(st.thumbnail&&role>0)continue;
      ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,pixels,pixels);ctx.setTransform(st.dpr,0,0,st.dpr,.5*S*st.dpr,.5*S*st.dpr);
      ctx.fillStyle='#fff';ctx.textAlign='center';ctx.textBaseline='alphabetic';
      const size=role===0?metrics.valueSize:role===1?metrics.unitSize:metrics.labelSize,weight=role===0?700:role===1?500:metrics.labelWeight;
      ctx.font=weight+' '+size+'px "Segoe UI Variable Display","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif';ctx.letterSpacing=(role===0?metrics.valueTracking:role===1?.5:metrics.labelTracking)+'px';
      ctx.fillText(role===0?frame.formattedValue:role===1?frame.unit:metrics.labelText,0,(role===0?metrics.valueY:role===1?metrics.unitY:metrics.labelY)*S);
      const alpha=ctx.getImageData(0,0,pixels,pixels).data;
      for(let i=0;i<buffer.length;i+=4)buffer[i+role]=alpha[i+3];
    }
    // Cache the submerged glyph shadow along with the masks, not a per-frame blur pass.
    const union=new ImageData(pixels,pixels);
    for(let i=0;i<buffer.length;i+=4){union.data[i]=union.data[i+1]=union.data[i+2]=255;union.data[i+3]=Math.max(buffer[i],buffer[i+1],buffer[i+2]);}
    ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,pixels,pixels);ctx.putImageData(union,0,0);
    const shadow=document.createElement('canvas');shadow.width=shadow.height=pixels;const blur=shadow.getContext('2d');if(!blur)throw new Error('Liquid readout shadow requires Canvas 2D');blur.filter='blur('+(.015*S*st.dpr)+'px)';blur.drawImage(canvas,0,0);blur.filter='none';
    const alpha=blur.getImageData(0,0,pixels,pixels).data;for(let i=0;i<buffer.length;i+=4)buffer[i+3]=alpha[i+3];
    // A task-only stack move must not restart or replace the main output's in-flight odometer.
    if(frame.taskReadout&&frame.taskReadout.visible&&lastText===frame.formattedValue){current=data;lastKey=key;return;}
    previous=current;current=data;
    const changed=lastText!==frame.formattedValue;
    if(animate&&changed&&previous){rollStart=performance.now();rollDuration=lastText.length===frame.formattedValue.length?240:120;rollTravel=rollDuration===240?.92*metrics.valueSize/S:0;rollDirection=(frame.value===null?0:frame.value)>=lastValue?-1:1;}
    else{rollStart=-99;rollDuration=0;}
    lastText=frame.formattedValue;lastValue=frame.value===null?0:frame.value;lastKey=key;
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
    gl.uniform1f(u.uTaskReadoutOn,taskCurrent?1:0);gl.uniform1f(u.uTaskReadoutContrast,taskContrast?1:0);
    if(taskCurrent){
      if(!taskTexture)taskTexture=texture(gl);gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,taskTexture);
      if(taskUploaded!==taskCurrent){gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,taskCurrent);taskUploaded=taskCurrent;}
      gl.uniform1i(u.uTaskReadout,3);
    }
    const age=performance.now()-rollStart,q=rollDuration>0?clamp(age/rollDuration):1,k=ease(q);
    roll[0]=-rollDirection*rollTravel*(1-k);roll[1]=rollDirection*rollTravel*k;roll[2]=q<1?k:1;roll[3]=q<1?1-k:0;gl.uniform4fv(u.uReadoutRoll,roll);
    const dark=st.dark,active=st.value>=.5,title=st.hovered?(dark?[1,1,1]:[0,0,0]):active?labelRgb(st.h,dark):(dark?[1,1,1]:[0,0,0]),below=st.hovered?(dark?[1,1,1]:[11/255,13/255,18/255]):dark?[1,1,1]:labDarken(heatRgb(Math.max(st.h,.05)),.55);
    gl.uniform4f(u.uReadoutValue,dark?1:11/255,dark?1:13/255,dark?1:18/255,active?(dark?.96:.92):(dark?.60:.55));
    gl.uniform4f(u.uReadoutUnit,dark?1:0,dark?1:0,dark?1:0,dark?.55:.5);
    gl.uniform4f(u.uReadoutTitle,title[0],title[1],title[2],st.hovered?(dark?.55:.5):active?1:(dark?.45:.4));
    gl.uniform4f(u.uReadoutBelowTitle,below[0],below[1],below[2],st.hovered?(dark?.80:.72):dark?.94:1);
  }
  function reset(gl){
    if(gl){if(currentTexture)gl.deleteTexture(currentTexture);if(previousTexture)gl.deleteTexture(previousTexture);if(decorativeTexture)gl.deleteTexture(decorativeTexture);if(taskTexture)gl.deleteTexture(taskTexture);}
    currentTexture=previousTexture=decorativeTexture=uploaded=uploadedPrevious=taskTexture=taskUploaded=null;
  }
  return {update,bind,reset};
}
`;
