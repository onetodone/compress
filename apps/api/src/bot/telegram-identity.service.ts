import { Injectable, Logger } from '@nestjs/common'
import { Auth } from 'firebase-admin/auth'
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
  firstName?: string
}

/** Finds or creates the Firebase user of a Telegram account, through `identities/telegram:{id}`. */
@Injectable()
export class TelegramIdentityService {
  private readonly logger = new Logger(TelegramIdentityService.name)

  constructor(
    private readonly firestore: Firestore,
    private readonly auth: Auth,
    private readonly timer: CallTimer,
  ) {}

  /**
   * Returns the user of a Telegram account, creating a Firebase Auth user on first contact. A
   * Telegram account identifies a person, so the user is `registered`.
   */
  async userFor(telegram: TelegramUser): Promise<AuthUser> {
    const ref = this.firestore.collection(IDENTITIES).doc(`telegram:${telegram.id}`)
    const existing = await this.timer.measure('firestore', 'identities.get', () => ref.get())
    const uid = existing.get('uid') as unknown
    if (typeof uid === 'string') return { uid, kind: 'registered' }

    const created = await this.timer.measure('auth', 'createUser', () =>
      this.auth.createUser({ displayName: telegram.firstName?.slice(0, 100) || undefined }),
    )
    try {
      await this.timer.measure('firestore', 'identities.create', () =>
        ref.create({ uid: created.uid, provider: 'telegram', createdAt: FieldValue.serverTimestamp() }),
      )
      this.logger.log({ userId: created.uid }, 'Created a user for a Telegram account')
      return { uid: created.uid, kind: 'registered' }
    } catch (error) {
      // Another update of the same account won the race; its user stands and this one goes.
      await this.timer.measure('auth', 'deleteUser', () => this.auth.deleteUser(created.uid))
      if ((error as { code?: unknown }).code !== ALREADY_EXISTS) throw error
      const winner = await this.timer.measure('firestore', 'identities.get', () => ref.get())
      return { uid: winner.get('uid') as string, kind: 'registered' }
    }
  }
}
