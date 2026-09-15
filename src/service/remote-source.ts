import type { ConductorStore } from '../store/repository.ts'
import type { BindingRecord, StoredOperationRecord } from '../store/schema.ts'
import { writeControlRefusal } from './access.ts'
import { z } from 'zod'
import type { SendRequest, SendResult, StopRequest, StopResult, QueueRequest, QueueResult } from './coordinator.ts'

export function remoteSendReceipt(value: unknown, request: SendRequest, messageId: string): SendResult {
  const result=z.object({taskId:z.literal(request.taskId),mode:z.literal(request.mode),delivery:z.enum(['accepted','replayed','pending']),
    requestedMessageId:z.literal(messageId),messageId:z.string().min(1).optional(),reason:z.string().optional()}).parse(value)
  if(result.delivery!=='pending' && !result.messageId)throw Error('REMOTE_INVALID_SEND_RECEIPT')
  return {taskId:result.taskId,mode:result.mode,delivery:result.delivery,...result.messageId===undefined?{}:{messageId:result.messageId},...result.reason===undefined?{}:{reason:result.reason}}
}
export function remoteStopReceipt(value: unknown, request: StopRequest): StopResult {
  const result=z.object({taskId:z.literal(request.taskId),outcome:z.enum(['no_active_turn','requested','confirmed','unconfirmed','kept']),
    sent:z.boolean(),keptText:z.boolean(),reason:z.string(),messageId:z.string().min(1).optional(),
    expectedTurn:z.number().int().optional(),turn:z.number().int().optional(),turnOutcome:z.string().optional()}).parse(value)
  if(result.expectedTurn!==request.expectedTurn || result.sent && (request.text===undefined || result.keptText || !result.messageId))throw Error('REMOTE_INVALID_STOP_RECEIPT')
  return {taskId:result.taskId,outcome:result.outcome,sent:result.sent,keptText:result.keptText,reason:result.reason,
    ...result.messageId===undefined?{}:{messageId:result.messageId},...result.expectedTurn===undefined?{}:{expectedTurn:result.expectedTurn},
    ...result.turn===undefined?{}:{turn:result.turn},...result.turnOutcome===undefined?{}:{turnOutcome:result.turnOutcome}}
}
export function remoteQueueReceipt(value: unknown, request: QueueRequest): QueueResult {
  const result=z.object({taskId:z.literal(request.taskId),reason:z.string(),messages:z.array(z.object({messageId:z.string().min(1),text:z.string(),list:z.enum(['queue','steering'])})),
    changed:z.object({messageId:z.string(),action:z.enum(['edited','withdrawn','already_consumed'])}).optional()}).parse(value)
  if(result.changed && (request.action==='list' || result.changed.messageId!==request.messageId
    || result.changed.action!=='already_consumed' && result.changed.action!==(request.action==='edit'?'edited':'withdrawn')))throw Error('REMOTE_INVALID_QUEUE_RECEIPT')
  return {taskId:result.taskId,reason:result.reason,messages:result.messages,...result.changed===undefined?{}:{changed:result.changed}}
}

/** Settle a known source operation from an explicit read of its original Host receipt. */
export async function reconcileRemoteSource(options: {
  store:ConductorStore;operationId:string;hostId:string;result:unknown
  counted(taskId:string,operationId:string,at:string):Promise<void>
}):Promise<boolean>{
  const {store,operationId}=options
  return await store.withExclusive('target-dispatch',async()=>{
    const operation=store.getOperation(operationId)
    const params=operation?.params as (SendRequest & StopRequest & QueueRequest & {remoteAction?:string;destinationHostId?:string;requestedMessageId?:string})|undefined
    if(!operation || operation.kind!=='remote' || !operation.taskId || !params || params.destinationHostId!==options.hostId
      || operation.withdrawn || operation.delivery==='failed')return false
    let pending=false,counted=false
    if(params.remoteAction==='task.send' && typeof params.requestedMessageId==='string'){
      const receipt=remoteSendReceipt(options.result,params,params.requestedMessageId)
      pending=receipt.delivery==='pending';counted=!pending
    }else if(params.remoteAction==='task.stop')counted=remoteStopReceipt(options.result,params).sent
    else if(params.remoteAction==='task.queue')remoteQueueReceipt(options.result,params)
    else return false
    const now=new Date().toISOString()
    await store.updateOperation(operationId,row=>({...row,result:options.result,delivery:pending?'unknown':'accepted',phase:pending?'remote_pending':'remote_confirmed'}))
    if(counted)await options.counted(operation.taskId,operationId,now)
    return true
  })
}

