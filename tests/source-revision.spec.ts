import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dshSourceAnnotationsPlugin } from '../src/index.ts'

describe('source revision evidence', () => {
  it('stamps all literal nodes with the original file digest and changes it after edits', async () => {
    const plugin = dshSourceAnnotationsPlugin(resolve('site'))
    const hook = plugin.transform!
    const transform = typeof hook === 'function' ? hook : hook.handler
    const source = '<header><span>{model.title}</span></header>'
    const first = await transform(source, resolve('site/src/Header.astro'))
    const digest = createHash('sha256').update(source).digest('hex')
    expect(first!.code.match(new RegExp(`data-dsh-source-hash="${digest}"`, 'gu'))).toHaveLength(2)
    const second = await transform(source.replace('model.title', 'other.title'), resolve('site/src/Header.astro'))
    expect(second!.code).not.toContain(digest)
    expect(first!.code).toContain('{model.title}')
  })
})
