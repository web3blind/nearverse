export interface RecoveryProbe { blocked:boolean; invalid:boolean; owners:string[]; entries:Record<string,string>; message:string }
export interface RecoveryObservation { blocked:boolean; entries:Record<string,string> }
/** Join independently observed startup bytes without forgetting either witness. */
export function mergeRecovery(previous:RecoveryObservation,next:RecoveryObservation):RecoveryObservation {
  const entries:Record<string,string>=Object.assign(Object.create(null),previous.entries);
  let blocked=previous.blocked || next.blocked;
  for(const [owner,raw] of Object.entries(next.entries)){
    if(Object.prototype.hasOwnProperty.call(entries,owner) && entries[owner]!==raw)blocked=true;
    else entries[owner]=raw;
  }
  return {blocked,entries};
}
/** Accumulate first-seen bytes until the converter takes ownership of recovery. */
export function observeRecovery(previous:RecoveryObservation,next:RecoveryProbe):RecoveryObservation {
  const entries:Record<string,string>=Object.assign(Object.create(null),previous.entries);
  let blocked=previous.blocked || next.invalid;
  for(const [owner,raw] of Object.entries(previous.entries))if(next.entries[owner]!==raw)blocked=true;
  for(const [owner,raw] of Object.entries(next.entries))if(!Object.prototype.hasOwnProperty.call(entries,owner))entries[owner]=raw;
  return {blocked,entries};
}
/** Metadata-only startup fence. Cached wallet addresses never activate the SDK. */
export function probeRecovery(provided?:Storage):RecoveryProbe {
  const owners:string[]=[];
  const entries:Record<string,string>=Object.create(null);
  try {
    const storage=provided ?? localStorage;
    for(let i=0;i<storage.length;i++){
      const key=storage.key(i);
      if(!key?.startsWith('nearverse:pending:'))continue;
      const owner=key.slice('nearverse:pending:'.length);
      const raw=storage.getItem(key);
      // Same account contract as storage.scopeKey, without importing IDB/world
      // into the initial shell. Invalid keys are a fence, never silently ignored.
      entries[owner]=raw ?? '';
      if(owner.length<2 || owner.length>64 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(owner))throw new Error('invalid_recovery_owner');
      const saved=JSON.parse(raw ?? 'null');
      if(!saved || saved.accountId!==owner || typeof saved.eventId!=='string' || !saved.eventId)throw new Error('invalid_recovery');
      owners.push(owner);
    }
    return {blocked:owners.length>0,invalid:false,owners,entries,message:owners.length?'A saved transaction needs recovery. Connect its NEAR wallet before starting any new financial action. Do not repeat a transfer.':''};
  }catch{return {blocked:true,invalid:true,owners,entries,message:'Transaction recovery storage is unavailable or corrupted. New financial actions are blocked. Do not repeat a transfer.'};}
}
