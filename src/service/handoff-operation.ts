import { createHash } from 'node:crypto'
import type { ConductorStore } from '../store/repository.ts'
import type { HandoffOutcome, HandoffRequest } from './handoff.ts'
import { writeControlRefusal } from './access.ts'

interface PreparedHandoff {sourceBindingId:string;successorSessionId:string;successorBindingId:string;ownerEpoch:number;bindingVersion:number;outcome?:HandoffOutcome}
const inFlight = new WeakMap<ConductorStore, Map<string,Promise<void>>>()
/** Durable admission returns before stop/filesystem/session preparation; uncertain work is never re-created. */
export async function enqueueHandoff(store:ConductorStore,request:HandoffRequest,
  execute:(identities:PreparedHandoff)=>Promise<HandoffOutcome>):Promise<HandoffOutcome> {
  return await store.withExclusive(`handoff-operation:${request.operationId}`,async()=>{
    const control=writeControlRefusal(store.getAccess(request.taskId),request.taskId,request.callerSessionId)
    if(control)throw new Error(`${control.code}: ${control.reason}`)
    const task=store.getTask(request.taskId)
    if(!task?.currentBindingId)throw new Error('NOT_FOUND: task has no binding')
    const claim=await store.beginOperation({operationId:request.operationId,kind:'handoff',taskId:request.taskId,params:request})
    if(claim.kind==='conflict')throw new Error('OPERATION_CONFLICT: handoff identity has different parameters')
    const operation=store.getOperation(request.operationId)!
    const prior=operation.result as PreparedHandoff|undefined
    if(prior?.outcome)return {...prior.outcome,operationId:request.operationId}
    const pending = ():HandoffOutcome=>({taskId:request.taskId,operationId:request.operationId,pending:true,succeeded:false,reached:'stopping',
      preconditions:{checked:['handoff request durably accepted'],unchecked:['asynchronous preparation still in progress']}})
    let queue=inFlight.get(store);if(!queue){queue=new Map();inFlight.set(store,queue)}
    if(queue.has(request.operationId))return pending()
    if(claim.kind==='replay'){
      const successor=prior ? store.getBinding(prior.successorBindingId) : undefined
      if(successor && task.currentBindingId===successor.bindingId){
        const outcome:HandoffOutcome={taskId:request.taskId,operationId:request.operationId,succeeded:true,reached:'switching_binding',successorSessionId:successor.sessionId,
          ...store.getBinding(prior!.sourceBindingId)?.sessionId === undefined ? {} : {previousSessionId:store.getBinding(prior!.sourceBindingId)!.sessionId},
          preconditions:{checked:['successor binding recovered from durable state'],unchecked:[]}}
        await store.updateOperation(request.operationId,row=>({...row,delivery:'accepted',phase:'complete',result:{...prior,outcome}}));return outcome
      }
      await store.markDelivery(request.operationId,'unknown','reconcile_required')
      return {taskId:request.taskId,operationId:request.operationId,succeeded:false,reached:'stopping',reason:'UNKNOWN: interrupted handoff has no committed successor receipt; source binding is retained and no session was recreated',preconditions:{checked:[],unchecked:['interrupted preparation outcome']}}
    }
    const identity=createHash('sha256').update(request.operationId).digest('hex').slice(0,32)
    const prepared:PreparedHandoff={sourceBindingId:task.currentBindingId,successorSessionId:`handoff-session-${identity}`,successorBindingId:`handoff-binding-${identity}`,
      ownerEpoch:store.getAccess(request.taskId)!.ownerEpoch,bindingVersion:store.getBinding(task.currentBindingId)!.version}
    await store.updateOperation(request.operationId,row=>({...row,result:prepared,phase:'accepted'}))
    const running=Promise.resolve().then(async()=>{
      await store.markDelivery(request.operationId,'dispatching','stopping')
      const outcome=await execute(prepared)
      await store.updateOperation(request.operationId,row=>({...row,result:{...prepared,outcome},delivery:outcome.succeeded?'accepted':'failed',phase:outcome.reached}))
    }).catch(async()=>{
      try{await store.markDelivery(request.operationId,'unknown','reconcile_required')}catch{/* the prior durable phase remains unconfirmed; background work must not reject unhandled */}
    }).finally(()=>queue!.delete(request.operationId))
    queue.set(request.operationId,running)
    return pending()
  })
}
