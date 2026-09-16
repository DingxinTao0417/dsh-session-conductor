export interface WorkspaceSurface {
  readonly content: HTMLElement
  setOpen(open: boolean): void
  dispose(): void
}

const OPEN = 'data-conductor-workspace-open'
const WIDTH = '--conductor-workspace-width'
const HEADER = '--conductor-workspace-header-height'
const PREFERENCE = 'dsh-session-conductor:workspace:ratio'
const activeOwners = new WeakSet<HTMLElement>()
const clampRatio = (ratio: number): number => Math.min(.8, Math.max(.2, ratio))
const CSS = [
  ':where([data-conductor-workspace-open="true"]){position:relative}',
  '[data-conductor-workspace-open="true"]{box-sizing:border-box;padding-right:var(--conductor-workspace-width,0px)!important}',
  '.conductor-workspace-surface{position:absolute;inset:0 0 0 auto;z-index:20;min-width:0;min-height:0;box-sizing:border-box;isolation:isolate;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,inherit);border-left:1px solid color-mix(in srgb,currentColor 10%,transparent)}',
  '.conductor-workspace-content{width:100%;height:100%;min-width:0;min-height:0;overflow:hidden}',
  '.conductor-workspace-separator{position:absolute;top:0;bottom:0;left:-4px;width:8px;z-index:2;cursor:col-resize;touch-action:none;outline:none}',
  '.conductor-workspace-separator:hover,.conductor-workspace-separator:focus-visible,.conductor-workspace-surface[data-dragging]>.conductor-workspace-separator{background:color-mix(in srgb,currentColor 15%,transparent)}',
  '.conductor-workspace-surface[data-floating]{z-index:1000}',
].join('')

/**
 * Bottom edge of the host header's visible divider. Desktop 2.0.3 draws it as
 * a 1px absolutely positioned `header::after` sitting above the box edge (the
 * box border itself is transparent). Fall back to the header box bottom when
 * no such line is present, so other Hosts still get a sensible alignment.
 */
export function headerDividerBottom(header: Element, viewport: Pick<Window, 'getComputedStyle'>): number {
  const rect = header.getBoundingClientRect()
  try {
    const after = viewport.getComputedStyle(header, '::after')
    const height = parseFloat(after.height), top = parseFloat(after.top)
    const painted = typeof after.backgroundColor === 'string' && after.backgroundColor !== '' && after.backgroundColor !== 'transparent' && after.backgroundColor !== 'rgba(0, 0, 0, 0)'
    if (after.content !== undefined && after.content !== 'none' && after.position === 'absolute' && height > 0 && height <= 2 && Number.isFinite(top) && painted) {
      const borderTop = parseFloat(viewport.getComputedStyle(header).borderTopWidth) || 0
      const bottom = rect.top + borderTop + top + height
      if (bottom > rect.top && bottom <= rect.bottom + .5) return bottom
    }
  } catch { /* Pseudo-element styles are optional in other renderers. */ }
  return rect.bottom
}

