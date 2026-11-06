import { type Api, GrammyError, InputFile } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'

import type { CallTimer } from '../common/logging/call-timer.js'
import {
  ChatError,
  type ChatErrorKind,
  ChatGateway,
  type InlineKeyboard,
  type OutgoingFile,
  type SendOptions,
} from './chat-gateway.js'

/** Bot API descriptions of errors that are not worth retrying, by what they mean for the bot. */
const KNOWN_ERRORS: [RegExp, ChatErrorKind][] = [
  [/file is too big/i, 'file_too_large'],
  [/chat not found|bot was blocked|user is deactivated|bot was kicked|not enough rights/i, 'chat_unavailable'],
  [/message (to \w+ )?not found|message is not modified|message_id_invalid|message can't be/i, 'message_unavailable'],
]

/** {@link ChatGateway} on the Telegram Bot API. */
export class TelegramChatGateway extends ChatGateway {
  /**
   * @param api Bot API client of the bot
   * @param token bot token, needed for file downloads, which are not part of the Bot API methods
   */
  constructor(
    private readonly api: Api,
    private readonly token: string,
    private readonly timer: CallTimer,
  ) {
    super()
  }

  async sendMessage(chatId: number, text: string, options: SendOptions = {}): Promise<number> {
    const message = await this.call('sendMessage', () =>
      this.api.sendMessage(chatId, text, {
        ...replyTo(options.replyTo),
        ...keyboard(options.keyboard),
        link_preview_options: { is_disabled: true },
      }),
    )
    return message.message_id
  }

  async editMessage(chatId: number, messageId: number, text: string, buttons?: InlineKeyboard): Promise<void> {
    await this.call('editMessageText', () =>
      this.api.editMessageText(chatId, messageId, text, {
        ...keyboard(buttons),
        link_preview_options: { is_disabled: true },
      }),
    )
  }

  async sendDocument(
    chatId: number,
    file: OutgoingFile,
    options: SendOptions & { caption?: string } = {},
  ): Promise<void> {
    await this.call('sendDocument', () =>
      this.api.sendDocument(chatId, new InputFile(file.data, file.fileName), {
        ...replyTo(options.replyTo),
        ...keyboard(options.keyboard),
        caption: options.caption,
        // Telegram would otherwise detect the image and may show it as a photo preview.
        disable_content_type_detection: true,
      }),
    )
  }

  async setReaction(chatId: number, messageId: number, emoji: string | null): Promise<void> {
    await this.call('setMessageReaction', () =>
      this.api.setMessageReaction(
        chatId,
        messageId,
        emoji ? [{ type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] }] : [],
      ),
    )
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', () => this.api.answerCallbackQuery(callbackId, { text }))
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    const file = await this.call('getFile', () => this.api.getFile(fileId))
    if (!file.file_path) throw new ChatError('transient', 'Telegram returned no file path')
    const response = await this.call('downloadFile', async () => {
      try {
        return await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`)
      } catch (error) {
        // The error of a failed fetch names the URL, which holds the token.
        throw new ChatError('transient', `File download failed: ${(error as Error).name}`)
      }
    })
    if (!response.ok) throw new ChatError('transient', `File download failed with status ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }

  /** Runs a Bot API call, timing it and turning its errors into {@link ChatError}. */
  private async call<T>(method: string, call: () => Promise<T>): Promise<T> {
    try {
      return await this.timer.measure('telegram', method, call)
    } catch (error) {
      throw toChatError(method, error)
    }
  }
}

function toChatError(method: string, error: unknown): ChatError {
  if (error instanceof ChatError) return error
  if (error instanceof GrammyError) {
    const kind = KNOWN_ERRORS.find(([pattern]) => pattern.test(error.description))?.[1] ?? 'transient'
    return new ChatError(kind, `${method} failed with ${error.error_code}: ${error.description}`)
  }
  // grammY's HttpError and anything else: the message may contain the request URL with the token,
  // which the log masking removes; the payload is never included.
  return new ChatError('transient', `${method} failed: ${error instanceof Error ? error.message : 'unknown error'}`)
}

function replyTo(messageId: number | undefined) {
  return messageId === undefined
    ? {}
    : { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } }
}

function keyboard(rows: InlineKeyboard | undefined) {
  if (!rows) return {}
  return {
    reply_markup: {
      inline_keyboard: rows.map((row) =>
        row.map((button) =>
          'url' in button ? { text: button.text, url: button.url } : { text: button.text, callback_data: button.data },
        ),
      ),
    },
  }
}
