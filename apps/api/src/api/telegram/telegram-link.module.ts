import { Module } from '@nestjs/common'

import { AccountsModule } from '../../common/accounts/accounts.module.js'
import { TelegramLinkController } from './telegram-link.controller.js'

/** `/auth/telegram`: connect a Telegram account, sign in with one, disconnect it. */
@Module({ imports: [AccountsModule], controllers: [TelegramLinkController] })
export class TelegramLinkModule {}
