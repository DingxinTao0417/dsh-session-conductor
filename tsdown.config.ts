import { defineConfig } from 'tsdown'

/**
 * Host-half build.
 *
 * The plugin is installed out of tree, so the emitted entry must be a
 * self-contained ESM module with the plain `.js`/`.d.ts` names that
 * `package.json` advertises: Node resolves it from the profile's
 * `node_modules`, and the Host packages it imports stay external because the
 * Host already has them loaded. They are declared as peerDependencies, and the
 * packaged desktop runtime resolves a profile plugin's bare imports from its
 * own installation when the profile carries no copy of its own.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: true,
  sourcemap: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  deps: {
    neverBundle: [/^@deepseek-ai\//],
  },
})
