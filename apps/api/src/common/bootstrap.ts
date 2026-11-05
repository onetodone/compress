import 'reflect-metadata'

import type { DynamicModule } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Logger } from 'nestjs-pino'

/**
 * Creates a Nest application on Express with the pino logger, proxy-aware client IPs and
 * graceful shutdown on `SIGTERM`.
 */
export async function createApp(module: DynamicModule): Promise<NestExpressApplication> {
  return configureApp(await NestFactory.create<NestExpressApplication>(module, { bufferLogs: true }))
}

/** Applies the logger, proxy and shutdown settings of {@link createApp} to an existing application. */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  app.useLogger(app.get(Logger))
  app.disable('x-powered-by')
  // The reverse proxy in front of the API appends the client address as the last X-Forwarded-For entry.
  app.set('trust proxy', 1)
  app.enableShutdownHooks()
  return app
}

/** Starts listening on the given address, e.g. `127.0.0.1` behind a reverse proxy or `0.0.0.0` in a container. */
export async function listen(app: NestExpressApplication, host: string, port: number): Promise<void> {
  await app.listen(port, host)
  app.get(Logger).log(`Listening on ${host}:${port}`, 'Bootstrap')
}
