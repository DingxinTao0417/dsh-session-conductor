import type { ConductorConfig } from '../config.ts'
import type { ConductorStore } from '../store/repository.ts'
import { createHostRouter, type RemoteMigration } from '../remote/router.ts'
import { createRemoteDispatcher } from '../remote/dispatcher.ts'
import { startIpcEndpoint } from '../remote/ipc.ts'
import { createSshTransport } from '../remote/transport.ts'
import type { RemoteHostPort, RemoteJournal, RemoteOperation } from '../remote/protocol.ts'

/** Persist protocol operations in the plugin domain. No user Session event is added. */
export function remoteJournals(store:ConductorStore) {
  const operations:RemoteJournal={
    get:async id=>store.getOperation(`remote-protocol:${id}`)?.result as RemoteOperation|undefined,
    put:async record=>{
      const id=`remote-protocol:${record.operationId}`
      const payload=record.request.payload as {taskId?:string;receipt?:{taskId:string}}
      const taskId=payload.taskId??payload.receipt?.taskId
      const claim=await store.beginOperation({operationId:id,kind:'remote',params:{paramDigest:record.paramDigest},...taskId?{taskId}:{}})
      if(claim.kind==='conflict')throw Error('REMOTE_JOURNAL_CONFLICT')
      await store.updateOperation(id,row=>({...row,result:record,delivery:record.state==='succeeded'?'accepted':record.state,phase:record.action}))
    },
  }
  const migrations={
    get:async(id:string)=>store.getOperation(`remote-migration:${id}`)?.result as RemoteMigration|undefined,
    put:async(record:RemoteMigration)=>{
      const id=`remote-migration:${record.migrationId}`
      const claim=await store.beginOperation({operationId:id,kind:'remote',taskId:record.request.taskId,params:{paramDigest:record.paramDigest}})
      if(claim.kind==='conflict')throw Error('REMOTE_MIGRATION_CONFLICT')
      await store.updateOperation(id,row=>({...row,result:record,delivery:record.phase==='succeeded'||record.phase==='aborted'?'accepted':record.phase==='unknown'?'unknown':'prepared',phase:record.phase}))
    },
  }
  return {operations,migrations}
}
export async function startRemoteRuntime(options:{store:ConductorStore;config:()=>ConductorConfig;pluginVersion:string;host:RemoteHostPort}) {
  const declared=options.config().bridge
  if(!options.config().crossHostEnabled || !declared)throw Error('REMOTE_BRIDGE_DISABLED_OR_UNCONFIGURED')
  const journals=remoteJournals(options.store)
  const dispatch=createRemoteDispatcher(options.host,journals.operations)
  const router=createHostRouter({enabled:()=>options.config().crossHostEnabled,pluginVersion:options.pluginVersion,...journals,
    route:hostId=>{
      if(hostId===declared.hostId || hostId==='local')return {enabled:true,transport:{request:dispatch}}
      const record=options.store.getRemoteHost(hostId)
      const route=options.config().remoteConnections?.find(entry=>entry.hostId===hostId)
      if(!record?.enabled || !route)return undefined
      return {enabled:true,transport:createSshTransport({alias:route.sshAlias,bridgeCommand:[route.nodePath,route.bridgePath,'--descriptor',route.descriptorPath]})}
    }})
  const endpoint=await startIpcEndpoint({runtimeRoot:declared.runtimeRoot,profileId:declared.profileId,dispatch})
  return {router,descriptorPath:endpoint.descriptorPath,close:()=>endpoint.close()}
}
export type RemoteRuntime=Awaited<ReturnType<typeof startRemoteRuntime>>
