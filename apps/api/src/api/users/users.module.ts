import { Module } from '@nestjs/common'

import { MeController } from './me.controller.js'

/** `GET /me`: the user, their account kind, quota and limits. */
@Module({ controllers: [MeController] })
export class UsersModule {}
