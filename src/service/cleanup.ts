/**
 * Resource registry and cleanup (PRD §三.6, T32).
 *
 * Stop, archive, unmanage, migrate and uninstall never delete a worktree, a
 * branch, a file or history. Cleanup is a separate, explicit action: a preview
 * first, then a selection the user confirmed. Only plugin-owned resources with
 * no active reference are eligible; user modifications and unknown contents
 * refuse the delete rather than being forced.
 *
 * Auto-delete is off (PRD §四.7). Nothing in the background pass calls this
 * module — an unsolicited delete would be the thing the default exists to
 * prevent.
 *
 * @module dsh-session-conductor/service/cleanup
 */

import { posix, win32 } from 'node:path'

/** Plugin-owned resource kinds this build registers. */
export const RESOURCE_KINDS = ['worktree'] as const
/** One plugin-owned resource kind. */
export type ResourceKind = (typeof RESOURCE_KINDS)[number]

/** Whether a registered resource is still on disk or already cleaned. */
export const RESOURCE_STATUSES = ['active', 'cleaned'] as const
/** One resource-status value. */
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number]

/** What inspecting a worktree's working tree produced. */
export const TREE_STATES = ['clean', 'modified', 'unknown', 'missing'] as const
/** One tree-state value. */
export type TreeState = (typeof TREE_STATES)[number]

/**
 * Stable identity of the worktree a task's Git starting state created.
 *
 * Deterministic on the task so a retry of the same preparation overwrites the
 * same row rather than registering a second resource for one directory.
 *
 * @param taskId - the logical task.
 * @returns the resource id.
 */
export function worktreeResourceId(taskId: string): string {
  return `worktree:${taskId}`
}

/**
 * Compare two filesystem paths the way cleanup has to: separators and trailing
 * slashes must not make the same directory look like two, and Windows must not
 * treat `D:\\a` and `d:/a` as different resources.
 *
 * @param left - one path.
 * @param right - the other.
 * @returns true when they name the same location.
 */
export function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right)
}

/**
 * Whether `child` is `parent` or a path inside it.
 *
 * Used to treat an artifact that lives in a worktree as a reference to that
 * worktree, so cleaning the directory cannot strand a recorded file.
 *
 * @param child - the nested path.
 * @param parent - the directory.
 * @returns true when the child is at or under the parent.
 */
export function underPath(child: string, parent: string): boolean {
  const nested = normalizePath(child)
  const directory = normalizePath(parent)
  return nested === directory || nested.startsWith(directory.endsWith('/') ? directory : `${directory}/`)
}

/**
 * Fold separators, trailing slashes and case so two spellings of one path
 * compare equal.
 *
 * @param path - a filesystem path.
 * @returns the comparison form.
 */
export function normalizePath(path: string): string {
  const windows = /^[a-z]:/i.test(path) || path.startsWith('\\\\') || path.startsWith('//')
  const provider = windows ? win32 : posix
  const normalized = provider.normalize(path).replace(/\\/g, '/')
  const root = provider.parse(provider.normalize(path)).root.replace(/\\/g, '/')
  const trimmed = normalized.length > root.length ? normalized.replace(/\/+$/, '') : normalized
  return windows ? trimmed.toLowerCase() : trimmed
}

/** The facts a cleanup decision needs about one resource. */
export interface ResourceFacts {
  /** True when this conductor created the directory. */
  readonly owned: boolean
  /** True when a previous confirmed cleanup already ran. */
  readonly alreadyCleaned: boolean
  /** Active task or artifact references, in the caller's terms. */
  readonly referencedBy: readonly string[]
  /** What inspecting the directory produced. */
  readonly tree: TreeState
}

/** Whether one resource may be cleaned, and why. */
export type CleanupDecision =
  | { readonly allowed: true; readonly reason: string }
  | { readonly allowed: false; readonly reason: string }

/**
 * Decide whether one resource may be cleaned (PRD §三.6, T32).
 *
 * The refusals are the specification's: not plugin-owned, still referenced,
 * user modifications, or unknown contents. A missing directory is eligible
 * only to mark the record cleaned — confirming it deletes nothing, because
 * there is nothing to delete.
 *
 * @param facts - what is known about the resource.
 * @returns whether a confirmed execute may proceed, and the reason either way.
 */
