# syntax=docker/dockerfile:1

# One image serves all processes:
#   API     node dist/main.api.js (default command)
#   worker  node dist/main.worker.js
#   bot     node dist/main.bot.js

FROM node:24-slim AS base
RUN npm install -g corepack@latest && corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter "@onetodone/compress-api..."
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter "@onetodone/compress-api..." run build \
  && pnpm --filter @onetodone/compress-api deploy --prod --legacy /out

FROM node:24-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 8080
# Started with node directly so SIGTERM reaches the app.
CMD ["node", "--enable-source-maps", "dist/main.api.js"]
