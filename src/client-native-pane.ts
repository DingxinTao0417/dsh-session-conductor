/**
 * Read-only compatibility observation of Desktop 2.0.3's AppFrame geometry.
 * This is actual visibility, not the private layout store's open preference:
 * the Host may keep details mounted but collapse its grid track to zero.
 */
export function observeNativePane(anchor: HTMLElement, publish: (visible: boolean) => void): () => void {
  const viewport = anchor.ownerDocument.defaultView
  if (!viewport) { publish(false); return () => {} }
  let stopped = false, previous: boolean | undefined
  let observed: readonly HTMLElement[] = []
  const ancestors = (): HTMLElement[] => {
    const result: HTMLElement[] = []
    for (let current: HTMLElement | null = anchor; current; current = current.parentElement) result.push(current)
    return result
  }
  const hidden = (element: HTMLElement): boolean => {
    const style = viewport.getComputedStyle(element)
    return Boolean(element.hidden) || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
  }
  const find = (chain: readonly HTMLElement[]): { frame: HTMLElement; details: HTMLElement } | undefined => {
    for (const frame of chain.slice(1)) {
      const style = viewport.getComputedStyle(frame)
      // Computed grid tracks are resolved px lengths. Fail closed for another
      // renderer, an unmeasured frame, or a changed Host column contract.
      if (style.display !== 'grid' || !/^\s*\d+(?:\.\d+)?px\s+\d+(?:\.\d+)?px\s+\d+(?:\.\d+)?px\s*$/.test(style.gridTemplateColumns)) continue
      const columns = Array.from(frame.children)
      const center = columns[1], details = columns[2], overlay = columns[3]
      // AppFrame's first three direct children are sidebar, conversation and
      // details; its fourth is the public shell.overlay carrier. Neither a
      // hashed CSS class nor an arbitrary gap to the viewport identifies it.
      if (!center?.contains(anchor) || !details || !overlay?.hasAttribute('data-shell-overlay')) continue
      if (details.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue
      return { frame, details: details as HTMLElement }
    }
    return undefined
  }
  const update = (): void => {
    if (stopped) return
    let visible = false
    const chain = ancestors()
    let details: HTMLElement | undefined
    try {
      const match = anchor.isConnected ? find(chain) : undefined
      details = match?.details
      if (match && details?.isConnected && !match.frame.hasAttribute('data-details-collapsed') && !hidden(match.frame) && !hidden(details)) {
        const bounds = details.getBoundingClientRect()
        visible = bounds.width > 80 && bounds.height > 0
      }
    } catch { /* A detached or unsupported renderer is not an open native pane. */ }
    const next = details ? [...chain, details] : chain
    if (next.length !== observed.length || next.some((element, index) => element !== observed[index])) {
      resize?.disconnect(); mutation?.disconnect(); observed = next
      for (const element of observed) {
        resize?.observe(element)
        mutation?.observe(element, { attributes: true, attributeFilter: ['data-details-collapsed', 'hidden', 'style', 'class'], childList: true })
      }
    }
    if (previous !== visible) { previous = visible; publish(visible) }
  }
  const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
  const mutation = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(update)
  viewport.addEventListener('resize', update)
  update()
  return () => {
    if (stopped) return
    stopped = true; resize?.disconnect(); mutation?.disconnect()
    viewport.removeEventListener('resize', update); observed = []
  }
}
