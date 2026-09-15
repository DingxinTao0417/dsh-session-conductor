import type { ConductorConfig } from '../config.ts'
import type { ConductorStore } from '../store/repository.ts'
import type { RemoteToolRequest, RemoteToolResult } from '../tools.ts'
import { checkCompatibility } from './crosshost.ts'
import { writeControlRefusal, mayRead } from './access.ts'
import { REMOTE_PROTOCOL_VERSION } from '../remote/protocol.ts'
import type { RemoteRuntime } from './remote-runtime.ts'
import type { RemoteMigration } from '../remote/router.ts'

const runningMigrations = new WeakMap<ConductorStore,Map<string,Promise<void>>>()

export async function remoteAction(options:{store:ConductorStore;config:ConductorConfig;runtime?:RemoteRuntime|undefined;pluginVersion:string;
  reconcileReceipt?:(operationId:string,hostId:string,result:unknown)=>Promise<void>},request:RemoteToolRequest):Promise<RemoteToolResult> {
  const {store,config,runtime}=options
  const hosts=():RemoteToolResult['hosts']=>store.listRemoteHosts().map(row=>({hostId:row.hostId,label:row.label,enabled:row.enabled,reached:!!row.protocolVersion,protocolVersion:row.protocolVersion??'unknown'}))
  const availability={available:config.crossHostEnabled && runtime!==undefined,reason:!config.crossHostEnabled?'Cross-Host work is disabled.':!runtime?'The configured bridge could not start; Host services and operator configuration are required.':'SSH/IPC runtime is available; each registered Host must pass live capability checks.'}
  const result=(summary:string,extra:Partial<RemoteToolResult>={}):RemoteToolResult=>({hosts:hosts(),checks:[],availability,refusals:[],summary,...extra})
  if(request.action==='list')return result(`${hosts().length} registered Host(s). ${availability.reason}`)
  if(!config.crossHostEnabled)return result('No remote action ran.',{refusals:[availability.reason]})
  if(['register','enable','disable','remove'].includes(request.action)){
    if(request.authorizedBy!==config.bridge?.controllerSessionId)throw Error('NOT_CONTROLLER: only the operator-selected bridge controller can manage remote registrations')
    if(!request.hostId)throw Error('HOST_REQUIRED')
    const existing=store.getRemoteHost(request.hostId)
    if(request.action==='remove'){
      const active=store.listTasks().some(task=>store.getBinding(task.currentBindingId??'')?.hostId===request.hostId)
      if(active)throw Error('REMOTE_HOST_IN_USE: migrate or explicitly detach bound tasks before removing the Host')
      await store.deleteRemoteHost(request.hostId);return result('Remote registration removed; no workspace or credentials were deleted.')
    }
    if(!config.remoteConnections?.some(route=>route.hostId===request.hostId))throw Error('OPERATOR_ROUTE_REQUIRED: configure an existing SSH alias and finite bridge paths in the plugin row first')
    if(request.action!=='register'&&!existing)throw Error('REMOTE_NOT_REGISTERED')
    await store.putRemoteHost({...existing,hostId:request.hostId,label:request.label??existing?.label??request.hostId,enabled:request.action==='enable',createdAt:existing?.createdAt??new Date().toISOString(),updatedAt:new Date().toISOString()})
    return result(`${request.hostId}: ${request.action}. No SSH keys or credentials were created.`)
  }
  if(!availability.available || !runtime)return result('No remote action ran.',{refusals:[availability.reason]})
  if(request.action==='check'){
    if(!request.hostId)throw Error('HOST_REQUIRED')
    const caps=await runtime.router.capabilities(request.hostId)
    const row=store.getRemoteHost(request.hostId)
    if(!row)throw Error('REMOTE_NOT_REGISTERED')
    await store.putRemoteHost({...row,...caps,updatedAt:new Date().toISOString()})
    const checked=checkCompatibility({...row,...caps},{localPluginVersion:options.pluginVersion,localProtocolVersion:REMOTE_PROTOCOL_VERSION,requiredModels:request.requiredModels??[],workspaceRepresentable:request.workspaceRepresentable??true})
    return result('Live remote capability handshake completed.',{checks:checked.checks.map(item=>({...item}))})
  }
  if(request.action==='migrate'){
    if(!request.taskId || !request.hostId || !request.targetWorkspace || request.historyThroughSeq===undefined)throw Error('MIGRATION_MANIFEST_REQUIRED: task, Host, target workspace and completed-history cutoff are required')
    const control=writeControlRefusal(store.getAccess(request.taskId),request.taskId,request.authorizedBy)
    if(control)throw Error(`${control.code}: ${control.reason}`)
    const task=store.getTask(request.taskId)!
    const binding=store.getBinding(task.currentBindingId??'')
    if(!binding)throw Error('NO_BINDING')
    const migrationId=request.migrationId??request.operationId
    if(!migrationId)throw Error('OPERATION_REQUIRED')
    const claim=await store.beginOperation({operationId:migrationId,kind:'remote',taskId:request.taskId,params:request})
    if(claim.kind==='conflict')throw Error('OPERATION_CONFLICT: migration request changed under the same identity')
    const previous=store.getOperation(`remote-migration:${migrationId}`)?.result as RemoteMigration|undefined
    if(previous?.phase==='succeeded'||previous?.phase==='aborted')return result(`Migration ${migrationId}: ${previous.phase}.`,{operationId:migrationId,phase:previous.phase})
    const manifest=previous?.request??{migrationId,taskId:request.taskId,sourceHostId:binding.hostId==='local'?config.bridge!.hostId:binding.hostId,targetHostId:request.hostId,
      expectedBindingVersion:request.expectedBindingVersion??binding.version,expectedOwnerEpoch:request.expectedOwnerEpoch??store.getAccess(request.taskId)!.ownerEpoch,
      targetWorkspace:request.targetWorkspace,historyThroughSeq:request.historyThroughSeq,artifactIds:request.artifactIds??[],pathMap:request.pathMap??[],requiredModels:request.requiredModels??[]}
    let running=runningMigrations.get(store);if(!running){running=new Map();runningMigrations.set(store,running)}
    if(!running.has(migrationId)){
      const pending=Promise.resolve().then(async()=>{
        await store.markDelivery(migrationId,'dispatching','remote_migration')
        const migration=await runtime.router.migrate(manifest)
        await store.updateOperation(migrationId,row=>({...row,result:{migrationId,phase:migration.phase},delivery:'accepted',phase:migration.phase}))
      }).catch(async()=>{try{await store.markDelivery(migrationId,'unknown','reconcile_required')}catch{/* retain the last durable phase; background failures must be handled */}}).finally(()=>running!.delete(migrationId))
      running.set(migrationId,pending)
    }
    return result(`Migration ${migrationId} accepted asynchronously. Query conductor_operation with this identity; preparation does not mean the target is enabled.`,{operationId:migrationId,phase:previous?.phase??'accepted'})
  }
  if(request.action==='abort'){
    if(!request.migrationId)throw Error('MIGRATION_ID_REQUIRED')
    const record=store.getOperation(`remote-migration:${request.migrationId}`)
    if(!record?.taskId)throw Error('MIGRATION_NOT_FOUND')
    const denied=writeControlRefusal(store.getAccess(record.taskId),record.taskId,request.authorizedBy)
    if(denied)throw Error(denied.reason)
    const migration=await runtime.router.abort(request.migrationId)
    return result(`Migration ${request.migrationId}: ${migration.phase}; source resumes only after the target's durable abort receipt.`,{operationId:request.migrationId,phase:migration.phase})
  }
  if(!request.taskId&&!request.hostId)throw Error('RECONCILE_SCOPE_REQUIRED')
  const records=store.listOperations({}).filter(row=>row.kind==='remote' && row.operationId.startsWith('remote-protocol:') && row.taskId)
  const notes:string[]=[]
  for(const row of records){
    const access=store.getAccess(row.taskId!)
    if(!access||!mayRead(access,request.authorizedBy)||request.taskId&&row.taskId!==request.taskId)continue
    const operation=row.result as import('../remote/protocol.ts').RemoteOperation
    const originalHost=operation.hostId
    if(!originalHost||request.hostId&&originalHost!==request.hostId)continue
    if(!('operationId' in operation.request))continue
    const remote=await runtime.router.request(originalHost,'operation.read',{operationId:operation.request.operationId}) as {operationId?:string;state?:string;result?:unknown}|null
    if(!remote || remote.operationId!==operation.request.operationId)throw Error('REMOTE_INVALID_OPERATION_RECEIPT')
    if(remote.state==='succeeded'){
      await options.reconcileReceipt?.(operation.request.operationId,originalHost,remote.result)
      await store.updateOperation(row.operationId,entry=>({...entry,result:{...operation,state:'succeeded',result:remote.result},delivery:'accepted'}))
    }
    notes.push(`${operation.request.operationId}: ${remote?.state??'unknown'}`)
  }
  return result(notes.length?notes.join('\n'):'No scoped remote operations have a receipt to reconcile. No mutation was resent.')
}
