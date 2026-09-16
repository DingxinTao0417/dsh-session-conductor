import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import { DEFAULTS, IMPLEMENTATION_DEFAULTS } from '../src/domain/defaults.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import { Context } from '@deepseek-ai/cordis'

describe('native pre-step while migration storage is opening',()=>{
  it.each([true,false])('fails closed only for an enabled configured bridge (enabled=%s)',async enabled=>{
    const tables=createInMemoryTables(),context=new Context()
    let release!:()=>void, hook!: (payload:unknown,next:()=>Promise<unknown>)=>Promise<unknown>
    let cancelled=0,nextCalls=0
    const opening=new Promise<void>(resolve=>{release=resolve})
    const services={storageDomain:{open:async()=>{await opening;return {table:(name:keyof typeof tables)=>tables[name],close:async()=>{}}}},tools:{register:()=>()=>{}}}
    for(const [name,service] of Object.entries(services))context.provide(name,service)
    apply({get:context.get.bind(context),on:(_event:string,callback:typeof hook)=>{hook=callback;return ()=>{}},
      effect:context.effect.bind(context),inject:context.inject.bind(context),
    } as never,{...DEFAULTS,passIntervalMs:IMPLEMENTATION_DEFAULTS.passIntervalMs,crossHostEnabled:enabled,
      hostExtensions:{selectModelRememberAsDefault:false,forkTargetParameters:false},
      bridge:{hostId:'host',controllerSessionId:'owner',runtimeRoot:'D:/unused-test',profileId:'test',workspaceRoots:[]}})
    try{
      const result=await hook({agent:{id:'old-source',cancel:(_cause:unknown,options:unknown)=>{expect(options).toEqual({keepInbox:true});cancelled++}}},async()=>{nextCalls++;return {kind:'enter'}})
      expect(result).toEqual({kind:enabled?'reject':'enter'});expect(cancelled).toBe(enabled?1:0);expect(nextCalls).toBe(enabled?0:1)
    }finally{
      release();for(let i=0;i<60;i++)await Promise.resolve()
      await context.fiber.dispose()
    }
  })
})
