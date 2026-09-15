import { describe, expect, it, vi } from 'vitest'
import { mountedPlugin } from './helpers/mounted-plugin.ts'
import { enqueueHandoff } from '../src/service/handoff-operation.ts'
import type { HandoffOutcome } from '../src/service/handoff.ts'

describe('schedule updates preserve authorization and accounting',()=>{
  it('uses a new relative delay instead of inheriting the old absolute instant; refuses replay after control loss',async()=>{
    const app=await mountedPlugin()
    try{
      await app.call('conductor_schedule',{action:'save',scheduleId:'later',operationId:'later-save',kind:'once',delayMs:3600000,timezone:'UTC',targetTaskId:'target'})
      const request={action:'update',scheduleId:'later',operationId:'later-update',delayMs:60000}
      const before=Date.now();await app.call('conductor_schedule',request)
      expect(Date.parse(app.store.getSchedule('later')!.nextAt)).toBeGreaterThanOrEqual(before+60000)
      expect(Date.parse(app.store.getSchedule('later')!.nextAt)).toBeLessThanOrEqual(Date.now()+60000)
      await app.store.putAccess({...app.store.getAccess('target')!,ownerSessionId:'successor',ownerEpoch:1,observerSessionIds:[]})
      await expect(app.call('conductor_schedule',request)).rejects.toThrow('NOT_CONTROLLER')
    }finally{await app.close()}
  })
  it('replays a save without duplicate schedules; updates preserve run history and paused state',async()=>{
    const app=await mountedPlugin()
    try{
      const args={action:'save',scheduleId:'daily-check',operationId:'save-check',kind:'interval',intervalMs:3600000,timezone:'UTC',targetTaskId:'target'}
      await app.call('conductor_schedule',args)
      const before=app.store.getSchedule('daily-check')!
      await app.call('conductor_schedule',args)
      expect(app.store.listSchedules({})).toHaveLength(1);expect(app.store.getSchedule('daily-check')?.nextAt).toBe(before.nextAt)
      await app.store.updateSchedule('daily-check',row=>({...row,status:'paused',runs:[{scheduledFor:before.nextAt,recordedAt:new Date().toISOString(),outcome:'ran'}]}))
      await app.call('conductor_schedule',{action:'update',scheduleId:'daily-check',operationId:'update-check',title:'new title',intervalMs:7200000})
      const updated=app.store.getSchedule('daily-check')!
      expect(updated.title).toBe('new title');expect(updated.intervalMs).toBe(7200000);expect(updated.status).toBe('paused');expect(updated.runs).toHaveLength(1);expect(updated.createdAt).toBe(before.createdAt)
      await expect(app.call('conductor_schedule',{action:'update',scheduleId:'daily-check',operationId:'steal',title:'stolen'},'observer')).rejects.toThrow('NOT_CONTROLLER')
      await expect(app.call('conductor_schedule',{...args,title:'conflicting retry'})).rejects.toThrow('OPERATION_CONFLICT')
    }finally{await app.close()}
  })
})
describe('asynchronous durable handoff admission',()=>{
  it('does not dispatch or leak an unhandled rejection when both background journal writes fail',async()=>{
    const app=await mountedPlugin();let executed=false
    const failure=vi.spyOn(app.store,'markDelivery').mockRejectedValue(Error('disk offline'))
    try{
      const result=await enqueueHandoff(app.store,{operationId:'disk-offline',callerSessionId:'owner',taskId:'target',targetPath:'D:/next'},async()=>{executed=true;throw Error('unexpected')})
      expect(result.pending).toBe(true)
      await new Promise(resolve=>setImmediate(resolve))
      expect(executed).toBe(false);expect(failure).toHaveBeenCalledTimes(2)
      expect(app.store.getOperation('disk-offline')?.delivery).toBe('prepared')
    }finally{failure.mockRestore();await app.close()}
  })
  it('returns an operation receipt before preparation finishes and never duplicates repeated work',async()=>{
    const app=await mountedPlugin();let release!:(value:HandoffOutcome)=>void;let calls=0
    const outcome=new Promise<HandoffOutcome>(resolve=>{release=resolve})
    const request={operationId:'move-1',callerSessionId:'owner',taskId:'target',targetPath:'D:/next'}
    try{
      const first=await enqueueHandoff(app.store,request,async()=>{calls++;return await outcome})
      expect(first.pending).toBe(true);expect(first.operationId).toBe('move-1')
      expect((await enqueueHandoff(app.store,request,async()=>{throw Error('duplicate')})).pending).toBe(true);expect(calls).toBe(1)
      await expect(enqueueHandoff(app.store,{...request,targetPath:'D:/changed'},async()=>{throw Error('bad')})).rejects.toThrow('OPERATION_CONFLICT')
      release({taskId:'target',succeeded:true,reached:'switching_binding',successorSessionId:'successor',preconditions:{checked:[],unchecked:[]}})
      for(let i=0;i<30;i++)await Promise.resolve()
      const replay=await enqueueHandoff(app.store,request,async()=>{throw Error('duplicate')})
      expect(replay.succeeded).toBe(true);expect(app.store.getOperation('move-1')?.delivery).toBe('accepted')
    }finally{await app.close()}
  })
  it('does not recreate a successor after a crash with no committed binding receipt',async()=>{
    const app=await mountedPlugin();const request={operationId:'interrupted-move',callerSessionId:'owner',taskId:'target',targetPath:'D:/next'}
    try{
      await app.store.beginOperation({operationId:request.operationId,kind:'handoff',taskId:'target',params:request})
      await app.store.markDelivery(request.operationId,'dispatching','creating_successor')
      const result=await enqueueHandoff(app.store,request,async()=>{throw Error('must not retry')})
      expect(result.succeeded).toBe(false);expect(result.reason).toContain('UNKNOWN');expect(app.store.getTask('target')?.currentBindingId).toBe('binding-1')
    }finally{await app.close()}
  })
})
