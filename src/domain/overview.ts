import type { PanelTaskView } from '../service/panelapi.ts'

export const OVERVIEW_ROUTE = '/conductor/overview'
export interface DelegationReceipt {
  readonly operationId: string
  readonly taskId: string
  readonly title: string
  readonly kind: 'create' | 'fork' | 'send'
  readonly sessionId: string
  readonly local: boolean
  readonly phase: string
  readonly delivery: string
  readonly outcome?: string
  readonly preview?: string
  readonly detail?: string
  readonly turn?: number
  readonly startSeq?: number
  readonly messageSeq?: number
  readonly endSeq?: number
  readonly completedAt?: string
  readonly read: boolean
}
export interface OverviewOutput {
  readonly id: string
  readonly title: string
  readonly taskId: string
  readonly local: boolean
  readonly sessionId?: string
  readonly path?: string
  readonly url?: string
  readonly existence: string
  readonly acceptance: string
}
export interface SessionOverview {
  readonly sessionId: string
  readonly generatedAt: string
  readonly tasks: readonly PanelTaskView[]
  readonly receipts: readonly DelegationReceipt[]
  readonly outputs: readonly OverviewOutput[]
  readonly unread: number
  readonly needsAttention: number
  readonly watchingTaskIds: readonly string[]
  readonly sharedDirectories: readonly { cwd: string; taskIds: readonly string[] }[]
  readonly truncated: boolean
}
