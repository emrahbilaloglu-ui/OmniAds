FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS builder
ENV NEXT_TELEMETRY_DISABLED=1
ENV DISABLE_WEBPACK_CACHE=1
# The default heap is not enough for this tree; the build OOMs without it.
ENV NODE_OPTIONS=--max-old-space-size=4096
COPY . .
RUN npm run build

FROM base AS web-runner
ARG APP_BUILD_ID=dev-build
# Immutable release identity carried BY the image. A tag is mutable and a
# digest says nothing about which commit produced it; this label is what the
# cutover checks the running container against.
LABEL org.opencontainers.image.revision=$APP_BUILD_ID
LABEL com.adsecute.release.role=web-runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV APP_BUILD_ID=$APP_BUILD_ID
COPY --from=builder /app/.next/standalone /app
COPY --from=builder /app/.next/static /app/.next/static
COPY --from=builder /app/public /app/public
EXPOSE 3000
CMD ["node", "server.js"]

FROM base AS worker-runner
ARG APP_BUILD_ID=dev-build
# Immutable release identity carried BY the image. A tag is mutable and a
# digest says nothing about which commit produced it; this label is what the
# cutover checks the running container against.
LABEL org.opencontainers.image.revision=$APP_BUILD_ID
LABEL com.adsecute.release.role=worker-runner
ENV NODE_ENV=production
ENV APP_BUILD_ID=$APP_BUILD_ID
ENV SYNC_WORKER_MODE=1
COPY --from=builder /app/package.json /app/package-lock.json /app/
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=builder /app/app /app/app
COPY --from=builder /app/lib /app/lib
COPY --from=builder /app/providers /app/providers
COPY --from=builder /app/scripts /app/scripts
# The recovery tier policy travels with the cutover wrapper.
COPY --from=builder /app/deploy /app/deploy
COPY --from=builder /app/src /app/src
COPY --from=builder /app/store /app/store
COPY --from=builder /app/hooks /app/hooks
COPY --from=builder /app/components /app/components
COPY --from=builder /app/next.config.ts /app/next.config.ts
COPY --from=builder /app/next-env.d.ts /app/next-env.d.ts
COPY --from=builder /app/tsconfig.json /app/tsconfig.json
COPY --from=builder /app/postcss.config.mjs /app/postcss.config.mjs
CMD ["npm", "run", "worker:start"]
