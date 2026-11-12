let countValue=0;
export function increment({by}:{by:number}){countValue+=by;return {count:countValue};}
export function searchCounter({query}:{query:string}){return {items:[{id:"snapshot",identifier:"counter://snapshot",title:`Counter snapshot ${countValue}`,url:"https://example.com/counter",text:`Count: ${countValue}\nQuery: ${query}`,resourceType:"text"}]};}
export function createCounterHandler(cleanups:Array<()=>void>){console.log("legacy-counter service started");const timer=setInterval(()=>console.log(`legacy-counter heartbeat ${countValue}`),60000);cleanups.push(()=>{clearInterval(timer);console.log("legacy-counter service stopped");});return increment;}
