import type { NestExpressApplication } from '@nestjs/platform-express'
import {
  createLinkCodeResponseSchema,
  listJobsResponseSchema,
  mergeSessionResponseSchema,
  meResponseSchema,
  telegramLoginResponseSchema,
  utcDayKey,
} from '@onetodone/compress-shared'
import { Auth } from 'firebase-admin/auth'
import { Firestore, Timestamp } from 'firebase-admin/firestore'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  ALREADY_LINKED_TEXT,
  CANCELLED_TEXT,
  LINK_EXPIRED_TEXT,
  LINKED_TEXT,
  linkedWithImagesText,
  UNLINK_REFUSED_TEXT,
  UNLINKED_TEXT,
} from '../src/bot/bot-messages.js'
import { BotService, type IncomingDocument } from '../src/bot/bot.service.js'
import { encodeCallback } from '../src/bot/callback-data.js'
import { AccountLinkService } from '../src/common/accounts/account-link.service.js'
import { linkCodeId } from '../src/common/accounts/link-codes.js'
import { TelegramIdentityService } from '../src/common/accounts/telegram-identity.service.js'
import { createTestApiApp, createTestBotApp } from './support/app.js'
import {
  clearAuth,
  clearFirestore,
  linkWithGoogle,
  signInAnonymously,
  signInWithCustomToken,
  signUpWithEmail,
} from './support/emulators.js'
import type { InMemoryChatGateway } from './support/fakes.js'
import { fixture } from './support/fixtures.js'

const TELEGRAM = { id: 5151, username: 'ada' }
const OTHER_TELEGRAM = { id: 6262 }
const MINUTE_MS = 60_000

