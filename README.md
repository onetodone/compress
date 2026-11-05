# OneToDone Image Compressor

Upload JPEG or PNG images and download smaller versions. A background worker compresses each image with `sharp`, and the browser shows the result in real time with a before/after comparison, the size saved and a download link. Anonymous users get a small daily quota; signing in with Google raises it.

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

## Getting started

```bash
pnpm install
cp .env.example .env
pnpm emulators   # in a separate terminal
pnpm dev
```

Open http://localhost:3000 and drop an image. The web app reads its `NEXT_PUBLIC_*` variables from the same root `.env`; with `NEXT_PUBLIC_USE_EMULATORS=true` it talks to the local emulators.

The API enqueues compression jobs in Redis (`REDIS_URL`, database 4 by default) and the worker consumes them; a job is retried with exponential backoff up to `QUEUE_MAX_ATTEMPTS` times. Integration tests use database 15 (`TEST_REDIS_URL`) and flush it.

Locally the API uses the Firebase Auth and Firestore emulators (UI on http://127.0.0.1:4000). Every route except `GET /health` requires a Firebase ID token in `Authorization: Bearer <token>`.

Uploads go to a real Cloudflare R2 bucket: fill in the `R2_*` variables in `.env` and apply the bucket's CORS policy as described in [`infra/r2/README.md`](infra/r2/README.md). Thumbnails can come from Cloudinary: set `CLOUDINARY_URL` to the API environment variable of a key that may upload and delete assets. Without it, the browser loads results from R2.

### Compressing an image

1. `POST /jobs` with `{ "originalName", "contentType", "size" }` returns `jobId` and a presigned `uploadUrl`, valid for 10 minutes.
2. `PUT` the file to `uploadUrl` with the same `Content-Type`. R2 rejects a body whose type or size differs from the declared one.
3. `POST /jobs/:id/submit` checks the upload, counts the job against the daily quota and queues it for compression.
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

## Docker

`apps/api/Dockerfile` builds one image for both services. It starts the API by default; the worker runs with `node dist/main.worker.js`.

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
  shared/     zod schemas, job status and quota limits shared by web and api
infra/        Firebase config, Firestore rules and indexes, R2 setup
```

## License

MIT
