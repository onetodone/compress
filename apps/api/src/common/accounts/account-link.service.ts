import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common'
import type { TelegramStatus } from '@onetodone/image-compressor-shared'
import { Auth } from 'firebase-admin/auth'
import {
  type DocumentReference,
  type DocumentSnapshot,
  FieldValue,
  Firestore,
  Timestamp,
  type Transaction,
} from 'firebase-admin/firestore'

import type { AuthUser } from '../auth/auth-user.js'
import { CallTimer } from '../logging/call-timer.js'
import { readStoredUsage } from '../quota/quota.js'
import { type AccountLinks, readAccountLinks, USERS } from './account-fields.js'
import {
  isLinkCode,
  LINK_CODE_LIFETIME_MS,
  LINK_CODES,
  type LinkCodePurpose,
  linkCodeId,
  newLinkCode,
  readLinkCode,
} from './link-codes.js'
import { IDENTITIES, telegramIdentity, type TelegramUser } from './telegram-identity.service.js'

/** A fresh one-time code and when it stops working. */
export interface IssuedCode {
  code: string
  expiresAt: Date
}

/** How linking a Telegram account with a code ended. */
export type LinkOutcome = 'linked' | 'already_linked' | 'invalid'

/** Message of a login code that cannot be used; the same for unknown, used and expired codes. */
export const LOGIN_CODE_REFUSED =
  'This sign-in link has expired or was already used. Send /login to the bot for a new one.'

/**
 * Links Telegram accounts and website users through one-time codes, and unlinks them.
 *
 * A Telegram account belongs to one uid, recorded in `identities/telegram:{id}` and mirrored in
 * `users/{uid}.telegramId`. A Telegram account that leaves a uid gets a fresh one that starts with
 * the day's used count of the uid it leaves, so unlinking and linking again never adds free jobs.
 * Nothing here manages Firebase Auth users: custom tokens are signed locally with the server's key.
 */
@Injectable()
export class AccountLinkService {
  private readonly logger = new Logger(AccountLinkService.name)

  constructor(
    private readonly firestore: Firestore,
    private readonly auth: Auth,
    private readonly timer: CallTimer,
  ) {}

  /** Returns what `users/{uid}` records about the ways into an account. */
  async links(uid: string): Promise<AccountLinks> {
    const snapshot = await this.timer.measure('firestore', 'users.get', () => this.user(uid).get())
    return readAccountLinks(snapshot.data())
  }

  /**
   * Returns the user's Telegram link and records whether the verified token shows a Google sign-in,
   * which the bot checks before it unlinks. Writes only when that changed.
   */
  async status(user: AuthUser, googleLinked: boolean): Promise<TelegramStatus> {
    const ref = this.user(user.uid)
    const snapshot = await this.timer.measure('firestore', 'users.get', () => ref.get())
    const links = readAccountLinks(snapshot.data())
    if (links.googleLinked !== googleLinked) {
      const fields = snapshot.exists ? { googleLinked } : { googleLinked, createdAt: FieldValue.serverTimestamp() }
      await this.timer.measure('firestore', 'users.set', () => ref.set(fields, { merge: true }))
    }
    return { linked: links.telegramId !== null, username: links.telegramUsername }
  }

  /**
   * Creates a code that connects the Telegram account which opens it in the bot to this user.
   * @throws ForbiddenException for anonymous users, who sign in with Google first
   */
  async createLinkCode(user: AuthUser, now = new Date()): Promise<IssuedCode> {
    if (user.kind !== 'registered') throw new ForbiddenException('Sign in with Google to connect Telegram')
    return this.issue('link', user.uid, null, user.email ?? null, now)
  }

