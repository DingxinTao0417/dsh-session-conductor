import { describe,expect,it } from 'vitest'
import { mountedPlugin } from './helpers/mounted-plugin.ts'
import { remoteHistoryCursor,persistRemoteHistoryCursor } from '../src/service/remote-read-cursor.ts'

describe('source-owned remote history cursors',()=>{
  it('keeps readers, sessions and wait cursors independent and never lets a late page move progress backwards',async()=>{
    const app=await mountedPlugin();const binding={...app.store.getBinding('binding-1')!,hostId:'remote'}
    try{
      expect(remoteHistoryCursor(app.store,binding,'owner')).toBe(-1)
      await Promise.all([persistRemoteHistoryCursor(app.store,binding,'owner','12'),persistRemoteHistoryCursor(app.store,binding,'owner','5')])
      expect(remoteHistoryCursor(app.store,binding,'owner')).toBe(12);expect(remoteHistoryCursor(app.store,binding,'observer')).toBe(-1)
      expect(remoteHistoryCursor(app.store,{...binding,sessionId:'successor',version:2},'owner')).toBe(-1)
      expect(app.store.listEveryWatch()).toEqual([])
      await expect(persistRemoteHistoryCursor(app.store,binding,'owner','12junk')).rejects.toThrow('CURSOR')
    }finally{await app.close()}
  })
})
