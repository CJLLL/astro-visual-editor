import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  astroVisualEditor,
  byteOffsetsToUtf16Indexes,
  buildBootstrap,
  DSH_ATOMIC_WRITE_WATCH_IGNORES,
  dshSourceAnnotationsPlugin,
  escapeAttribute,
  isCompiledAstroOutput,
  isPrimaryAstroRequest,
  toProjectRelative,
} from '../src/index.ts'

async function runTransform(plugin: ReturnType<typeof dshSourceAnnotationsPlugin>, code: string, id: string): Promise<{ code: string; map?: unknown } | null> {
  const transform = plugin.transform
  if (transform === undefined) return null
  return typeof transform === 'function'
    ? await transform(code, id)
    : await transform.handler(code, id)
}

describe('Astro source annotations', () => {
  it('escapes HTML-significant attribute characters', () => {
    expect(escapeAttribute('a&b<c>d"e')).toBe('a&amp;b&lt;c&gt;d&quot;e')
  })

  it('maps UTF-8 byte offsets to UTF-16 indices', () => {
    const indexes = byteOffsetsToUtf16Indexes('é<div>', [3])
    expect(indexes.get(3)).toBe(2)
  })

  it('accepts primary Astro modules only', () => {
    expect(isPrimaryAstroRequest('/proj/src/pages/index.astro')).toBe(true)
    expect(isPrimaryAstroRequest('/proj/src/x.astro?astro&type=script')).toBe(false)
    expect(isPrimaryAstroRequest('/proj/src/x.tsx')).toBe(false)
  })

  it('recognizes generated SSR JavaScript without rejecting markup', () => {
    expect(isCompiledAstroOutput('import "astro/runtime/server"; const page = ($$result) => $$render`<main />`')).toBe(true)
    expect(isCompiledAstroOutput('"default": ($$result) => $$render`${$$maybeRenderHead($$result)}<main />`')).toBe(true)
    expect(isCompiledAstroOutput('<main>{value}</main>')).toBe(false)
  })

  it('returns a forward-slash project-relative path', () => {
    const root = resolve('proj')
    expect(toProjectRelative(root, resolve('proj/src/pages/index.astro'))).toBe('src/pages/index.astro')
  })

  it('injects source markers into literal Astro elements', async () => {
    const root = resolve('proj')
    const id = resolve('proj/src/pages/index.astro')
    const result = await runTransform(dshSourceAnnotationsPlugin(root), '<div class="hero"><p>Hello</p></div>', id)
    expect(result?.code).toContain('<div data-dsh-source-file="src/pages/index.astro"')
    expect(result?.code).toContain('data-dsh-source-loc="1:')
  })

  it('injects source markers before dynamic Astro attributes', async () => {
    const root = resolve('proj')
    const id = resolve('proj/src/pages/product.astro')
    const result = await runTransform(dshSourceAnnotationsPlugin(root), '<img src={featuredImage} alt="Product" />', id)
    expect(result?.code).toContain('<img data-dsh-source-file="src/pages/product.astro"')
    expect(result?.code).toContain('src={featuredImage}')
  })

  it('runs before Astro compilation and refuses generated SSR modules', async () => {
    const root = resolve('proj')
    const id = resolve('proj/src/pages/product.astro')
    const plugin = dshSourceAnnotationsPlugin(root)
    expect(typeof plugin.transform).toBe('object')
    expect(typeof plugin.transform === 'object' ? plugin.transform.order : undefined).toBe('pre')
    const compiled = 'import "astro/runtime/server"; const page = ($$result) => $$render`<img${$$addAttribute(image, "src")}>`'
    expect(await runTransform(plugin, compiled, id)).toBeNull()
  })

  it('refuses generated Astro 7 HMR output', async () => {
    const root = resolve('proj')
    const id = resolve('proj/src/pages/product.astro')
    const compiled = '"default": ($$result) => $$render`${$$maybeRenderHead($$result)}<main><img${$$addAttribute(image, "src")}></main>`'
    expect(await runTransform(dshSourceAnnotationsPlugin(root), compiled, id)).toBeNull()
  })

  it('skips non-Astro modules', async () => {
    const result = await runTransform(dshSourceAnnotationsPlugin(resolve('proj')), 'export const x = 1', resolve('proj/src/lib.ts'))
    expect(result).toBeNull()
  })
})

describe('visual editor bootstrap', () => {
  it('loads the picker only for an explicit editor URL or editor iframe', () => {
    const script = buildBootstrap({ projectRoot: 'C:\\site', host: 'http://127.0.0.1:43120' }, 'site')
    expect(script).toContain('get("dsh-visual-editor") === "1"')
    expect(script).toContain('window.name === "dsh-visual-editor"')
    expect(script).toContain('if (!editorQuery && !editorFrame) return;')
  })

  it('ignores short-lived atomic edit directories in the Astro watcher', () => {
    expect(DSH_ATOMIC_WRITE_WATCH_IGNORES).toEqual([
      '**/.*.tmpdir',
      '**/.*.tmpdir/**',
    ])
  })

  it('adds the atomic edit ignores to the development server config', () => {
    let updatedConfig: unknown
    const setup = astroVisualEditor({ projectRoot: resolve('proj') }).hooks['astro:config:setup']
    setup?.({
      command: 'dev',
      config: {},
      updateConfig(config: unknown) { updatedConfig = config },
      injectScript() {},
    } as never)
    expect(updatedConfig).toMatchObject({
      vite: { server: { watch: { ignored: [...DSH_ATOMIC_WRITE_WATCH_IGNORES] } } },
    })
  })
})
