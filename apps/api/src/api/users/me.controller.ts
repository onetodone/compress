import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Ip, Post } from '@nestjs/common'
import {
  FILE_TYPES,
  isImageType,
  type MergeSessionRequest,
  mergeSessionRequestSchema,
  type MergeSessionResponse,
  type MeResponse,
  type InputLimits,
  type UserLimits,
} from '@onetodone/compress-shared'

import { AccountLinkService } from '../../common/accounts/account-link.service.js'
import type { AuthUser } from '../../common/auth/auth-user.js'
import type { ApiConfig } from '../../common/config/config.js'
import { CONFIG } from '../../common/config/config.module.js'
import { QuotaService } from '../../common/quota/quota.service.js'
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js'
import { CurrentUser, GoogleLinked } from '../auth/current-user.decorator.js'

@Controller('me')
export class MeController {
  constructor(
    private readonly quota: QuotaService,
    private readonly accounts: AccountLinkService,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get()
  async me(
    @CurrentUser() user: AuthUser,
    @GoogleLinked() googleLinked: boolean,
    @Ip() ip: string | undefined,
  ): Promise<MeResponse> {
    const [quota, networkLimitReached, telegram] = await Promise.all([
      this.quota.get(user),
      this.quota.networkLimitReached(user, ip),
      this.accounts.status(user, googleLinked),
    ])
    return {
      uid: user.uid,
      kind: user.kind,
      isAnonymous: user.kind === 'anonymous',
      quota,
      limits: limitsOf(this.quota.entitlements(user).inputLimits),
      networkLimitReached,
      telegram: this.config.TELEGRAM_BOT_USERNAME ? telegram : null,
    }
  }

  @Post('merge')
  @HttpCode(HttpStatus.OK)
  async merge(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(mergeSessionRequestSchema)) body: MergeSessionRequest,
  ): Promise<MergeSessionResponse> {
    return { movedJobs: await this.accounts.mergeAnonymousSession(user, body.anonymousToken) }
  }
}

function limitsOf(inputLimits: InputLimits): UserLimits {
  const formats = FILE_TYPES.flatMap((type) => {
    const maxBytes = inputLimits[type]
    return maxBytes === undefined ? [] : [{ type, maxBytes }]
  })
  const images = formats.filter(({ type }) => isImageType(type)).map(({ maxBytes }) => maxBytes)
  return { maxInputBytes: Math.max(...images), formats }
}
