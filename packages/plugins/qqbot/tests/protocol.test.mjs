import { afterEach, expect, it } from 'vitest';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { startProtocolServer } from './protocol-server.mjs';
let fixture;
let bot;
afterEach(async()=>{bot?.stop();await fixture?.close();bot=undefined;fixture=undefined;});
it('real QQ SDK identifies, receives C2C and replies through actual protocol endpoints',async()=>{
  fixture=await startProtocolServer();
  bot=new QQBot({appId:fixture.appId,appSecret:fixture.clientSecret,baseUrl:fixture.base,tokenBaseUrl:fixture.base,reconnect:{maxAttempts:0}});
  const ready=new Promise(resolve=>bot.on('ready',resolve));
  let resolveMessage;
  const message=new Promise(resolve=>{resolveMessage=resolve;});
  bot.on('message',async context=>{await bot.sendMarkdown(context.replyTarget,`echo:${context.message.content}`);resolveMessage(context.message);});
  const running=bot.start();await ready;
  const result=await fetch(`${fixture.base}/__control/message`,{method:'POST',body:JSON.stringify({scope:'c2c',sender:'protocol-user',text:'hello'})});
  expect(result.ok).toBe(true);expect((await message).senderId).toBe('protocol-user');
  expect(fixture.connections).toBe(1);expect(fixture.outbound).toContainEqual(expect.objectContaining({path:'/v2/users/protocol-user/messages',body:expect.objectContaining({markdown:{content:'echo:hello'}})}));
  bot.stop();await running;
},10000);
