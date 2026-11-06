import type { NestExpressApplication } from '@nestjs/platform-express'
import { MAX_INPUT_BYTES, meResponseSchema } from '@onetodone/image-compressor-shared'
import { Firestore } from 'firebase-admin/firestore'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApiApp } from '../src/api/api.module.js'
import { apiConfig } from './support/config.js'
import { QuotaService } from '../src/common/quota/quota.service.js'
import { clearFirestore, linkWithGoogle, signInAnonymously, signUpWithEmail } from './support/emulators.js'

describe('GET /me', () => {
  let app: NestExpressApplication

  beforeAll(async () => {
    app = await createApiApp(apiConfig)
    await app.init()
  })

  afterAll(() => app.close())

  beforeEach(() => clearFirestore())

  it('rejects requests without a token', async () => {
    await request(app.getHttpServer()).get('/me').expect(401)
  })

  it('rejects a malformed token', async () => {
    await request(app.getHttpServer()).get('/me').set('Authorization', 'Bearer not-a-token').expect(401)
  })

  it('rejects a non-bearer authorization header', async () => {
    const { token } = await signInAnonymously()

    await request(app.getHttpServer()).get('/me').set('Authorization', `Basic ${token}`).expect(401)
  })

  it('returns the anonymous limit for an anonymous user', async () => {
    const { token, uid } = await signInAnonymously()

    const response = await request(app.getHttpServer()).get('/me').set('Authorization', `Bearer ${token}`).expect(200)

    expect(meResponseSchema.parse(response.body)).toEqual({
      uid,
      kind: 'anonymous',
      isAnonymous: true,
      quota: { dayKey: expect.any(String), used: 0, limit: 5 },
      limits: { maxInputBytes: MAX_INPUT_BYTES },
      networkLimitReached: false,
      telegram: { linked: false, username: null },
    })
  })

  it('returns the signed-in limit for a non-anonymous user', async () => {
    const { token, uid } = await signUpWithEmail()

    const response = await request(app.getHttpServer()).get('/me').set('Authorization', `Bearer ${token}`).expect(200)

    expect(response.body).toMatchObject({
      uid,
      kind: 'registered',
      isAnonymous: false,
      quota: { used: 0, limit: 30 },
      limits: { maxInputBytes: MAX_INPUT_BYTES },
    })
  })

  it('keeps the uid and used quota and raises the limit when an anonymous user links Google', async () => {
    const anonymous = await signInAnonymously()
    const firestore = app.get(Firestore)
    const quota = app.get(QuotaService)
    for (let i = 0; i < 5; i++) {
      await firestore.runTransaction((tx) => quota.consume(tx, { uid: anonymous.uid, kind: 'anonymous' }))
    }

    const linked = await linkWithGoogle(anonymous.token)

    expect(linked.uid).toBe(anonymous.uid)
    const response = await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${linked.token}`)
      .expect(200)
    expect(response.body).toMatchObject({
      uid: anonymous.uid,
      kind: 'registered',
      isAnonymous: false,
      quota: { used: 5, limit: 30 },
    })
  })

  it('keeps health checks public', async () => {
    await request(app.getHttpServer()).get('/health').expect(200)
  })
})
