import { listen } from './common/bootstrap.js'
import { parseConfig, workerConfigSchema } from './common/config/config.js'
import { createWorkerApp } from './worker/worker.module.js'

const config = parseConfig(workerConfigSchema, process.env)
const app = await createWorkerApp(config)
await listen(app, config.HOST, config.PORT)
