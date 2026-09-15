/**
 * The conductor's background pass (PRD §二.8.1, §二.11, §二.12).
 *
 * Two things the specification asks for cannot happen on demand:
 *
 * - scheduled checks must fire when their time comes, not when someone asks;
 * - reports must wake a controller when something happens, not when someone asks.
 *
 * Without a pass of its own the conductor has neither — `conductor_schedule` would
 * only ever run when a caller ticked it, and a watch would only ever report when a
 * caller ran it, which is a scheduling service that does not schedule and a
 * reporting service that does not report. The pass is therefore part of the feature,
 * not an optimisation on top of it.
 *
 * The specification also names what happens when the plugin stops:
 *
 * > 插件停用：停止新调度和回报，保留任务、成果和数据。
 *
 * So {@link BackgroundPass.stop} stops the loop and **nothing else** — it deletes no
 * record, cancels no task and withdraws no authorisation. Three further properties
 * are load-bearing and each has a test:
 *
 * - **No overlap.** A pass that is still running is not joined by another. Two
 *   concurrent report passes would both read the same undelivered facts and could
 *   both deliver them, which is the duplication the delivered-id list exists to
 *   prevent — and the cheapest way to prevent it is not to start the second pass.
 * - **A failure is contained.** One failing pass is recorded and the next one still
 *   runs. A background loop that dies on its first error is a loop that silently
 *   stops monitoring.
 * - **Stopping is final.** `stop()` clears the timer and refuses to schedule again,
 *   so a pass in flight cannot re-arm the loop on its way out. New scheduling and
 *   reports inside that in-flight pass are refused by the plugin lifecycle flag
 *   (PRD §四.5), which is disabled before the timer is stopped.
 *
 * The timer is injected, so every one of those is testable without waiting.
 *
 * @module dsh-session-conductor/service/pass
 */

/** What one pass does, and how it is scheduled. */
export interface BackgroundPassDeps {
  /**
   * Perform one pass.
   * @returns a one-line account of what it did, for the mount log.
   */
  readonly run: () => Promise<string>
  /** How long to wait between passes. */
  readonly intervalMs: number
  /** Schedule a callback; defaults to `setTimeout`. */
  readonly setTimer?: (callback: () => void, ms: number) => unknown
  /** Cancel a scheduled callback; defaults to `clearTimeout`. */
  readonly clearTimer?: (handle: unknown) => void
}

/** A running background pass, or a stopped one. */
export class BackgroundPass {
  private handle: unknown
  private stopped = false
  private inFlight = false
  private passCount = 0
  private skipCount = 0
  private lastAccountValue: string | undefined
  private lastErrorValue: string | undefined

  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  /**
   * @param deps - what the pass does and how it is scheduled.
   */
  constructor(private readonly deps: BackgroundPassDeps) {
    this.setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer = deps.clearTimer ?? ((handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })
  }

  /** Whether the loop is still armed. */
  get running(): boolean {
    return !this.stopped
  }

  /** How many passes actually ran. */
  get passes(): number {
    return this.passCount
  }

  /** How many ticks were skipped because a pass was still in flight. */
  get skips(): number {
    return this.skipCount
  }

  /** The last pass's account, when it succeeded. */
  get lastAccount(): string | undefined {
    return this.lastAccountValue
  }

  /** The last failure, when a pass threw. */
  get lastError(): string | undefined {
    return this.lastErrorValue
  }

  /**
   * Arm the loop.
   *
   * Idempotent: calling it twice must not leave two timers running, which would
   * quietly double every pass. The first pass is scheduled rather than run
   * immediately, so mounting the plugin does not do work inside the Host's own
   * startup path.
   */
  start(): void {
    if (this.handle !== undefined || this.stopped) return
    this.arm()
  }

  /**
   * Stop the loop.
   *
   * Final: after this the pass never runs again, including from a pass that was
   * already in flight when it was called. Nothing else is touched — no record is
   * deleted, no task is cancelled, no authorisation is withdrawn.
   */
  stop(): void {
    this.stopped = true
    if (this.handle !== undefined) {
      this.clearTimer(this.handle)
      this.handle = undefined
    }
  }

  /**
   * Run one pass now, as the timer would.
   *
   * Exposed so a caller can drive the pass deterministically — and so a test can
   * assert the no-overlap rule without a real clock. Returns without doing anything
   * when the loop is stopped or a pass is already in flight.
   *
   * @returns whether a pass actually ran.
   */
  async tick(): Promise<boolean> {
    if (this.stopped) return false
    if (this.inFlight) {
      // Counted rather than ignored: a loop that is consistently skipping is a loop
      // whose interval is shorter than its work, and that should be visible.
      this.skipCount += 1
      return false
    }
    this.inFlight = true
    try {
      this.lastAccountValue = await this.deps.run()
      this.lastErrorValue = undefined
    } catch (error) {
      // Contained on purpose. The alternative is a background loop that stops
      // monitoring after one transient failure, which is worse than a loud log line.
      this.lastErrorValue = error instanceof Error ? error.message : String(error)
    } finally {
      this.inFlight = false
      this.passCount += 1
      // Re-armed only if the loop is still meant to be running: `stop()` during a
      // pass must not be undone by the pass finishing.
      this.arm()
    }
    return true
  }

  /** Schedule the next tick, unless the loop has been stopped or is already armed. */
  private arm(): void {
    if (this.stopped || this.handle !== undefined) return
    this.handle = this.setTimer(() => {
      this.handle = undefined
      void this.tick()
    }, this.deps.intervalMs)
  }
}
