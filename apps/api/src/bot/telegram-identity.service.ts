import { Injectable, Logger } from '@nestjs/common'
import { FieldValue, Firestore } from 'firebase-admin/firestore'

import type { AuthUser } from '../common/auth/auth-user.js'
import { CallTimer } from '../common/logging/call-timer.js'

/** Firestore collection that maps accounts of other channels to Firebase uids. */
export const IDENTITIES = 'identities'

/** gRPC status of a Firestore `create` on a document that already exists. */
const ALREADY_EXISTS = 6

/** The Telegram user behind an update. */
export interface TelegramUser {
  id: number
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

  /** Returns the user of a Telegram account. A Telegram account identifies a person, so the user is `registered`. */
  async userFor(telegram: TelegramUser): Promise<AuthUser> {
    const identities = this.firestore.collection(IDENTITIES)
    const ref = identities.doc(`telegram:${telegram.id}`)
    const existing = await this.timer.measure('firestore', 'identities.get', () => ref.get())
    const known = existing.get('uid') as unknown
    if (typeof known === 'string') return { uid: known, kind: 'registered' }

    const uid = identities.doc().id
    try {
      await this.timer.measure('firestore', 'identities.create', () =>
        ref.create({ uid, provider: 'telegram', createdAt: FieldValue.serverTimestamp() }),
      )
      this.logger.log({ userId: uid }, 'Created a user for a Telegram account')
      return { uid, kind: 'registered' }
    } catch (error) {
      // Another update of the same account won the race; its uid stands.
      if ((error as { code?: unknown }).code !== ALREADY_EXISTS) throw error
      const winner = await this.timer.measure('firestore', 'identities.get', () => ref.get())
      return { uid: winner.get('uid') as string, kind: 'registered' }
    }
  }
}
