import type { NestExpressApplication } from '@nestjs/platform-express'
import { utcDayKey } from '@onetodone/image-compressor-shared'
import { Firestore } from 'firebase-admin/firestore'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApiApp } from '../src/api/api.module.js'
import type { AuthUser } from '../src/common/auth/auth-user.js'
import { QuotaService } from '../src/api/users/quota.service.js'
import { apiConfig } from './support/config.js'
import { clearFirestore } from './support/emulators.js'

describe('QuotaService', () => {
  let app: NestExpressApplication
  let firestore: Firestore
  let quota: QuotaService
  const user: AuthUser = { uid: 'user-1', kind: 'anonymous' }

  beforeAll(async () => {
    app = await createApiApp(apiConfig)
    await app.init()
    firestore = app.get(Firestore)
    quota = app.get(QuotaService)
  })

  afterAll(() => app.close())

  beforeEach(() => clearFirestore())

  const consume = (who: AuthUser = user, now?: Date) => firestore.runTransaction((tx) => quota.consume(tx, who, now))

  it('creates the user document on the first job', async () => {
    await consume()

    const snapshot = await firestore.doc('users/user-1').get()
    expect(snapshot.data()).toMatchObject({
      dayKey: utcDayKey(new Date()),
      jobsToday: 1,
      isAnonymous: true,
      createdAt: expect.anything(),
    })
  })

  it('reports consumed jobs', async () => {
    await consume()
    await consume()

    await expect(quota.get(user)).resolves.toMatchObject({ used: 2, limit: 5 })
  })

  it('refuses jobs beyond the daily limit without changing the counter', async () => {
    for (let i = 0; i < 5; i++) await consume()

    await expect(consume()).rejects.toMatchObject({ status: 429 })
    await expect(quota.get(user)).resolves.toMatchObject({ used: 5 })
  })

  // Contended transactions retry with exponential backoff, which can outlast the default test timeout.
  it('never exceeds the limit under concurrent submits', async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => consume()))

    // Under heavy contention Firestore may abort a transaction after its retries, so fewer than
    // five can succeed; the counter must still match the successful ones and stay within the limit.
    const fulfilled = results.filter((result) => result.status === 'fulfilled').length
    expect(fulfilled).toBeGreaterThan(0)
    expect(fulfilled).toBeLessThanOrEqual(5)
    await expect(quota.get(user)).resolves.toMatchObject({ used: fulfilled })
  }, 30_000)

  it('resets the counter on the next UTC day', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    for (let i = 0; i < 5; i++) await consume(user, yesterday)

    await expect(consume()).resolves.toMatchObject({ used: 1, dayKey: utcDayKey(new Date()) })
  })

  it('keeps the creation time when the document is updated', async () => {
    await consume()
    const createdAt = (await firestore.doc('users/user-1').get()).get('createdAt')

    await consume({ uid: 'user-1', kind: 'registered' })

    const snapshot = await firestore.doc('users/user-1').get()
    expect(snapshot.get('createdAt')).toEqual(createdAt)
    expect(snapshot.get('isAnonymous')).toBe(false)
  })

  it('never counts a registered user without a client address against a network', async () => {
    const registered: AuthUser = { uid: 'user-2', kind: 'registered' }

    expect(await quota.reserveNetwork(registered, undefined)).toBeNull()
    expect(await quota.networkLimitReached(registered, undefined)).toBe(false)
  })
})
