import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

rmSync(resolve(import.meta.dirname, '../lib'), { recursive: true, force: true })
