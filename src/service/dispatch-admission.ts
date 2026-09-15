import type { ConductorStore } from '../store/repository.ts'
import type { StoredOperationRecord } from '../store/schema.ts'
import { writeControlRefusal } from './access.ts'
import { acceptanceCounts, isPinnedForDependency } from './artifacts.ts'

/** Revalidate saved automation when it finally reaches the Host, including queued sends. */
export function automaticDispatchRefusal(store: ConductorStore, record: StoredOperationRecord, now: number): string | undefined {
  const source = record.attribution
  if (source === undefined || source.kind === 'user' || source.kind === 'notice') return undefined
  const params = record.params as { text?: string; mode?: string } | undefined
  const expired = (at: string | undefined): boolean => at !== undefined && (!Number.isFinite(Date.parse(at)) || Date.parse(at) <= now)
  if (source.kind === 'rule') {
    const rule = source.ruleId === undefined ? undefined : store.getRule(source.ruleId)
    if (rule === undefined || !rule.active || rule.grantId !== source.grantId) return 'AUTOMATION_REVOKED: the rule or its grant is no longer active'
    if (expired(rule.expiresAt)) return 'AUTOMATION_EXPIRED: the rule grant has expired'
    if (rule.targetTaskId !== record.taskId || rule.instruction !== params?.text
      || (rule.action === 'queue' ? 'queue' : 'steer') !== params?.mode) return 'AUTOMATION_CHANGED: the saved rule no longer authorizes this instruction'
    const control = writeControlRefusal(store.getAccess(rule.sourceTaskId), rule.sourceTaskId, rule.authorizedBy)
    if (control !== undefined) return `${control.code}: the rule source is no longer controlled by its grantor`
    const sourceTask = store.getTask(rule.sourceTaskId)
    const binding = sourceTask?.currentBindingId === undefined ? undefined : store.getBinding(sourceTask.currentBindingId)
    if (source.sourceEventId?.includes('#')) {
      const eventPrefix = source.sourceEventId.slice(0, source.sourceEventId.lastIndexOf('#'))
      if (binding === undefined || (eventPrefix !== binding.sessionId && !eventPrefix.endsWith(`-${binding.sessionId}`))) {
        return 'STALE_BINDING: the rule source moved before its instruction was dispatched'
      }
    }
    const used = new Set(rule.firings.map(firing => firing.operationId))
    for (const operation of store.listOperations({})) {
      if (operation.attribution?.ruleId === rule.ruleId && operation.delivery === 'accepted') used.add(operation.operationId)
    }
    used.delete(record.operationId)
    if (used.size >= rule.maxExecutions) return 'AUTOMATION_LIMIT: the rule execution limit has been reached'
    if (rule.requiredArtifactId !== undefined) {
      const artifact = store.getArtifact(rule.requiredArtifactId)
      if (artifact === undefined || !acceptanceCounts(artifact).counts || !isPinnedForDependency(artifact).pinned) {
        return 'AUTOMATION_INPUT_CHANGED: the required artifact is no longer accepted and pinned'
      }
    }
  } else if (source.sourceEventId?.startsWith('schedule-')) {
    const schedule = store.listSchedules({}).find(entry => source.sourceEventId!.startsWith(`schedule-${entry.scheduleId}-`)
      && Number.isFinite(Date.parse(source.sourceEventId!.slice(`schedule-${entry.scheduleId}-`.length))))
    if (schedule === undefined || schedule.status !== 'active') return 'AUTOMATION_REVOKED: the schedule is no longer active'
    if (expired(schedule.expiresAt)) return 'AUTOMATION_EXPIRED: the schedule grant has expired'
    if (schedule.targetTaskId !== record.taskId || schedule.instruction !== params?.text
      || (schedule.action === 'queue' ? 'queue' : 'steer') !== params?.mode || schedule.action === 'inspect') {
      return 'AUTOMATION_CHANGED: the saved schedule no longer authorizes this instruction'
    }
    const used = new Set(schedule.runs.filter(run => run.outcome === 'ran').map(run => `schedule-${schedule.scheduleId}-${run.scheduledFor}`))
    for (const operation of store.listOperations({})) {
      if (operation.attribution?.sourceEventId?.startsWith(`schedule-${schedule.scheduleId}-`) && operation.delivery === 'accepted') used.add(operation.operationId)
    }
    used.delete(record.operationId)
    if (schedule.maxRuns !== undefined && used.size >= schedule.maxRuns) return 'AUTOMATION_LIMIT: the schedule execution limit has been reached'
  } else if (source.sourceEventId?.startsWith('workflow-')) {
    const run = store.listWorkflowRuns().find(run => run.nodes.some(node => record.operationId === `workflow-${run.runId}-${node.nodeId}-${String(node.attempts + 1)}`))
    if (run === undefined || run.status !== 'running') return 'AUTOMATION_REVOKED: the workflow run no longer authorizes this pending instruction'
    const definition = store.getWorkflow(run.workflowId)
    if (definition === undefined || definition.status !== 'active') return 'AUTOMATION_REVOKED: the workflow is no longer active'
  }
  return undefined
}
