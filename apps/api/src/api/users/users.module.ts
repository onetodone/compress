import { Module } from '@nestjs/common'

import { AccountsModule } from '../../common/accounts/accounts.module.js'
import { MeController } from './me.controller.js'

/** `GET /me`: the user, their account kind, quota, limits and Telegram link; `POST /me/merge`. */
@Module({ imports: [AccountsModule], controllers: [MeController] })
export class UsersModule {}
