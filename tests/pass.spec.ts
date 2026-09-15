import { describe, expect, it } from 'vitest'
import { BackgroundPass } from '../src/service/pass.ts'

/**
 * A hand-driven timer, so every scheduling property is asserted without waiting.
 *
 * `fire()` runs whatever is scheduled, which is what a real timer would do; nothing
 * happens on its own, so a test states the ordering it is checking.
 */
function fakeTimer() {
  const scheduled: { callback: () => void; delay: number; cancelled: boolean }[] = []
  return {
    scheduled,
    setTimer: (callback: () => void, delay: number) => {
      const entry = { callback, delay, cancelled: false }
      scheduled.push(entry)
      return entry
    },
    clearTimer: (handle: unknown) => {
      const entry = handle as { cancelled: boolean }
      entry.cancelled = true
    },
    /** Run the next uncancelled callback. */
    async fire(): Promise<void> {
      const next = scheduled.find(entry => !entry.cancelled)
      if (next === undefined) return
      next.cancelled = true
      next.callback()
      // Let the pass's promise chain settle before the caller asserts.
      await new Promise(resolve => { setImmediate(resolve) })
    },
    get pending(): number {
      return scheduled.filter(entry => !entry.cancelled).length
    },
  }
}

/** A pass over a hand-driven timer, with a controllable body. */
function makePass(body: () => Promise<string>) {
  const timer = fakeTimer()
  const pass = new BackgroundPass({ run: body, intervalMs: 5000, setTimer: timer.setTimer, clearTimer: timer.clearTimer })
  return { pass, timer }
}

describe('the background pass (PRD §二.8.1, §二.11)', () => {
  it('does not run on start, and schedules the first pass instead', async () => {
    // Mounting the plugin must not do work inside the Host's own startup path.
    const { pass, timer } = makePass(async () => 'done')
    pass.start()
    expect(pass.passes).toBe(0)
    expect(timer.pending).toBe(1)
    expect(timer.scheduled[0]?.delay).toBe(5000)
  })

  it('runs the pass when the timer fires and records its account', async () => {
    const { pass, timer } = makePass(async () => 'checked 2 schedules')
    pass.start()
    await timer.fire()
    expect(pass.passes).toBe(1)
    expect(pass.lastAccount).toBe('checked 2 schedules')
    expect(pass.lastError).toBeUndefined()
  })

  it('re-arms itself after each pass', async () => {
    const { pass, timer } = makePass(async () => 'ok')
    pass.start()
    await timer.fire()
    expect(timer.pending).toBe(1)
    await timer.fire()
    expect(pass.passes).toBe(2)
  })

  it('is idempotent: starting twice does not leave two timers running', async () => {
    // Two timers would quietly double every pass.
    const { pass, timer } = makePass(async () => 'ok')
    pass.start()
    pass.start()
    expect(timer.pending).toBe(1)
  })

  it('does not overlap passes, and counts what it skipped', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const { pass, timer } = makePass(async () => { await gate; return 'slow' })

    pass.start()
    const first = timer.fire()
    // A second tick while the first is still running must not start a second pass:
    // two concurrent report passes would read the same undelivered facts and could
    // both deliver them.
    const skipped = await pass.tick()
    expect(skipped).toBe(false)
    expect(pass.skips).toBe(1)
    expect(pass.passes).toBe(0)

    release?.()
    await first
    expect(pass.passes).toBe(1)
  })

  it('contains a failure and keeps going', async () => {
    let calls = 0
    const { pass, timer } = makePass(async () => {
      calls += 1
      if (calls === 1) throw new Error('the first pass failed')
      return 'recovered'
    })
    pass.start()
    await timer.fire()
    expect(pass.lastError).toBe('the first pass failed')
    expect(pass.running).toBe(true)

    await timer.fire()
    expect(pass.passes).toBe(2)
    expect(pass.lastAccount).toBe('recovered')
    // The failure is cleared once a pass succeeds, so the log line stops repeating.
    expect(pass.lastError).toBeUndefined()
  })

  it('stops scheduling when stopped, and deletes nothing', async () => {
    const { pass, timer } = makePass(async () => 'ok')
    pass.start()
    pass.stop()
    expect(pass.running).toBe(false)
    expect(timer.pending).toBe(0)

    // A tick after stopping does nothing at all.
    expect(await pass.tick()).toBe(false)
    expect(pass.passes).toBe(0)
  })

  it('cannot be restarted, so a stopped plugin stays stopped', async () => {
    const { pass, timer } = makePass(async () => 'ok')
    pass.start()
    pass.stop()
    pass.start()
    expect(timer.pending).toBe(0)
  })

  it('does not re-arm the loop when it is stopped mid-pass', async () => {
    // The pass that was already running must not undo the stop on its way out.
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const { pass, timer } = makePass(async () => { await gate; return 'late' })

    pass.start()
    const inFlight = timer.fire()
    pass.stop()
    release?.()
    await inFlight

    expect(pass.running).toBe(false)
    expect(timer.pending).toBe(0)
    // The work that had already started still finished and was recorded.
    expect(pass.passes).toBe(1)
  })
})
