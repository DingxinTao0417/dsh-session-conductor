import { EXECUTION_STATES, TURN_OUTCOMES, type ConnectionReading } from './state.ts'
import { initialProjection, type ProjectionState } from '../service/projection.ts'

export interface RemotePanelIdentity { readonly taskId: string; readonly hostId: string; readonly sessionId: string; readonly version: number }
interface Receipt { readonly generation: number; readonly observedAt?: number; readonly projection?: ProjectionState; readonly failed: boolean }

/** A display-only snapshot cache, pinned to the full binding; it never authorizes dispatch. */
export class RemotePanelFacts {
  private readonly records = new Map<string, Receipt>()
  private key(identity: RemotePanelIdentity): string { return JSON.stringify([identity.taskId, identity.hostId, identity.sessionId, identity.version]) }
  begin(identity: RemotePanelIdentity): number {
    const key = this.key(identity), current = this.records.get(key)
    const generation = (current?.generation ?? 0) + 1
    this.records.set(key, { ...current, generation, failed: current?.failed ?? false })
    return generation
  }
  accept(identity: RemotePanelIdentity, generation: number, value: {
    readonly execution: string; readonly pendingIntervention?: string; readonly lastTurn?: string; readonly lastTurnDetail?: string
    readonly cursor: string; readonly expectedTurn?: number; readonly expectedStartSeq?: number
  }, observedAt: number): void {
    const key = this.key(identity)
    if (this.records.get(key)?.generation !== generation) return
    if (!(EXECUTION_STATES as readonly string[]).includes(value.execution)
      || (value.lastTurn !== undefined && !(TURN_OUTCOMES as readonly string[]).includes(value.lastTurn))) {
      this.fail(identity, generation); return
    }
    this.records.set(key, { generation, observedAt, failed: false, projection: {
      ...initialProjection(), execution: value.execution as ProjectionState['execution'],
      interaction: value.pendingIntervention === 'waiting_input' || value.pendingIntervention === 'waiting_approval' ? value.pendingIntervention : 'none',
      cursor: Number(value.cursor), lastTurn: value.lastTurn as ProjectionState['lastTurn'], lastTurnDetail: value.lastTurnDetail,
      openTurn: value.expectedTurn, openTurnStartSeq: value.expectedStartSeq,
    } })
  }
  fail(identity: RemotePanelIdentity, generation: number): void {
    if (this.records.get(this.key(identity))?.generation === generation) this.records.set(this.key(identity), { generation, failed: true })
  }
  read(identity: RemotePanelIdentity, now: number): { projection: ProjectionState; reach: ConnectionReading; observedAt?: string } {
    const entry = this.records.get(this.key(identity))
    const fresh = entry?.projection !== undefined && !entry.failed && entry.observedAt !== undefined && now - entry.observedAt >= 0 && now - entry.observedAt <= 5_000
    const observedAt = entry?.observedAt === undefined ? undefined : new Date(entry.observedAt).toISOString()
    return {
      projection: fresh ? entry.projection! : { ...initialProjection(), execution: 'reconciling' },
      reach: { connection: fresh ? 'online' : 'unavailable', unrecoverable: false,
        reason: fresh ? `Remote observation at ${observedAt}; display freshness window 5 seconds.`
          : `Remote state needs a fresh read${observedAt === undefined ? '' : `; last observation ${observedAt}`}. Cached state does not prove the task is running or idle.` },
      ...observedAt === undefined ? {} : { observedAt },
    }
  }
  clear(): void { this.records.clear() }
}
