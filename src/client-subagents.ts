import { createElement as h, useEffect, useState, type ReactElement } from 'react'
import { IconBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SubagentsPort, SubagentsRead } from './client-subagents-data.ts'

const CSS = [
  '.conductor-subagents-summary{min-width:0}.conductor-subagents-summary>button{width:100%;text-align:left;padding:7px 8px;margin:0 -8px;box-sizing:content-box}.conductor-subagents-summary strong{display:block;font-size:15px;font-weight:550;color:var(--dsw-alias-label-secondary,#999);margin-bottom:10px}.conductor-subagents-counts{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px}.conductor-subagents-counts>span:last-child{margin-left:auto;color:var(--dsw-alias-label-secondary,#999)}',
  '.conductor-subagents{width:100%;max-width:820px;margin:0 auto;font-size:14px}.conductor-subagents-group{margin:10px 0 28px}.conductor-subagents-group h3{font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary,#999);margin:12px 8px}.conductor-subagents-list{list-style:none!important;margin:0!important;padding:0!important}.conductor-subagents-list>li{margin:3px 0!important}.conductor-subagent-row{display:flex!important;align-items:flex-start;gap:12px;min-width:0;width:100%;padding:14px 10px!important;border-radius:10px;text-align:left}.conductor-subagent-row:hover,.conductor-subagent-row:focus-visible{background:color-mix(in srgb,currentColor 8%,transparent)!important}.conductor-subagent-row:disabled{cursor:default;opacity:.6}.conductor-subagent-icon{flex-shrink:0;padding-top:2px}.conductor-subagent-copy{flex:1;min-width:0}.conductor-subagent-title{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}.conductor-subagent-status{display:block;margin-top:3px;color:var(--dsw-alias-label-secondary,#999);font-size:12px}.conductor-subagent-time{font-size:12px;white-space:nowrap;flex-shrink:0;color:var(--dsw-alias-label-secondary,#999)}.conductor-subagents-more{margin:8px 0 0 34px}.conductor-subagents-note{font-size:12px;color:var(--dsw-alias-label-secondary,#999);line-height:1.6}.conductor-subagents-error{font-size:13px;overflow-wrap:anywhere}.conductor-subagents-actions{display:flex;align-items:center;gap:8px;justify-content:space-between;margin-bottom:16px}',
].join('')

export function useSubagents(port: SubagentsPort, parentId: string): SubagentsRead {
  const [read, setRead] = useState(() => port.getSnapshot(parentId))
  useEffect(() => port.subscribe(parentId, setRead), [port, parentId])
  return read.parentId === parentId ? read : port.getSnapshot(parentId)
}

export function SubagentsSummary(props: { port: SubagentsPort; parentId: string; open(): void }): ReactElement {
  const read = useSubagents(props.port, props.parentId)
  const running = read.items.filter(item => item.activity === 'running').length
  const inactive = read.items.filter(item => item.activity === 'inactive').length
  const unavailable = read.items.length - running - inactive
  return h('div', { className: 'conductor-overview-section conductor-subagents-summary' }, [
    h('style', { key: 'style' }, CSS),
    h('button', { key: 'button', type: 'button', onClick: props.open, title: '在右侧查看子智能体', 'aria-label': '查看子智能体' }, [
      h('strong', { key: 'title' }, '子智能体'),
      h('span', { key: 'counts', className: 'conductor-subagents-counts' }, [
        h(IconBranchOutline16, { key: 'icon' }),
        read.state === 'ready' ? h('span', { key: 'running' }, String(running) + ' 个运行中') : h('span', { key: 'state' }, read.state === 'loading' ? '正在读取…' : '暂不可用'),
        read.state === 'ready' ? h('span', { key: 'inactive' }, String(inactive) + ' 已结束 / 空闲') : null,
      ]),
      unavailable > 0 && read.state === 'ready' ? h('span', { key: 'unavailable', className: 'conductor-subagent-status' }, String(unavailable) + ' 个记录不可用') : null,
    ]),
  ])
}

