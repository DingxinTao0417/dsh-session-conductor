import { describe, expect, it } from 'vitest'
import { unreadCountOf, unreadItemsOf, UNREAD_ITEM_LIMIT } from '../src/service/unread.ts'

describe('unread counts (PRD §二.1 未读数量)', () => {
  it('counts only reports that are neither withdrawn nor acknowledged', () => {
    expect(unreadCountOf([
      { withdrawn: false },
      { withdrawn: false, acknowledgedAt: '2026-09-13T01:00:00.000Z' },
      { withdrawn: true },
      { withdrawn: false },
    ])).toBe(2)
  })

  it('is zero for an empty list', () => {
    expect(unreadCountOf([])).toBe(0)
  })

  it('does not treat a missing acknowledgedAt as read', () => {
    expect(unreadCountOf([{ withdrawn: false, acknowledgedAt: undefined }])).toBe(1)
  })

  it('lists the newest unacknowledged reports and skips withdrawn and acked ones', () => {
    const items = unreadItemsOf([
      { notificationId: 'n-new', summary: 'turn ended', createdAt: '2026-09-13T02:00:00.000Z', withdrawn: false },
      { notificationId: 'n-acked', summary: 'old', createdAt: '2026-09-13T01:00:00.000Z', withdrawn: false, acknowledgedAt: '2026-09-13T01:30:00.000Z' },
      { notificationId: 'n-out', summary: 'gone', createdAt: '2026-09-13T00:30:00.000Z', withdrawn: true },
      { notificationId: 'n-older', summary: 'question', createdAt: '2026-09-13T00:00:00.000Z', withdrawn: false },
    ])
    expect(items).toEqual([
      { notificationId: 'n-new', summary: 'turn ended', createdAt: '2026-09-13T02:00:00.000Z' },
      { notificationId: 'n-older', summary: 'question', createdAt: '2026-09-13T00:00:00.000Z' },
    ])
  })

  it('caps the listed unread items without changing the count', () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      notificationId: `n-${String(index)}`,
      summary: `fact ${String(index)}`,
      createdAt: `2026-09-13T00:00:${String(index).padStart(2, '0')}.000Z`,
      withdrawn: false,
    }))
    expect(unreadCountOf(many)).toBe(25)
    expect(unreadItemsOf(many)).toHaveLength(UNREAD_ITEM_LIMIT)
    expect(unreadItemsOf(many)[0]?.notificationId).toBe('n-0')
  })
})
