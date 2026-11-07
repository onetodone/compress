# Compress OneToDone

Upload JPEG, PNG, WebP, AVIF or HEIC images and PDF documents, one or many at once, and download smaller versions in the same format. A background worker compresses each image with `sharp` (HEIC with the libheif tools) and each PDF with Ghostscript; every file appears in one list that updates in real time with its state, thumbnail and size saved. Download results one by one or all together as a ZIP. Anonymous users get a small daily quota; signing in with Google raises it.

## Stack

- **Web:** Next.js (App Router, static export) and Tailwind CSS on Firebase Hosting
- **API and worker:** NestJS, one build with two entrypoints, run as two services on a Linux server
- **Data and auth:** Firestore and Firebase Auth
- **Storage and delivery:** Cloudflare R2 for files, Cloudinary for previews
- **Background jobs:** BullMQ on Redis

## Requirements

- Node.js 24
- pnpm 12 (version pinned in `package.json`)
- Java 21 for the Firebase emulators (the Firebase CLI is a dev dependency)
- Redis 7 or later on `127.0.0.1:6379` (job queue)
- Ghostscript for PDF compression (`apt install ghostscript`); optional: with `GHOSTSCRIPT_PATH` empty, PDF files are refused
- The libheif tools for HEIC compression (`apt install libheif-examples libheif-plugin-libde265 libheif-plugin-x265`); optional: with `HEIF_TOOLS_DIR` empty, HEIC files are refused

## Getting started

```bash
pnpm install
cp .env.example .env
pnpm emulators   # in a separate terminal
pnpm dev
```

Open http://localhost:3000 and drop one or more images or PDF files. The web app reads its `NEXT_PUBLIC_*` variables from the same root `.env`; with `NEXT_PUBLIC_USE_EMULATORS=true` it talks to the local emulators.

The API enqueues compression jobs in Redis (`REDIS_URL`, database 4 by default) and the worker consumes them; a job is retried with exponential backoff up to `QUEUE_MAX_ATTEMPTS` times. Once an hour the worker also removes stale jobs: uploads that never finished after a day, jobs left without a task in Redis (marked failed, quota returned) and jobs older than their results (7 days, files included). Integration tests use database 15 (`TEST_REDIS_URL`) and flush it.

