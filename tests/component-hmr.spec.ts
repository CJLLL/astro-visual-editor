import { once } from 'node:events'
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dev as defaultDev } from 'astro'
import type { AstroIntegration } from 'astro'
import { describe, expect, it, vi } from 'vitest'
import { astroVisualEditor } from '../src/index.ts'

interface HotMessage {
  type: string
  err?: { message: string }
}

function nextMessage(socket: WebSocket, type: string): Promise<HotMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('message', listener)
      reject(new Error(`No ${type} after component edit`))
    }, 10_000)
    function listener(event: MessageEvent): void {
      const message = JSON.parse(String(event.data)) as HotMessage
      if (message.type !== type) return
      clearTimeout(timer)
      socket.removeEventListener('message', listener)
      resolve(message)
    }
    socket.addEventListener('message', listener)
  })
}

// Allows the same regression to run against an existing site's installed Astro.
const dependencies = process.env.HMR_TEST_NODE_MODULES ?? fileURLToPath(new URL('../node_modules', import.meta.url))
const dev: typeof defaultDev = process.env.HMR_TEST_NODE_MODULES === undefined ? defaultDev : (await import(pathToFileURL(join(dependencies, 'astro/dist/index.js')).href)).dev

describe('shared component HTML hot updates', () => {
  it.each([false, true])('updates both pages and recovers from render errors (scoped CSS=%s)', async scopedCss => {
    const root = await mkdtemp(join(tmpdir(), 'shared-component-hmr-'))
    const cwd = process.cwd()
    let server: Awaited<ReturnType<typeof dev>> | undefined
    let socket: WebSocket | undefined
    try {
      await symlink(dependencies, join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
      for (const directory of ['components', 'layouts', 'pages']) await mkdir(join(root, 'src', directory), { recursive: true })
      const header = join(root, 'src/components/Header.astro')
      const source = '---\nconst { model } = Astro.props;\n---\n<header>HEADER_ONE {model.title}</header>'
        + (scopedCss ? '\n<style>header {color: blue}</style>' : '')
      await writeFile(header, source)
      await writeFile(join(root, 'src/components/Footer.astro'), '<footer>Footer</footer>')
      await writeFile(join(root, 'src/layouts/Layout.astro'), '---\nimport Header from "../components/Header.astro";\nimport Footer from "../components/Footer.astro";\nconst { title } = Astro.props;\n---\n<html><head></head><body><Header model={{title}}/><slot/><Footer/></body></html>')
      for (const page of ['index', 'contact']) await writeFile(join(root, `src/pages/${page}.astro`), `---\nimport Layout from "../layouts/Layout.astro";\n---\n<Layout title="${page}"><p>${page}</p></Layout>`)
      process.chdir(root)
      vi.stubEnv('NODE_ENV', 'development')
      vi.stubEnv('ASTRO_TELEMETRY_DISABLED', '1')
      vi.stubEnv('ASTRO_DEV_BACKGROUND', '1')
      vi.stubEnv('VITEST', undefined)
      server = await dev({ root, configFile: false, logLevel: 'silent', devToolbar: { enabled: false },
        integrations: [astroVisualEditor({ projectRoot: root }) as AstroIntegration],
        server: { host: '127.0.0.1', port: 0, open: false }, vite: { cacheDir: join(root, 'vite-cache') },
      })
      const origin = `http://127.0.0.1:${server.address.port}`
      // Consume and verify the body: a streaming render can return 200 before
      // a component throws and reports its error over the HMR connection.
      const html = async (route: string) => (await fetch(origin + route, { headers: { accept: 'text/html' } })).text()
      for (const route of ['/', '/contact/']) expect(await html(route)).toContain('HEADER_ONE')
      if (scopedCss) await (await fetch(`${origin}/src/components/Header.astro?astro&type=style&index=0&lang.css`)).text()
      const client = await (await fetch(`${origin}/@vite/client`)).text()
      const token = /const wsToken = "([^"]+)"/u.exec(client)?.[1]
      expect(token).toBeDefined()
      socket = new WebSocket(`ws://127.0.0.1:${server.address.port}/?token=${token}`, 'vite-hmr')
      await new Promise<void>((done, reject) => {
        socket!.addEventListener('open', () => { done() }, { once: true })
        socket!.addEventListener('error', () => { reject(new Error('WebSocket failed')) }, { once: true })
      })
      for (const [label, atomic] of [['HEADER_TWO', false], ['HEADER_THREE', true]] as const) {
        await delay(150)
        const updated = nextMessage(socket, 'full-reload')
        if (atomic) {
          const directory = join(dirname(header), '.edit.tmpdir')
          await mkdir(directory)
          await writeFile(join(directory, 'new.astro'), source.replace('HEADER_ONE', label))
          await rename(join(directory, 'new.astro'), header)
        } else await writeFile(header, source.replace('HEADER_ONE', label))
        await updated
        for (const route of ['/', '/contact/']) expect(await html(route)).toContain(label)
      }

      await delay(150)
      const footerUpdate = nextMessage(socket, 'full-reload')
      await writeFile(join(root, 'src/components/Footer.astro'), '<footer>FOOTER_UPDATED</footer>')
      await footerUpdate
      for (const route of ['/', '/contact/']) expect(await html(route)).toContain('FOOTER_UPDATED')

      await delay(150)
      const invalidUpdate = nextMessage(socket, 'full-reload')
      await writeFile(header, source.replace('model.title', 'model.missing.title'))
      await invalidUpdate
      const renderError = nextMessage(socket, 'error')
      const brokenHtml = await html('/')
      expect((await renderError).err?.message).toContain('title')
      expect(brokenHtml).not.toContain('HEADER_THREE')

      await delay(150)
      const repaired = nextMessage(socket, 'full-reload')
      await writeFile(header, source.replace('HEADER_ONE', 'HEADER_REPAIRED'))
      await repaired
      for (const route of ['/', '/contact/']) {
        // Astro also sends an early reload when clearing the error state.
        // Verify eventual recovery rather than treating that first notification
        // (or its 200 response) as proof that compilation has already finished.
        await expect.poll(() => html(route), { timeout: 5000 }).toContain('HEADER_REPAIRED')
        const fresh = await html(route)
        expect(fresh).toContain('HEADER_REPAIRED')
        expect(fresh).toContain('FOOTER_UPDATED')
        expect(fresh).not.toContain('HEADER_THREE')
      }
    } finally {
      try {
        const socketClosed = socket !== undefined && socket.readyState !== WebSocket.CLOSED
          ? once(socket, 'close', { signal: AbortSignal.timeout(5000) })
          : Promise.resolve()
        socket?.close()
        // Wait for both resources before removing the fixture, and still
        // restore process state if either shutdown fails.
        const stopped = await Promise.allSettled([socketClosed, server?.stop()])
        const failed = stopped.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      } finally {
        try {
          process.chdir(cwd)
        } finally {
          vi.unstubAllEnvs()
          await unlink(join(root, 'node_modules')).catch(() => {})
          await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
        }
      }
    }
  }, 30_000)
})
