import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'

import { LibheifHeicEncoder } from '../../src/worker/compression/compress-heic.js'

/** Directory of `heif-enc` on `PATH`, if the libheif tools are installed with their HEVC codecs. */
async function findHeifTools(): Promise<string | undefined> {
  const found = spawnSync('sh', ['-c', 'command -v heif-enc'], { encoding: 'utf8' })
  if (found.status !== 0) return undefined
  const dir = dirname(found.stdout.trim())
  return new LibheifHeicEncoder(dir).check().then(
    () => dir,
    () => undefined,
  )
}

/**
 * Directory with `heif-dec` and `heif-enc` used by tests, or `undefined` when they are not installed.
 * Tests that run them are skipped without them locally; CI installs them, so they never skip there.
 */
export const HEIF_TOOLS_DIR = await findHeifTools()

/** Whether the libheif tools with their HEVC codecs are installed. */
export const heifToolsAvailable = HEIF_TOOLS_DIR !== undefined

if (!heifToolsAvailable && process.env.CI) throw new Error('The libheif tools are required to run the tests in CI')
