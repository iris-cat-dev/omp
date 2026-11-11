import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { pathToFileURL } from 'node:url';

// Test fixture only: the production gateway always uses Tencent endpoints unless
// its operator explicitly overrides QQBOT_BASE_URL / QQBOT_TOKEN_BASE_URL.
export async function startProtocolServer(port = 0) {
  const appId = 'local-qq-smoke';
  const clientSecret = 'local-protocol-only';
  const token = 'local-protocol-token';
  const outbound = [];
  const sockets = new Set();
  let sequence = 0;
  let connections = 0;
  let base;
  const respond = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  const readBody = async request => { let body=''; for await (const chunk of request) { body+=chunk; if(body.length>1048576)throw new Error('Request too large'); } return body ? JSON.parse(body) : {}; };
  const broadcast = (type, data) => { for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op:0,t:type,s:++sequence,d:data })); };
  const server = createServer((request,response) => void (async () => {
    const path = new URL(request.url, base ?? 'http://127.0.0.1').pathname;
    if(path==='/app/getAppAccessToken'&&request.method==='POST') { const body=await readBody(request); return respond(response,body.appId===appId&&body.clientSecret===clientSecret?200:401,body.appId===appId&&body.clientSecret===clientSecret?{access_token:token,expires_in:7200}:{message:'Local fixture credential mismatch'}); }
    if(path==='/__control/state')return respond(response,200,{connections,activeSockets:sockets.size,outbound});
    if(path==='/__control/message'&&request.method==='POST') { const body=await readBody(request); if(body.scope!=='c2c'&&body.scope!=='group')return respond(response,400,{message:'scope required'});const message={id:body.messageId??randomUUID(),content:String(body.text??''),timestamp:new Date().toISOString(),author:body.scope==='group'?{member_openid:body.sender??'local-sender'}:{user_openid:body.sender??'local-sender'},...(body.scope==='group'?{group_openid:body.peer??'local-group',mentions:body.mention?[{id:appId}]:[]}:{}),attachments:body.attachments??[]};broadcast(body.scope==='group'?'GROUP_AT_MESSAGE_CREATE':'C2C_MESSAGE_CREATE',message);return respond(response,200,{accepted:true,id:message.id}); }
    if(path==='/__control/interaction'&&request.method==='POST'){const body=await readBody(request);broadcast('INTERACTION_CREATE',{id:randomUUID(),type:12,version:1,scene:body.scope??'c2c',user_openid:body.scope==='group'?undefined:body.peer??'local-sender',group_openid:body.scope==='group'?body.peer??'local-group':undefined,group_member_openid:body.scope==='group'?body.sender??'local-sender':undefined,data:{type:12,resolved:{button_data:String(body.data??'')}}});return respond(response,200,{accepted:true});}
    if(request.headers.authorization!==`QQBot ${token}`)return respond(response,401,{message:'Unauthorized'});
    if(path==='/gateway')return respond(response,200,{url:base.replace('http:','ws:')+'/gateway'});
    if(/^\/v2\/(users|groups)\/[^/]+\/(messages|stream_messages)$/.test(path)&&request.method==='POST'){const body=await readBody(request);outbound.push({path,body});return respond(response,200,{id:randomUUID(),timestamp:new Date().toISOString()});}
    if(/^\/v2\/(users|groups)\/[^/]+\/files$/.test(path)&&request.method==='POST'){outbound.push({path,body:await readBody(request)});return respond(response,200,{file_uuid:randomUUID(),file_info:'local-fixture-file-reference',ttl:3600});}
    if(path.startsWith('/interactions/')&&request.method==='PUT'){outbound.push({path,body:await readBody(request)});return respond(response,200,{});}
    respond(response,404,{message:'Unsupported QQ fixture endpoint'});
  })().catch(error=>respond(response,400,{message:error.message})));
  const gateway = new WebSocketServer({server,path:'/gateway'});
  gateway.on('connection',socket=>{connections++;sockets.add(socket);socket.send(JSON.stringify({op:10,d:{heartbeat_interval:5000}}));socket.on('message',raw=>{const message=JSON.parse(String(raw));if(message.op===1)socket.send(JSON.stringify({op:11,d:null}));if(message.op===2){if(message.d?.token!==`QQBot ${token}`){socket.close(4004,'Fixture authentication failed');return;}socket.send(JSON.stringify({op:0,t:'READY',s:++sequence,d:{session_id:randomUUID(),user:{id:appId},version:1}}));}if(message.op===6)socket.send(JSON.stringify({op:0,t:'RESUMED',s:++sequence,d:{}}));});socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
  return {base,appId,clientSecret,outbound,get connections(){return connections;},broadcast,close:async()=>{for(const socket of sockets)socket.terminate();await new Promise(resolve=>gateway.close(resolve));await new Promise(resolve=>server.close(resolve));}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const fixture=await startProtocolServer(Number(process.env.QQBOT_SMOKE_PORT??6769));console.info(`QQ protocol fixture: ${fixture.base}\nSet QQBOT_BASE_URL and QQBOT_TOKEN_BASE_URL to this URL before starting a separate test daemon.\nBind AppID ${fixture.appId}; AppSecret ${fixture.clientSecret} (test fixture only).\nPOST /__control/message {scope:c2c,text:/whoami,sender:local-sender}; GET /__control/state captures real SDK replies.`);const close=async()=>{await fixture.close();process.exit(0);};process.once('SIGINT',close);process.once('SIGTERM',close);}