export function subagentDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined
  const seconds = Math.floor(ms / 1000), minutes = Math.floor(seconds / 60)
  return minutes >= 60 ? String(Math.floor(minutes / 60)) + 'h ' + String(minutes % 60) + 'm'
    : minutes > 0 ? String(minutes) + 'm ' + String(seconds % 60) + 's' : String(seconds) + 's'
}

function color(id: string): string {
  const colors = ['#55ad9c', '#729f4a', '#629bae', '#b785b2', '#bd9452']
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return colors[hash % colors.length]!
}

export function SubagentsView(props: { port: SubagentsPort; parentId: string }): ReactElement {
  const read = useSubagents(props.port, props.parentId)
  const [error, setError] = useState(''), [refreshing, setRefreshing] = useState(false)
  const [limits, setLimits] = useState({ running: 10, inactive: 10, unavailable: 10 })
  const group = (activity: 'running' | 'inactive' | 'unavailable', title: string): ReactElement | null => {
    const items = read.items.filter(item => item.activity === activity)
    if (!items.length) return null
    const limit = limits[activity]
    return h('section', { key: activity, className: 'conductor-subagents-group', 'aria-label': title }, [
      h('h3', { key: 'title' }, title + ' · ' + String(items.length)),
      h('ul', { key: 'list', className: 'conductor-subagents-list' }, items.slice(0, limit).map(item => {
        const duration = subagentDuration(item.durationMs)
        return h('li', { key: item.id }, h('button', { type: 'button', className: 'conductor-subagent-row', disabled: activity === 'unavailable' || read.state !== 'ready',
          title: item.title, onClick: () => {
            setError('')
            void Promise.resolve().then(() => props.port.open(props.parentId, item.id)).catch(cause => setError(cause instanceof Error ? cause.message : '无法打开子智能体。'))
          } }, [
          h('span', { key: 'icon', className: 'conductor-subagent-icon', style: { color: color(item.id) } }, h(IconBranchOutline16)),
          h('span', { key: 'copy', className: 'conductor-subagent-copy' }, [h('span', { key: 'title', className: 'conductor-subagent-title' }, item.title), h('span', { key: 'status', className: 'conductor-subagent-status' }, item.statusLabel)]),
          duration ? h('span', { key: 'time', className: 'conductor-subagent-time', title: '累计执行时间' }, duration) : null,
        ]))
      })),
      items.length > limit ? h('button', { key: 'more', type: 'button', className: 'conductor-subagents-more', onClick: () => setLimits(value => ({ ...value, [activity]: value[activity] + 30 })) }, '再显示 ' + String(Math.min(30, items.length - limit)) + ' 个') : null,
    ])
  }
  return h('div', { className: 'conductor-subagents' }, [
    h('style', { key: 'style' }, CSS),
    h('div', { key: 'actions', className: 'conductor-subagents-actions' }, [
      h('span', { key: 'scope', className: 'conductor-subagents-note' }, '当前会话直接创建的原生子智能体'),
      h('button', { key: 'refresh', type: 'button', disabled: refreshing || read.state === 'unavailable', onClick: () => {
        setRefreshing(true); setError('')
        void props.port.refresh(props.parentId).catch(cause => setError(cause instanceof Error ? cause.message : '刷新未完成。')).finally(() => setRefreshing(false))
      } }, refreshing ? '刷新中…' : '刷新'),
    ]),
    read.state !== 'ready' || read.error ? h('p', { key: 'state', role: 'status', className: 'conductor-subagents-error' }, read.error ?? (read.state === 'loading' ? '正在读取子智能体…' : '当前宿主无法读取原生子智能体。')) : null,
    error ? h('p', { key: 'error', role: 'status', className: 'conductor-subagents-error' }, error) : null,
    read.state === 'ready' && !read.items.length ? h('p', { key: 'empty', className: 'conductor-subagents-note' }, '这个会话还没有原生子智能体。独立创建的聊天位于概览的“委派任务”。') : null,
    group('running', '运行中'), group('inactive', '已结束 / 空闲'), group('unavailable', '记录不可用'),
    h('p', { key: 'note', className: 'conductor-subagents-note' }, '“已结束 / 空闲”仅表示当前未运行，不代表成功完成。这里只显示宿主状态与可用的累计执行时间；点击条目打开原生会话记录。'),
  ])
}
