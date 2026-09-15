import type { ConductorStore } from '../store/repository.ts'
import type { StoredOperationRecord, WorkflowRunRecord } from '../store/schema.ts'
import { readSessionSelection, selectionFromHeader, type ModelSelectionReader } from './modelconfig.ts'

type Configuration = NonNullable<NonNullable<WorkflowRunRecord['fixed']>['modelConfigurations']>[number]

/** Capture each target's effective next request and binding; repeated task nodes share one read. */
export async function freezeWorkflowModels(
  store: ConductorStore,
  nodes: readonly { readonly nodeId: string; readonly taskId: string }[],
  reader: ModelSelectionReader | undefined,
): Promise<Configuration[]> {
  if (reader === undefined || typeof reader.peekForSession !== 'function') throw new Error('WORKFLOW_CONFIG_UNAVAILABLE: run configuration needs the companion reader and synchronous dispatch guard')
  const captured = new Map<string, Promise<Omit<Configuration, 'nodeId'>>>()
  for (const node of nodes) {
    if (captured.has(node.taskId)) continue
    captured.set(node.taskId, (async () => {
      const task = store.getTask(node.taskId)
      const binding = task?.currentBindingId === undefined ? undefined : store.getBinding(task.currentBindingId)
      if (!task || !binding) throw new Error(`WORKFLOW_CONFIG_UNAVAILABLE: ${node.taskId} has no bound session`)
      const state = await readSessionSelection(reader, binding.sessionId)
      if (store.getTask(node.taskId)?.currentBindingId !== binding.bindingId) throw new Error(`STALE_BINDING: ${node.taskId} moved while capturing workflow configuration`)
      return { taskId: node.taskId, sessionId: binding.sessionId, bindingVersion: binding.version, selection: state.next,
        ...task.preset === undefined ? {} : { preset: task.preset } }
    })())
  }
  return await Promise.all(nodes.map(async node => ({ nodeId: node.nodeId, ...await captured.get(node.taskId)! })))
}

/** No asynchronous gap between this comparison and Coordinator's actual Host admission. */
export function workflowModelRefusal(
  store: ConductorStore,
  fixed: NonNullable<WorkflowRunRecord['fixed']>['modelConfigurations'],
  nodeId: string,
  reader: ModelSelectionReader | undefined,
): string | undefined {
  const pin = fixed?.find(entry => entry.nodeId === nodeId)
  if (!pin) return 'WORKFLOW_CONFIG_UNAVAILABLE: this node has no frozen runtime configuration; the old run was not upgraded from current defaults'
  const task = store.getTask(pin.taskId)
  const binding = task?.currentBindingId === undefined ? undefined : store.getBinding(task.currentBindingId)
  if (binding?.sessionId !== pin.sessionId || binding.version !== pin.bindingVersion || task?.preset !== pin.preset) return 'WORKFLOW_CONFIG_CHANGED: node session, binding or preset differs from the run snapshot'
  let observed: ReturnType<NonNullable<ModelSelectionReader['peekForSession']>>
  try { observed = reader?.peekForSession?.({ sessionId: pin.sessionId }) }
  catch { return 'WORKFLOW_CONFIG_UNAVAILABLE: Host next-request read failed' }
  const next = selectionFromHeader({ config: observed?.next })
  if (observed?.sessionId !== pin.sessionId || observed.effectiveAt !== 'next_request' || !next) return 'WORKFLOW_CONFIG_UNAVAILABLE: Host cannot synchronously verify the node next-request configuration'
  if (next.provider !== pin.selection.provider || next.model !== pin.selection.model || next.reasoningEffort !== pin.selection.reasoningEffort) return 'WORKFLOW_CONFIG_CHANGED: node model differs from the run snapshot; no instruction was dispatched'
  return undefined
}

/** Recheck queued workflow instructions against their original run at flush time. */
export function workflowOperationModelRefusal(store: ConductorStore, operation: StoredOperationRecord, reader: ModelSelectionReader | undefined): string | undefined {
  if (!operation.attribution?.sourceEventId?.startsWith('workflow-')) return undefined
  for (const run of store.listWorkflowRuns()) {
    const node = run.nodes.find(entry => operation.operationId === `workflow-${run.runId}-${entry.nodeId}-${String(entry.attempts + 1)}`)
    if (node) return workflowModelRefusal(store, run.fixed?.modelConfigurations, node.nodeId, reader)
  }
  return 'WORKFLOW_CONFIG_UNAVAILABLE: queued instruction has no matching run configuration'
}
