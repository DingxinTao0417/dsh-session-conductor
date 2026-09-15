import { describe, expect, it } from 'vitest'
import { mountedPlugin } from './helpers/mounted-plugin.ts'
import { TaskObserver, watchKey } from '../src/service/observer.ts'
import { initialProjection, type SessionEventLike } from '../src/service/projection.ts'
import { encodeObservationCursor, observationAfterCursor, taskObservationSchema, type TaskObservation } from '../src/service/observation.ts'
import { createRemoteDispatcher } from '../src/remote/dispatcher.ts'
import type { RemoteHostPort } from '../src/remote/protocol.ts'

async function fixture(){
  const app=await mountedPlugin();const events:SessionEventLike[]=[]
  const target=new TaskObserver({store:app.store,agents:{get:()=>({id:'session-1',session:{events,seq:0}})}})
  const observed=()=>target.observe('target',-1)
  const initial=observed()
  await app.store.putBinding({...app.store.getBinding('binding-1')!,hostId:'remote'})
  return {...app,initial,events}
}
const ended=(state:TaskObservation):TaskObservation=>({...state,position:1,throughSeq:1,state:{...initialProjection(),cursor:1,lastTurn:'completed',turnsStarted:1},notable:[{seq:1,event:{kind:'turn_ended',turn:1,outcome:'completed',detail:'done'},reportTriggered:false}]})

describe('read-only remote observations and source-reader waits',()=>{
  it('uses independent source cursors, excludes predecessor cursors and never touches another reader',async()=>{
    const app=await fixture(),full=ended(app.initial),seen:string[]=[]
    const observer=new TaskObserver({store:app.store,agents:{get:()=>undefined},remoteObservation:async(_task,reader,cursor)=>{
      seen.push(reader);return {...full,notable:full.notable.filter(row=>row.seq>observationAfterCursor(cursor,full.sessionId))}
    }})
    try{
      const first=await observer.wait([{taskId:'target',afterCursor:'9999'}],'owner',0)
      expect(first.ending).toBe('woke');expect(first.targets[0]?.cursor).toBe(encodeObservationCursor('session-1',1))
      expect((await observer.wait([{taskId:'target'}],'owner',0)).ending).toBe('timed_out')
      expect((await observer.wait([{taskId:'target'}],'observer',0)).ending).toBe('woke')
      expect(seen).toEqual(['owner','owner','observer']);expect(app.store.getWatch(watchKey('owner','target'))?.waitCursor).toBe(encodeObservationCursor('session-1',1))
    }finally{await app.close()}
  })
  it('returns a disconnected target as an error and preserves its cursor, never as idle',async()=>{
    const app=await fixture()
    const observer=new TaskObserver({store:app.store,agents:{get:()=>undefined},remoteObservation:async()=>{throw Error('SSH_UNAVAILABLE')}})
    try{const result=await observer.wait([{taskId:'target',afterCursor:'old-cursor'}],'owner',0)
      expect(result.targets[0]).toMatchObject({cursor:'old-cursor',error:'SSH_UNAVAILABLE'});expect(result.targets[0]?.state?.execution).not.toBe('idle')
      expect(app.store.getWatch(watchKey('owner','target'))).toBeUndefined()
    }finally{await app.close()}
  })
  it('does not expose late facts after control was revoked during the remote read',async()=>{
    const app=await fixture()
    const observer=new TaskObserver({store:app.store,agents:{get:()=>undefined},remoteObservation:async()=>{
      await app.store.putAccess({...app.store.getAccess('target')!,ownerSessionId:'next',ownerEpoch:1,observerSessionIds:[]});return ended(app.initial)
    }})
    try{const result=await observer.wait([{taskId:'target'}],'owner',0);expect(result.targets[0]?.error).toContain('permission');expect(result.targets[0]?.wake).toBeUndefined()}finally{await app.close()}
  })
  it('cancels stalled read-only observations at the wait deadline and ignores their late result',async()=>{
    const app=await fixture();let signal:AbortSignal|undefined,release!:(value:TaskObservation)=>void
    const pending=new Promise<TaskObservation>(resolve=>{release=resolve})
    const observer=new TaskObserver({store:app.store,agents:{get:()=>undefined},remoteObservation:async(_t,_r,_c,current)=>{signal=current;return await pending}})
    try{
      const start=Date.now();const result=await observer.wait([{taskId:'target'}],'owner',30)
      expect(Date.now()-start).toBeLessThan(1000);expect(result.ending).toBe('timed_out');expect(signal?.aborted).toBe(true)
      release(ended(app.initial));await Promise.resolve();expect(app.store.getWatch(watchKey('owner','target'))).toBeUndefined()
    }finally{await app.close()}
  })
  it('ends a stalled remote wait when the Host abort signal fires',async()=>{
    const app=await fixture(),controller=new AbortController()
    const observer=new TaskObserver({store:app.store,agents:{get:()=>undefined},remoteObservation:async()=>await new Promise(()=>{})})
    const timer=setTimeout(()=>controller.abort(),20)
    try{expect((await observer.wait([{taskId:'target'}],'owner',5000,{signal:controller.signal})).ending).toBe('cancelled')}
    finally{clearTimeout(timer);await app.close()}
  })
  it('exports positioned Host facts with bounded pages and notice-origin flags, without a remote watch',async()=>{
    const app=await mountedPlugin();const events:SessionEventLike[]=[
      {seq:0,type:'user/message',data:{source:{kind:'plugin',plugin:'dsh-session-conductor',form:'notice',summary:'report'},content:[{type:'text',text:'report'}]}},
      {seq:1,type:'turn/start',data:{turn:1}},{seq:2,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
    ]
    const observer=new TaskObserver({store:app.store,agents:{get:()=>({id:'session-1',session:{events,seq:2}})}})
    try{
      const page=observer.observe('target',-1,1);expect(page).toMatchObject({position:2,throughSeq:1,truncated:true})
      const rest=observer.observe('target',page.throughSeq,1);expect(rest.notable[0]).toMatchObject({seq:2,reportTriggered:true,event:{kind:'turn_ended'}})
      expect(taskObservationSchema.parse(JSON.parse(JSON.stringify(rest))).state.lastTurn).toBe('completed');expect(app.store.listEveryWatch()).toEqual([])
      const host={authorize:async()=>{},observeTask:async()=>rest} as unknown as RemoteHostPort
      const dispatch=createRemoteDispatcher(host,{get:async()=>undefined,put:async()=>{throw Error('read may not persist protocol operation')}})
      expect(await dispatch({protocolVersion:'1',requestId:'read',action:'task.observe',payload:{taskId:'target',afterSeq:1}})).toMatchObject({ok:true,result:{position:2}})
      expect(await dispatch({protocolVersion:'1',requestId:'read',action:'task.observe',payload:{taskId:'target',afterSeq:1,callerSessionId:'owner'}})).toMatchObject({ok:false,code:'BAD_REMOTE_REQUEST'})
    }finally{await app.close()}
  })
})
