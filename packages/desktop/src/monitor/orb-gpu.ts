// GPU hosting for the Agent Speed v1.4.1 shader port (zoefix, MIT; a94a67fcc78e5d8eea5f82d8d5e737bccf994e2c).
// Static previews share one detached WebGL2 owner; their visible canvases retain real shader snapshots, not substitute art.
export const ORB_GPU_SCRIPT = String.raw`
const GPU_UNIFORMS=['uRes','uS','uLogicalS','uThumbnail','uReduced','uTime','uH','uO','uDark','uNew','uLevel','uFlash','uPeak','uSweep','uTier','uComet','uFlow','uPhase','uPhase2','uWarp','uCorona','uWaves','uTicks','uFx','uMoving','uEmbedded','uIdleSweep','uSurface','uPhases','uRipples','uReadout','uReadoutOld','uDecorative','uReadoutOn','uReadoutRoll','uReadoutValue','uReadoutUnit','uReadoutTitle','uReadoutBelowTitle','uLiquidColors','uLiquidInk','uMeniscus','uWaveColors'];
function orbGl(canvas){
  const gl=canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false,preserveDrawingBuffer:false,powerPreference:'low-power'});
  if(!gl)throw new Error('WebGL 2 is unavailable');return gl;
}
function disposeGpuResources(resources){
  if(!resources||resources.gl.isContextLost())return;
  const gl=resources.gl;for(const p of Object.values(resources.programs))gl.deleteProgram(p.program);
  if(resources.buffer)gl.deleteBuffer(resources.buffer);if(resources.vertex)gl.deleteShader(resources.vertex);
}
function loseOrbGl(gl){if(gl&&!gl.isContextLost()){const extension=gl.getExtension('WEBGL_lose_context');if(extension)extension.loseContext();}}
function createGpuResources(gl){
  const resources={gl,buffer:null,vertex:null,programs:{}};
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
let thumbnailGpuPool=null;
function retainThumbnailGpu(lost,restored){
  if(!thumbnailGpuPool){
    const pool={canvas:document.createElement('canvas'),gl:null,resources:null,error:null,lost:false,users:new Set(),onLost:null,onRestored:null};
    thumbnailGpuPool=pool;
    pool.onLost=event=>{event.preventDefault();pool.lost=true;pool.resources=null;for(const user of Array.from(pool.users))user.lost(event);};
    pool.onRestored=()=>{pool.lost=false;pool.error=null;try{pool.resources=createGpuResources(pool.gl);}catch(error){pool.error=error;}for(const user of Array.from(pool.users))user.restored();};
    pool.canvas.addEventListener('webglcontextlost',pool.onLost);pool.canvas.addEventListener('webglcontextrestored',pool.onRestored);
    try{pool.gl=orbGl(pool.canvas);pool.resources=createGpuResources(pool.gl);}catch(error){pool.error=error;}
  }
  const user={lost,restored},lease={pool:thumbnailGpuPool,user,released:false};thumbnailGpuPool.users.add(user);return lease;
}
function releaseThumbnailGpu(lease){
  if(!lease||lease.released)return;lease.released=true;const pool=lease.pool;pool.users.delete(lease.user);if(pool.users.size)return;
  pool.canvas.removeEventListener('webglcontextlost',pool.onLost);pool.canvas.removeEventListener('webglcontextrestored',pool.onRestored);
  disposeGpuResources(pool.resources);loseOrbGl(pool.gl);pool.resources=null;pool.gl=null;pool.canvas.width=pool.canvas.height=1;
  if(thumbnailGpuPool===pool)thumbnailGpuPool=null;
}
`;
