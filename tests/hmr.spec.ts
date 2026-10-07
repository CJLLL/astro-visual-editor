import { once } from 'node:events'
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dev } from 'astro'
import type { AstroIntegration } from 'astro'
import { describe, expect, it, vi } from 'vitest'
import { astroVisualEditor } from '../src/index.ts'

interface HotMessage {
  type: string
  updates?: { path: string; timestamp: number }[]
  err?: { message: string }
}

function nextUpdate(socket: WebSocket, description: string): Promise<HotMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', onMessage)
      reject(new Error(`Timed out waiting for CSS hot update: ${description}`))
    }, 10_000)
    function onMessage(event: MessageEvent): void {
      const message = JSON.parse(String(event.data)) as HotMessage
      if (message.type !== 'update' && message.type !== 'error') return
      clearTimeout(timeout)
      socket.removeEventListener('message', onMessage)
      if (message.type === 'error') reject(new Error(`HMR error: ${message.err?.message ?? 'unknown compiler error'}`))
      else resolve(message)
    }
    socket.addEventListener('message', onMessage)
  })
}

describe('Astro development CSS hot updates', () => {
  it.each(['page', 'component'] as const)('serves current %s CSS on consecutive edits without restarting', async kind => {
    const root = await mkdtemp(join(tmpdir(), 'astro-visual-editor-hmr-'))
    const dependencies = join(root, 'node_modules')
    const cwd = process.cwd()
    let server: Awaited<ReturnType<typeof dev>> | undefined
    let socket: WebSocket | undefined
    try {
      await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), dependencies, process.platform === 'win32' ? 'junction' : 'dir')
      const page = join(root, 'src', 'pages', 'index.astro')
      const file = kind === 'page' ? page : join(root, 'src', 'components', 'Button.astro')
      await mkdir(dirname(page), { recursive: true })
      await mkdir(dirname(file), { recursive: true })
      let source = '<style is:global>\n.button { background: #2663eb; }\n</style>\n<button class="button">开始了解</button>\n'
      await writeFile(file, source)
      if (kind === 'component') await writeFile(page, '---\nimport Button from "../components/Button.astro";\n---\n<html><head></head><body><Button /></body></html>')
      process.chdir(root)
      vi.stubEnv('NODE_ENV', 'development')
      vi.stubEnv('ASTRO_TELEMETRY_DISABLED', '1')
      vi.stubEnv('ASTRO_DEV_BACKGROUND', '1')
      // Astro disables its HTTP middleware inside Vitest by default; this
      // integration test deliberately exercises a real development server.
      vi.stubEnv('VITEST', undefined)
      server = await dev({
        root,
        configFile: false,
        logLevel: 'silent',
        devToolbar: { enabled: false },
        integrations: [astroVisualEditor({ projectRoot: root }) as AstroIntegration],
        server: { host: '127.0.0.1', port: 0, open: false },
        vite: { cacheDir: join(root, 'vite-cache') },
      })
      const origin = `http://127.0.0.1:${server.address.port}`
      const initialPage = await fetch(origin, { headers: { accept: 'text/html' } })
      expect(initialPage.status).toBe(200)
      const cssPath = `/src/${kind === 'page' ? 'pages/index' : 'components/Button'}.astro?astro&type=style&index=0&lang.css`
      const initialCss = await (await fetch(`${origin}${cssPath}`)).text()
      expect(initialCss).toContain('#2663eb')
      expect(initialCss).toContain('import.meta.hot.accept')
      const client = await (await fetch(`${origin}/@vite/client`)).text()
      const token = /const wsToken = "([^"]+)"/u.exec(client)?.[1]
      expect(token).toBeDefined()
      socket = new WebSocket(`ws://127.0.0.1:${server.address.port}/?token=${token}`, 'vite-hmr')
      await new Promise<void>((resolve, reject) => {
        socket!.addEventListener('open', () => resolve(), { once: true })
        socket!.addEventListener('error', () => reject(new Error('HMR connection failed')), { once: true })
      })

      for (const edit of [
        { color: '#e53935', atomic: false, addRule: true },
        { color: '#ffd400', atomic: true, addRule: false },
        { color: '#123456', atomic: false, addRule: false },
      ]) {
        // Keep separate saves outside Chokidar's native change-event throttle.
        await delay(150)
        source = edit.addRule
          ? source.replace('</style>', `.button { background: ${edit.color}; }\n</style>`)
          : source.replace(/\.button \{ background: #[0-9a-f]+; \}(?=\n<\/style>)/u, `.button { background: ${edit.color}; }`)
        const update = nextUpdate(socket, edit.color)
        if (edit.atomic) {
          const stage = join(dirname(file), '.edit.tmpdir')
          await mkdir(stage)
          const temporary = join(stage, 'source.tmp')
          await writeFile(temporary, source)
          await rename(temporary, file)
        } else {
          await writeFile(file, source)
        }
        const message = await update
        const cssUpdate = message.updates?.find(item => item.path === cssPath)
        expect(cssUpdate).toBeDefined()
        // Fetch the CSS as soon as the HMR message arrives, before an HTML
        // request can recompile the page and hide stale compile metadata.
        const css = await (await fetch(`${origin}${cssPath}&t=${cssUpdate!.timestamp}`)).text()
        expect(css).toContain(`background: ${edit.color}`)
        const html = await (await fetch(origin, { headers: { accept: 'text/html' } })).text()
        expect(html).toContain('data-dsh-source-loc="5:1"')
        expect(html).toContain(kind === 'page' ? 'src/pages/index.astro' : 'src/components/Button.astro')
      }

      // A temporarily invalid AI edit must still report the compiler error and
      // allow the next valid edit to refresh CSS, without restarting the server.
      await delay(150)
      const invalidUpdate = nextUpdate(socket, 'invalid source')
      const failed = expect(invalidUpdate).rejects.toThrow('HMR error:')
      await writeFile(file, `---\nconst broken = ;\n---\n${source}`)
      await failed
      await delay(150)
      const recovered = nextUpdate(socket, 'repaired source')
      await writeFile(file, source.replace('#123456', '#009966'))
      const recoveryMessage = await recovered
      const recoveryTimestamp = recoveryMessage.updates?.find(item => item.path === cssPath)?.timestamp
      expect(recoveryTimestamp).toBeDefined()
      expect(await (await fetch(`${origin}${cssPath}&t=${recoveryTimestamp}`)).text()).toContain('background: #009966')
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
          await unlink(dependencies).catch(() => {})
          await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
        }
      }
    }
  }, 30_000)
})
