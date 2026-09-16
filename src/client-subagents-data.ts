/** Only the public native directory and navigation surfaces; no history or Agent APIs. */
export interface NativeSubagentSessions {
  readonly list?: { getSnapshot?(): unknown; subscribe?(listener: () => void): () => void }
  refreshSubagents?(parentSessionId: string): Promise<void>
  openSubagent?(address: { parentSessionId: string; childSessionId: string; mode: 'one-shot' | 'continuable' }): void | Promise<void>
}
export interface SubagentItem {
  readonly id: string
  readonly title: string
  readonly mode?: 'one-shot' | 'continuable'
  readonly activity: 'running' | 'inactive' | 'unavailable'
  readonly statusLabel: string
  /** Projected accumulated turn time; an active running turn advances from its official start. */
  readonly durationMs?: number
  readonly updatedAt?: number
}
export interface SubagentsRead {
  readonly parentId: string
  readonly state: 'loading' | 'ready' | 'error' | 'unavailable'
  readonly parentAvailable?: boolean
  readonly error?: string
  readonly items: readonly SubagentItem[]
}
export interface SubagentsPort {
  getSnapshot(parentId: string): SubagentsRead
  subscribe(parentId: string, listener: (read: SubagentsRead) => void): () => void
  refresh(parentId: string): Promise<void>
  open(parentId: string, id: string): Promise<void>
  close(): void
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const own = (value: unknown, key: string): unknown => {
  const record = object(value)
  return record && Object.hasOwn(record, key) ? record[key] : undefined
}
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const detail = (error: unknown): string | undefined => text(object(error)?.['message'])?.slice(0, 240)
const timingDuration = (value: unknown, running: boolean, now: number): number | undefined => {
  const timing = object(value)
  if (!timing || !finite(timing['settledMs'])) return undefined
  const active = timing['active']
  let duration = timing['settledMs']
  if (active !== undefined) {
    const range = object(active)
    if (!range || !finite(range['since']) || !finite(range['through']) || range['through'] < range['since']) return undefined
    if (running && !Number.isFinite(now)) return undefined
    duration += running ? Math.max(0, now - range['since']) : range['through'] - range['since']
  }
  return Number.isFinite(duration) ? duration : undefined
}

function project(parentId: string, snapshot: unknown, now: number, failure?: string): SubagentsRead {
  const source = object(snapshot)
  const catalog = object(own(source?.['subagentsByParent'], parentId))
  if (!catalog) return { parentId, state: failure ? 'error' : 'loading', items: [], ...failure ? { error: failure } : {} }
  const parentAvailable = typeof catalog['parentAvailable'] === 'boolean' ? catalog['parentAvailable'] : undefined
  const rows = catalog['entries']
  let error = failure, state: SubagentsRead['state'] = catalog['state'] === 'ready' ? 'ready' : catalog['state'] === 'error' ? 'error' : 'loading'
  if (!['loading', 'ready', 'error'].includes(String(catalog['state'])) || !Array.isArray(rows) || parentAvailable === undefined) {
    state = 'error'; error ??= '宿主返回的子智能体目录格式无效，请刷新重试。'
  }
  if (catalog['state'] === 'error') error ??= detail(catalog['error']) ?? '子智能体目录读取失败，请刷新重试。'
  if (failure) state = 'error'
  const items = new Map<string, SubagentItem>()
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = object(raw), rawId = row?.['id']
    const id = typeof rawId === 'string' && rawId.trim() === rawId && rawId ? rawId : undefined
    if (!row || !id || items.has(id)) {
      state = 'error'; error ??= '子智能体目录包含无效或重复条目，请刷新重试。'
      continue
    }
    const summary = object(own(source?.['byId'], id))
    const title = text(row['label']) ?? text(summary?.['title']) ?? text(summary?.['displayTitle']) ?? id
    const durationMs = timingDuration(object(summary?.['projectionValues'])?.['subagentTiming'], row['activity'] === 'running' && state === 'ready', now)
    const updatedAt = summary?.['updatedAt']
    const mode = row['mode'] === 'one-shot' || row['mode'] === 'continuable' ? row['mode'] : undefined
    if (row['kind'] === 'diagnostic' || row['kind'] !== 'child' || mode === undefined || !['running', 'inactive'].includes(String(row['activity']))) {
      const statusLabel = row['reason'] === 'corrupt' ? '记录损坏' : row['reason'] === 'unsupported' ? '版本不支持' : row['reason'] === 'unavailable' ? '暂不可用' : '状态不可用'
      items.set(id, { id, title, activity: 'unavailable', statusLabel })
    } else {
      const activity = row['activity'] as 'running' | 'inactive'
      items.set(id, { id, title, mode, activity, statusLabel: activity === 'running' ? '进行中' : '已结束 / 空闲',
        ...durationMs === undefined ? {} : { durationMs }, ...finite(updatedAt) ? { updatedAt } : {} })
    }
  }
  if (state === 'ready' && parentAvailable === false) {
    error ??= '父会话当前不可用；仍可查看已保存的子智能体，继续执行可能不可用。'
  }
  return { parentId, state, ...parentAvailable === undefined ? {} : { parentAvailable }, ...error ? { error } : {},
    items: [...items.values()].map(item => state === 'ready' || item.activity === 'unavailable' ? item : {
      ...item, activity: 'unavailable', statusLabel: state === 'loading' ? '正在刷新' : '状态暂不可用',
    }),
  }
}

