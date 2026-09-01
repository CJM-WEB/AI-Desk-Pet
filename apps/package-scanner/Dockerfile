FROM node:22-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY packages/character-runtime/package.json packages/character-runtime/package.json
COPY packages/character-assets/package.json packages/character-assets/package.json
COPY apps/package-scanner/package.json apps/package-scanner/package.json
RUN pnpm install --frozen-lockfile --filter @myself/package-scanner...

COPY packages/shared-types packages/shared-types
COPY packages/character-runtime packages/character-runtime
COPY packages/character-assets packages/character-assets
COPY apps/package-scanner apps/package-scanner
RUN pnpm --filter @myself/package-scanner build \
  && pnpm --filter @myself/package-scanner deploy --prod --legacy /deploy

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates clamav dumb-init \
  && freshclam \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system scanner \
  && useradd --system --gid scanner --home-dir /nonexistent --shell /usr/sbin/nologin scanner \
  && mkdir -p /app /tmp/scan \
  && chown scanner:scanner /tmp/scan

COPY --from=builder --chown=root:root /deploy /app
COPY --from=builder --chown=root:root /workspace/apps/package-scanner/dist /app/dist

ENV NODE_ENV=production
ENV TMPDIR=/tmp/scan
WORKDIR /tmp/scan
USER scanner:scanner

ENTRYPOINT ["dumb-init", "--", "node", "/app/dist/local-scan-cli.js"]
