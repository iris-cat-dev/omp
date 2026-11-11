const metadataKeys:Record<string,true>={epoch:true,revision:true,installationId:true,generation:true,clientActivationId:true};
/** Classification is not authorization: the owner must still match the exact revoked lease binding. */
export function isPluginReleaseOperation(operation:string,input:unknown):boolean {
 if(!input||typeof input!=="object"||Array.isArray(input))return false;
 if(operation==="files.sandbox"){
  return "action" in input&&input.action==="close"&&"handle" in input&&typeof input.handle==="string"&&input.handle.length>0&&Object.keys(input).every(key=>key==="action"||key==="handle");
 }
 if(operation==="wallpaper:setBackground"){
  return "candidateId" in input&&input.candidateId===null&&Object.keys(input).every(key=>key==="candidateId"||metadataKeys[key]);
 }
 if(operation==="wallpaper:setPreviews"){
  return "candidateIds" in input&&Array.isArray(input.candidateIds)&&input.candidateIds.length===0&&Object.keys(input).every(key=>key==="candidateIds"||metadataKeys[key]);
 }
 if(operation==="overlay.release"||operation==="menu.unregister"){
  return "leaseId" in input&&typeof input.leaseId==="string"&&input.leaseId.length>0&&Object.keys(input).every(key=>key==="leaseId"||metadataKeys[key]);
 }
 return false;
}