Locally the API uses the Firebase Auth and Firestore emulators (UI on http://127.0.0.1:4000). Every route except `GET /health` requires a Firebase ID token in `Authorization: Bearer <token>`.

Uploads go to a real Cloudflare R2 bucket: fill in the `R2_*` variables in `.env` and apply the bucket's CORS policy as described in [`infra/r2/README.md`](infra/r2/README.md). Thumbnails can come from Cloudinary: set `CLOUDINARY_URL` to the API environment variable of a key that may upload and delete assets. Without it, the browser loads results from R2.

### Compressing a file

1. `POST /jobs` with `{ "originalName", "contentType", "size", "settings": { "preset" } }` returns `jobId` and a presigned `uploadUrl`, valid for 10 minutes. `contentType` is `image/jpeg`, `image/png`, `image/webp`, `image/avif` or, when HEIC or PDF compression is on, `image/heic` or `application/pdf`, each up to 20 MB; `GET /me` lists the accepted types and limits in `limits.formats`. `preset` is `balanced` (default) or `smaller`; for PDF files it downsamples images to 150 or 100 dpi.
2. `PUT` the file to `uploadUrl` with the same `Content-Type`. R2 rejects a body whose type or size differs from the declared one.
3. `POST /jobs/:id/submit` checks the upload, counts the job against the daily quota and queues it for compression. Daily limits come from `QUOTA_*` variables; anonymous jobs are also limited per client network (IPv4 address or IPv6 /64), so new anonymous sessions do not add free jobs without bound. The API takes the client address from `X-Forwarded-For` only when the request comes from a proxy on the same host.
4. The browser follows `jobs/{jobId}` in Firestore until the job is `done` or `failed`. `GET /jobs?limit=&cursor=` lists the user's jobs, newest first.
5. `GET /jobs/:id/download` returns a presigned URL, valid for 5 minutes, that saves the compressed file under the original name (`?disposition=inline` lets the browser display it instead). `DELETE /jobs/:id` removes the job, its files in R2 and its Cloudinary preview, if any.

## Scripts

| Script | Description |
|---|---|
| `pnpm dev` | Start all apps in development mode (web on port 3000, API on 3001, worker on 3002) |
| `pnpm start` | Start the built API and worker |
| `pnpm emulators` | Start the Firebase Auth (9099) and Firestore (8080) emulators |
| `pnpm build` | Build every workspace; the web app is exported to `apps/web/out` |
| `pnpm typecheck` | Type-check every workspace |
| `pnpm lint` / `pnpm lint:check` | Lint and fix / lint only |
| `pnpm format` / `pnpm format:check` | Format / check formatting |
| `pnpm test` | Run unit and integration tests |
| `pnpm test:unit` | Run unit tests only |
| `pnpm test:integration` | Run integration tests against their own emulator instance (ports 9199 and 8180) |

## Deployment

- **API and worker:** built from the repository on a Linux server and run as two services (`node dist/main.api.js`, `node dist/main.worker.js`) behind a reverse proxy, with Redis on the same host. PDF compression needs the `ghostscript` package on the server and `GHOSTSCRIPT_PATH` set, HEIC compression the libheif tools and `HEIF_TOOLS_DIR` set; the worker refuses to start when a configured tool cannot be run. Every variable is described in `.env.example`; in production `firebase-admin` reads a service account key with `roles/datastore.user` through `GOOGLE_APPLICATION_CREDENTIALS`, and `METADATA_SERVER_DETECTION=none` skips the Google Cloud metadata lookup.
- **Web app:** static export on Firebase Hosting (`infra/firebase.json`). Firebase serves only files inside the config's directory, so the export in `apps/web/out` is copied to `infra/hosting` before `firebase deploy --only hosting`.
- **Auth:** anonymous and Google providers enabled. Google sign-in uses a popup on `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`; set it to the web app's own Hosting domain so the sign-in handler is same-origin, list that domain under Auth's authorized domains, and add `https://<web domain>/__/auth/handler` to the redirect URIs of the OAuth web client.
- **Firestore:** `firebase deploy --only firestore:rules,firestore:indexes --config infra/firebase.json --project <project>`.
- **R2:** production bucket with the CORS policy and lifecycle rules from [`infra/r2/README.md`](infra/r2/README.md).

`.github/workflows/ci.yml` checks every push and pull request. After a green CI run on `main`, `.github/workflows/deploy.yml` deploys the API and the worker over SSH to a command bound to the deploy key, then builds the web app and deploys it to Hosting with Workload Identity Federation (no key). It reads from the GitHub environment `production`:

| Kind | Name |
|---|---|
| Secrets | `DEPLOY_TARGET`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` |
| Variables | `FIREBASE_PROJECT_ID`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_APP_ID` |

## Docker

`apps/api/Dockerfile` builds one image for both services, with Ghostscript and the libheif tools installed, `GHOSTSCRIPT_PATH=gs` and `HEIF_TOOLS_DIR=/usr/bin`. It starts the API by default; the worker runs with `node dist/main.worker.js`.

```bash
docker compose up --build
```

Compose also starts Redis and the Firebase Auth and Firestore emulators (ports 9099 and 8080), so the stack runs without a Google Cloud project, and serves the static export of the web app on http://localhost:3000. The API and the worker read the `R2_*` and `CLOUDINARY_*` variables from `.env`.

## Repository layout

```
apps/
  web/        Next.js app
  api/        NestJS API and worker
packages/
  shared/     file format registry, zod schemas, job status and quota helpers shared by web and api
infra/        Firebase config (hosting, emulators), Firestore rules and indexes, R2 setup
.github/      CI and deploy workflows
```

## License

MIT
