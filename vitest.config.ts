import { defineConfig } from 'vitest/config'

/**
 * The plugin package is out of tree: it is not a member of the Harness
 * workspace, so it owns its own vitest configuration and `tests/` glob
 * instead of inheriting the repository root config.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    pool: 'forks',
  },
})
