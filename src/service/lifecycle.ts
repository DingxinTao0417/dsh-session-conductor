/**
 * Plugin enablement (PRD §四.5 插件停用).
 *
 * Stopping the plugin must stop **new scheduling and reports** and keep tasks,
 * artifacts and data. The background timer already refuses to re-arm after
 * `stop()`, but an in-flight pass — and any tool that is the same automatic
 * path — could still tick a schedule, deliver a notice, fire a rule or flush a
 * pending send. {@link PluginLifecycle} is the flag those paths consult: once
 * `disable()` has been called it never becomes active again on this instance.
 * A later mount is a new instance.
 *
 * User-initiated send, stop, list and read are not "调度" and are not gated
 * here. The Host typically unregisters tools on teardown anyway.
 *
 * @module dsh-session-conductor/service/lifecycle
 */

/** One-line account a stopped background pass returns. */
export const PLUGIN_DISABLED_ACCOUNT =
  'plugin disabled: new scheduling and reports stopped; tasks, artifacts and data are kept'

/**
 * Whether this plugin instance may start new automatic work.
 */
export class PluginLifecycle {
  private activeValue = true

  /** Whether new scheduling and reports may still be started. */
  get active(): boolean {
    return this.activeValue
  }

  /**
   * Stop new scheduling and reports. Idempotent and final for this instance.
   */
  disable(): void {
    this.activeValue = false
  }

  /**
   * Reason to refuse one automatic activity, when disabled.
   *
   * @param activity - what would have been started.
   * @returns the reason, or undefined while the plugin is active.
   */
  refusal(activity: string): string | undefined {
    if (this.activeValue) return undefined
    return `the plugin is disabled, so ${activity} is not started; tasks, artifacts and data are kept`
  }
}
