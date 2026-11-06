import {
  Body,
  ConflictException,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
} from '@nestjs/common'
import {
  type CreateLinkCodeResponse,
  type TelegramLoginRequest,
  telegramLoginRequestSchema,
  type TelegramLoginResponse,
} from '@onetodone/image-compressor-shared'

import { AccountLinkService } from '../../common/accounts/account-link.service.js'
import type { AuthUser } from '../../common/auth/auth-user.js'
import { Public } from '../../common/auth/public.decorator.js'
import type { ApiConfig } from '../../common/config/config.js'
import { CONFIG } from '../../common/config/config.module.js'
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js'
import { CurrentUser, GoogleLinked } from '../auth/current-user.decorator.js'

@Controller('auth/telegram')
export class TelegramLinkController {
  constructor(
    private readonly accounts: AccountLinkService,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Post('link-code')
  async createLinkCode(@CurrentUser() user: AuthUser): Promise<CreateLinkCodeResponse> {
    const bot = this.config.TELEGRAM_BOT_USERNAME
    if (!bot) throw new NotFoundException('Telegram is not available')
    const { code, expiresAt } = await this.accounts.createLinkCode(user)
    return { url: `https://t.me/${bot}?start=link_${code}`, expiresAt: expiresAt.toISOString() }
  }

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(telegramLoginRequestSchema)) body: TelegramLoginRequest,
  ): Promise<TelegramLoginResponse> {
    return { customToken: await this.accounts.exchangeLoginCode(body.code) }
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async unlink(@CurrentUser() user: AuthUser, @GoogleLinked() googleLinked: boolean): Promise<void> {
    // Without another sign-in, the account could not be reached again.
    if (!googleLinked) throw new ConflictException('Link Google to this account before disconnecting Telegram')
    await this.accounts.status(user, googleLinked)
    if (!(await this.accounts.unlinkTelegram(user.uid))) throw new NotFoundException('No Telegram account is connected')
  }
}
