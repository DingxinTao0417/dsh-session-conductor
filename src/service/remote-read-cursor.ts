import { createHash } from 'node:crypto'
import type { ConductorStore } from '../store/repository.ts'
import type { BindingRecord } from '../store/schema.ts'

function identity(binding:BindingRecord,readerSessionId:string){
  const params={purpose:'remote-history-cursor',readerSessionId,taskId:binding.taskId,hostId:binding.hostId,sessionId:binding.sessionId,bindingVersion:binding.version}
  return {operationId:`remote-read-cursor:${createHash('sha256').update(JSON.stringify(params)).digest('hex')}`,params}
}
/** History reads and waits own separate source positions; the bridge controller owns neither. */
export function remoteHistoryCursor(store:ConductorStore,binding:BindingRecord,readerSessionId:string):number {
  const result=store.getOperation(identity(binding,readerSessionId).operationId)?.result as {cursor?:unknown}|undefined
  return typeof result?.cursor==='number' && Number.isSafeInteger(result.cursor) && result.cursor>=-1?result.cursor:-1
}
export async function persistRemoteHistoryCursor(store:ConductorStore,binding:BindingRecord,readerSessionId:string,cursor:string):Promise<void>{
  if(!/^-?\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)) || Number(cursor)<-1)throw Error('REMOTE_INVALID_HISTORY_CURSOR')
  const input=identity(binding,readerSessionId)
  await store.withExclusive(input.operationId,async()=>{
    const claim=await store.beginOperation({...input,kind:'remote',taskId:binding.taskId})
    if(claim.kind==='conflict')throw Error('REMOTE_HISTORY_CURSOR_CONFLICT')
    const position=Math.max(remoteHistoryCursor(store,binding,readerSessionId),Number(cursor))
    await store.updateOperation(input.operationId,row=>({...row,result:{cursor:position},delivery:'accepted',phase:'remote_history_cursor'}))
  })
}
