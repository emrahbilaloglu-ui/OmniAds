FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat

FROM base AS deps
# Built from /build, never /app.
#
# With the project root at `/app`, the root layout's absolute path is
# `/app/app/layout.tsx` -- character for character the repo-relative path of the
# canonical `/app` segment layout, `app/app/layout.tsx`. The app-router build
# collapses the two into ONE module and binds the canonical layout to the root
# layout slot. Proven in this image, on this source: rooted at /app both slots
# return the same module; rooted at /build they return the two different modules
# they should.
#
# What that cost, before it was found: the root layout is where `QueryProvider`
# lives, so with the wrong module in that slot no page could reach a
# QueryClient -- every route that calls `useQuery` died with "No QueryClient
# set" -- and every route rendered inside the canonical `/app` shell, so the
# dashboard drew a second rail beside its own.
#
# It reproduces only on Linux with the root at exactly `/app`; a macOS build at
# any path, and a Linux build at any other path, are both correct. That is why
# CI never saw it: CI type-checks, tests and builds in the workspace directory,
# and only the image -- the artifact that actually ships -- built from `/app`.
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS builder
WORKDIR /build
ENV NEXT_TELEMETRY_DISABLED=1
ENV DISABLE_WEBPACK_CACHE=1
# The default heap is not enough for this tree; the build OOMs without it.
# Matched to the CI build job. The branch grew the TypeScript program enough
# that `next build` -- webpack graph plus type-check in one process -- exceeded
# 2GB on CI; 4096 left little margin for the image build that actually ships.
ENV NODE_OPTIONS=--max-old-space-size=6144
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
# The same identity under a name docker-compose.yml never mentions.
# `environment:` overrides the image's own ENV, so a stale APP_BUILD_ID on the
# host silently renames the running build. This copy cannot be overwritten from
# the host, so the process can prove which image it actually is.
ENV ADSECUTE_IMAGE_BUILD_ID=$APP_BUILD_ID
COPY --from=builder /build/.next/standalone /app
COPY --from=builder /build/.next/static /app/.next/static
COPY --from=builder /build/public /app/public
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
# The same identity under a name docker-compose.yml never mentions.
# `environment:` overrides the image's own ENV, so a stale APP_BUILD_ID on the
# host silently renames the running build. This copy cannot be overwritten from
# the host, so the process can prove which image it actually is.
ENV ADSECUTE_IMAGE_BUILD_ID=$APP_BUILD_ID
ENV SYNC_WORKER_MODE=1
COPY --from=builder /build/package.json /build/package-lock.json /app/
COPY --from=deps /build/node_modules /app/node_modules
COPY --from=builder /build/app /app/app
COPY --from=builder /build/lib /app/lib
COPY --from=builder /build/providers /app/providers
COPY --from=builder /build/scripts /app/scripts
# The recovery tier policy travels with the cutover wrapper.
COPY --from=builder /build/deploy /app/deploy
COPY --from=builder /build/src /app/src
COPY --from=builder /build/store /app/store
COPY --from=builder /build/hooks /app/hooks
COPY --from=builder /build/components /app/components
COPY --from=builder /build/next.config.ts /app/next.config.ts
COPY --from=builder /build/next-env.d.ts /app/next-env.d.ts
COPY --from=builder /build/tsconfig.json /app/tsconfig.json
COPY --from=builder /build/postcss.config.mjs /app/postcss.config.mjs
CMD ["npm", "run", "worker:start"]
