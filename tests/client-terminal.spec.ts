import { describe, expect, it } from 'vitest'
import { appendTerminalOutput, encodeTerminalKey } from '../src/client-terminal.ts'

describe('workspace terminal key encoding', () => {
  it('sends enter, backspace and printable characters without browser shortcuts', () => {
    expect(encodeTerminalKey({ key: 'Enter', ctrlKey: false, metaKey: false, altKey: false })).toBe('\r')
    expect(encodeTerminalKey({ key: 'Backspace', ctrlKey: false, metaKey: false, altKey: false })).toBe('\x7f')
    expect(encodeTerminalKey({ key: 'a', ctrlKey: false, metaKey: false, altKey: false })).toBe('a')
    expect(encodeTerminalKey({ key: 'c', ctrlKey: true, metaKey: false, altKey: false })).toBe('\x03')
    expect(encodeTerminalKey({ key: 'v', ctrlKey: true, metaKey: false, altKey: false })).toBeUndefined()
    expect(encodeTerminalKey({ key: 'c', ctrlKey: false, metaKey: true, altKey: false })).toBeUndefined()
  })
})

describe('workspace terminal output folding', () => {
  it('keeps a PowerShell banner readable and honours carriage return', () => {
    const banner = appendTerminalOutput('', 'Windows PowerShell\nPS D:\\workspace\\app> ')
    expect(banner).toContain('Windows PowerShell')
    expect(appendTerminalOutput(banner, '\rPS D:\\workspace\\app> dir')).toBe('Windows PowerShell\nPS D:\\workspace\\app> dir')
  })
})
