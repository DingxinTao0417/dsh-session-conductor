/**
 * Live conductor configuration (PRD §四.4 并发上限可由用户调整).
 *
 * The composition entry is the base. When the Host mounts `ctx.settings`, the
 * user document sits on top and `current()` reads the resolved value. Host
 * compatibility extensions stay an operator declaration: a settings write that
 * would flip them is refused, because that would claim an extension this
 * process did not install.
 *
 * @module dsh-session-conductor/service/liveconfig
 */

import type { ConductorConfig } from '../config.ts'

/** The settings namespace; kebab-case, matching the plugin's short name. */
export const CONDUCTOR_SETTINGS_NS = 'dsh-session-conductor'

/** Hooks the Host settings helper calls, plus the live read. */
export interface LiveConfigSource {
  /** The currently authoritative config (settings when attached, else the entry). */
  current(): ConductorConfig
  /** Replace the read thunk when settings attach or detach. */
  setSource(current: () => ConductorConfig): void
  /** Re-judge derived facts after a commit. Empty: readers call `current()` live. */
  onChange(): void
  /**
   * Refuse a resolved section that would rewrite Host-extension declarations.
   * @param value - the resolved section, schema-valid by construction.
   */
  validate(value: ConductorConfig): void
}

/**
 * Hold the composition entry and swap in a settings thunk when one exists.
 *
 * @param entry - the validated plugin-row config, used as `base` and as fallback.
 * @returns the live source.
 */
export function createLiveConfig(entry: ConductorConfig): LiveConfigSource {
  let read: () => ConductorConfig = () => entry
  return {
    current: () => read(),
    setSource: (current) => {
      read = current
    },
    onChange: () => {
      // Readers call `current()` at the moment they act. Nothing here is cached.
    },
    validate: (value) => {
      for (const field of ['remoteConnections','bridge','shareServiceUrl','shareTokenEnv','shareCaFile'] as const) {
        if (JSON.stringify(value[field]) !== JSON.stringify(entry[field])) throw new Error(`${field} is operator-owned connection configuration; change the plugin row and restart the Host`)
      }
      if (
        value.hostExtensions.selectModelRememberAsDefault !== entry.hostExtensions.selectModelRememberAsDefault
        || value.hostExtensions.forkTargetParameters !== entry.hostExtensions.forkTargetParameters
      ) {
        throw new Error(
          'hostExtensions are an operator declaration of installed Host compatibility extensions; '
          + 'they cannot be changed from user settings',
        )
      }
    },
  }
}
