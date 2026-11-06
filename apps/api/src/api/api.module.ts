import { type DynamicModule, Module } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'

import { createApp } from '../common/bootstrap.js'
import { CloudinaryModule } from '../common/cloudinary/cloudinary.module.js'
import type { ApiConfig } from '../common/config/config.js'
import { ConfigModule } from '../common/config/config.module.js'
import { FirebaseModule } from '../common/firebase/firebase.module.js'
import { HealthModule } from '../common/health/health.module.js'
import { LoggingModule } from '../common/logging/logging.module.js'
import { QuotaModule } from '../common/quota/quota.module.js'
import { R2Module } from '../common/r2/r2.module.js'
import { TasksModule } from '../common/tasks/tasks.module.js'
import { AuthModule } from './auth/auth.module.js'
import { JobsModule } from './jobs/jobs.module.js'
import { UsersModule } from './users/users.module.js'

@Module({})
export class ApiModule {
  static register(config: ApiConfig): DynamicModule {
    return {
      module: ApiModule,
      imports: [
        ConfigModule.register(config),
        LoggingModule.register(config),
        FirebaseModule,
        R2Module.register(config),
        CloudinaryModule.register(config),
        TasksModule.register(config),
        AuthModule,
        HealthModule,
        QuotaModule.register(config),
        UsersModule,
        JobsModule,
      ],
    }
  }
}

export async function createApiApp(config: ApiConfig): Promise<NestExpressApplication> {
  return configureApiApp(await createApp(ApiModule.register(config)), config)
}

/** Applies the API-specific HTTP settings to an application created from {@link ApiModule}. */
export function configureApiApp(app: NestExpressApplication, config: ApiConfig): NestExpressApplication {
  app.enableCors({ origin: config.CORS_ORIGINS })
  return app
}
