/**
 * Coalesce rapid panel refreshes (PRD §四.7 面板刷新合并间隔).
 *
 * The specified 250 ms is a merge window, not a poll interval and not a delay
 * on the first paint: the first request in a quiet period runs immediately,
 * overlapping requests share that result, and the window stays open for
 * `mergeMs` after it settles so a burst is one Host round-trip.
 *
 * @module dsh-session-conductor/domain/refresh
 */

/** How a merged refresh talks to the clock. Injectable so a test owns time. */
export interface RefreshClock {
  readonly delay: (fn: () => void, ms: number) => unknown
  readonly cancel: (id: unknown) => void
}

const defaultClock: RefreshClock = {
  delay: (fn, ms) => setTimeout(fn, ms),
  cancel: (id) => { clearTimeout(id as ReturnType<typeof setTimeout>) },
}

/** A refresh result, including failures that must leave the last snapshot visible. */
export type RefreshResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }

/** Poll while mounted, serialize slow reads, and discard reads invalidated by disconnect/unmount. */
export function createPollingRefresh<T>(args: {
  readonly read: () => Promise<T>
  readonly accept: (result: RefreshResult<T>) => void
  readonly intervalMs: number
  readonly clock?: RefreshClock
}): { refresh(): Promise<void>; pause(): void; stop(): void } {
  const clock = args.clock ?? defaultClock
  let stopped = false
  let paused = false
  let inFlight = false
  let generation = 0
  let timer: unknown
  const clear = (): void => {
    if (timer !== undefined) clock.cancel(timer)
    timer = undefined
  }
  const refresh = async (): Promise<void> => {
    if (stopped) return
    paused = false
    if (inFlight) return
    clear()
    inFlight = true
    const ticket = generation
    let result: RefreshResult<T>
    try { result = { ok: true, value: await args.read() } }
    catch (error) { result = { ok: false, error } }
    try {
      if (!stopped && !paused && ticket === generation) args.accept(result)
    } finally {
      inFlight = false
      if (!stopped && !paused) timer = clock.delay(() => { timer = undefined; void refresh() }, args.intervalMs)
    }
  }
  return {
    refresh,
    pause() { paused = true; generation += 1; clear() },
    stop() { stopped = true; generation += 1; clear() },
  }
}

/** Only the most recently selected subject may update a detail view. */
export function createLatestRequest(): {
  run<T>(request: () => Promise<T>, accept: (value: T) => void, reject: (error: unknown) => void): Promise<void>
  invalidate(): void
} {
  let generation = 0
  return {
    async run(request, accept, reject) {
      const ticket = ++generation
      try {
        const result = await request()
        if (ticket === generation) accept(result)
      } catch (error) {
        if (ticket === generation) reject(error)
      }
    },
    invalidate() { generation += 1 },
  }
}

/**
 * Build a refresh that merges overlapping requests into one run.
 *
 * @param args - the merge window and an optional clock.
 * @returns a `request` that coalesces.
 */
export function createMergedRefresh<T>(args: {
  readonly mergeMs: number | (() => number)
  readonly clock?: RefreshClock
}): { request: (run: () => Promise<T>) => Promise<T> } {
  const clock = args.clock ?? defaultClock
  const mergeMsOf = (): number => Math.max(0, typeof args.mergeMs === 'function' ? args.mergeMs() : args.mergeMs)
  let current: Promise<T> | undefined
  let hold: unknown

  return {
    request(run) {
      if (current !== undefined) return current
      if (hold !== undefined) {
        clock.cancel(hold)
        hold = undefined
      }
      const started = run()
      current = started
      void started.finally(() => {
        hold = clock.delay(() => {
          current = undefined
          hold = undefined
        }, mergeMsOf())
      }).catch(() => {
        // The caller already holds `started`. This catch only stops a rejected
        // run from becoming an unhandled rejection on the finally-chain.
      })
      return started
    },
  }
}
