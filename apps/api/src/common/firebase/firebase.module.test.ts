import { createVerify, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { deleteApp, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { firebaseAppOptions } from './firebase.module.js'

const dirs: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeServiceAccountKey(privateKey: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'firebase-key-'))
  dirs.push(dir)
  const file = join(dir, 'key.json')
  writeFileSync(
    file,
    JSON.stringify({
      type: 'service_account',
      project_id: 'demo-key-test',
      private_key_id: 'key-1',
      private_key: privateKey,
      client_email: 'server@demo-key-test.iam.gserviceaccount.com',
      client_id: '1',
    }),
  )
  return file
}

describe('firebaseAppOptions', () => {
  it('leaves credentials to the SDK without a key file', () => {
    expect(firebaseAppOptions('demo-key-test', {})).toEqual({ projectId: 'demo-key-test' })
  })

  it('signs custom tokens with the key file locally', async () => {
    vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', '')
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const keyFile = writeServiceAccountKey(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
    const app = initializeApp(firebaseAppOptions('demo-key-test', { GOOGLE_APPLICATION_CREDENTIALS: keyFile }), 'key')
    try {
      const token = await getAuth(app).createCustomToken('user-1')
      const [header, payload, signature] = token.split('.') as [string, string, string]
      const verifier = createVerify('RSA-SHA256').update(`${header}.${payload}`)
      expect(verifier.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true)
      expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({ uid: 'user-1' })
    } finally {
      await deleteApp(app)
    }
  })
})
