import { describe, expect, it } from 'vitest'
import { mountedPlugin } from './helpers/mounted-plugin.ts'
import { executeRemoteMutation, reconcileRemoteSource, remoteSendReceipt, remoteStopReceipt, remoteQueueReceipt } from '../src/service/remote-source.ts'
import { createHostRouter } from '../src/remote/router.ts'
import { createRemoteDispatcher } from '../src/remote/dispatcher.ts'
import { remoteJournals } from '../src/service/remote-runtime.ts'
import type { RemoteHostPort, RemoteOperation } from '../src/remote/protocol.ts'

async function fixture() {
  const app=await mountedPlugin()
  const binding={...app.store.getBinding('binding-1')!,hostId:'remote'};await app.store.putBinding(binding)
  let sends=0, lose=false, pending=false, frozen=false, budget=false
  let onHandshake=async()=>{}
  const remoteRows=new Map<string,RemoteOperation>()
  const host={
    authorize:async()=>{},capabilities:async()=>{await onHandshake();return {hostId:'remote',protocolVersion:'1',pluginVersion:'0.1.0',models:[],workspaceCapable:true}},
    send:async(payload: {taskId:string;mode:string;messageId:string})=>{sends++;return {taskId:payload.taskId,mode:payload.mode,delivery:pending?'pending':'accepted',requestedMessageId:payload.messageId,...pending?{}:{messageId:'host-message'}}},
    reconcile:async(record:RemoteOperation)=>pending?undefined:{result:{taskId:'target',mode:'queue',delivery:'accepted',messageId:'host-message',requestedMessageId:record.request.action==='task.send'?record.request.payload.messageId:''}},
  } as unknown as RemoteHostPort
  const dispatch=createRemoteDispatcher(host,{get:async id=>remoteRows.get(id),put:async record=>{remoteRows.set(record.operationId,structuredClone(record))}})
  const local=remoteJournals(app.store)
  const router=createHostRouter({enabled:()=>true,pluginVersion:'0.1.0',...local,route:()=>({enabled:true,transport:{request:async request=>{
    const result=await dispatch(request)
    if(request.action==='task.send' && lose){lose=false;throw Error('lost response after acceptance')}
    return result
  }}})})
  const run=async(operationId='send-1')=>{
    const request={taskId:'target',callerSessionId:'owner',mode:'queue' as const,text:'work',operationId}
    const messageId=`requested-${operationId}`
    return await executeRemoteMutation({store:app.store,binding,...request,action:'task.send',params:{...request,requestedMessageId:messageId},
      admission:()=>{if(frozen)throw Error('REMOTE_MIGRATION_FROZEN');if(budget && (app.store.getLedger('target')?.dispatches??0)>=1)throw Error('BUDGET_EXCEEDED')},
      dispatch:async beforeDispatch=>await router.request('remote','task.send',{taskId:'target',messageId,text:'work',mode:'queue',expectedBindingVersion:1,expectedOwnerEpoch:0},operationId,beforeDispatch),
      validate:value=>remoteSendReceipt(value,request,messageId),pending:result=>result.delivery==='pending',
      counted:async(_result,id,at)=>{await app.store.recordLedgerEvent('target',{kind:'dispatch',at},at,id)},
    })
  }
  return {...app,run,sends:()=>sends,setLoss:()=>{lose=true},setPending:(value:boolean)=>{pending=value},setFrozen:()=>{frozen=true},
    setBudget:()=>{budget=true},handshake:(callback:()=>Promise<void>)=>{onHandshake=callback}}
}

