/** A button under a message: it sends `data` back to the bot, or opens `url`, when pressed. */
export type InlineButton =
  | {
      text: string
      /** Callback data, at most 64 bytes. */
      data: string
    }
  | {
      text: string
      /** HTTPS link the button opens. */
      url: string
    }

/** Rows of buttons under a message. */
export type InlineKeyboard = InlineButton[][]

/** A file to send as a document. */
export interface OutgoingFile {
  data: Buffer
  fileName: string
}

/** Options of a sent message. */
export interface SendOptions {
  /** Message to reply to; the message is sent anyway if that one is gone. */
  replyTo?: number
  keyboard?: InlineKeyboard
}

/** Why a chat call failed, as far as the bot cares. */
export type ChatErrorKind =
  /** The user blocked the bot or the chat is gone; retrying will not help. */
  | 'chat_unavailable'
  /** The file is larger than the platform lets bots download. */
  | 'file_too_large'
  /** The message to edit or react to is gone or unchanged. */
  | 'message_unavailable'
  /** Anything else, e.g. the platform is unreachable; worth retrying. */
  | 'transient'

/**
 * Error of a {@link ChatGateway} call. It carries only what is safe to log: never the payload,
 * which may hold file contents, nor the request URL, which holds the bot token.
 */
export class ChatError extends Error {
  constructor(
    readonly kind: ChatErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'ChatError'
  }
}

/**
 * What the bot does in a chat. Injected by this class, so tests can replace Telegram with an
 * in-memory fake. Every method throws {@link ChatError}.
 */
export abstract class ChatGateway {
  /** Sends a text message and returns its id. */
  abstract sendMessage(chatId: number, text: string, options?: SendOptions): Promise<number>

  /** Replaces the text and buttons of a message the bot sent. */
  abstract editMessage(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void>

  /** Sends a file as a document, keeping its bytes as they are. */
  abstract sendDocument(chatId: number, file: OutgoingFile, options?: SendOptions & { caption?: string }): Promise<void>

  /**
   * Sets the bot's reaction on a message.
   * @param emoji the reaction, or `null` to remove it
   */
  abstract setReaction(chatId: number, messageId: number, emoji: string | null): Promise<void>

  /**
   * Confirms a button press, so the client stops showing progress.
   * @param text short notice shown to the user
   */
  abstract answerCallback(callbackId: string, text?: string): Promise<void>

  /** Downloads a file a user sent. */
  abstract downloadFile(fileId: string): Promise<Buffer>
}