/** Shared per-parent read leases, independent of the Host menu's setSubagentCatalogOpen flag. */
export function createSubagentsPort(sessions: NativeSubagentSessions | undefined, now: () => number = Date.now): SubagentsPort {
  interface Entry {
    parentId: string; read: SubagentsRead; listeners: Set<(read: SubagentsRead) => void>
    sampledAt: number; stopped: boolean; failure?: string; failureCatalog?: unknown
    confirmed?: { entries: unknown; parentAvailable: unknown }
    inFlight?: Promise<void>; timer?: ReturnType<typeof setTimeout>; release?: () => void
  }
  const entries = new Map<string, Entry>()
  let closed = false
  const unavailable = (parentId: string, error: string): SubagentsRead => ({ parentId, state: 'unavailable', error, items: [] })
  const source = (): unknown => sessions?.list?.getSnapshot?.()
  const usable = (): boolean => typeof sessions?.list?.getSnapshot === 'function'
    && typeof sessions.list.subscribe === 'function' && typeof sessions.refreshSubagents === 'function'
  const current = (entry: Entry): boolean => !closed && !entry.stopped && entries.get(entry.parentId) === entry
  const read = (entry: Entry): SubagentsRead => {
    if (closed) return unavailable(entry.parentId, '子智能体视图已关闭。')
    if (!usable()) return unavailable(entry.parentId, '当前宿主未提供完整的子智能体目录读取能力。')
    try {
      const snapshot = source(), catalog = own(object(snapshot)?.['subagentsByParent'], entry.parentId)
      // Unrelated session-list updates must not erase a failed refresh of this parent.
      if (entry.failure && entry.failureCatalog !== catalog) { delete entry.failure; delete entry.failureCatalog }
      const value = object(catalog)
      // Native refresh retains the previous confirmed catalog while its pull is loading.
      // Keep those sampled facts visible; loading alone is not a loss of availability.
      const confirmedLoading = value?.['state'] === 'loading' && entry.confirmed
        && value['parentAvailable'] === entry.confirmed.parentAvailable
        && JSON.stringify(value['entries']) === JSON.stringify(entry.confirmed.entries)
      const effective = confirmedLoading ? { ...object(snapshot), subagentsByParent: {
        ...object(object(snapshot)?.['subagentsByParent']), [entry.parentId]: { ...value, state: 'ready' },
      } } : snapshot
      const result = project(entry.parentId, effective, entry.sampledAt, entry.failure)
      if (value?.['state'] === 'ready' && result.state === 'ready') entry.confirmed = { entries: value['entries'], parentAvailable: value['parentAvailable'] }
      else if (!value || result.state === 'error') delete entry.confirmed
      return result
    } catch (cause) { return { parentId: entry.parentId, state: 'error', error: detail(cause) ?? '子智能体目录暂时无法读取。', items: [] } }
  }
  const update = (entry: Entry, notify = true): SubagentsRead => {
    if (notify) entry.sampledAt = now()
    const next = read(entry)
    if (JSON.stringify(next) !== JSON.stringify(entry.read)) {
      entry.read = next
      if (notify && current(entry)) for (const listener of entry.listeners) listener(next)
    }
    return entry.read
  }
  const entryOf = (parentId: string): Entry => {
    let entry = entries.get(parentId)
    if (!entry) {
      entry = { parentId, read: { parentId, state: 'loading', items: [] }, listeners: new Set(), sampledAt: now(), stopped: false }
      entries.set(parentId, entry); update(entry, false)
    }
    return entry
  }
  const refresh = async (parentId: string): Promise<void> => {
    if (closed) return
    const entry = entryOf(parentId)
    if (entry.inFlight) return await entry.inFlight
    if (!usable()) { update(entry); return }
    delete entry.failure; delete entry.failureCatalog; update(entry)
    const pending = Promise.resolve().then(async () => {
      if (!current(entry)) return
      try {
        await sessions!.refreshSubagents!(parentId)
        if (!current(entry)) return
        update(entry)
      } catch (cause) {
        if (!current(entry)) return
        entry.failure = detail(cause) ?? '子智能体目录刷新失败，请重试。'
        try { entry.failureCatalog = own(object(source())?.['subagentsByParent'], parentId) } catch { entry.failureCatalog = undefined }
        update(entry)
      }
    })
    entry.inFlight = pending
    try { await pending } finally { if (entry.inFlight === pending) delete entry.inFlight }
  }
  const stop = (entry: Entry): void => {
    entry.stopped = true; clearTimeout(entry.timer); entry.release?.(); entry.listeners.clear()
    if (entries.get(entry.parentId) === entry) entries.delete(entry.parentId)
  }
  return {
    getSnapshot(parentId) { return closed ? unavailable(parentId, '子智能体视图已关闭。') : update(entryOf(parentId), false) },
    subscribe(parentId, listener) {
      if (closed) { listener(unavailable(parentId, '子智能体视图已关闭。')); return () => {} }
      const entry = entryOf(parentId), observer = (value: SubagentsRead): void => { listener(value) }
      entry.listeners.add(observer); observer(update(entry, false))
      if (entry.listeners.size === 1 && usable()) {
        try { entry.release = sessions!.list!.subscribe!(() => { if (current(entry)) update(entry) }) }
        catch {
          entry.failure = '子智能体目录订阅失败，请刷新重试。'
          try { entry.failureCatalog = own(object(source())?.['subagentsByParent'], parentId) } catch { entry.failureCatalog = undefined }
          update(entry)
        }
        const tick = async (): Promise<void> => {
          if (!current(entry) || !entry.listeners.size) return
          if (typeof document === 'undefined' || document.visibilityState !== 'hidden') await refresh(parentId)
          if (current(entry) && entry.listeners.size) entry.timer = setTimeout(() => { void tick() }, 5_000)
        }
        void tick()
      }
      return () => { entry.listeners.delete(observer); if (!entry.listeners.size) stop(entry) }
    },
    refresh,
    async open(parentId, id) {
      if (closed) throw Error('子智能体视图已关闭。')
      if (typeof sessions?.openSubagent !== 'function') throw Error('当前宿主未提供子智能体跳转能力。')
      if (update(entryOf(parentId), false).state !== 'ready') throw Error('子智能体目录尚未就绪，请刷新后重试。')
      const snapshot = source(), catalog = object(own(object(snapshot)?.['subagentsByParent'], parentId))
      if (!catalog || catalog['state'] !== 'ready' || !Array.isArray(catalog['entries'])) throw Error('子智能体目录尚未就绪，请刷新后重试。')
      const matches = catalog['entries'].filter(raw => object(raw)?.['id'] === id)
      const child = matches.length === 1 ? object(matches[0]) : undefined
      if (child?.['kind'] !== 'child' || !['running', 'inactive'].includes(String(child['activity']))
        || child['mode'] !== 'one-shot' && child['mode'] !== 'continuable') throw Error('该子智能体已不在当前父会话的可用目录中。')
      // No await between the final directory lookup and exact native navigation.
      await sessions.openSubagent({ parentSessionId: parentId, childSessionId: id, mode: child['mode'] })
    },
    close() { closed = true; for (const entry of entries.values()) stop(entry) },
  }
}
