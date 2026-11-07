import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'

import { ApiModule, configureApiApp } from '../../src/api/api.module.js'
import { BotModule } from '../../src/bot/bot.module.js'
import { ChatGateway } from '../../src/bot/chat-gateway.js'
import { NotificationConsumer } from '../../src/bot/notifications/notification.consumer.js'
import { TELEGRAM_BOT, TelegramPoller } from '../../src/bot/telegram-poller.js'
import { configureApp } from '../../src/common/bootstrap.js'
import { NetworkQuota } from '../../src/common/quota/network-quota.js'
import { ImageCdn } from '../../src/common/cloudinary/image-cdn.js'
import { ObjectStorage } from '../../src/common/r2/object-storage.js'
import { TaskQueue } from '../../src/common/tasks/task-queue.js'
import { WorkerModule } from '../../src/worker/worker.module.js'
import type { ApiConfig } from '../../src/common/config/config.js'
import { apiConfig, botConfig, workerConfig } from './config.js'
import {
  InMemoryChatGateway,
  InMemoryImageCdn,
  InMemoryNetworkQuota,
  InMemoryObjectStorage,
  RecordingTaskQueue,
} from './fakes.js'

/** An initialized API application whose R2 storage, CDN, task queue and network counters are in-memory fakes. */
export interface TestApiApp {
  app: NestExpressApplication
  storage: InMemoryObjectStorage
  cdn: InMemoryImageCdn
  tasks: RecordingTaskQueue
  networks: InMemoryNetworkQuota
}

/**
 * Creates the API against the emulators with in-memory replacements for R2, Cloudinary, the task
 * queue and the network counters.
 * @param config configuration of the API; the test configuration by default
 */
export async function createTestApiApp(config: ApiConfig = apiConfig): Promise<TestApiApp> {
  const storage = new InMemoryObjectStorage()
  const cdn = new InMemoryImageCdn()
  const tasks = new RecordingTaskQueue()
  const networks = new InMemoryNetworkQuota()
  const moduleRef = await Test.createTestingModule({ imports: [ApiModule.register(config)] })
    .overrideProvider(ObjectStorage)
    .useValue(storage)
    .overrideProvider(ImageCdn)
    .useValue(cdn)
    .overrideProvider(TaskQueue)
    .useValue(tasks)
    .overrideProvider(NetworkQuota)
    .useValue(networks)
    .compile()
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true })
  configureApiApp(configureApp(app), config)
  await app.init()
  return { app, storage, cdn, tasks, networks }
}

/** An initialized worker application whose R2 storage and CDN are in-memory fakes. */
export interface TestWorkerApp {
  app: NestExpressApplication
  storage: InMemoryObjectStorage
  cdn: InMemoryImageCdn
}

/** Creates the worker against the emulators with in-memory replacements for R2 and Cloudinary. */
export async function createTestWorkerApp(): Promise<TestWorkerApp> {
  const storage = new InMemoryObjectStorage()
  const cdn = new InMemoryImageCdn()
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule.register(workerConfig)] })
    .overrideProvider(ObjectStorage)
    .useValue(storage)
    .overrideProvider(ImageCdn)
    .useValue(cdn)
    .compile()
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true })
  configureApp(app)
  await app.init()
  return { app, storage, cdn }
}

/** An initialized bot application whose Telegram, R2 storage, CDN and task queue are in-memory fakes. */
export interface TestBotApp {
  app: NestExpressApplication
  chat: InMemoryChatGateway
  storage: InMemoryObjectStorage
  cdn: InMemoryImageCdn
  tasks: RecordingTaskQueue
}

/**
 * Creates the bot against the emulators with in-memory replacements for Telegram, R2, Cloudinary and
 * the task queue. Nothing polls Telegram or consumes the notification queue; tests call the handlers.
 */
export async function createTestBotApp(): Promise<TestBotApp> {
  const chat = new InMemoryChatGateway()
  const storage = new InMemoryObjectStorage()
  const cdn = new InMemoryImageCdn()
  const tasks = new RecordingTaskQueue()
  const moduleRef = await Test.createTestingModule({ imports: [BotModule.register(botConfig)] })
    .overrideProvider(TELEGRAM_BOT)
    .useValue({})
    .overrideProvider(ChatGateway)
    .useValue(chat)
    .overrideProvider(TelegramPoller)
    .useValue({})
    .overrideProvider(NotificationConsumer)
    .useValue({})
    .overrideProvider(ObjectStorage)
    .useValue(storage)
    .overrideProvider(ImageCdn)
    .useValue(cdn)
    .overrideProvider(TaskQueue)
    .useValue(tasks)
    .overrideProvider(NetworkQuota)
    .useValue(new InMemoryNetworkQuota())
    .compile()
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true })
  configureApp(app)
  await app.init()
  return { app, chat, storage, cdn, tasks }
}
