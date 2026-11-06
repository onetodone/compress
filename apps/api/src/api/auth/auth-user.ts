import type { Request } from 'express'

import type { AuthUser } from '../../common/auth/auth-user.js'

/**
 * A request that passed the auth guard carries the user from its verified Firebase ID token, and the
 * sign-in providers linked to that user (the token's `firebase.identities`, e.g. `google.com`).
 */
export type AuthenticatedRequest = Request & { user?: AuthUser; linkedProviders?: string[] }
