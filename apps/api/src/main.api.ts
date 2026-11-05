import { createApiApp } from './api/api.module.js'
import { listen } from './common/bootstrap.js'
import { apiConfigSchema, parseConfig } from './common/config/config.js'

const config = parseConfig(apiConfigSchema, process.env)
const app = await createApiApp(config)
await listen(app, config.HOST, config.PORT)