  /** Creates a code that signs in on the website as the user of a Telegram account. */
  async createLoginCode(telegram: TelegramUser, uid: string, now = new Date()): Promise<IssuedCode> {
    // Accounts created before `users/{uid}` recorded Telegram get it here, so the website shows the link.
    const ref = this.user(uid)
    await this.timer.measure('firestore', 'users.markTelegram', () =>
      this.firestore.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref)
        if (readAccountLinks(snapshot.data()).telegramId === telegram.id) return
        setUser(tx, ref, snapshot, { telegramId: telegram.id, telegramUsername: telegram.username ?? null })
      }),
    )
    return this.issue('login', uid, telegram.id, null, now)
  }

  /**
   * Returns the user a `link` code would connect to and how to name it, without using the code;
   * `null` if it cannot be used.
   */
  async linkTarget(code: string, now = new Date()): Promise<{ uid: string; label: string | null } | null> {
    if (!isLinkCode(code)) return null
    const ref = this.firestore.collection(LINK_CODES).doc(linkCodeId(code))
    const snapshot = await this.timer.measure('firestore', 'linkCodes.get', () => ref.get())
    const stored = readLinkCode(snapshot.data(), 'link', now)
    return stored && { uid: stored.uid, label: stored.label }
  }

  /**
   * Uses a `link` code: the Telegram account moves to the code's user. The uid it leaves keeps its
   * jobs; a Telegram account the user had linked before is released.
   */
  async linkTelegram(code: string, telegram: TelegramUser, now = new Date()): Promise<LinkOutcome> {
    if (!isLinkCode(code)) return 'invalid'
    const codeRef = this.firestore.collection(LINK_CODES).doc(linkCodeId(code))
    const identityRef = telegramIdentity(this.firestore, telegram.id)
    const telegramUsername = telegram.username ?? null

    const { outcome, uid } = await this.timer.measure('firestore', 'accounts.linkTelegram', () =>
      this.firestore.runTransaction(async (tx): Promise<{ outcome: LinkOutcome; uid?: string }> => {
        const [codeSnapshot, identity] = await tx.getAll(codeRef, identityRef)
        const stored = readLinkCode(codeSnapshot!.data(), 'link', now)
        if (!stored) return { outcome: 'invalid' }

        const targetRef = this.user(stored.uid)
        const target = await tx.get(targetRef)
        const previousUid = identity!.get('uid') as string | undefined
        const previousRef = previousUid && previousUid !== stored.uid ? this.user(previousUid) : null
        const replacedId = readAccountLinks(target.data()).telegramId
        const replacedRef =
          replacedId !== null && replacedId !== telegram.id ? telegramIdentity(this.firestore, replacedId) : null
        const [previous, replaced] = await Promise.all([
          previousRef ? tx.get(previousRef) : null,
          replacedRef ? tx.get(replacedRef) : null,
        ])

        tx.delete(codeRef)
        setUser(tx, targetRef, target, { telegramId: telegram.id, telegramUsername })
        if (previousUid === stored.uid) return { outcome: 'already_linked', uid: stored.uid }

        tx.set(identityRef, { uid: stored.uid, provider: 'telegram', createdAt: FieldValue.serverTimestamp() })
        if (previous?.exists) tx.update(previousRef!, clearedTelegram())
        if (replaced?.get('uid') === stored.uid) {
          const { telegramUsername: replacedUsername } = readAccountLinks(target.data())
          this.release(tx, replacedRef!, replacedId!, replacedUsername, target)
        }
        return { outcome: 'linked', uid: stored.uid }
      }),
    )
    if (outcome === 'linked') this.logger.log({ userId: uid }, 'Linked a Telegram account')
    return outcome
  }

  /**
   * Uses a `login` code and returns a Firebase custom token of the Telegram account's user. The
   * first sign-in with it creates the Auth user.
   *
   * @throws BadRequestException when the code is unknown, used, expired, or its Telegram account has moved
   */
  async exchangeLoginCode(code: string, now = new Date()): Promise<string> {
    if (!isLinkCode(code)) throw new BadRequestException(LOGIN_CODE_REFUSED)
    const codeRef = this.firestore.collection(LINK_CODES).doc(linkCodeId(code))

    const uid = await this.timer.measure('firestore', 'accounts.exchangeLoginCode', () =>
      this.firestore.runTransaction(async (tx): Promise<string | null> => {
        const stored = readLinkCode((await tx.get(codeRef)).data(), 'login', now)
        if (!stored) return null
        const identity = await tx.get(telegramIdentity(this.firestore, stored.telegramId!))
        tx.delete(codeRef)
        return identity.get('uid') === stored.uid ? stored.uid : null
      }),
    )
    if (!uid) throw new BadRequestException(LOGIN_CODE_REFUSED)
    return this.timer.measure('auth', 'createCustomToken', () => this.auth.createCustomToken(uid))
  }

  /**
   * Releases the Telegram account of a user: it gets a fresh uid and starts over there, while this
   * user keeps its jobs. Returns whether anything was linked.
   *
   * @param telegramId Telegram account to release when `users/{uid}` does not record one
   */
  async unlinkTelegram(uid: string, telegramId?: number): Promise<boolean> {
    const userRef = this.user(uid)
    const unlinked = await this.timer.measure('firestore', 'accounts.unlinkTelegram', () =>
      this.firestore.runTransaction(async (tx): Promise<boolean> => {
        const user = await tx.get(userRef)
        const links = readAccountLinks(user.data())
        const id = links.telegramId ?? telegramId
        if (id === undefined) return false
        const identityRef = telegramIdentity(this.firestore, id)
        const identity = await tx.get(identityRef)
        if (user.exists && links.telegramId !== null) tx.update(userRef, clearedTelegram())
        if (identity.get('uid') !== uid) return false
        this.release(tx, identityRef, id, links.telegramUsername, user)
        return true
      }),
    )
    if (unlinked) this.logger.log({ userId: uid }, 'Unlinked a Telegram account')
    return unlinked
  }

  /** Moves a Telegram identity to a fresh uid that starts with today's used count of `from`. */
  private release(
    tx: Transaction,
    identityRef: DocumentReference,
    telegramId: number,
    telegramUsername: string | null,
    from: DocumentSnapshot,
  ): void {
    const uid = this.firestore.collection(IDENTITIES).doc().id
    tx.set(identityRef, { uid, provider: 'telegram', createdAt: FieldValue.serverTimestamp() })
    const usage = readStoredUsage(from.data())
    tx.create(this.user(uid), {
      ...(usage ?? {}),
      telegramId,
      telegramUsername,
      createdAt: FieldValue.serverTimestamp(),
    })
  }

  private async issue(
    purpose: LinkCodePurpose,
    uid: string,
    telegramId: number | null,
    label: string | null,
    now: Date,
  ): Promise<IssuedCode> {
    const code = newLinkCode()
    const expiresAt = new Date(now.getTime() + LINK_CODE_LIFETIME_MS)
    const ref = this.firestore.collection(LINK_CODES).doc(linkCodeId(code))
    await this.timer.measure('firestore', 'linkCodes.create', () =>
      ref.create({
        purpose,
        uid,
        telegramId,
        label,
        expiresAt: Timestamp.fromDate(expiresAt),
        createdAt: FieldValue.serverTimestamp(),
      }),
    )
    return { code, expiresAt }
  }

  private user(uid: string): DocumentReference {
    return this.firestore.collection(USERS).doc(uid)
  }
}

/** Writes fields of `users/{uid}`, creating the document with `createdAt` when it does not exist. */
function setUser(tx: Transaction, ref: DocumentReference, snapshot: DocumentSnapshot, fields: object): void {
  if (snapshot.exists) tx.update(ref, { ...fields })
  else tx.set(ref, { ...fields, createdAt: FieldValue.serverTimestamp() })
}

function clearedTelegram() {
  return { telegramId: FieldValue.delete(), telegramUsername: FieldValue.delete() }
}
