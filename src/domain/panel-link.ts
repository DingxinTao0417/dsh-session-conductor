/**
 * Whether a panel snapshot is live or a leftover (PRD §四.5 网络中断).
 *
 * A failed refresh after a successful one must keep the last cards and mark
 * them disconnected. Replacing them with an empty list would read as "no work";
 * leaving them unlabelled would present old values as the latest facts.
 *
 * @module dsh-session-conductor/domain/panel-link
 */

/** How the panel relates to the Host right now. */
export type PanelLink = 'live' | 'disconnected' | 'unavailable'

/** The list view after a fetch, successful or not. */
export interface PanelListView<T> {
  readonly items: readonly T[] | undefined
  readonly error?: string | undefined
  readonly link: PanelLink
}

/**
 * Fold one list fetch into the view the panel already holds.
 *
 * @param previous - the cards currently shown, if any.
 * @param result - this fetch.
 * @returns the next view.
 */
export function applyPanelListResult<T>(
  previous: { readonly items: readonly T[] | undefined },
  result: { readonly ok: true; readonly items: readonly T[] } | { readonly ok: false; readonly error: string },
): PanelListView<T> {
  if (result.ok) return { items: result.items, link: 'live' }
  if (previous.items !== undefined) {
    return { items: previous.items, error: result.error, link: 'disconnected' }
  }
  return { items: undefined, error: result.error, link: 'unavailable' }
}

/**
 * The sentence that stops a leftover snapshot being read as live.
 *
 * @param view - the folded view.
 * @returns the note, when one must be shown.
 */
export function panelLinkNote<T>(view: PanelListView<T>): string | undefined {
  if (view.link === 'disconnected') {
    return `the panel is disconnected (${view.error ?? 'the host could not be reached'}); `
      + 'the cards below are the last snapshot, not a live reading'
  }
  return undefined
}
