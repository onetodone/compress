import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import {
  createJobRequestSchema,
  DEFAULT_COMPRESSION_PRESET,
  fileFormats,
  type FileType,
  type InputLimits,
  TELEGRAM_LOGIN_FRAGMENT,
} from '@onetodone/compress-shared'

import { AccountLinkService, type LinkResult } from '../common/accounts/account-link.service.js'
import { LINK_CODE_LIFETIME_MS } from '../common/accounts/link-codes.js'
import { TelegramIdentityService, type TelegramUser } from '../common/accounts/telegram-identity.service.js'
import type { AuthUser } from '../common/auth/auth-user.js'
import type { BotConfig } from '../common/config/config.js'
import { CONFIG } from '../common/config/config.module.js'
import { entitlementsFor } from '../common/entitlements/entitlements.js'
import { JobsService, NO_LONGER_AVAILABLE } from '../common/jobs/jobs.service.js'
import { QuotaService } from '../common/quota/quota.service.js'
import { ObjectStorage } from '../common/r2/object-storage.js'
import {
  ALREADY_LINKED_TEXT,
  type BotMessage,
  CANCELLED_TEXT,
  dailyLimitText,
  deleteQuestion,
  GENERIC_ERROR,
  helpText,
  IMAGES_PAGE_SIZE,
  imagesPage,
  LINK_EXPIRED_TEXT,
  LINKED_TEXT,
  linkedWithImagesText,
  linkQuestion,
  LOGIN_UNAVAILABLE_TEXT,
  loginMessage,
  pageCount,
  PHOTO_TEXT,
  quotaText,
  resultCaption,
  startText,
  TEXT_HINT,
  tooLargeText,
  UNLINK_REFUSED_TEXT,
  UNLINKED_TEXT,
  unlinkQuestion,
  unsupportedText,
  WORKING_REACTION,
} from './bot-messages.js'
import { parseCallback } from './callback-data.js'
import { ChatError, ChatGateway } from './chat-gateway.js'

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
    private readonly accounts: AccountLinkService,
    @Inject(CONFIG) private readonly config: BotConfig,
  ) {}

  /**
   * Answers `/start`. A start parameter `link_<code>` comes from "Connect Telegram" on the website
   * and connects this Telegram account to that website account.
   */
  async start(message: IncomingMessage, payload = '', now = new Date()): Promise<void> {
    if (payload.startsWith(LINK_PREFIX)) {
      await this.linkFromWebsite(message, payload.slice(LINK_PREFIX.length), now)
      return
    }
    await this.chat.sendMessage(message.chatId, startText(this.telegramInputLimits()))
  }

  /** Answers `/login` with a one-time link that signs in on the website as this account. */
  async login(message: IncomingMessage, now = new Date()): Promise<void> {
    const website = this.config.WEB_APP_URL
    if (!website) {
      await this.chat.sendMessage(message.chatId, LOGIN_UNAVAILABLE_TEXT)
      return
    }
    const user = await this.identities.userFor(message.from)
    const { code } = await this.accounts.createLoginCode(message.from, user.uid, now)
    const { text, keyboard } = loginMessage(
      `${website}/#${TELEGRAM_LOGIN_FRAGMENT}=${code}`,
      LINK_CODE_LIFETIME_MS / 60_000,
    )
    await this.chat.sendMessage(message.chatId, text, { keyboard })
  }

  /** Answers `/unlink`: asks before disconnecting, if the account has another way in. */
  async unlink(message: IncomingMessage): Promise<void> {
    const user = await this.identities.userFor(message.from)
    if (!(await this.accounts.links(user.uid)).googleLinked) {
      await this.chat.sendMessage(message.chatId, UNLINK_REFUSED_TEXT)
      return
    }
    const { text, keyboard } = unlinkQuestion()
    await this.chat.sendMessage(message.chatId, text, { keyboard })
  }

  async help(message: IncomingMessage): Promise<void> {
    const user = await this.identities.userFor(message.from)
    await this.chat.sendMessage(message.chatId, helpText(this.quota.entitlements(user)))
  }

  async showQuota(message: IncomingMessage, now = new Date()): Promise<void> {
    const user = await this.identities.userFor(message.from)
    const quota = await this.quota.get(user, now)
    await this.chat.sendMessage(message.chatId, quotaText(quota, this.quota.entitlements(user).inputLimits, now))
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
    const type = fileTypeOf(document)
    const limits = this.telegramInputLimits()
    if (!type || limits[type] === undefined) {
      await this.chat.sendMessage(chatId, unsupportedText(limits), { replyTo: messageId })
      return
    }

    const user = await this.identities.userFor(document.from)
    try {
      await this.jobs.assertCanCreate(user, undefined, type, document.fileSize ?? 0)
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
      await this.chat.sendMessage(chatId, this.refusal(user, type, error, now), { replyTo: messageId })
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
    if (action.type === 'cancel') {
      await this.chat.answerCallback(callbackId)
      await this.edit(chatId, messageId, { text: CANCELLED_TEXT })
      return
    }
    if (action.type === 'link') {
      const result = await this.accounts.linkTelegram(action.code, callback.from, now)
      await this.chat.answerCallback(callbackId)
      await this.edit(chatId, messageId, { text: linkOutcomeText(result) })
      return
    }

    const user = await this.identities.userFor(callback.from)
    switch (action.type) {
      case 'unlink': {
        await this.chat.answerCallback(callbackId)
        // Google may have been unlinked since the question was asked.
        if (!(await this.accounts.links(user.uid)).googleLinked) {
          await this.edit(chatId, messageId, { text: UNLINK_REFUSED_TEXT })
          return
        }
        await this.accounts.unlinkTelegram(user.uid, callback.from.id)
        await this.edit(chatId, messageId, { text: UNLINKED_TEXT })
        return
      }

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

  private async linkFromWebsite(message: IncomingMessage, code: string, now: Date): Promise<void> {
    const target = await this.accounts.linkTarget(code, now)
    if (!target) {
      await this.chat.sendMessage(message.chatId, LINK_EXPIRED_TEXT)
      return
    }
    const current = await this.identities.find(message.from)
    if (current === target.uid) {
      await this.chat.sendMessage(message.chatId, ALREADY_LINKED_TEXT)
      return
    }
    // Always asked, so a link someone else sent cannot connect this account to theirs unnoticed.
    const images = current ? (await this.jobs.page({ uid: current, kind: 'registered' }, 0, 1)).total : 0
    const imagesMove = images > 0 && !(await this.accounts.links(current!)).googleLinked
    const { text, keyboard } = linkQuestion(target.label, images, imagesMove, code)
    await this.chat.sendMessage(message.chatId, text, { keyboard })
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

  /**
   * Formats Telegram users may send and their size limits. Every Telegram user is registered, so
   * they are known before the user is looked up.
   */
  private telegramInputLimits(): InputLimits {
    return entitlementsFor({ kind: 'registered' }, 'free', this.config).inputLimits
  }

  /** The user-safe answer to a file that was not accepted. */
  private refusal(user: AuthUser, type: FileType, error: unknown, now: Date): string {
    const { dailyJobs, inputLimits } = this.quota.entitlements(user)
    if (error instanceof ChatError && error.kind === 'file_too_large') {
      return tooLargeText(type, inputLimits[type] ?? fileFormats.info(type).maxBytes)
    }
    if (error instanceof HttpException) {
      if (error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) return dailyLimitText(dailyJobs, now)
      // API errors below 500 carry messages written for users.
      if (error.getStatus() < 500) return `${error.message.replace(/\.?$/, '.')}`
    }
    this.logger.error({ userId: user.uid, err: error }, 'Could not accept a file')
    return GENERIC_ERROR
  }
}

const LINK_PREFIX = 'link_'

function linkOutcomeText({ outcome, movedJobs }: LinkResult): string {
  if (outcome === 'linked') return movedJobs > 0 ? linkedWithImagesText(movedJobs) : LINKED_TEXT
  if (outcome === 'already_linked') return ALREADY_LINKED_TEXT
  return LINK_EXPIRED_TEXT
}

/** The file type of a document: its declared MIME type, or its extension when the type is unknown. */
function fileTypeOf({ mimeType, fileName }: IncomingDocument): FileType | undefined {
  const declared = mimeType ? fileFormats.typeOfMimeType(mimeType) : undefined
  if (declared) return declared
  return fileName ? fileFormats.typeOfFileName(fileName) : undefined
}

/** A valid job name for a document: its file name, cleaned up, or a generic one. */
function fileNameOf({ fileName }: IncomingDocument, type: FileType): string {
  const fallback = `${fileFormats.info(type).kind === 'image' ? 'image' : 'document'}.${fileFormats.extension(type)}`
  if (!fileName) return fallback
  const cleaned = fileName.replace(UNSAFE_NAME_CHARACTERS, '_').trim().slice(-255)
  return createJobRequestSchema.shape.originalName.safeParse(cleaned).success ? cleaned : fallback
}
