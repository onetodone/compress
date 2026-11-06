import { autoRetry } from '@grammyjs/auto-retry'
import { type DynamicModule, Module } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Bot } from 'grammy'

import { AccountsModule } from '../common/accounts/accounts.module.js'
import { createApp } from '../common/bootstrap.js'
import { CloudinaryModule } from '../common/cloudinary/cloudinary.module.js'
import type { BotConfig } from '../common/config/config.js'
import { ConfigModule } from '../common/config/config.module.js'
import { FirebaseModule } from '../common/firebase/firebase.module.js'
import { HealthModule } from '../common/health/health.module.js'
import { JobsService } from '../common/jobs/jobs.service.js'
import { CallTimer } from '../common/logging/call-timer.js'
import { LoggingModule } from '../common/logging/logging.module.js'
import { QuotaModule } from '../common/quota/quota.module.js'
import { R2Module } from '../common/r2/r2.module.js'
import { TasksModule } from '../common/tasks/tasks.module.js'
import { BotService } from './bot.service.js'
import { ChatGateway } from './chat-gateway.js'
import { NotificationConsumer } from './notifications/notification.consumer.js'
import { NotificationService } from './notifications/notification.service.js'
import { TelegramChatGateway } from './telegram-chat-gateway.js'
import { TELEGRAM_BOT, TelegramPoller } from './telegram-poller.js'

/** The Telegram bot: answers users by long polling and delivers finished jobs from the notification queue. */
@Module({})
export class BotModule {
  static register(config: BotConfig): DynamicModule {
    return {
      module: BotModule,
      imports: [
        ConfigModule.register(config),
        LoggingModule.register(config),
        FirebaseModule,
        R2Module.register(config),
        CloudinaryModule.register(config),
        TasksModule.register(config),
        QuotaModule.register(config),
        HealthModule,
        AccountsModule,
      ],
      providers: [
        {
          provide: TELEGRAM_BOT,
          useFactory: () => {
            const bot = new Bot(config.TELEGRAM_BOT_TOKEN)
            // Waits out Telegram's flood limits (429 with retry_after) and brief outages.
            bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }))
            return bot
          },
        },
        {
          provide: ChatGateway,
          useFactory: (bot: Bot, timer: CallTimer) =>
            new TelegramChatGateway(bot.api, config.TELEGRAM_BOT_TOKEN, timer),
          inject: [TELEGRAM_BOT, CallTimer],
        },
        JobsService,
        BotService,
        NotificationService,
        NotificationConsumer,
        TelegramPoller,
      ],
    }
  }
}

export function createBotApp(config: BotConfig): Promise<NestExpressApplication> {
  return createApp(BotModule.register(config))
}