describe('source-side remote authority, journal and receipt accounting',()=>{
  it('persists a source operation and counts concurrent retries once',async()=>{
    const app=await fixture()
    try{
      await Promise.all([app.run(),app.run()])
      expect(app.sends()).toBe(1);expect(app.store.getLedger('target')?.dispatches).toBe(1)
      expect(app.store.getOperation('send-1')).toMatchObject({kind:'remote',taskId:'target',delivery:'accepted',dispatchGuard:{ownerSessionId:'owner',ownerEpoch:0,bindingVersion:1}})
    }finally{await app.close()}
  })
  it('rechecks current authority after capability awaits before writing to the carrier',async()=>{
    const app=await fixture()
    app.handshake(async()=>{await app.store.putAccess({...app.store.getAccess('target')!,ownerSessionId:'next',ownerEpoch:1})})
    try{
      await expect(app.run()).rejects.toThrow('ADMISSION_REFUSED');expect(app.sends()).toBe(0)
      expect(app.store.getOperation('send-1')?.delivery).toBe('failed')
    }finally{await app.close()}
  })
  it('rechecks migration freeze at the last transport boundary',async()=>{
    const app=await fixture();app.handshake(async()=>{app.setFrozen()})
    try{await expect(app.run()).rejects.toThrow('ADMISSION_REFUSED');expect(app.sends()).toBe(0)}finally{await app.close()}
  })
  it('reconciles loss without a second send and backfills the same source ledger identity',async()=>{
    const app=await fixture();app.setLoss()
    try{
      await expect(app.run()).rejects.toThrow('UNCONFIRMED');expect(app.store.getOperation('send-1')?.delivery).toBe('unknown')
      expect(app.store.getLedger('target')).toBeUndefined()
      await app.run();await app.run()
      expect(app.sends()).toBe(1);expect(app.store.getLedger('target')?.dispatches).toBe(1)
    }finally{await app.close()}
  })
  it('refreshes a pending target receipt by reconciliation without resending or prematurely counting it',async()=>{
    const app=await fixture();app.setPending(true)
    try{
      expect((await app.run()).delivery).toBe('pending');expect(app.store.getLedger('target')).toBeUndefined()
      expect((await app.run()).delivery).toBe('pending');expect(app.sends()).toBe(1)
      app.setPending(false);expect((await app.run()).delivery).toBe('accepted')
      expect(app.sends()).toBe(1);expect(app.store.getLedger('target')?.dispatches).toBe(1)
    }finally{await app.close()}
  })
  it('serializes two different requests against a one-dispatch source budget',async()=>{
    const app=await fixture();app.setBudget()
    try{
      const results=await Promise.allSettled([app.run('one'),app.run('two')])
      expect(results.map(row=>row.status)).toEqual(['fulfilled','rejected']);expect(app.sends()).toBe(1)
      expect(app.store.getLedger('target')?.dispatches).toBe(1)
    }finally{await app.close()}
  })
  it('explicit reconciliation settles only the original Host and counts its source receipt once',async()=>{
    const app=await fixture();app.setLoss()
    const result={taskId:'target',mode:'queue',delivery:'accepted',messageId:'host-message',requestedMessageId:'requested-send-1'}
    const reconcile=async(hostId:string)=>await reconcileRemoteSource({store:app.store,operationId:'send-1',hostId,result,
      counted:async(taskId,id,at)=>{await app.store.recordLedgerEvent(taskId,{kind:'dispatch',at},at,id)}})
    try{
      await expect(app.run()).rejects.toThrow('UNCONFIRMED')
      expect(await reconcile('other')).toBe(false);expect(app.store.getLedger('target')).toBeUndefined()
      expect(await reconcile('remote')).toBe(true);await reconcile('remote')
      expect(app.store.getOperation('send-1')?.delivery).toBe('accepted');expect(app.store.getLedger('target')?.dispatches).toBe(1);expect(app.sends()).toBe(1)
    }finally{await app.close()}
  })
})

describe('remote receipt binding',()=>{
  it('rejects another message identity and accepted responses lacking a Host message receipt',()=>{
    const request={operationId:'op',taskId:'t',callerSessionId:'owner',mode:'queue' as const,text:'work'}
    expect(()=>remoteSendReceipt({taskId:'t',mode:'queue',delivery:'accepted',messageId:'m',requestedMessageId:'wrong'},request,'expected')).toThrow()
    expect(()=>remoteSendReceipt({taskId:'t',mode:'queue',delivery:'accepted',requestedMessageId:'expected'},request,'expected')).toThrow()
  })
  it('rejects retargeted stops and queue mutation receipts',()=>{
    expect(()=>remoteStopReceipt({taskId:'t',outcome:'confirmed',sent:false,keptText:false,reason:'ok',expectedTurn:3},{operationId:'op',taskId:'t',callerSessionId:'owner',expectedTurn:2})).toThrow()
    expect(()=>remoteQueueReceipt({taskId:'t',messages:[],reason:'ok',changed:{messageId:'other',action:'withdrawn'}},{operationId:'op',taskId:'t',callerSessionId:'owner',action:'withdraw',messageId:'expected'})).toThrow()
  })
})
