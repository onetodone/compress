import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common'
import type { TelegramStatus } from '@onetodone/compress-shared'
import { Auth } from 'firebase-admin/auth'
import {
  type DocumentReference,
  type DocumentSnapshot,
  FieldValue,
  Firestore,
  Timestamp,
  type Transaction,
} from 'firebase-admin/firestore'

import { accountKindOf, type AuthUser } from '../auth/auth-user.js'
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
import { LibraryMergeService } from './library-merge.service.js'
import { IDENTITIES, telegramIdentity, type TelegramUser } from './telegram-identity.service.js'

/** A fresh one-time code and when it stops working. */
export interface IssuedCode {
  code: string
  expiresAt: Date
}

/** How linking a Telegram account with a code ended. */
export type LinkOutcome = 'linked' | 'already_linked' | 'invalid'

/** How linking a Telegram account with a code ended, and how many of its images moved along. */
export interface LinkResult {
  outcome: LinkOutcome
  /** Jobs that moved from the uid the Telegram account left to the website account. */
  movedJobs: number
}

/** Message of a login code that cannot be used; the same for unknown, used and expired codes. */
export const LOGIN_CODE_REFUSED =
  'This sign-in link has expired or was already used. Send /login to the bot for a new one.'

/** Message of an anonymous session that cannot be merged into the user. */
export const MERGE_REFUSED = 'The images of this session cannot be moved to your account'

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
    private readonly library: LibraryMergeService,
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
   * Uses a `link` code: the Telegram account moves to the code's user. When nothing else leads to the
   * uid it leaves (no Google sign-in), that uid's images and today's used quota move along; a uid with
   * Google keeps them. A Telegram account the user had linked before is released.
   */
  async linkTelegram(code: string, telegram: TelegramUser, now = new Date()): Promise<LinkResult> {
    if (!isLinkCode(code)) return { outcome: 'invalid', movedJobs: 0 }
    const codeRef = this.firestore.collection(LINK_CODES).doc(linkCodeId(code))
    const identityRef = telegramIdentity(this.firestore, telegram.id)
    const telegramUsername = telegram.username ?? null

    const { outcome, uid, orphaned } = await this.timer.measure('firestore', 'accounts.linkTelegram', () =>
      this.firestore.runTransaction(async (tx): Promise<{ outcome: LinkOutcome; uid?: string; orphaned?: string }> => {
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
        const reachable = previous?.exists === true && readAccountLinks(previous.data()).googleLinked
        return { outcome: 'linked', uid: stored.uid, orphaned: previousRef && !reachable ? previousUid : undefined }
      }),
    )
    if (outcome !== 'linked') return { outcome, movedJobs: 0 }
    this.logger.log({ userId: uid }, 'Linked a Telegram account')
    return { outcome, movedJobs: orphaned ? await this.library.merge(orphaned, uid!, now) : 0 }
  }

  /**
   * Moves the images and today's used quota of an anonymous session the user leaves, e.g. by signing
   * in to an account that already existed, into the user. Holding the session's ID token proves that
   * the caller owns it.
   *
   * @throws ForbiddenException when the user is anonymous
   * @throws BadRequestException when the token is invalid, not anonymous, the user's own, or its uid has
   *   another way in since (Google or Telegram)
   * @returns the number of jobs moved
   */
  async mergeAnonymousSession(user: AuthUser, anonymousToken: string): Promise<number> {
    if (user.kind !== 'registered') throw new ForbiddenException('Sign in to keep the images of another session')
    const fromUid = await this.anonymousUid(anonymousToken)
    if (fromUid === user.uid) throw new BadRequestException(MERGE_REFUSED)
    // A token stays valid for an hour after its session linked Google; that uid is reachable and stays.
    const links = await this.links(fromUid)
    if (links.googleLinked || links.telegramId !== null) throw new BadRequestException(MERGE_REFUSED)
    return this.library.merge(fromUid, user.uid)
  }

  private async anonymousUid(token: string): Promise<string> {
    let decoded
    try {
      decoded = await this.timer.measure('auth', 'verifyIdToken', () => this.auth.verifyIdToken(token))
    } catch (error) {
      // Failing to fetch Google's public keys is a server problem, not a bad token.
      if ((error as { code?: unknown }).code === 'auth/internal-error') throw error
      throw new BadRequestException(MERGE_REFUSED)
    }
    if (accountKindOf(decoded.firebase.sign_in_provider) !== 'anonymous') throw new BadRequestException(MERGE_REFUSED)
    return decoded.uid
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
