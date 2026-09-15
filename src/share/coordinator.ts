import { randomBytes, randomUUID } from 'node:crypto'
import type { ConductorStore } from '../store/repository.ts'
import type { ShareToolRequest, ShareToolResult } from '../tools.ts'
import { mayRead, writeControlRefusal } from '../service/access.ts'
import { describeRevocation, planPublish, shareServiceAvailable, shareState, type SharePreview, type ShareRecord } from '../service/share.ts'
import { snapshotDigest, type ShareAttachment, type ShareServicePort, type ShareUpload } from './transport.ts'

export interface ShareDraft {preview: SharePreview; document: string; attachments: ShareAttachment[]; digest: string; authorizedBy: string}
const fixedFields = ['shareId','snapshotId','taskId','token','cutoffAt','publishedAt','expiresAt'] as const
function sameShareIdentity(expected: ShareRecord, receipt: ShareRecord): boolean {
  return fixedFields.every(field => expected[field] === receipt[field])
    && (receipt.revokedAt === undefined || Number.isFinite(Date.parse(receipt.revokedAt)))
}
export function createShareCoordinator(options: {
  store: ConductorStore; service?: ShareServicePort | undefined; enabled: boolean; lifetimeDays: number
  build(request: ShareToolRequest): Promise<Omit<ShareDraft, 'digest' | 'authorizedBy'>>
}): (request: ShareToolRequest) => Promise<ShareToolResult> {
  const {store,service} = options
  return async request => {
    const now = new Date().toISOString()
    const availability = shareServiceAvailable(options.enabled, service !== undefined)
    const readable = (taskId: string): boolean => {const access=store.getAccess(taskId);return access !== undefined && mayRead(access,request.authorizedBy)}
    const requireOwner = (taskId: string): number => {const access=store.getAccess(taskId);const refusal=writeControlRefusal(access,taskId,request.authorizedBy);if(refusal)throw new Error(`${refusal.code}: ${refusal.reason}`);return access!.ownerEpoch}
    const shares = (): ShareToolResult['shares'] => store.listShares().filter(row=>readable(row.taskId)).map(row=>({shareId:row.shareId,taskId:row.taskId,state:shareState(row,now),cutoffAt:row.cutoffAt,expiresAt:row.expiresAt,revokedAt:row.revokedAt??''}))
    const result = (summary: string, extra: Partial<ShareToolResult> = {}): ShareToolResult => ({shares:shares(),availability,refusals:[],summary,...extra})
    if (request.action==='list') return result(`${shares().length} visible share(s). ${availability.reason}`)
    if (request.action==='status' || request.action==='revoke') {
      const record = request.shareId ? store.getShare(request.shareId) : undefined
      if (!record || !readable(record.taskId)) throw new Error('NOT_FOUND: share is unavailable to this controller')
      if (request.action==='status') return result(`Share ${record.shareId}: ${shareState(record,now)}. Cutoff ${record.cutoffAt}; expires ${record.expiresAt}.`)
      const ownerEpoch=requireOwner(record.taskId)
      if (!availability.available || !service) return result('Revocation has not reached the HTTPS service.',{refusals:[availability.reason]})
      // Revoke is idempotent at the service and acknowledged before the local state changes.
      if(requireOwner(record.taskId)!==ownerEpoch)throw Error('STALE_OWNER_EPOCH')
      const receipt = await service.revoke(record.shareId)
      if (!sameShareIdentity(record, receipt.record) || !receipt.record.revokedAt) throw new Error('UNKNOWN: revocation receipt did not match the published share')
      await store.withExclusive(`share-record:${record.shareId}`,async()=>await store.updateShare(record.shareId,row=>({...receipt.record,...row.revokedAt===undefined?{}:{revokedAt:row.revokedAt}})))
      return result(describeRevocation(receipt.record))
    }
    if (request.action==='preview') {
      if (!request.taskId || !readable(request.taskId)) throw new Error('NOT_FOUND: task is unavailable to this controller')
      const opid = request.operationId ?? `share-preview-${randomUUID()}`
      return await store.withExclusive(`share:${opid}`,async()=>{
        const claim = await store.beginOperation({operationId:opid,kind:'share',taskId:request.taskId!,params:request})
        if (claim.kind==='conflict') throw new Error('OPERATION_CONFLICT: preview identity has different parameters')
        let draft = store.getOperation(opid)?.result as ShareDraft | undefined
        if (!draft) {
          const built = await options.build(request)
          if(!readable(request.taskId!))throw Error('NOT_FOUND: preview read permission changed while building')
          draft={...built,preview:{...built.preview,snapshotId:opid},authorizedBy:request.authorizedBy,digest:snapshotDigest(built.preview.format,built.document,built.attachments)}
          await store.updateOperation(opid,row=>({...row,result:draft,delivery:'accepted',phase:'preview_ready'}))
        }
        if(!readable(request.taskId!))throw Error('NOT_FOUND: preview read permission changed before delivery')
        return result(`Unpublished fixed preview ${draft.preview.snapshotId}; SHA-256 ${draft.digest}.\n${draft.document}\n${draft.preview.warnings.join('\n')}`,
          {preview:{...draft.preview,document:draft.document,digest:draft.digest}})
      })
    }
    const draft = request.snapshotId ? store.getOperation(request.snapshotId)?.result as ShareDraft | undefined : undefined
    if (!draft || draft.authorizedBy!==request.authorizedBy || request.taskId && request.taskId!==draft.preview.taskId) throw new Error('PREVIEW_REQUIRED: publish needs the exact snapshotId previously previewed by this controller')
    requireOwner(draft.preview.taskId)
    if (!request.confirmed) throw new Error('CONFIRMATION_REQUIRED: publishing requires explicit confirmation of the fixed preview')
    if (!availability.available || !service) return result('Nothing was uploaded.',{refusals:[availability.reason]})
    const opid = request.operationId
    if (!opid) throw new Error('OPERATION_REQUIRED: publish requires a stable operationId')
    return await store.withExclusive(`share:${opid}`,async()=>{
      const ownerEpoch=requireOwner(draft.preview.taskId)
      const claim = await store.beginOperation({operationId:opid,kind:'share',taskId:draft.preview.taskId,params:{...request,serviceOrigin:service.baseUrl,ownerEpoch}})
      if(claim.kind==='conflict')throw new Error('OPERATION_CONFLICT: publish identity has different parameters')
      let upload = store.getOperation(opid)?.result as ShareUpload | undefined
      if(!upload){
        const decision=planPublish({preview:draft.preview,confirmed:true,now,lifetimeDays:request.lifetimeDays??options.lifetimeDays,baseUrl:service.baseUrl,newShareId:()=>`share-${randomUUID()}`,newToken:()=>randomBytes(32).toString('base64url')})
        if(!decision.ok)throw new Error(decision.reason)
        upload={record:decision.record,format:draft.preview.format,document:draft.document,attachments:draft.attachments,digest:draft.digest}
        await store.updateOperation(opid,row=>({...row,result:upload,phase:'prepared'}))
      }
      const fixed = upload
      // A crash after dispatch reconciles by shareId. A missing receipt remains unknown; no blind PUT retry.
      const previous = store.getOperation(opid)!
      requireOwner(draft.preview.taskId)
      try {
        let receipt
        if(previous.phase==='prepared'){
          await store.markDelivery(opid,'dispatching','dispatching')
          if(requireOwner(draft.preview.taskId)!==ownerEpoch)throw Error('STALE_OWNER_EPOCH')
          receipt=await service.publish(fixed)
        }else receipt=await service.status(fixed.record.shareId)
        if(!receipt || receipt.digest!==fixed.digest || !sameShareIdentity(fixed.record,receipt.record))throw new Error('UNKNOWN: share publication cannot be confirmed; reconcile with the same operationId')
        const received=receipt
        const published=await store.withExclusive(`share-record:${fixed.record.shareId}`,async()=>{
          const prior=store.getShare(fixed.record.shareId)
          return await store.putShare({...received.record,...prior?.revokedAt===undefined?{}:{revokedAt:prior.revokedAt}})
        })
        await store.markDelivery(opid,'accepted','published')
        const state=shareState(published,new Date().toISOString())
        return result(`Publication confirmed for fixed snapshot ${fixed.record.shareId}; current state: ${state}. Expires ${fixed.record.expiresAt}.`,
          { ...state==='active'?{url:`${service.baseUrl}/s/${fixed.record.token}`}:{},preview:draft.preview})
      }catch(error){await store.markDelivery(opid,'unknown','reconcile_required');throw error}
    })
  }
}
