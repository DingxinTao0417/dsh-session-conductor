import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLatestRequest, createMergedRefresh, createPollingRefresh } from '../src/domain/refresh.ts'

afterEach(() => { vi.useRealTimers() })

describe('mounted panel refresh lifecycle', () => {
  it('observes later Host changes automatically and recovers after a failed read', async () => {
    vi.useFakeTimers()
    const read = vi.fn<() => Promise<string>>()
      .mockResolvedValueOnce('running')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('completed')
    const accept = vi.fn()
    const poll = createPollingRefresh({ read, accept, intervalMs: 500 })
    await poll.refresh()
    expect(accept).toHaveBeenLastCalledWith({ ok: true, value: 'running' })
    await vi.advanceTimersByTimeAsync(500)
    expect(accept).toHaveBeenLastCalledWith({ ok: false, error: expect.any(Error) })
    await vi.advanceTimersByTimeAsync(500)
    expect(accept).toHaveBeenLastCalledWith({ ok: true, value: 'completed' })
    poll.stop()
    await vi.advanceTimersByTimeAsync(2000)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('does not overlap slow reads or accept an in-flight result after offline/unmount', async () => {
    vi.useFakeTimers()
    let release: (value: string) => void = () => {}
    const read = vi.fn(() => new Promise<string>(resolve => { release = resolve }))
    const accept = vi.fn()
    const poll = createPollingRefresh({ read, accept, intervalMs: 500 })
    const pending = poll.refresh()
    await poll.refresh()
    await vi.advanceTimersByTimeAsync(1500)
    expect(read).toHaveBeenCalledTimes(1)
    poll.pause()
    release('old online snapshot')
    await pending
    expect(accept).not.toHaveBeenCalled()
    const afterOnline = poll.refresh()
    expect(read).toHaveBeenCalledTimes(2)
    poll.stop()
    release('after unmount')
    await afterOnline
    expect(accept).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('task detail request ordering', () => {
  it('keeps the last selected task when an older request completes later', async () => {
    const requests = createLatestRequest()
    const accept = vi.fn()
    const reject = vi.fn()
    let release: (value: string) => void = () => {}
    const first = requests.run(() => new Promise<string>(resolve => { release = resolve }), accept, reject)
    await requests.run(async () => 'task-B', accept, reject)
    release('task-A')
    await first
    expect(accept.mock.calls).toEqual([['task-B']])
  })

  it('ignores an old failure and stops detail updates when its source disappears', async () => {
    const requests = createLatestRequest()
    const accept = vi.fn()
    const reject = vi.fn()
    let fail: (error: unknown) => void = () => {}
    const first = requests.run(() => new Promise<string>((_resolve, reject) => { fail = reject }), accept, reject)
    await requests.run(async () => 'task-B', accept, reject)
    fail(new Error('task A missing'))
    await first
    expect(reject).not.toHaveBeenCalled()
    const unmounted = requests.run(async () => 'unmounted detail', accept, reject)
    requests.invalidate()
    await unmounted
    expect(accept.mock.calls).toEqual([['task-B']])
  })
})

describe('panel refresh merge (PRD §四.7)', () => {
  it('runs a quiet first request immediately, and overlapping requests share that run', async () => {
    let runs = 0
    const refresh = createMergedRefresh<number>({ mergeMs: 250 })
    const first = refresh.request(async () => {
      runs += 1
      return 1
    })
    const second = refresh.request(async () => {
      runs += 1
      return 2
    })
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1])
    expect(runs).toBe(1)
  })

  it('keeps the window open after the run so a burst is still one Host round-trip', async () => {
    const delayed: (() => void)[] = []
    const refresh = createMergedRefresh<string>({
      mergeMs: 250,
      clock: {
        delay: (fn) => { delayed.push(fn); return delayed.length },
        cancel: () => {},
      },
    })
    let runs = 0
    await expect(refresh.request(async () => {
      runs += 1
      return 'a'
    })).resolves.toBe('a')
    expect(runs).toBe(1)
    expect(delayed).toHaveLength(1)

    await expect(refresh.request(async () => {
      runs += 1
      return 'b'
    })).resolves.toBe('a')
    expect(runs).toBe(1)

    delayed[0]?.()
    await expect(refresh.request(async () => {
      runs += 1
      return 'c'
    })).resolves.toBe('c')
    expect(runs).toBe(2)
  })

  it('still rejects the caller when the run fails, without an unhandled rejection', async () => {
    const refresh = createMergedRefresh<number>({ mergeMs: 250 })
    const first = refresh.request(async () => { throw new Error('the host answered 404') })
    const second = refresh.request(async () => 1)
    await expect(first).rejects.toThrow(/404/)
    await expect(second).rejects.toThrow(/404/)
  })
})