describe('linking the website and Telegram', () => {
  let api: NestExpressApplication
  let botApp: NestExpressApplication
  let bot: BotService
  let chat: InMemoryChatGateway
  let firestore: Firestore
  let auth: Auth
  let nextMessageId = 1

  beforeAll(async () => {
    ;({ app: api } = await createTestApiApp())
    ;({ app: botApp, chat } = await createTestBotApp())
    bot = botApp.get(BotService)
    firestore = botApp.get(Firestore)
    auth = botApp.get(Auth)
  })

  afterAll(async () => {
    await Promise.all([api.close(), botApp.close()])
  })

  beforeEach(async () => {
    await Promise.all([clearFirestore(), clearAuth()])
    chat.reset()
  })

  const http = () => request(api.getHttpServer())
  const message = (from: { id: number; username?: string } = TELEGRAM) => ({
    chatId: from.id,
    messageId: nextMessageId++,
    from,
  })
  const lastMessage = () => chat.callsOf('message').at(-1)
  const lastEdit = () => chat.callsOf('edit').at(-1)
  const identityUid = async (telegramId = TELEGRAM.id) =>
    (await firestore.doc(`identities/telegram:${telegramId}`).get()).get('uid') as string | undefined
  const userDoc = async (uid: string) => (await firestore.doc(`users/${uid}`).get()).data()

  /** Sends a file to the bot, which creates and submits a job of the account. */
  async function sendFile(from: { id: number; username?: string } = TELEGRAM): Promise<void> {
    const fileId = `file-${nextMessageId}`
    chat.files.set(fileId, fixture('photo.jpg'))
    const document: IncomingDocument = {
      ...message(from),
      fileId,
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
    }
    await bot.document(document)
  }

  /** Stores finished web jobs of a user and counts them on today's quota, as submits do. */
  async function seedJobs(ownerId: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const ref = firestore.collection('jobs').doc()
      await ref.set({
        ownerId,
        status: 'done',
        originalName: `photo-${i}.jpg`,
        inputType: 'image/jpeg',
        inputKey: `originals/${ownerId}/${ref.id}`,
        inputBytes: 2048,
        outputKey: `results/${ownerId}/${ref.id}.jpg`,
        outputBytes: 1024,
        width: 64,
        height: 48,
        previewUrl: null,
        error: null,
        source: 'web',
        createdAt: Timestamp.now(),
        finishedAt: Timestamp.now(),
      })
    }
    const used = (await userDoc(ownerId))?.jobsToday as number | undefined
    await firestore
      .doc(`users/${ownerId}`)
      .set({ dayKey: utcDayKey(new Date()), jobsToday: (used ?? 0) + count }, { merge: true })
  }

  async function me(token: string) {
    const response = await http().get('/me').set('Authorization', `Bearer ${token}`).expect(200)
    return meResponseSchema.parse(response.body)
  }

  async function jobIds(token: string): Promise<string[]> {
    const response = await http().get('/jobs').set('Authorization', `Bearer ${token}`).expect(200)
    return listJobsResponseSchema.parse(response.body).jobs.map((job) => job.id)
  }

  /** Asks the bot for a login link and returns the code in it. */
  async function loginCode(from: { id: number; username?: string } = TELEGRAM): Promise<string> {
    await bot.login(message(from))
    const code = /telegram-login=([\w-]{22})/.exec(lastMessage()?.text ?? '')?.[1]
    if (!code) throw new Error('No login link in the answer')
    return code
  }

  /** Signs in on the website with a login code, as the web app does. */
  async function signInWithCode(code: string): Promise<{ token: string; uid: string }> {
    const response = await http().post('/auth/telegram').send({ code }).expect(200)
    return signInWithCustomToken(telegramLoginResponseSchema.parse(response.body).customToken)
  }

  /** Creates a link code for a website user and returns the code from its Telegram link. */
  async function linkCode(token: string): Promise<string> {
    const response = await http().post('/auth/telegram/link-code').set('Authorization', `Bearer ${token}`).expect(201)
    const { url } = createLinkCodeResponseSchema.parse(response.body)
    expect(url).toMatch(/^https:\/\/t\.me\/test_compressor_bot\?start=link_[\w-]{22}$/)
    return url.split('link_')[1]!
  }

  /** Opens a website link in the bot and confirms the question, as a user does. */
  async function connect(token: string, from: { id: number; username?: string } = TELEGRAM): Promise<void> {
    const code = await linkCode(token)
    await bot.start(message(from), `link_${code}`)
    await bot.callback({ ...message(from), callbackId: 'cb', data: encodeCallback({ type: 'link', code }) })
  }

  describe('from Telegram to the website', () => {
    it('signs in as the Telegram account, with its history and quota', async () => {
      await sendFile()
      const telegramUid = (await identityUid())!

      const { token, uid } = await signInWithCode(await loginCode())

      expect(uid).toBe(telegramUid)
      expect(await jobIds(token)).toHaveLength(1)
      const profile = await me(token)
      expect(profile).toMatchObject({ kind: 'registered', quota: { used: 1, limit: 30 } })
      expect(profile.telegram).toEqual({ linked: true, username: 'ada' })
      // The sign-in created the Auth user; the server never did.
      expect((await auth.getUser(uid)).uid).toBe(uid)
    })

    it('puts the login link on a button and keeps the code out of Firestore', async () => {
      const code = await loginCode()

      expect(lastMessage()?.keyboard).toEqual([
        [{ text: 'Sign in on the website', url: `https://img.example.com/#telegram-login=${code}` }],
      ])
      const stored = await firestore.collection('linkCodes').get()
      expect(stored.docs.map((doc) => doc.id)).toEqual([linkCodeId(code)])
      expect(JSON.stringify(stored.docs[0]!.data())).not.toContain(code)
    })

    it('refuses a login code the second time', async () => {
      const code = await loginCode()
      await signInWithCode(code)

      const response = await http().post('/auth/telegram').send({ code }).expect(400)
      expect(response.body.message).toMatch(/expired or was already used/)
    })

    it('refuses an expired login code', async () => {
      const telegramUser = await botApp.get(TelegramIdentityService).userFor(TELEGRAM)
      const { code } = await botApp
        .get(AccountLinkService)
        .createLoginCode(TELEGRAM, telegramUser.uid, new Date(Date.now() - 11 * MINUTE_MS))

      await http().post('/auth/telegram').send({ code }).expect(400)
    })

    it('refuses a link code at the login and a malformed code', async () => {
      const { token } = await signUpWithEmail()
      const code = await linkCode(token)

      await http().post('/auth/telegram').send({ code }).expect(400)
      await http().post('/auth/telegram').send({ code: 'short' }).expect(400)
    })

    it('refuses a login code whose Telegram account moved to another user meanwhile', async () => {
      const code = await loginCode()
      const { token } = await signUpWithEmail()
      await connect(token)

      await http().post('/auth/telegram').send({ code }).expect(400)
    })

    it('links Google to the Telegram account without changing the uid', async () => {
      const { token, uid } = await signInWithCode(await loginCode())

      const linked = await linkWithGoogle(token)

      expect(linked.uid).toBe(uid)
      await me(linked.token)
      expect(await userDoc(uid)).toMatchObject({ googleLinked: true, telegramId: TELEGRAM.id })
    })
  })

  describe('from the website to Telegram', () => {
    it('connects a new Telegram account to the website user after a confirmation, sharing history and quota', async () => {
      const { token, uid } = await signUpWithEmail()
      const code = await linkCode(token)

      await bot.start(message(), `link_${code}`)
      // A link someone else sent must not connect an account unnoticed: the bot names the account first.
      expect(lastMessage()?.text).toMatch(/to the website account .+@example\.com\?/)
      expect(await identityUid()).toBeUndefined()
      await bot.callback({ ...message(), callbackId: 'cb', data: encodeCallback({ type: 'link', code }) })
      expect(lastEdit()?.text).toBe(LINKED_TEXT)
      await sendFile()

      expect(await identityUid()).toBe(uid)
      expect(await jobIds(token)).toHaveLength(1)
      expect(await me(token)).toMatchObject({
        quota: { used: 1 },
        telegram: { linked: true, username: 'ada' },
      })
    })

    it('refuses a link code the second time', async () => {
      const { token } = await signUpWithEmail()
      const code = await linkCode(token)
      await bot.start(message(), `link_${code}`)
      await bot.callback({ ...message(), callbackId: 'cb', data: encodeCallback({ type: 'link', code }) })

      await bot.start(message(OTHER_TELEGRAM), `link_${code}`)

      expect(lastMessage()?.text).toBe(LINK_EXPIRED_TEXT)
      expect(await identityUid(OTHER_TELEGRAM.id)).toBeUndefined()
    })

    it('refuses an expired link code', async () => {
      const { token } = await signUpWithEmail()
      const code = await linkCode(token)

      await bot.start(message(), `link_${code}`, new Date(Date.now() + 11 * MINUTE_MS))

      expect(lastMessage()?.text).toBe(LINK_EXPIRED_TEXT)
      expect(await identityUid()).toBeUndefined()
    })

    it('refuses a login code in a link', async () => {
      const code = await loginCode(OTHER_TELEGRAM)

      await bot.start(message(), `link_${code}`)

      expect(lastMessage()?.text).toBe(LINK_EXPIRED_TEXT)
    })

    it('says so when the account is already connected', async () => {
      const { token } = await signUpWithEmail()
      await connect(token)

      await bot.start(message(), `link_${await linkCode(token)}`)

      expect(lastMessage()?.text).toBe(ALREADY_LINKED_TEXT)
    })

    it('gives no link code to anonymous users', async () => {
      const { token } = await signInAnonymously()

      await http().post('/auth/telegram/link-code').set('Authorization', `Bearer ${token}`).expect(403)
    })

    it('asks before moving a Telegram account that has images, and moves them with it', async () => {
      await sendFile()
      const oldUid = (await identityUid())!
      const { token, uid } = await signUpWithEmail()
      const code = await linkCode(token)

      await bot.start(message(), `link_${code}`)
      expect(await identityUid()).toBe(oldUid)
      const question = lastMessage()!
      expect(question.text).toContain('The 1 image you have here moves to that account too.')

      await bot.callback({
        ...message(),
        messageId: question.messageId,
        callbackId: 'cb-1',
        data: encodeCallback({ type: 'link', code }),
      })

      expect(lastEdit()?.text).toBe(linkedWithImagesText(1))
      expect(await identityUid()).toBe(uid)
      expect(await jobIds(token)).toHaveLength(1)
      expect((await firestore.collection('jobs').where('ownerId', '==', oldUid).get()).size).toBe(0)
      expect(await me(token)).toMatchObject({ quota: { used: 1 } })
      expect(await userDoc(oldUid)).toMatchObject({ jobsToday: 0 })
      expect(await userDoc(oldUid)).not.toHaveProperty('telegramId')
    })

    it('adds the used count of the Telegram account to the website user', async () => {
      const { token, uid } = await signUpWithEmail()
      await seedJobs(uid, 2)
      await sendFile()

      await connect(token)

      expect(await jobIds(token)).toHaveLength(3)
      expect(await me(token)).toMatchObject({ quota: { used: 3 } })
    })

    it('leaves the images with the account the Telegram account leaves when it has Google', async () => {
      await sendFile()
      const first = await signInWithCode(await loginCode())
      const google = await linkWithGoogle(first.token)
      await me(google.token)
      const { token } = await signUpWithEmail()
      const code = await linkCode(token)

      await bot.start(message(), `link_${code}`)
      expect(lastMessage()?.text).toContain('The 1 image you have here stays with the current account')
      await bot.callback({ ...message(), callbackId: 'cb', data: encodeCallback({ type: 'link', code }) })

      expect(lastEdit()?.text).toBe(LINKED_TEXT)
      expect(await jobIds(token)).toEqual([])
      expect(await jobIds(google.token)).toHaveLength(1)
      expect(await me(google.token)).toMatchObject({ quota: { used: 1 }, telegram: { linked: false } })
    })

    it('leaves everything as it is when the move is cancelled', async () => {
      await sendFile()
      const oldUid = await identityUid()
      const { token } = await signUpWithEmail()
      await bot.start(message(), `link_${await linkCode(token)}`)

      await bot.callback({ ...message(), callbackId: 'cb-1', data: encodeCallback({ type: 'cancel' }) })

      expect(lastEdit()?.text).toBe(CANCELLED_TEXT)
      expect(await identityUid()).toBe(oldUid)
    })

    it('releases the Telegram account the user had before, keeping its used count for today', async () => {
      const { token, uid } = await signUpWithEmail()
      await connect(token, OTHER_TELEGRAM)
      await sendFile(OTHER_TELEGRAM)

      await connect(token)

      expect(await identityUid()).toBe(uid)
      const releasedUid = (await identityUid(OTHER_TELEGRAM.id))!
      expect(releasedUid).not.toBe(uid)
      expect(await userDoc(releasedUid)).toMatchObject({ jobsToday: 1, telegramId: OTHER_TELEGRAM.id })
      expect(await userDoc(uid)).toMatchObject({ telegramId: TELEGRAM.id, jobsToday: 1 })
    })
  })

  describe('merging an anonymous session', () => {
    const merge = (token: string, anonymousToken: string) =>
      http().post('/me/merge').set('Authorization', `Bearer ${token}`).send({ anonymousToken })

    it('moves the images and the used count of an anonymous session into the account signed in to', async () => {
      const anonymous = await signInAnonymously()
      await seedJobs(anonymous.uid, 2)
      await sendFile()
      const { token, uid } = await signInWithCode(await loginCode())

      const response = await merge(token, anonymous.token).expect(200)

      expect(mergeSessionResponseSchema.parse(response.body)).toEqual({ movedJobs: 2 })
      expect(await jobIds(token)).toHaveLength(3)
      expect(await jobIds(anonymous.token)).toEqual([])
      expect(await me(token)).toMatchObject({ quota: { used: 3, limit: 30 } })
      expect(await userDoc(anonymous.uid)).toMatchObject({ jobsToday: 0 })
      const moved = await firestore.collection('jobs').where('ownerId', '==', uid).get()
      // R2 keys stay where they are; the job keeps pointing at them.
      expect(moved.docs.map((doc) => doc.get('inputKey') as string)).toEqual(
        expect.arrayContaining([expect.stringContaining(`originals/${anonymous.uid}/`)]),
      )
    })

    it('changes nothing when repeated', async () => {
      const anonymous = await signInAnonymously()
      await seedJobs(anonymous.uid, 1)
      const { token } = await signUpWithEmail()
      await merge(token, anonymous.token).expect(200)

      const response = await merge(token, anonymous.token).expect(200)

      expect(response.body).toEqual({ movedJobs: 0 })
      expect(await me(token)).toMatchObject({ quota: { used: 1 } })
    })

    it('refuses a token that is not anonymous', async () => {
      const other = await signUpWithEmail()
      await seedJobs(other.uid, 1)
      const { token } = await signUpWithEmail()

      await merge(token, other.token).expect(400)
      expect(await jobIds(other.token)).toHaveLength(1)
    })

    it('refuses an anonymous token whose session has linked Google since', async () => {
      const anonymous = await signInAnonymously()
      await seedJobs(anonymous.uid, 1)
      await me((await linkWithGoogle(anonymous.token)).token)
      const { token } = await signUpWithEmail()

      await merge(token, anonymous.token).expect(400)
      expect(await jobIds(token)).toEqual([])
    })

    it('refuses an invalid token and an anonymous caller', async () => {
      const anonymous = await signInAnonymously()
      const { token } = await signUpWithEmail()

      await merge(token, 'not-a-token').expect(400)
      await merge(token, '').expect(400)
      await merge(anonymous.token, (await signInAnonymously()).token).expect(403)
    })
  })

  describe('unlinking', () => {
    it('refuses to disconnect from the website without Google', async () => {
      const { token } = await signInWithCode(await loginCode())

      await http().delete('/auth/telegram').set('Authorization', `Bearer ${token}`).expect(409)
      expect(await me(token)).toMatchObject({ telegram: { linked: true } })
    })

    it('disconnects from the website; the Telegram account starts over with today’s used count', async () => {
      await sendFile()
      const { token, uid } = await signInWithCode(await loginCode())
      const google = await linkWithGoogle(token)

      await http().delete('/auth/telegram').set('Authorization', `Bearer ${google.token}`).expect(204)

      expect(await me(google.token)).toMatchObject({ telegram: { linked: false, username: null } })
      expect(await jobIds(google.token)).toHaveLength(1)
      const newUid = (await identityUid())!
      expect(newUid).not.toBe(uid)
      expect(await userDoc(newUid)).toMatchObject({ jobsToday: 1, telegramId: TELEGRAM.id })
      await bot.showImages(message())
      expect(lastMessage()?.text).toContain('You have no images yet.')
    })

    it('answers 404 when nothing is connected', async () => {
      const { token } = await linkWithGoogle((await signInAnonymously()).token)

      await http().delete('/auth/telegram').set('Authorization', `Bearer ${token}`).expect(404)
    })

    it('refuses to disconnect in the bot while Telegram is the only way in', async () => {
      await sendFile()

      await bot.unlink(message())

      expect(lastMessage()?.text).toBe(UNLINK_REFUSED_TEXT)
    })

    it('disconnects in the bot after a confirmation once Google is linked', async () => {
      const { token, uid } = await signInWithCode(await loginCode())
      await me((await linkWithGoogle(token)).token)

      await bot.unlink(message())
      const question = lastMessage()!
      expect(question.keyboard?.[0]?.[0]).toEqual({ text: 'Disconnect', data: encodeCallback({ type: 'unlink' }) })
      await bot.callback({
        ...message(),
        messageId: question.messageId,
        callbackId: 'cb-1',
        data: encodeCallback({ type: 'unlink' }),
      })

      expect(lastEdit()?.text).toBe(UNLINKED_TEXT)
      expect(await identityUid()).not.toBe(uid)
      expect(await userDoc(uid)).not.toHaveProperty('telegramId')
    })
  })

  it('reports no Telegram link for a user who has none', async () => {
    const { token } = await signUpWithEmail()

    expect((await me(token)).telegram).toEqual({ linked: false, username: null })
  })
})
