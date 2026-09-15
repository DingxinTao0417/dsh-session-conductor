import { defineConfig } from 'tsdown'
export default defineConfig({
  entry: {'share-service': 'src/share/cli.ts', 'bridge/stdio': 'companions/bridge/stdio.ts'},
  format: 'esm', platform: 'node', target: 'node22', outDir: 'lib', clean: false, dts: false,
  outExtensions: () => ({ js: '.js' }),
  deps: {alwaysBundle: ['zod']},
})
