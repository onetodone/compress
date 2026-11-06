import { ConflictException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common'
import {
  createJobRequestSchema,
  DEFAULT_COMPRESSION_PRESET,
  type ImageType,
  imageFormats,
  imageTypeSchema,
} from '@onetodone/image-compressor-shared'

import type { AuthUser } from '../common/auth/auth-user.js'
import { JobsService } from '../common/jobs/jobs.service.js'
import { QuotaService } from '../common/quota/quota.service.js'
import { ObjectStorage } from '../common/r2/object-storage.js'
import {
  type BotMessage,
  dailyLimitText,
  deleteQuestion,
  GENERIC_ERROR,
  helpText,
  IMAGES_PAGE_SIZE,
  imagesPage,
  pageCount,
  PHOTO_TEXT,
  quotaText,
  resultCaption,
  startText,
  TEXT_HINT,
  tooLargeText,
  unsupportedText,
  WORKING_REACTION,
} from './bot-messages.js'
import { parseCallback } from './callback-data.js'
import { ChatError, ChatGateway } from './chat-gateway.js'
import { TelegramIdentityService, type TelegramUser } from './telegram-identity.service.js'

/** A message a user sent to the bot in a private chat. */
export interface IncomingMessage {
  chatId: number
  messageId: number
  from: TelegramUser
}

/** A file a user sent as a document. */
export interface IncomingDocument extends IncomingMessage {
  fileId: string
  fileName?: string
  mimeType?: string
  /** Size reported by Telegram, if any. */
  fileSize?: number
}

/** A press of a button under a bot message. */
export interface IncomingCallback extends IncomingMessage {
  callbackId: string
  data: string
}

const NO_LONGER_AVAILABLE = 'The image is no longer available.'

// Characters a job name may not contain: control characters and path separators.
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARACTERS = /[\u0000-\u001f\u007f/\\]/g

/** Answers what users send to the bot. Independent of Telegram, which is behind {@link ChatGateway}. */
@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name)

  constructor(
    private readonly chat: ChatGateway,
    private readonly identities: TelegramIdentityService,
    private readonly jobs: JobsService,
    private readonly quota: QuotaService,
    private readonly storage: ObjectStorage,
  ) {}

  async start({ chatId }: IncomingMessage): Promise<void> {
    await this.chat.sendMessage(chatId, startText())
  }

  async help(message: IncomingMessage): Promise<void> {
    const user = await this.identities.userFor(message.from)
    await this.chat.sendMessage(message.chatId, helpText(this.quota.entitlements(user)))
  }

  async showQuota(message: IncomingMessage, now = new Date()): Promise<void> {
    const user = await this.identities.userFor(message.from)
    const quota = await this.quota.get(user, now)
    await this.chat.sendMessage(message.chatId, quotaText(quota, this.quota.entitlements(user).maxInputBytes, now))
  }

  async showImages(message: IncomingMessage, now = new Date()): Promise<void> {
    const user = await this.identities.userFor(message.from)
    const { text, keyboard } = await this.imagesPage(user, 0, now)
    await this.chat.sendMessage(message.chatId, text, { keyboard })
  }

  async photo({ chatId, messageId }: IncomingMessage): Promise<void> {
    await this.chat.sendMessage(chatId, PHOTO_TEXT, { replyTo: messageId })
  }

  async text({ chatId }: IncomingMessage): Promise<void> {
    await this.chat.sendMessage(chatId, TEXT_HINT)
  }

  /**
   * Creates and submits a job for a file. The answer with the result comes from the notification
   * queue once the worker is done; refusals are answered right away.
   */
  async document(document: IncomingDocument, now = new Date()): Promise<void> {
    const { chatId, messageId } = document
    const type = imageTypeOf(document)
    if (!type) {
      await this.chat.sendMessage(chatId, unsupportedText(), { replyTo: messageId })
      return
    }

    const user = await this.identities.userFor(document.from)
    try {
      await this.jobs.assertCanCreate(user, undefined, document.fileSize ?? 0)
      await this.react(chatId, messageId, WORKING_REACTION)
      const data = await this.chat.downloadFile(document.fileId)
      await this.jobs.createFromFile(
        user,
        {
          originalName: fileNameOf(document, type),
          contentType: type,
          size: data.length,
          settings: { preset: DEFAULT_COMPRESSION_PRESET },
        },
        data,
        { source: 'telegram', notify: { chatId, messageId } },
      )
    } catch (error) {
      await this.react(chatId, messageId, null)
      await this.chat.sendMessage(chatId, this.refusal(user, error, now), { replyTo: messageId })
    }
  }

  /** Handles a button under a `/my_images` message. */
  async callback(callback: IncomingCallback, now = new Date()): Promise<void> {
    const { callbackId, chatId, messageId } = callback
    const action = parseCallback(callback.data)
    if (!action) {
      await this.chat.answerCallback(callbackId, 'This button no longer works. Send /my_images again.')
      return
    }

    const user = await this.identities.userFor(callback.from)
    switch (action.type) {
      case 'page':
        await this.chat.answerCallback(callbackId)
        await this.showPage(user, chatId, messageId, action.page, now)
        return

      case 'download':
        try {
          const job = await this.jobs.get(user, action.jobId)
          const result = await this.jobs.result(user, action.jobId)
          const data = await this.storage.get(result.key)
          if (!data) throw new NotFoundException(NO_LONGER_AVAILABLE)
          await this.chat.answerCallback(callbackId)
          await this.chat.sendDocument(chatId, { data, fileName: result.fileName }, { caption: resultCaption(job) })
        } catch (error) {
          if (error instanceof NotFoundException) await this.chat.answerCallback(callbackId, NO_LONGER_AVAILABLE)
          else if (error instanceof ConflictException) await this.chat.answerCallback(callbackId, 'Not ready yet.')
          else throw error
        }
        return

      case 'askDelete':
        try {
          const question = deleteQuestion(await this.jobs.get(user, action.jobId), action.page)
          await this.chat.answerCallback(callbackId)
          await this.edit(chatId, messageId, question)
        } catch (error) {
          if (!(error instanceof NotFoundException)) throw error
          await this.chat.answerCallback(callbackId, NO_LONGER_AVAILABLE)
          await this.showPage(user, chatId, messageId, action.page, now)
        }
        return

      case 'delete':
        try {
          await this.jobs.delete(user, action.jobId)
        } catch (error) {
          // Already gone, e.g. a second press or the cleanup: the result is the same.
          if (!(error instanceof NotFoundException)) throw error
        }
        await this.chat.answerCallback(callbackId, 'Deleted.')
        await this.showPage(user, chatId, messageId, action.page, now)
        return
    }
  }

  /** Replaces a `/my_images` message with a page, or the last page if fewer remain. */
  private async showPage(user: AuthUser, chatId: number, messageId: number, page: number, now: Date): Promise<void> {
    await this.edit(chatId, messageId, await this.imagesPage(user, page, now))
  }

  private async imagesPage(user: AuthUser, page: number, now: Date): Promise<BotMessage> {
    const quota = await this.quota.get(user, now)
    let result = await this.jobs.page(user, page * IMAGES_PAGE_SIZE, IMAGES_PAGE_SIZE)
    const last = pageCount(result.total) - 1
    if (page > last) {
      page = last
      result = await this.jobs.page(user, page * IMAGES_PAGE_SIZE, IMAGES_PAGE_SIZE)
    }
    return imagesPage(result.jobs, page, result.total, quota, now)
  }

  private async edit(chatId: number, messageId: number, { text, keyboard }: BotMessage): Promise<void> {
    try {
      await this.chat.editMessage(chatId, messageId, text, keyboard ?? [])
    } catch (error) {
      // An unchanged page (refresh without news) or a deleted message needs nothing more.
      if (!(error instanceof ChatError && error.kind === 'message_unavailable')) throw error
    }
  }

  /** Sets or removes the bot's reaction; reactions are decoration, so a failure is only logged. */
  private async react(chatId: number, messageId: number, emoji: string | null): Promise<void> {
    try {
      await this.chat.setReaction(chatId, messageId, emoji)
    } catch (error) {
      this.logger.debug({ err: error }, 'Could not set a reaction')
    }
  }

  /** The user-safe answer to a file that was not accepted. */
  private refusal(user: AuthUser, error: unknown, now: Date): string {
    const { dailyJobs, maxInputBytes } = this.quota.entitlements(user)
    if (error instanceof ChatError && error.kind === 'file_too_large') return tooLargeText(maxInputBytes)
    if (error instanceof HttpException) {
      if (error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) return dailyLimitText(dailyJobs, now)
      // API errors below 500 carry messages written for users.
      if (error.getStatus() < 500) return `${error.message.replace(/\.?$/, '.')}`
    }
    this.logger.error({ userId: user.uid, err: error }, 'Could not accept a file')
    return GENERIC_ERROR
  }
}

/** The image type of a document: its declared MIME type, or its extension when the type is unknown. */
function imageTypeOf({ mimeType, fileName }: IncomingDocument): ImageType | undefined {
  const declared = imageTypeSchema.safeParse(mimeType)
  if (declared.success) return declared.data
  const dot = fileName?.lastIndexOf('.') ?? -1
  return fileName && dot > 0 ? imageFormats.typeOfExtension(fileName.slice(dot + 1)) : undefined
}

/** A valid job name for a document: its file name, cleaned up, or a generic one. */
function fileNameOf({ fileName }: IncomingDocument, type: ImageType): string {
  const fallback = `image.${imageFormats.extension(type)}`
  if (!fileName) return fallback
  const cleaned = fileName.replace(UNSAFE_NAME_CHARACTERS, '_').trim().slice(-255)
  return createJobRequestSchema.shape.originalName.safeParse(cleaned).success ? cleaned : fallback
}
