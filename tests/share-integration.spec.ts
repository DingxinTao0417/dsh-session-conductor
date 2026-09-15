import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { get } from 'node:https'
import { createHash } from 'node:crypto'
import { createShareClient, createSnapshotServer, snapshotDigest, type ShareUpload } from '../src/share/transport.ts'
import { createShareCoordinator } from '../src/share/coordinator.ts'
import { commitImmutableFile, readSnapshotFile } from '../src/share/storage.ts'
import { mountedPlugin } from './helpers/mounted-plugin.ts'

let directory: string, key: Buffer, cert: Buffer
const secret = 'isolated-test-publishing-key-'.repeat(3)
beforeAll(async()=>{
  directory=await mkdtemp(join(tmpdir(),'dsh-share-test-'))
  const openssl=process.platform==='win32' ? 'D:/Program Files/Git/usr/bin/openssl.exe' : 'openssl'
  execFileSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore',windowsHide:true})
  key=await readFile(join(directory,'key.pem'));cert=await readFile(join(directory,'cert.pem'))
})
afterAll(async()=>{
  if(directory && resolve(directory).startsWith(resolve(tmpdir())) && directory.includes('dsh-share-test-')) await rm(directory,{recursive:true,force:true})
})
async function running(name: string, now?:()=>string) {
  const server=await createSnapshotServer({key,cert,bearerToken:secret,directory:join(directory,name),...now?{now}:{}})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();if(!address || typeof address==='string')throw Error('no port')
  const baseUrl=`https://127.0.0.1:${address.port}`
  return {baseUrl,client:createShareClient({baseUrl,bearerToken:secret,ca:cert}),close:async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}}
}
function upload(name='share-1'): ShareUpload {
  const document='固定预览。\n<script>never execute</script>'
  const bytes=Buffer.from([0,255,13,10])
  const attachments=[{artifactId:'artifact-1',name:'binary.bin',base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}]
  return {record:{shareId:name,snapshotId:'preview-1',taskId:'task-1',token:'test_'.repeat(9),cutoffAt:'2026-01-01T00:00:00.000Z',publishedAt:'2026-01-01T00:00:01.000Z',expiresAt:'2027-01-01T00:00:00.000Z'},format:'markdown',document,attachments,digest:snapshotDigest('markdown',document,attachments)}
}
async function retrieve(url: string) {return await new Promise<{status:number;type:string;bytes:Buffer}>((resolve,reject)=>{
  get(url,{ca:cert},res=>{const chunks:Buffer[]=[];res.on('data',(b:Buffer)=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode!,type:res.headers['content-type']??'',bytes:Buffer.concat(chunks)}));res.on('error',reject)}).on('error',reject)
})}
describe('standalone HTTPS snapshot service (real TLS, filesystem and restart)',()=>{
  it('ignores incomplete staging files on restart and never replaces a committed file',async()=>{
    const path=join(directory,'atomic-recovery');await mkdir(path)
    await writeFile(join(path,'.snapshot-interrupted.pending'),'{"record":')
    const fixed=upload();await commitImmutableFile(path,'share-1.json',JSON.stringify(fixed))
    await expect(commitImmutableFile(path,'share-1.json','broken replacement')).rejects.toThrow()
    expect(JSON.parse(await readFile(join(path,'share-1.json'),'utf8'))).toEqual(fixed)
    expect((await readdir(path)).filter(name=>name.endsWith('.pending'))).toEqual(['.snapshot-interrupted.pending'])
    const service=await running('atomic-recovery',()=> '2026-09-14T00:00:00.000Z')
    try{expect((await service.client.status('share-1'))?.digest).toBe(fixed.digest);expect((await retrieve(`${service.baseUrl}/s/${fixed.record.token}`)).status).toBe(200)}finally{await service.close()}
  })
  it('bounds persisted snapshot reads and rejects invalid UTF-8 at restart',async()=>{
    const path=join(directory,'bounded-read');await mkdir(path)
    await writeFile(join(path,'oversized'),'12345');await writeFile(join(path,'invalid'),Buffer.from([0xff]))
    await expect(readSnapshotFile(join(path,'oversized'),4)).rejects.toThrow('size')
    await expect(readSnapshotFile(join(path,'invalid'),4)).rejects.toThrow()
  })
  it('publishes exactly the fixed Unicode document and selected binary attachment; duplicate PUT is immutable',async()=>{
    const service=await running('fixed',()=> '2026-09-14T00:00:00.000Z')
    try{
      const fixed=upload();expect((await service.client.publish(fixed)).digest).toBe(fixed.digest)
      expect((await service.client.publish(fixed)).digest).toBe(fixed.digest)
      const page=await retrieve(`${service.baseUrl}/s/${fixed.record.token}`)
      expect(page.bytes.toString('utf8')).toBe(fixed.document);expect(page.type).toContain('text/plain')
      expect((await retrieve(`${service.baseUrl}/s/${fixed.record.token}/attachments/artifact-1`)).bytes).toEqual(Buffer.from([0,255,13,10]))
      const changed={...fixed,document:'changed',digest:snapshotDigest(fixed.format,'changed',fixed.attachments)}
      await expect(service.client.publish(changed)).rejects.toThrow('409')
      expect((await retrieve(`${service.baseUrl}/execute`)).status).toBe(404)
    }finally{await service.close()}
  })
  it('requires upload credentials and rejects tampered bytes',async()=>{
    const service=await running('auth',()=> '2026-09-14T00:00:00.000Z')
    try{
      await expect(createShareClient({baseUrl:service.baseUrl,bearerToken:'wrong'.repeat(10),ca:cert}).publish(upload())).rejects.toThrow('401')
      await expect(service.client.publish({...upload(),document:'changed'})).rejects.toThrow('400')
      expect((await retrieve(`${service.baseUrl}/api/snapshots/share-1`)).status).toBe(401)
    }finally{await service.close()}
  })
  it('durably revokes public document and attachments across service restarts',async()=>{
    let service=await running('restart',()=> '2026-09-14T00:00:00.000Z')
    const fixed=upload()
    try{await service.client.publish(fixed);await service.client.revoke(fixed.record.shareId)}finally{await service.close()}
    service=await running('restart',()=> '2026-09-14T00:00:00.000Z')
    try{
      expect((await service.client.status(fixed.record.shareId))?.record.revokedAt).toBeTruthy()
      expect((await retrieve(`${service.baseUrl}/s/${fixed.record.token}`)).status).toBe(404)
      expect((await retrieve(`${service.baseUrl}/s/${fixed.record.token}/attachments/artifact-1`)).status).toBe(404)
      expect((await service.client.revoke(fixed.record.shareId)).record.revokedAt).toBeTruthy()
    }finally{await service.close()}
  })
  it('enforces expiry at retrieval, without depending on a scheduled cleanup',async()=>{
    let now='2026-09-14T00:00:00.000Z';const service=await running('expiry',()=>now)
    try{const fixed=upload();await service.client.publish(fixed);now=fixed.record.expiresAt;expect((await retrieve(`${service.baseUrl}/s/${fixed.record.token}`)).status).toBe(404)}finally{await service.close()}
  })
})
describe('share publication coordination',()=>{
  it('checks the pinned owner epoch after dispatching is persisted, immediately before publishing',async()=>{
    const app=await mountedPlugin();let uploads=0
    const original=app.store.markDelivery.bind(app.store)
    const changed=vi.spyOn(app.store,'markDelivery').mockImplementation(async(id,state,phase)=>{
      const row=await original(id,state,phase)
      if(id==='publish' && state==='dispatching')await app.store.putAccess({...app.store.getAccess('target')!,ownerEpoch:1})
      return row
    })
    const execute=createShareCoordinator({store:app.store,enabled:true,lifetimeDays:7,
      service:{baseUrl:'https://snapshots.example',publish:async value=>{uploads++;return {record:value.record,digest:value.digest}},status:async()=>undefined,revoke:async()=>{throw Error('unused')}},
      build:async()=>({document:'preview',attachments:[],preview:{snapshotId:'unused',taskId:'target',format:'markdown',cutoffAt:new Date().toISOString(),byteSize:7,includes:[],excludes:[],warnings:[]}})})
    try{
      await execute({action:'preview',taskId:'target',operationId:'preview',authorizedBy:'owner'})
      await expect(execute({action:'publish',snapshotId:'preview',operationId:'publish',confirmed:true,authorizedBy:'owner'})).rejects.toThrow('STALE_OWNER_EPOCH')
      expect(uploads).toBe(0)
    }finally{changed.mockRestore();await app.close()}
  })
  it('does not return a private preview after its reader loses access during export',async()=>{
    const app=await mountedPlugin()
    const execute=createShareCoordinator({store:app.store,enabled:false,lifetimeDays:7,build:async()=>{
      await app.store.putAccess({...app.store.getAccess('target')!,ownerSessionId:'next',ownerEpoch:1,observerSessionIds:[]})
      return {document:'private',attachments:[],preview:{snapshotId:'unused',taskId:'target',format:'markdown',cutoffAt:new Date().toISOString(),byteSize:7,includes:[],excludes:[],warnings:[]}}
    }})
    try{await expect(execute({action:'preview',taskId:'target',operationId:'preview',authorizedBy:'owner'})).rejects.toThrow('NOT_FOUND');expect(app.store.getOperation('preview')?.result).toBeUndefined()}finally{await app.close()}
  })
  it('binds a publication retry to its original service and reports a revoked receipt without an active URL',async()=>{
    const app=await mountedPlugin();let held:ShareUpload|undefined;let endpoint='https://snapshots.example';let calls=0
    const execute=()=>createShareCoordinator({store:app.store,enabled:true,lifetimeDays:7,
      service:{baseUrl:endpoint,publish:async value=>{held=value;throw Error('lost reply')},status:async()=>{calls++;return {record:{...held!.record,revokedAt:new Date().toISOString()},digest:held!.digest}},revoke:async()=>{throw Error('unused')}},
      build:async()=>({document:'preview',attachments:[],preview:{snapshotId:'unused',taskId:'target',format:'markdown',cutoffAt:new Date().toISOString(),byteSize:7,includes:[],excludes:[],warnings:[]}})})
    const request={action:'publish' as const,snapshotId:'preview',operationId:'publish',confirmed:true,authorizedBy:'owner'}
    try{
      await execute()({action:'preview',taskId:'target',operationId:'preview',authorizedBy:'owner'})
      await expect(execute()(request)).rejects.toThrow('lost reply');endpoint='https://other.example'
      await expect(execute()(request)).rejects.toThrow('OPERATION_CONFLICT');expect(calls).toBe(0)
      endpoint='https://snapshots.example';const reconciled=await execute()(request)
      expect(reconciled.url).toBeUndefined();expect(reconciled.summary).toContain('revoked');expect(reconciled.shares[0]?.state).toBe('revoked')
    }finally{await app.close()}
  })
  it.each(['shareId','snapshotId','taskId','cutoffAt','publishedAt','expiresAt'] as const)('rejects a publish receipt with changed %s even when digest and token match',async field=>{
    const app=await mountedPlugin()
    const execute=createShareCoordinator({store:app.store,enabled:true,lifetimeDays:7,
      service:{baseUrl:'https://snapshots.example',publish:async value=>({record:{...value.record,[field]:field.endsWith('At')?'2027-01-01T00:00:00.000Z':'wrong-identity'},digest:value.digest}),status:async()=>undefined,revoke:async()=>{throw Error('unused')}},
      build:async()=>({document:'preview',attachments:[],preview:{snapshotId:'unused',taskId:'target',format:'markdown',cutoffAt:new Date().toISOString(),byteSize:7,includes:[],excludes:[],warnings:[]}})})
    try{
      await execute({action:'preview',taskId:'target',operationId:'preview',authorizedBy:'owner'})
      await expect(execute({action:'publish',snapshotId:'preview',operationId:'publish',confirmed:true,authorizedBy:'owner'})).rejects.toThrow('UNKNOWN')
      expect(app.store.listShares()).toEqual([]);expect(app.store.getOperation('publish')?.delivery).toBe('unknown')
    }finally{await app.close()}
  })
  it('rejects mismatched revocation receipts without replacing local share identity',async()=>{
    const app=await mountedPlugin();let held:ShareUpload|undefined
    const execute=createShareCoordinator({store:app.store,enabled:true,lifetimeDays:7,
      service:{baseUrl:'https://snapshots.example',publish:async value=>{held=value;return {record:value.record,digest:value.digest}},status:async()=>undefined,
        revoke:async()=>({record:{...held!.record,taskId:'other-task',revokedAt:new Date().toISOString()},digest:held!.digest})},
      build:async()=>({document:'preview',attachments:[],preview:{snapshotId:'unused',taskId:'target',format:'markdown',cutoffAt:new Date().toISOString(),byteSize:7,includes:[],excludes:[],warnings:[]}})})
    try{
      await execute({action:'preview',taskId:'target',operationId:'preview',authorizedBy:'owner'})
      await execute({action:'publish',snapshotId:'preview',operationId:'publish',confirmed:true,authorizedBy:'owner'})
      await expect(execute({action:'revoke',shareId:held!.record.shareId,authorizedBy:'owner'})).rejects.toThrow('UNKNOWN')
      expect(app.store.getShare(held!.record.shareId)?.taskId).toBe('target');expect(app.store.getShare(held!.record.shareId)?.revokedAt).toBeUndefined()
    }finally{await app.close()}
  })
  it('holds the confirmed preview across task changes; lost receipts reconcile without re-upload',async()=>{
    const app=await mountedPlugin();let uploads=0;let held:ShareUpload|undefined;let text='first preview'
    const execute=createShareCoordinator({store:app.store,enabled:true,lifetimeDays:7,
      service:{baseUrl:'https://snapshots.example',publish:async value=>{uploads++;held=value;throw Error('lost reply')},status:async()=>held?{record:held.record,digest:held.digest}:undefined,revoke:async()=>{throw Error('unused')}},
      build:async()=>({document:text,attachments:[],preview:{snapshotId:'unused',taskId:'target',format:'markdown',cutoffAt:new Date().toISOString(),byteSize:Buffer.byteLength(text),includes:[],excludes:[],warnings:[]}})})
    try{
      const preview=await execute({action:'preview',taskId:'target',operationId:'preview',authorizedBy:'owner'})
      text='later private update'
      const request={action:'publish' as const,snapshotId:preview.preview!.snapshotId,operationId:'publish',confirmed:true,authorizedBy:'owner'}
      await expect(execute(request)).rejects.toThrow('lost reply');expect(app.store.getOperation('publish')?.delivery).toBe('unknown')
      const published=await execute(request);expect(published.url).toContain('/s/');expect(uploads).toBe(1);expect(held?.document).toBe('first preview')
      expect((await execute({action:'list',authorizedBy:'stranger'})).shares).toEqual([])
      await expect(execute({...request,authorizedBy:'observer'})).rejects.toThrow('PREVIEW_REQUIRED')
    }finally{await app.close()}
  })
  it('enforces current control again after preview, and never publishes an unconfirmed or unpreviewed snapshot',async()=>{
    const app=await mountedPlugin();let calls=0
    const execute=createShareCoordinator({store:app.store,enabled:true,lifetimeDays:7,service:{baseUrl:'https://snapshots.example',publish:async v=>{calls++;return{record:v.record,digest:v.digest}},status:async()=>undefined,revoke:async()=>{throw Error('unused')}},build:async()=>({document:'preview',attachments:[],preview:{snapshotId:'unused',taskId:'target',format:'markdown',cutoffAt:new Date().toISOString(),byteSize:7,includes:[],excludes:[],warnings:[]}})})
    try{
      await expect(execute({action:'publish',authorizedBy:'owner',confirmed:true,operationId:'p'})).rejects.toThrow('PREVIEW_REQUIRED')
      await execute({action:'preview',taskId:'target',operationId:'preview',authorizedBy:'owner'})
      await expect(execute({action:'publish',snapshotId:'preview',authorizedBy:'owner',operationId:'p'})).rejects.toThrow('CONFIRMATION_REQUIRED')
      await app.store.putAccess({taskId:'target',ownerSessionId:'successor',ownerEpoch:1,observerSessionIds:['owner'],updatedAt:new Date().toISOString()})
      await expect(execute({action:'publish',snapshotId:'preview',authorizedBy:'owner',operationId:'p',confirmed:true})).rejects.toThrow('NOT_CONTROLLER');expect(calls).toBe(0)
    }finally{await app.close()}
  })
})
