import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Auth, type DecodedIdToken } from 'firebase-admin/auth'

import { accountKindOf } from '../../common/auth/auth-user.js'
import { IS_PUBLIC_KEY } from '../../common/auth/public.decorator.js'
import { CallTimer } from '../../common/logging/call-timer.js'
import type { AuthenticatedRequest } from './auth-user.js'

const BEARER = /^Bearer\s+(\S+)$/i

/** Requires a valid Firebase ID token on every route not marked `@Public()`. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: Auth,
    private readonly timer: CallTimer,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (isPublic) return true

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const token = BEARER.exec(request.headers.authorization ?? '')?.[1]
    if (!token) throw new UnauthorizedException('Missing bearer token')

    const decoded = await this.verify(token)
    request.user = { uid: decoded.uid, kind: accountKindOf(decoded.firebase.sign_in_provider) }
    return true
  }

  private async verify(token: string): Promise<DecodedIdToken> {
    try {
      return await this.timer.measure('auth', 'verifyIdToken', () => this.auth.verifyIdToken(token))
    } catch (error) {
      // Failing to fetch Google's public keys is a server problem, not a bad token.
      if (isAuthError(error) && error.code !== 'auth/internal-error') {
        throw new UnauthorizedException('Invalid or expired token')
      }
      throw error
    }
  }
}

function isAuthError(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('auth/')
  )
}
