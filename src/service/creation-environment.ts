import type { AgentLike, AgentRegistryLike } from './host.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ServiceLookup } from '../adapters.ts'

/** Frozen from the trusted initiating session, never from a model-supplied controller ID. */
export interface ParentEnvironment { readonly cwd: string; readonly workspaceId?: string }

export function parentEnvironmentOf(ctx: ServiceLookup, controllerSessionId: string): ParentEnvironment {
  const agents = ctx.get('agents') as AgentRegistryLike | undefined
  const parent = agents?.get(SessionId(controllerSessionId))
  const header = parent?.session?.header as { cwd?: unknown } | undefined
  if (typeof header?.cwd !== 'string' || !header.cwd.trim()) throw new Error('PARENT_DIRECTORY_UNAVAILABLE: choose a working directory in the initiating session, or explicitly specify the new task directory')
  const registry = ctx.get('workspaceRegistry') as { list?(): readonly { id: string; path: string; sessionIds: readonly string[] }[] } | undefined
  const workspace = registry?.list?.().find(row => row.sessionIds.includes(controllerSessionId))
  return { cwd: header.cwd, ...workspace === undefined ? {} : { workspaceId: workspace.id } }
}

/** Public Host title service makes this an explicit title, protected from automatic prompt naming. */
export async function setCreatedSessionTitle(ctx: ServiceLookup, agent: AgentLike, title: string): Promise<string> {
  const titles = ctx.get('sessionTitle') as { rename(session: unknown, title: string): { title: string } } | undefined
  const sessions = ctx.get('sessions') as { flush(session: unknown): Promise<unknown> } | undefined
  if (titles === undefined || typeof titles.rename !== 'function' || agent.session === undefined || sessions === undefined) throw new Error('SESSION_NAMING_UNAVAILABLE: this Host must provide sessionTitle.rename and sessions.flush to create a named task')
  const accepted = titles.rename(agent.session, title)
  await sessions.flush(agent.session)
  return accepted.title
}
