import { createBotApp } from './bot/bot.module.js'
import { listen } from './common/bootstrap.js'
import { botConfigSchema, parseConfig } from './common/config/config.js'

const config = parseConfig(botConfigSchema, process.env)
const app = await createBotApp(config)
await listen(app, config.HOST, config.PORT)
