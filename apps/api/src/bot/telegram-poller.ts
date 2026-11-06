import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import type { Bot, Context } from 'grammy'

import { BOT_COMMANDS, GENERIC_ERROR } from './bot-messages.js'
import { BotService, type IncomingMessage } from './bot.service.js'
import { ChatGateway } from './chat-gateway.js'
import type { TelegramUser } from '../common/accounts/telegram-identity.service.js'

/** Injection token of the grammY bot. */
export const TELEGRAM_BOT = Symbol('TELEGRAM_BOT')

/**
 * Receives updates from Telegram by long polling and hands them to {@link BotService}. Telegram
 * allows one poller per bot, so exactly one bot process may run. Only private chats are served.
 */
@Injectable()
export class TelegramPoller implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TelegramPoller.name)

  constructor(
    @Inject(TELEGRAM_BOT) private readonly bot: Bot,
    private readonly handlers: BotService,
    private readonly chat: ChatGateway,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const chat = this.bot.chatType('private')
    chat.command('start', (ctx) => this.run('start', ctx, () => this.handlers.start(messageOf(ctx), ctx.match)))
    chat.command('login', (ctx) => this.run('login', ctx, () => this.handlers.login(messageOf(ctx))))
    chat.command('unlink', (ctx) => this.run('unlink', ctx, () => this.handlers.unlink(messageOf(ctx))))
    chat.command('help', (ctx) => this.run('help', ctx, () => this.handlers.help(messageOf(ctx))))
    chat.command('quota', (ctx) => this.run('quota', ctx, () => this.handlers.showQuota(messageOf(ctx))))
    chat.command('my_images', (ctx) => this.run('my_images', ctx, () => this.handlers.showImages(messageOf(ctx))))
    chat.on('message:document', (ctx) => {
      const { document } = ctx.message
      return this.run('document', ctx, () =>
        this.handlers.document({
          ...messageOf(ctx),
          fileId: document.file_id,
          fileName: document.file_name,
          mimeType: document.mime_type,
          fileSize: document.file_size,
        }),
      )
    })
    chat.on('message:photo', (ctx) => this.run('photo', ctx, () => this.handlers.photo(messageOf(ctx))))
    chat.on('message:text', (ctx) => this.run('text', ctx, () => this.handlers.text(messageOf(ctx))))
    chat.on('callback_query:data', (ctx) => {
      const message = ctx.callbackQuery.message
      if (!message) return ctx.answerCallbackQuery()
      return this.run('callback', ctx, () =>
        this.handlers.callback({
          chatId: message.chat.id,
          messageId: message.message_id,
          from: userOf(ctx.from),
          callbackId: ctx.callbackQuery.id,
          data: ctx.callbackQuery.data,
        }),
      )
    })
    this.bot.catch(({ error }) => this.logger.error({ err: error }, 'Unhandled bot error'))

    // Fails startup on an invalid token instead of polling in vain.
    await this.bot.init()
    try {
      await this.bot.api.setMyCommands(BOT_COMMANDS)
    } catch (error) {
      this.logger.warn({ err: error }, 'Could not register the bot commands')
    }

    this.bot
      .start({
        allowed_updates: ['message', 'callback_query'],
        onStart: ({ username }) => this.logger.log({ username }, 'Polling Telegram for updates'),
      })
      .catch((error: unknown) => {
        // Polling stops for good, e.g. when another process polls with the same token; a restart
        // by the service manager is the only way back.
        this.logger.error({ err: error }, 'Telegram polling stopped')
        process.exit(1)
      })
  }

  // Runs before other providers shut down; stopping waits for the updates being handled.
  async onModuleDestroy(): Promise<void> {
    if (this.bot.isRunning()) await this.bot.stop()
  }

  /** Handles one update, logging its kind, outcome and duration; failures get a generic answer. */
  private async run(update: string, ctx: Context, handle: () => Promise<void>): Promise<void> {
    const started = performance.now()
    const elapsed = () => Math.round(performance.now() - started)
    try {
      await handle()
      this.logger.log({ update, outcome: 'handled', durationMs: elapsed() }, `Telegram ${update} handled`)
    } catch (error) {
      this.logger.error({ update, outcome: 'error', durationMs: elapsed(), err: error }, `Telegram ${update} failed`)
      try {
        if (ctx.callbackQuery) await this.chat.answerCallback(ctx.callbackQuery.id, GENERIC_ERROR)
        else if (ctx.chat) await this.chat.sendMessage(ctx.chat.id, GENERIC_ERROR)
      } catch {
        // Telegram itself is failing; the error is already logged.
      }
    }
  }
}

function messageOf(ctx: Context & { message: { message_id: number; chat: { id: number } } }): IncomingMessage {
  return {
    chatId: ctx.message.chat.id,
    messageId: ctx.message.message_id,
    from: userOf(ctx.from!),
  }
}

function userOf(from: { id: number; username?: string }): TelegramUser {
  return from.username ? { id: from.id, username: from.username } : { id: from.id }
}
