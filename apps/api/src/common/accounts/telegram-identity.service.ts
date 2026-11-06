import { Injectable, Logger } from '@nestjs/common'
import { type DocumentReference, FieldValue, Firestore } from 'firebase-admin/firestore'

import type { AuthUser } from '../auth/auth-user.js'
import { CallTimer } from '../logging/call-timer.js'
import { USERS } from './account-fields.js'

/** Firestore collection that maps accounts of other channels to Firebase uids. */
export const IDENTITIES = 'identities'

/** gRPC status of a Firestore `create` on a document that already exists. */
const ALREADY_EXISTS = 6

/** The Telegram user behind an update. */
export interface TelegramUser {
  id: number
  /** Telegram username without `@`, if the account has one. */
  username?: string
}

/** Returns the `identities` document of a Telegram account. */
export function telegramIdentity(firestore: Firestore, telegramId: number): DocumentReference {
  return firestore.collection(IDENTITIES).doc(`telegram:${telegramId}`)
}

/**
 * Finds or creates the uid of a Telegram account, through `identities/telegram:{id}`. No Firebase
 * Auth user is created: the server's credentials only reach Firestore, and an Auth user with this
 * uid comes into being when the account first signs in on the website with a custom token.
 */
@Injectable()
export class TelegramIdentityService {
  private readonly logger = new Logger(TelegramIdentityService.name)

  constructor(
    private readonly firestore: Firestore,
    private readonly timer: CallTimer,
  ) {}

  /** Returns the uid of a Telegram account, or `null` if it has never used the bot. */
  async find(telegram: TelegramUser): Promise<string | null> {
    const ref = telegramIdentity(this.firestore, telegram.id)
    const snapshot = await this.timer.measure('firestore', 'identities.get', () => ref.get())
    const uid = snapshot.get('uid') as unknown
    return typeof uid === 'string' ? uid : null
  }

  /** Returns the user of a Telegram account. A Telegram account identifies a person, so the user is `registered`. */
  async userFor(telegram: TelegramUser): Promise<AuthUser> {
    const known = await this.find(telegram)
    if (known) return { uid: known, kind: 'registered' }

    const ref = telegramIdentity(this.firestore, telegram.id)
    const uid = this.firestore.collection(IDENTITIES).doc().id
    const batch = this.firestore.batch()
    batch.create(ref, { uid, provider: 'telegram', createdAt: FieldValue.serverTimestamp() })
    batch.create(this.firestore.collection(USERS).doc(uid), {
      telegramId: telegram.id,
      telegramUsername: telegram.username ?? null,
      createdAt: FieldValue.serverTimestamp(),
    })
    try {
      await this.timer.measure('firestore', 'identities.create', () => batch.commit())
      this.logger.log({ userId: uid }, 'Created a user for a Telegram account')
      return { uid, kind: 'registered' }
    } catch (error) {
      // Another update of the same account won the race; its uid stands.
      if ((error as { code?: unknown }).code !== ALREADY_EXISTS) throw error
      const winner = await this.find(telegram)
      if (!winner) throw error
      return { uid: winner, kind: 'registered' }
    }
  }
}
