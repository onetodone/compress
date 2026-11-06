import type { NestExpressApplication } from '@nestjs/platform-express'
import { utcDayKey } from '@onetodone/compress-shared'
import { Auth } from 'firebase-admin/auth'
import { FieldValue, Firestore } from 'firebase-admin/firestore'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { PHOTO_TEXT, WORKING_REACTION } from '../src/bot/bot-messages.js'
import { BotService, type IncomingDocument } from '../src/bot/bot.service.js'
import { encodeCallback } from '../src/bot/callback-data.js'
import { NotificationService } from '../src/bot/notifications/notification.service.js'
import { createTestBotApp } from './support/app.js'
import { clearAuth, clearFirestore } from './support/emulators.js'
import type {
  InMemoryChatGateway,
  InMemoryImageCdn,
  InMemoryObjectStorage,
  RecordingTaskQueue,
} from './support/fakes.js'
import { fixture } from './support/fixtures.js'

const TELEGRAM_ID = 4242
const CHAT_ID = 4242
const MESSAGE_ID = 77

describe('telegram bot', () => {
  let app: NestExpressApplication
  let bot: BotService
  let notifications: NotificationService
  let chat: InMemoryChatGateway
  let storage: InMemoryObjectStorage
  let cdn: InMemoryImageCdn
  let tasks: RecordingTaskQueue
  let firestore: Firestore
  let auth: Auth
  const today = utcDayKey(new Date())

  beforeAll(async () => {
    ;({ app, chat, storage, cdn, tasks } = await createTestBotApp())
    bot = app.get(BotService)
    notifications = app.get(NotificationService)
    firestore = app.get(Firestore)
    auth = app.get(Auth)
  })

  afterAll(() => app.close())

  beforeEach(async () => {
    await Promise.all([clearFirestore(), clearAuth()])
    chat.reset()
    storage.objects.clear()
    storage.unavailable.clear()
    cdn.reset()
    tasks.reset()
  })

  const from = { id: TELEGRAM_ID }
  const message = (messageId = MESSAGE_ID) => ({ chatId: CHAT_ID, messageId, from })

  function document(fields: Partial<IncomingDocument> = {}): IncomingDocument {
    const data = fixture('photo.jpg')
    chat.files.set('file-1', data)
    return {
      ...message(),
      fileId: 'file-1',
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      fileSize: data.length,
      ...fields,
    }
  }

  const uid = async () => (await firestore.doc(`identities/telegram:${TELEGRAM_ID}`).get()).get('uid') as string
  const jobs = async () => (await firestore.collection('jobs').get()).docs
  const lastText = () => chat.callsOf('message').at(-1)?.text

  /** Stores a finished job of the Telegram user with its result in place, as the worker leaves it. */
  async function finishedJob(
    owner: string,
    fields: Record<string, unknown> = {},
    createdAt: Date = new Date(),
  ): Promise<string> {
    const ref = firestore.collection('jobs').doc()
    const outputKey = `results/${owner}/${ref.id}.jpg`
    storage.upload(`originals/${owner}/${ref.id}`, { data: Buffer.from('original') })
    storage.upload(outputKey, { data: Buffer.from('result'), contentType: 'image/jpeg' })
    await ref.set({
      ownerId: owner,
      source: 'telegram',
      notify: { chatId: CHAT_ID, messageId: MESSAGE_ID },
      status: 'done',
      originalName: 'photo.jpeg',
      inputType: 'image/jpeg',
      outputType: 'image/jpeg',
      settings: { preset: 'balanced' },
      inputKey: `originals/${owner}/${ref.id}`,
      inputBytes: 2000,
      outputKey,
      outputBytes: 500,
      width: 10,
      height: 10,
      previewUrl: null,
      error: null,
      attempts: 1,
      quotaDayKey: today,
      quotaRefunded: false,
      createdAt,
      updatedAt: FieldValue.serverTimestamp(),
      finishedAt: FieldValue.serverTimestamp(),
      ...fields,
    })
    return ref.id
  }

  describe('files', () => {
    it('creates a registered user without an Auth account and submits a job that remembers the message', async () => {
      await bot.document(document())

      const owner = await uid()
      // The server's credentials only reach Firestore; the Auth user comes with the first web sign-in.
      expect((await auth.listUsers()).users).toEqual([])
      const [job] = await jobs()
      expect(job?.data()).toMatchObject({
        ownerId: owner,
        source: 'telegram',
        notify: { chatId: CHAT_ID, messageId: MESSAGE_ID },
        status: 'queued',
        originalName: 'photo.jpg',
        inputType: 'image/jpeg',
        settings: { preset: 'balanced' },
        inputBytes: fixture('photo.jpg').length,
      })
      expect(storage.objects.get(`originals/${owner}/${job!.id}`)?.data).toEqual(fixture('photo.jpg'))
      expect(tasks.enqueued).toEqual([job!.id])
      expect(chat.callsOf('reaction')).toEqual([
        { type: 'reaction', chatId: CHAT_ID, messageId: MESSAGE_ID, emoji: WORKING_REACTION },
      ])
      expect(chat.callsOf('message')).toEqual([])
      // Registered users get the signed-in daily limit.
      expect((await firestore.doc(`users/${owner}`).get()).data()).toMatchObject({ jobsToday: 1, isAnonymous: false })
    })

    it('keeps one user per Telegram account across messages', async () => {
      await bot.document(document())
      await bot.document(document({ messageId: MESSAGE_ID + 1 }))

      const owners = new Set((await jobs()).map((job) => job.get('ownerId') as string))
      expect([...owners]).toEqual([await uid()])
    })

    it('creates one user when two messages of a new account arrive at once', async () => {
      await Promise.all([bot.document(document()), bot.document(document({ messageId: MESSAGE_ID + 1 }))])

      const owners = new Set((await jobs()).map((job) => job.get('ownerId') as string))
      expect(owners.size).toBe(1)
      expect([...owners]).toEqual([await uid()])
    })

    it('reads the type from the extension when Telegram does not know it', async () => {
      chat.files.set('file-avif', fixture('photo.avif'))
      await bot.document(
        document({ fileId: 'file-avif', fileName: 'photo.avif', mimeType: 'application/octet-stream', fileSize: 1 }),
      )

      const [job] = await jobs()
      expect(job?.get('inputType')).toBe('image/avif')
    })

    it('names a file without a name after its type', async () => {
      await bot.document(document({ fileName: undefined }))

      expect((await jobs())[0]?.get('originalName')).toBe('image.jpg')
    })

    it('refuses a file of another type without creating a job', async () => {
      await bot.document(document({ fileName: 'notes.pdf', mimeType: 'application/pdf' }))

      expect(lastText()).toBe('I can only compress JPEG, PNG, WebP and AVIF images. Send one as a file.')
      expect(chat.callsOf('message')[0]?.replyTo).toBe(MESSAGE_ID)
      expect(await jobs()).toHaveLength(0)
    })

    it('refuses a file above the size limit before downloading it', async () => {
      chat.files.clear()
      await bot.document({ ...document(), fileSize: 11 * 1024 * 1024 })

      expect(lastText()).toBe('The file must be at most 10 MB.')
      expect(await jobs()).toHaveLength(0)
    })

    it('refuses a file Telegram does not let bots download', async () => {
      chat.failures.set('download', 'file_too_large')

      await bot.document(document({ fileSize: undefined }))

      expect(lastText()).toBe('The file is too large: images can be at most 10 MB.')
      expect(await jobs()).toHaveLength(0)
    })

    it('answers with the daily limit once it is used up and removes the reaction', async () => {
      await bot.document(document())
      await firestore.doc(`users/${await uid()}`).update({ jobsToday: 30 })
      chat.reset()

      await bot.document(document({ messageId: MESSAGE_ID + 1 }))

      expect(lastText()).toMatch(/^You have used all 30 images for today\. The limit resets at 00:00 UTC, in /)
      expect(await jobs()).toHaveLength(1)
    })

    it('deletes the job again when the file cannot be stored', async () => {
      storage.unavailable.add('put')

      await bot.document(document())

      expect(lastText()).toBe('Something went wrong. Please try again later.')
      expect(await jobs()).toHaveLength(0)
      expect(chat.callsOf('reaction').map((call) => call.emoji)).toEqual([WORKING_REACTION, null])
    })

    it('asks for a file when an image arrives as a photo', async () => {
      await bot.photo(message())

      expect(chat.callsOf('message')).toMatchObject([{ text: PHOTO_TEXT, replyTo: MESSAGE_ID }])
    })
  })

  describe('commands', () => {
    it('shows the quota of today', async () => {
      await bot.document(document())

      await bot.showQuota(message(), new Date())

      expect(lastText()).toMatch(/^Today you have used 1 of 30 images; 29 left\./)
    })

    it('says so when there are no images', async () => {
      await bot.showImages(message())

      expect(lastText()).toMatch(/^You have no images yet\./)
    })

    it('lists the images newest first with buttons, five per page', async () => {
      await bot.document(document())
      const owner = await uid()
      const base = Date.now() - 60_000
      for (let i = 0; i < 6; i++) {
        await finishedJob(owner, { originalName: `image-${i}.jpg` }, new Date(base + i * 1000))
      }
      chat.reset()

      await bot.showImages(message())

      const [list] = chat.callsOf('message')
      expect(list?.text).toMatch(/^Your images: 7 · page 1 of 2\nToday: 1 of 30 images used\./)
      // The queued job from the message is the newest.
      expect(list?.text).toContain('1. photo.jpg\nWaiting to be compressed…')
      expect(list?.text).toContain('2. image-5.jpg\n2.0 KB → 500 B, 75% smaller · 6 days left')
      expect(list?.keyboard).toHaveLength(6)
      expect(list?.keyboard?.[0]?.map((button) => button.text)).toEqual(['🗑 1. photo.jpg'])
      expect(list?.keyboard?.[1]?.map((button) => button.text)).toEqual(['⬇ 2. image-5.jpg', '🗑'])
      expect(list?.keyboard?.at(-1)?.map((button) => button.text)).toEqual(['↻ Refresh', 'Older ›'])

      await bot.callback({
        ...message(list!.messageId),
        callbackId: 'c1',
        data: encodeCallback({ type: 'page', page: 1 }),
      })

      const [page] = chat.callsOf('edit')
      expect(page?.text).toMatch(/^Your images: 7 · page 2 of 2/)
      expect(page?.text).toContain('6. image-1.jpg')
      expect(page?.text).toContain('7. image-0.jpg')
      expect(page?.keyboard?.at(-1)?.map((button) => button.text)).toEqual(['‹ Newer', '↻ Refresh'])
    })

    it('sends a result again when its download button is pressed', async () => {
      await bot.showImages(message())
      const jobId = await finishedJob(await uid())

      await bot.callback({ ...message(), callbackId: 'c1', data: encodeCallback({ type: 'download', jobId }) })

      expect(chat.callsOf('callbackAnswer')).toEqual([{ type: 'callbackAnswer', callbackId: 'c1', text: undefined }])
      expect(chat.callsOf('document')).toMatchObject([
        { chatId: CHAT_ID, file: { fileName: 'photo.jpg', data: Buffer.from('result') } },
      ])
    })

    it('asks before deleting and then deletes the job with its files', async () => {
      await bot.showImages(message())
      const owner = await uid()
      const jobId = await finishedJob(owner)

      await bot.callback({
        ...message(),
        callbackId: 'c1',
        data: encodeCallback({ type: 'askDelete', jobId, page: 0 }),
      })

      expect(chat.callsOf('edit')[0]?.text).toMatch(/^Delete photo\.jpeg\?/)
      expect((await firestore.doc(`jobs/${jobId}`).get()).exists).toBe(true)

      await bot.callback({ ...message(), callbackId: 'c2', data: encodeCallback({ type: 'delete', jobId, page: 0 }) })

      expect((await firestore.doc(`jobs/${jobId}`).get()).exists).toBe(false)
      expect([...storage.objects.keys()].filter((key) => key.includes(jobId))).toEqual([])
      expect(chat.callsOf('callbackAnswer').at(-1)).toMatchObject({ callbackId: 'c2', text: 'Deleted.' })
      expect(chat.callsOf('edit').at(-1)?.text).toMatch(/^You have no images yet\./)
    })

    it('does not let a user download or delete the job of someone else', async () => {
      const jobId = await finishedJob('someone-else')

      await bot.callback({ ...message(), callbackId: 'c1', data: encodeCallback({ type: 'download', jobId }) })
      await bot.callback({ ...message(), callbackId: 'c2', data: encodeCallback({ type: 'delete', jobId, page: 0 }) })

      expect(chat.callsOf('callbackAnswer')[0]).toMatchObject({ text: 'The image is no longer available.' })
      expect(chat.callsOf('document')).toEqual([])
      expect((await firestore.doc(`jobs/${jobId}`).get()).exists).toBe(true)
    })

    it('answers buttons it cannot read', async () => {
      await bot.callback({ ...message(), callbackId: 'c1', data: 'unknown' })

      expect(chat.callsOf('callbackAnswer')).toMatchObject([
        { callbackId: 'c1', text: expect.stringMatching(/no longer works/) },
      ])
    })
  })

  describe('answers to finished jobs', () => {
    it('replies with the result file once and removes the reaction', async () => {
      const jobId = await finishedJob('user-1')

      expect(await notifications.deliver(jobId)).toBe('sent')
      expect(await notifications.deliver(jobId)).toBe('skipped')

      expect(chat.callsOf('document')).toEqual([
        {
          type: 'document',
          chatId: CHAT_ID,
          file: { data: Buffer.from('result'), fileName: 'photo.jpg' },
          caption: 'photo.jpeg: 2.0 KB → 500 B, 75% smaller',
          replyTo: MESSAGE_ID,
        },
      ])
      expect(chat.callsOf('reaction')).toEqual([
        { type: 'reaction', chatId: CHAT_ID, messageId: MESSAGE_ID, emoji: null },
      ])
      expect((await firestore.doc(`jobs/${jobId}`).get()).get('notifiedAt')).toBeDefined()
    })

    it('replies with the error of a failed job and says its quota is back', async () => {
      const jobId = await finishedJob('user-1', {
        status: 'failed',
        outputKey: null,
        outputBytes: null,
        error: 'The file is not a valid image',
        quotaRefunded: true,
      })

      expect(await notifications.deliver(jobId)).toBe('sent')

      expect(chat.callsOf('message')).toMatchObject([
        {
          text: 'Could not compress photo.jpeg. The file is not a valid image. It does not count against your daily limit.',
          replyTo: MESSAGE_ID,
        },
      ])
    })

    it('gives up on a chat that blocked the bot', async () => {
      const jobId = await finishedJob('user-1')
      chat.failures.set('document', 'chat_unavailable')

      expect(await notifications.deliver(jobId)).toBe('undeliverable')
      expect((await firestore.doc(`jobs/${jobId}`).get()).get('notifiedAt')).toBeDefined()
    })

    it('asks for a retry when Telegram is unavailable', async () => {
      const jobId = await finishedJob('user-1')
      chat.failures.set('document', 'transient')

      await expect(notifications.deliver(jobId)).rejects.toThrow()
      expect((await firestore.doc(`jobs/${jobId}`).get()).get('notifiedAt')).toBeUndefined()
    })

    it('skips jobs that are deleted, still running or from the web', async () => {
      const running = await finishedJob('user-1', { status: 'processing' })
      const web = await finishedJob('user-1', { source: 'web', notify: null })

      expect(await notifications.deliver('a1B2c3D4e5F6g7H8i9J0')).toBe('skipped')
      expect(await notifications.deliver(running)).toBe('skipped')
      expect(await notifications.deliver(web)).toBe('skipped')
      expect(chat.calls).toEqual([])
    })
  })
})
