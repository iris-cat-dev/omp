// GPU hosting for Agent Speed v1.6.1 Windows (zoefix, MIT; 384ce020cc655133e95aaad5cc085f3985f0ed99).
// Settings previews share one window-lifetime WebGL2 owner; their visible canvases retain real shader snapshots, not substitute art.
export const ORB_GPU_SCRIPT = String.raw`
const GPU_UNIFORMS=['uRes','uS','uLogicalS','uThumbnail','uReduced','uTime','uH','uO','uDark','uNew','uLevel','uFlash','uPeak','uSweep','uTier','uComet','uFlow','uPhase','uPhase2','uSilkNoise','uSilkClock','uWarp','uCorona','uWaves','uTicks','uFx','uMoving','uEmbedded','uIdleSweep','uIdleProgress','uSurface','uPhases','uRipples','uReadout','uReadoutOld','uDecorative','uReadoutOn','uReadoutRoll','uReadoutValue','uReadoutUnit','uReadoutTitle','uReadoutBelowTitle','uPerfReadout','uPerfReadoutOn','uPerfReadoutContrast','uLiquidColors','uLiquidInk','uMeniscus','uHeatPalette','uReadoutBoxes','uReadoutCells','uReadoutCellCount','uReadoutBand','uReadoutPrefix','uReadoutPreviousShift','uReadoutLabelRoll','uReadoutLabelMoving','uReadoutLabelClipped','uReadoutLabelBand','uReadoutPreviousLabelShift','uReadoutOldTitle','uReadoutOldBelowTitle','uAuraColor','uAuraIntensity','uActivity','uLedColors','uCometArcs'];
function orbGl(canvas){
  const gl=canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false,preserveDrawingBuffer:false,powerPreference:'low-power'});
  if(!gl)throw new Error('WebGL 2 is unavailable');return gl;
}
function disposeGpuResources(resources){
  if(!resources||resources.gl.isContextLost())return;
  const gl=resources.gl;if(resources.palette)gl.deleteTexture(resources.palette);for(const p of Object.values(resources.programs))gl.deleteProgram(p.program);
  if(resources.buffer)gl.deleteBuffer(resources.buffer);if(resources.vertex)gl.deleteShader(resources.vertex);
}
function loseOrbGl(gl){if(gl&&!gl.isContextLost()){const extension=gl.getExtension('WEBGL_lose_context');if(extension)extension.loseContext();}}
function createGpuResources(gl){
  const resources={gl,buffer:null,vertex:null,palette:null,programs:{}};
  try{
    const compile=(type,source)=>{const shader=gl.createShader(type);if(!shader)throw new Error('Cannot allocate shader');gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){const reason=gl.getShaderInfoLog(shader);gl.deleteShader(shader);throw new Error(reason||'Shader compilation failed');}return shader;};
    resources.vertex=compile(gl.VERTEX_SHADER,VERTEX_SHADER);resources.buffer=gl.createBuffer();if(!resources.buffer)throw new Error('Cannot allocate vertex buffer');
    gl.bindBuffer(gl.ARRAY_BUFFER,resources.buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
    const createProgram=source=>{
      const fragment=compile(gl.FRAGMENT_SHADER,source),program=gl.createProgram();if(!program){gl.deleteShader(fragment);throw new Error('Cannot allocate shader program');}
      gl.attachShader(program,resources.vertex);gl.attachShader(program,fragment);gl.bindAttribLocation(program,0,'p');gl.linkProgram(program);gl.deleteShader(fragment);
      if(!gl.getProgramParameter(program,gl.LINK_STATUS)){const reason=gl.getProgramInfoLog(program);gl.deleteProgram(program);throw new Error(reason||'Shader link failed');}
      const locations={};for(const name of GPU_UNIFORMS)locations[name]=gl.getUniformLocation(program,name);return {program,locations};
    };
    resources.programs.led=createProgram(LED_FRAGMENT_SHADER);resources.programs.liquid=createProgram(LIQUID_FRAGMENT_SHADER);
    gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);return resources;
  }catch(error){disposeGpuResources(resources);throw error;}
}
const ledSegmentPalettes={dark:null,light:null},ledWhite=[1,1,1];
function prepareLedColors(out,st,h,o,sweep,thumbnail,embedded){
  out.fill(0);const lit=h*sweep*36;if(lit<=0)return;
  const appearance=st.dark?'dark':'light';let palette=ledSegmentPalettes[appearance];
  if(!palette)palette=ledSegmentPalettes[appearance]=Array.from({length:36},(_,i)=>{const color=heatRgb(Math.max(.07,i/35));return st.dark?color:labDarken(color,.06);});
  // LedDraw.AddSegments computes OKLab per segment, not per fragment in the driver.
  const fx=embedded?Math.min(st.fx,1):st.fx,motion=fx>=2&&st.moving&&!thumbnail&&!embedded,act=smooth(0,.08,h),darkLeading=st.dark?labMix(HOT,ledWhite,.4*o):null,flash=.25*clamp(st.flash);
  for(let i=0;i<Math.min(36,Math.ceil(lit));i++){
    const hash=Math.sin((i*13.1+Math.floor(st.time*12))*127.1)*43758.5453,shimmer=st.tier>3.5&&fx>=2&&st.moving?.75+.25*(hash-Math.floor(hash)):1;
    const phase=i/36*2.2-st.flow,flow=motion?Math.pow(1-(phase-Math.floor(phase)),9)*act*(.5+.9*h):0;
    let color=palette[i].map(channel=>channel*shimmer);
    if(flow>.001)color=mix(color,st.dark?HOT:color.map(channel=>Math.min(1,channel*1.15)),.75*flow);
    const whiteness=clamp(1-Math.max(0,lit-i-1));
    if(whiteness>0)color=labMix(color,st.dark?darkLeading:labMix(heatRgb(i/35),AMBER,.2+.3*o),whiteness);
    if(flash>0)color=mix(color,ledWhite,flash);
    const at=i*4;out[at]=color[0];out[at+1]=color[1];out[at+2]=color[2];out[at+3]=Math.min(1,clamp(lit-i)*(1+.9*flow));
  }
}
function prepareCometArcs(out,st,h,thumbnail,embedded){
  out.fill(0);const fx=embedded?Math.min(st.fx,1):st.fx;
  if(h<=.01||fx<=.5||!st.moving)return;
  const count=fx>=2&&!thumbnail&&!embedded&&h>.55?2:1;
  for(let index=0;index<count;index++){
    const head=((270+st.comet*360+index*180)%360+360)%360,angle=head*Math.PI/180,gapDistance=Math.abs((head-90+540)%360-180),at=index*4;
    out[at]=head;out[at+1]=Math.cos(angle)*.468;out[at+2]=-Math.sin(angle)*.468;
    out[at+3]=(.25+.6*h)*(index===1?.7:1)*(.3+.7*smooth(18,52,gapDistance));
  }
}
function bindHeatPalette(resources,location){
  const gl=resources.gl;gl.activeTexture(gl.TEXTURE0+4);
  if(!resources.palette){
    const pixels=new ImageData(256,1);for(let i=0;i<256;i++){const c=heatRgb(i/255),k=i*4;pixels.data[k]=Math.round(c[0]*255);pixels.data[k+1]=Math.round(c[1]*255);pixels.data[k+2]=Math.round(c[2]*255);pixels.data[k+3]=255;}
    resources.palette=gl.createTexture();if(!resources.palette)throw new Error('Cannot allocate orb heat palette');
    gl.bindTexture(gl.TEXTURE_2D,resources.palette);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
  }else gl.bindTexture(gl.TEXTURE_2D,resources.palette);
  gl.uniform1i(location,4);
}
let thumbnailGpuPool=null,thumbnailGpuDisposed=false;
function retainThumbnailGpu(lost,restored){
  if(thumbnailGpuDisposed)throw new Error('Preview GPU has been disposed');
  if(!thumbnailGpuPool){
    const pool={canvas:document.createElement('canvas'),gl:null,resources:null,error:null,lost:false,users:new Set(),onLost:null,onRestored:null};
    thumbnailGpuPool=pool;
    pool.onLost=event=>{event.preventDefault();pool.lost=true;pool.resources=null;for(const user of Array.from(pool.users))user.lost(event);};
    // Restoration invalidates the old programs, but rebuilding waits for an actual visible draw.
    pool.onRestored=()=>{pool.lost=false;pool.error=null;for(const user of Array.from(pool.users))user.restored();};
    pool.canvas.addEventListener('webglcontextlost',pool.onLost);pool.canvas.addEventListener('webglcontextrestored',pool.onRestored);
  }
  const user={lost,restored},lease={pool:thumbnailGpuPool,user,released:false};thumbnailGpuPool.users.add(user);return lease;
}
function thumbnailGpuResources(pool){
  if(thumbnailGpuDisposed||pool.lost)return null;
  if(!pool.resources&&!pool.error){
    try{if(!pool.gl)pool.gl=orbGl(pool.canvas);pool.resources=createGpuResources(pool.gl);}catch(error){pool.error=error;}
  }
  if(pool.error)throw pool.error;return pool.resources;
}
function releaseThumbnailGpu(lease){
  if(!lease||lease.released)return;lease.released=true;const pool=lease.pool;pool.users.delete(lease.user);
  // No animation or work belongs to an idle pool. Keep successful programs until page teardown,
  // while allowing a failed initialization to recover on the next visible activation.
  if(!pool.users.size)pool.error=null;
}
function disposeThumbnailGpu(){
  if(thumbnailGpuDisposed)return;thumbnailGpuDisposed=true;const pool=thumbnailGpuPool;thumbnailGpuPool=null;if(!pool)return;
  pool.canvas.removeEventListener('webglcontextlost',pool.onLost);pool.canvas.removeEventListener('webglcontextrestored',pool.onRestored);
  disposeGpuResources(pool.resources);loseOrbGl(pool.gl);pool.resources=null;pool.gl=null;pool.users.clear();pool.canvas.width=pool.canvas.height=1;
}
`;
