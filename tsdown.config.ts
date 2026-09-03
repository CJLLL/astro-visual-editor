import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    // The compiler loads its sibling WASM/binding through package resolution.
    neverBundle: ['@astrojs/compiler'],
    alwaysBundle: [/^magic-string$/u],
  },
})
