# Cloudflare R2

Originals and results are stored in R2 and accessed through the S3 API. Buckets are private; clients only use presigned URLs.

| Environment | Bucket |
|---|---|
| Development | `onetodone-compress-dev` |
| Production | a bucket of its own, with its own token |

## Bucket

- Location: automatic with the location hint *Western Europe*, close to the API and to Firestore (`europe-west3`). No jurisdiction: it would change the endpoint host to `*.eu.r2.cloudflarestorage.com`.
- Storage class: Standard.
- Public access: disabled.

## API token

R2 → *Manage API tokens* → *Create Account API token*:

- Permissions: **Object Read & Write**, applied to the bucket only. One token per bucket, so the development token cannot touch production files.
- Put the Access Key ID and Secret Access Key into `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, and the account ID from the R2 overview into `R2_ACCOUNT_ID`.

## CORS

Browsers upload originals with a presigned `PUT` and read results with a presigned `GET`, so the bucket must allow both from the web origins, including the `Content-Type` header that the upload URL is signed with. `GET` is needed for more than links and `<img>`: "Download all" fetches every result with `fetch` to build a ZIP, which only works when the response carries `Access-Control-Allow-Origin`. Without this policy, uploads and "Download all" fail in the browser with a CORS error (`curl` is not affected).

Bucket → *Settings* → *CORS Policy* → *Add CORS policy*, then paste the policy for the environment:

- Development: [`cors.dev.json`](cors.dev.json) (`http://localhost:3000`).
- Production: the same policy with the production web origins (the Hosting domains) in `AllowedOrigins`.

## Lifecycle rules

Bucket → *Settings* → *Object lifecycle rules*:

| Rule | Prefix | Action |
|---|---|---|
| Delete originals | `originals/` | delete objects 1 day after upload |
| Delete results | `results/` | delete objects 7 days after upload |