/** Mount only plugin-owned DOM beside the public conversation header slot. */
export function mountWorkspaceSurface(anchor: HTMLElement): WorkspaceSurface | undefined {
  const document = anchor.ownerDocument, viewport = document.defaultView
  const header = anchor.closest('header')
  if (!viewport || !header) return undefined
  let candidate = header.parentElement
  while (candidate && candidate !== document.body) {
    const computed = viewport.getComputedStyle(candidate)
    if (computed.display === 'flex' && computed.flexDirection === 'column' && candidate.getBoundingClientRect().height > 200) break
    candidate = candidate.parentElement
  }
  if (!candidate || candidate === document.body || activeOwners.has(candidate)) return undefined
  const owner = candidate, application = anchor.closest('#root')
  activeOwners.add(owner)
  const priorOpen = owner.getAttribute(OPEN), priorWidth = owner.style.getPropertyValue(WIDTH), priorPriority = owner.style.getPropertyPriority(WIDTH)
  const priorHeader = owner.style.getPropertyValue(HEADER), priorHeaderPriority = owner.style.getPropertyPriority(HEADER)
  const surface = document.createElement('div'), content = document.createElement('div'), separator = document.createElement('div'), style = document.createElement('style')
  surface.className = 'conductor-workspace-surface'
  content.className = 'conductor-workspace-content'
  separator.className = 'conductor-workspace-separator'
  separator.tabIndex = 0
  separator.setAttribute('role', 'separator')
  separator.setAttribute('aria-orientation', 'vertical')
  separator.setAttribute('aria-label', '调整聊天与工作区宽度')
  separator.setAttribute('aria-description', '按左右方向键调整宽度，Home 恢复默认比例')
  style.textContent = CSS
  surface.append(separator, content)
  surface.style.display = 'none'
  owner.append(surface)
  document.head.append(style)
  let ratio = .7, open = false, disposed = false, floating = false, paneWidth = 0
  let drag: { pointer: number; ratio: number } | undefined
  try {
    const saved = viewport.localStorage.getItem(PREFERENCE)
    if (saved !== null && saved.trim() && Number.isFinite(Number(saved)) && Number(saved) >= .2 && Number(saved) <= .8) ratio = Number(saved)
  } catch { /* Storage is optional, including sandboxed browser environments. */ }
  const restore = (): void => {
    if (priorOpen === null) owner.removeAttribute(OPEN); else owner.setAttribute(OPEN, priorOpen)
    if (priorWidth) owner.style.setProperty(WIDTH, priorWidth, priorPriority); else owner.style.removeProperty(WIDTH)
    if (priorHeader) owner.style.setProperty(HEADER, priorHeader, priorHeaderPriority); else owner.style.removeProperty(HEADER)
  }
  const save = (): void => { try { viewport.localStorage.setItem(PREFERENCE, String(ratio)) } catch { /* Optional preference. */ } }
  const endDrag = (commit: boolean): void => {
    if (!drag) return
    const previous = drag
    drag = undefined
    surface.removeAttribute('data-dragging')
    if (commit) save(); else ratio = previous.ratio
    try { separator.releasePointerCapture(previous.pointer) } catch { /* Capture may already be lost. */ }
  }
  const update = (): void => {
    if (disposed || !open) return
    const width = owner.clientWidth
    floating = width < 740
    if (floating && drag) endDrag(false)
    owner.setAttribute(OPEN, 'true')
    surface.style.display = 'flex'
    separator.style.display = floating ? 'none' : ''
    if (floating) {
      if (surface.parentElement !== document.body) document.body.append(surface)
      const bounds = application?.getBoundingClientRect(), height = viewport.innerHeight
      const valid = bounds && bounds.bottom > bounds.top
      const top = valid ? Math.min(height, Math.max(0, bounds.top)) : 0
      const bottom = valid ? Math.min(height - top, Math.max(0, height - bounds.bottom)) : 0
      surface.setAttribute('data-floating', '')
      surface.style.position = 'fixed'
      surface.style.top = String(top) + 'px'
      surface.style.bottom = String(bottom) + 'px'
      surface.style.width = String(viewport.innerWidth) + 'px'
      owner.style.setProperty(WIDTH, '0px')
      // The drawer has no host header beside it; use a compact single-row bar.
      owner.style.setProperty(HEADER, '44px')
      surface.style.setProperty(HEADER, '44px')
    } else {
      if (surface.parentElement !== owner) owner.append(surface)
      paneWidth = Math.min(width - 320, Math.max(300, width * ratio))
      surface.removeAttribute('data-floating')
      surface.style.position = 'absolute'
      // Full-height pane beside the chat. Publish the distance from the owner
      // top to the host header's visible divider, so the workspace tab row's
      // own divider lands on the same pixel row as the host tabs line.
      const headerHeight = Math.max(0, Math.round((headerDividerBottom(header, viewport) - owner.getBoundingClientRect().top) * 100) / 100)
      surface.style.top = '0px'
      surface.style.bottom = '0px'
      surface.style.width = String(paneWidth) + 'px'
      owner.style.setProperty(WIDTH, String(paneWidth) + 'px')
      owner.style.setProperty(HEADER, String(headerHeight) + 'px')
      surface.style.setProperty(HEADER, String(headerHeight) + 'px')
      separator.setAttribute('aria-valuemin', String(Math.round(Math.max(300, width * .2) / width * 100)))
      separator.setAttribute('aria-valuemax', String(Math.round(Math.min(width - 320, width * .8) / width * 100)))
      separator.setAttribute('aria-valuenow', String(Math.round(paneWidth / width * 100)))
      separator.setAttribute('aria-valuetext', '工作区 ' + String(Math.round(paneWidth / width * 100)) + '%')
    }
  }
  const pointerDown = (event: PointerEvent): void => {
    if (disposed || !open || floating || drag || event.button !== 0 || event.isPrimary === false) return
    try { separator.setPointerCapture(event.pointerId) } catch { return }
    drag = { pointer: event.pointerId, ratio }
    surface.setAttribute('data-dragging', '')
    separator.focus({ preventScroll: true })
    event.preventDefault()
  }
  const pointerMove = (event: PointerEvent): void => {
    if (!drag || drag.pointer !== event.pointerId || !Number.isFinite(event.clientX)) return
    const bounds = owner.getBoundingClientRect()
    if (bounds.width <= 0) return
    ratio = clampRatio((bounds.right - event.clientX) / bounds.width)
    update()
    event.preventDefault()
  }
  const pointerUp = (event: PointerEvent): void => { if (drag?.pointer === event.pointerId) { endDrag(true); update() } }
  const pointerCancel = (event: PointerEvent): void => { if (drag?.pointer === event.pointerId) { endDrag(false); update() } }
  const keyDown = (event: KeyboardEvent): void => {
    if (disposed || !open || floating || !['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
    ratio = event.key === 'Home' ? .7 : clampRatio((paneWidth + (event.key === 'ArrowLeft' ? 24 : -24)) / owner.clientWidth)
    update(); save(); event.preventDefault(); event.stopPropagation()
  }
  separator.addEventListener('pointerdown', pointerDown)
  separator.addEventListener('pointermove', pointerMove)
  separator.addEventListener('pointerup', pointerUp)
  separator.addEventListener('pointercancel', pointerCancel)
  separator.addEventListener('lostpointercapture', pointerCancel)
  separator.addEventListener('keydown', keyDown)
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
  observer?.observe(owner)
  observer?.observe(header)
  if (application) observer?.observe(application)
  viewport.addEventListener('resize', update)
  return {
    content,
    setOpen(value) {
      if (disposed) return
      open = value
      if (open) update()
      else { endDrag(false); surface.style.display = 'none'; restore() }
    },
    dispose() {
      if (disposed) return
      disposed = true; open = false; endDrag(false)
      observer?.disconnect(); viewport.removeEventListener('resize', update)
      separator.removeEventListener('pointerdown', pointerDown)
      separator.removeEventListener('pointermove', pointerMove)
      separator.removeEventListener('pointerup', pointerUp)
      separator.removeEventListener('pointercancel', pointerCancel)
      separator.removeEventListener('lostpointercapture', pointerCancel)
      separator.removeEventListener('keydown', keyDown)
      surface.remove(); style.remove(); restore(); activeOwners.delete(owner)
    },
  }
}
