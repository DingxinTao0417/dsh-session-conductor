import { defineConfig } from 'tsdown'

/**
 * Client-half build: the browser bundle in the shell's closure-factory format.
 *
 * The shape of this config is not a guess. It is the contract the web shell loads
 * plugins with, read from the Host's own client build preset
 * (`packages/client/tsdown.client.ts` at the pinned baseline) and from its platform
 * module list (`packages/client/web/src/platform.ts`). Neither is a published package, so
 * the contract is reproduced here rather than imported — and every value that matters is
 * copied deliberately:
 *
 * - **`format: 'cjs'` with a banner/footer wrapper.** The artifact is not an ES module;
 *   it is a factory the loader calls with a `require` bound to the frozen module table.
 * - **`platform: 'browser'`, `clean: false`.** The bundle lands next to the Host half in
 *   `lib/`, so a default clean would wipe `lib/index.js`.
 * - **Externals come from the platform table**, and everything else is inlined. A
 *   `require()` the table cannot answer is a guaranteed runtime throw, which is why the
 *   rule is the table itself rather than an opinion about each dependency.
 * - **The `define` substitutions** exist because inlined browser libraries probe
 *   `process.env.NODE_ENV` and `import.meta.env.MODE`, and a CJS output cannot carry an
 *   `import.meta` — without them the factory throws at boot.
 *
 * A purity gate is deliberately **not** reproduced. The Host's rejects any cross-plugin
 * value import, which is a workspace-wide invariant; this plugin uses only client
 * imports (React and native UI primitives, both platform modules), so the gate would have nothing else to
 * enforce. That is recorded in `docs/host-api-notes.md` rather than left implicit.
 */

/** The module specifiers the shell shares through its frozen module table. */
const PLATFORM_MODULES: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

const id = 'dsh-session-conductor'

export default defineConfig({
  name: `${id}/client`,
  entry: { client: 'src/client-navigation.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  // Types ship from the Host half's own dts pass; dts here would wrap the banner and
  // footer into the declaration output and break its parsing.
  dts: false,
  sourcemap: true,
  // Must stay false: the Host half is emitted into the same directory.
  clean: false,
  deps: {
    neverBundle: [...PLATFORM_MODULES],
    alwaysBundle: (moduleId: string) => (PLATFORM_MODULES.includes(moduleId) ? undefined : true),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env['NODE_ENV'] ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env['NODE_ENV'] ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env['NODE_ENV'] ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
