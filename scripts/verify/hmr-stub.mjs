/**
 * Verification-harness stub that provides an `hmr` service.
 *
 * The CLI launcher, after the tree boots, creates the real
 * `@deepseek-ai/cordis-plugin-hmr` whenever no `hmr` service is mounted. That
 * plugin refuses to construct without `ctx.loader.internal` and the failure
 * takes the whole process down — an unrelated dev-tooling step that would mask
 * the result this harness is measuring. Providing a service under the same key
 * makes the launcher skip it.
 *
 * Test scaffolding: never installed into a real profile.
 */

export const name = 'conductor-verify-hmr-stub'

export function apply(ctx) {
  ctx.provide('hmr', {
    /** Accept and ignore the profile-patch watchers the launcher registers. */
    registerConfig: async () => () => {},
  })
}
