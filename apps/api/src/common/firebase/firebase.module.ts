import { randomUUID } from 'node:crypto'

import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common'
import { type App, type AppOptions, cert, deleteApp, initializeApp } from 'firebase-admin/app'
import { Auth, getAuth } from 'firebase-admin/auth'
import { Firestore, getFirestore } from 'firebase-admin/firestore'

import type { BaseConfig } from '../config/config.js'
import { CONFIG } from '../config/config.module.js'

/** Injection token for the Firebase Admin app of this Nest application. */
export const FIREBASE_APP = Symbol('FIREBASE_APP')

/**
 * Options of the Firebase Admin app. A service account key named by `GOOGLE_APPLICATION_CREDENTIALS`
 * is loaded as a certificate credential, so custom tokens are signed locally with its private key;
 * the same key passed as Application Default Credentials would make the SDK sign through the IAM
 * `signBlob` API, which the service account has no role for. Without a key (emulators) the SDK
 * uses Application Default Credentials.
 * @param projectId Firebase project id
 * @param env process environment
 */
export function firebaseAppOptions(projectId: string, env: NodeJS.ProcessEnv): AppOptions {
  const keyFile = env.GOOGLE_APPLICATION_CREDENTIALS
  return keyFile ? { projectId, credential: cert(keyFile) } : { projectId }
}

function createFirebaseApp(config: BaseConfig): App {
  const { FIREBASE_AUTH_EMULATOR_HOST: auth, FIRESTORE_EMULATOR_HOST: firestore } = process.env
  if (auth || firestore) {
    // The Auth emulator accepts unsigned tokens, so this must never happen in production.
    const level = config.NODE_ENV === 'production' ? 'warn' : 'log'
    new Logger('Firebase')[level](`Using emulators: auth ${auth ?? 'off'}, firestore ${firestore ?? 'off'}`)
  }
  // A unique name keeps several Nest applications in one process (tests) independent.
  return initializeApp(firebaseAppOptions(config.GCP_PROJECT_ID, process.env), `app-${randomUUID()}`)
}

/**
 * Provides the Firebase Admin {@link Auth} and {@link Firestore} clients globally.
 *
 * The SDK connects to the local emulators when `FIREBASE_AUTH_EMULATOR_HOST` and
 * `FIRESTORE_EMULATOR_HOST` are set.
 */
@Global()
@Module({
  providers: [
    { provide: FIREBASE_APP, useFactory: createFirebaseApp, inject: [CONFIG] },
    { provide: Auth, useFactory: (app: App) => getAuth(app), inject: [FIREBASE_APP] },
    { provide: Firestore, useFactory: (app: App) => getFirestore(app), inject: [FIREBASE_APP] },
  ],
  exports: [Auth, Firestore],
})
export class FirebaseModule implements OnApplicationShutdown {
  constructor(@Inject(FIREBASE_APP) private readonly app: App) {}

  async onApplicationShutdown(): Promise<void> {
    await deleteApp(this.app)
  }
}