export function cleanupDecision(facts: ResourceFacts): CleanupDecision {
  if (facts.alreadyCleaned) {
    return {
      allowed: false,
      reason: 'this resource was already cleaned; the record is kept so a later reader can tell',
    }
  }
  if (!facts.owned) {
    return {
      allowed: false,
      reason: 'this directory was not created by the conductor, so it is not plugin-owned and is not deleted',
    }
  }
  if (facts.referencedBy.length > 0) {
    return {
      allowed: false,
      reason: `still referenced by ${facts.referencedBy.join('; ')} — only unreferenced plugin-owned resources may be cleaned`,
    }
  }
  if (facts.tree === 'modified') {
    return {
      allowed: false,
      reason: 'the directory contains user modifications, so automatic deletion is refused',
    }
  }
  if (facts.tree === 'unknown') {
    return {
      allowed: false,
      reason: 'the directory contents are unknown, so automatic deletion is refused',
    }
  }
  if (facts.tree === 'missing') {
    return {
      allowed: true,
      reason: 'the directory is already gone; confirming marks the record cleaned and deletes nothing',
    }
  }
  return {
    allowed: true,
    reason: 'plugin-owned, unreferenced, and the working tree is clean',
  }
}

/** What an execute call asked for. */
export interface ExecutePlan {
  /** Set only after the user saw the preview and chose these resources. */
  readonly confirmed: boolean
  /** Resource ids selected from the preview. Empty means no selection. */
  readonly selectedIds: readonly string[]
}

/** Whether the execute gate opens. */
export type ExecuteGate =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/**
 * Refuse an execute that skipped the preview-and-choose step.
 *
 * Auto-delete is a different switch (off by default) and is not honoured here:
 * even a caller who turned it on still has to confirm a named selection.
 * Background code must not call execute at all.
 *
 * @param plan - confirmation and the ids the caller named.
 * @returns whether any selected resource may be considered for deletion.
 */
export function planCleanupExecute(plan: ExecutePlan): ExecuteGate {
  if (!plan.confirmed) {
    return {
      ok: false,
      reason: 'cleanup is not automatic: set confirmed after the user saw the preview and chose these resources. '
        + 'Nothing was deleted.',
    }
  }
  if (plan.selectedIds.length === 0) {
    return {
      ok: false,
      reason: 'execute needs an explicit selection of resource ids from the preview. Nothing was deleted.',
    }
  }
  return { ok: true }
}

/**
 * One line of a cleanup preview, in the terms PRD §三.6 asks the registry to
 * carry: why it was created, whether it is still referenced, where it lives,
 * and the condition under which it may be cleaned.
 */
export interface CleanupPreviewItem {
  readonly resourceId: string
  readonly kind: ResourceKind
  readonly path: string
  readonly taskId: string
  readonly createdReason: string
  readonly status: ResourceStatus
  readonly owned: boolean
  readonly referenced: boolean
  readonly referencedBy: readonly string[]
  readonly retention: string
  readonly tree: TreeState
  readonly eligible: boolean
  readonly condition: string
}

/**
 * Render a preview as the text a caller reads before choosing.
 *
 * @param items - the preview rows.
 * @returns a summary that names eligibility rather than implying a delete.
 */
export function describeCleanupPreview(items: readonly CleanupPreviewItem[]): string {
  if (items.length === 0) {
    return 'No plugin-owned resource is registered. Stop, archive, unmanage, migrate and uninstall do not delete '
      + 'worktrees; cleanup is a separate, explicit action and there is nothing to preview.'
  }
  const eligible = items.filter(item => item.eligible).length
  const lines = items.map(item => {
    const mark = item.eligible ? 'eligible' : 'refused'
    return `- ${item.resourceId} (${item.kind}) at ${item.path}: ${mark} — ${item.condition}`
  })
  return `${String(items.length)} plugin-owned resource(s), ${String(eligible)} eligible for a confirmed selection.\n`
    + lines.join('\n')
}