/** Source-side admission/receipt. The wire's own journal still owns transport dedupe. */
export async function executeRemoteMutation<Result>(options: {
  store: ConductorStore; binding: BindingRecord; taskId: string; operationId: string; callerSessionId: string
  expectedOwnerEpoch?:number;expectedBindingVersion?:number
  action: 'task.send'|'task.stop'|'task.queue'; params: object
  attribution?: StoredOperationRecord['attribution']
  admission(record: StoredOperationRecord): void
  dispatch(beforeDispatch: () => void): Promise<unknown>
  validate(value: unknown): Result
  pending?(result: Result): boolean
  counted?(result: Result, operationId: string, at: string): Promise<void>
}): Promise<Result> {
  const {store,binding,taskId,operationId,callerSessionId}=options
  // Share the local target queue's admission lock: two remote dispatches cannot
  // both pass a one-dispatch source budget before either records its receipt.
  return await store.withExclusive('target-dispatch',async()=>{
    const authority=():void=>{
      const access=store.getAccess(taskId)
      const refused=writeControlRefusal(access,taskId,callerSessionId)
      if(refused)throw Error(`${refused.code}: ${refused.reason}`)
      if(options.expectedOwnerEpoch!==undefined && options.expectedOwnerEpoch!==access?.ownerEpoch)throw Error('STALE_OWNER_EPOCH')
      const current=store.getBinding(store.getTask(taskId)?.currentBindingId??'')
      if(current?.bindingId!==binding.bindingId || current.version!==binding.version || current.hostId!==binding.hostId)throw Error('STALE_BINDING')
      if(options.expectedBindingVersion!==undefined && options.expectedBindingVersion!==current.version)throw Error('STALE_BINDING')
    }
    authority()
    const claim=await store.beginOperation({operationId,kind:'remote',taskId,
      params:{...options.params,remoteAction:options.action,destinationHostId:binding.hostId,callerSessionId},
      ...options.attribution===undefined?{}:{attribution:options.attribution},
      dispatchGuard:{ownerSessionId:callerSessionId,ownerEpoch:store.getAccess(taskId)!.ownerEpoch,bindingId:binding.bindingId,bindingVersion:binding.version}})
    if(claim.kind==='conflict')throw Error(`OPERATION_CONFLICT: ${claim.reason}`)
    const record=store.getOperation(operationId)!
    const guard=():void=>{
      authority()
      const pin=record.dispatchGuard
      if(!pin || pin.ownerEpoch!==store.getAccess(taskId)?.ownerEpoch)throw Error('STALE_OWNER_EPOCH')
      if(pin.bindingId!==binding.bindingId || pin.bindingVersion!==binding.version)throw Error('STALE_BINDING')
      if(store.getOperation(operationId)?.withdrawn)throw Error('OPERATION_WITHDRAWN')
    }
    guard()
    if(record.withdrawn || record.delivery==='failed' || record.delivery==='withdrawn')throw Error('REMOTE_SOURCE_OPERATION_REFUSED')
    if(record.delivery==='accepted' && record.result!==undefined){
      const result=options.validate(record.result)
      await options.counted?.(result,operationId,record.updatedAt)
      return result
    }
    let admissionRefusal: string|undefined
    const beforeDispatch=():void=>{
      try {guard();options.admission(record)} catch(error){admissionRefusal=error instanceof Error?error.message:'REMOTE_SOURCE_ADMISSION_REFUSED';throw error}
    }
    try {
      // Unknown source operations only ask the router to reconcile its existing
      // stable identity. The router never repeats an uncertain transport write.
      if(record.delivery==='prepared')beforeDispatch()
      await store.markDelivery(operationId,'dispatching','remote_dispatching')
      const raw=await options.dispatch(beforeDispatch)
      const result=options.validate(raw)
      const pending=options.pending?.(result)===true
      await store.updateOperation(operationId,row=>({...row,result:raw,delivery:pending?'unknown':'accepted',phase:pending?'remote_pending':'remote_confirmed'}))
      if(!pending)await options.counted?.(result,operationId,new Date().toISOString())
      return result
    }catch(error){
      // Even if the store is unavailable, its last dispatching record is already
      // a durable reason to reconcile. Never lose an exception to a second write.
      try{await store.markDelivery(operationId,admissionRefusal===undefined?'unknown':'failed',admissionRefusal??'remote_reconcile_required')}catch{/* retain previous durable state */}
      throw error
    }
  })
}
