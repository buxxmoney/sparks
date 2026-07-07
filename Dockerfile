# Sparks API server (apps/server) — container image for Railway/Render/Fly.
#
# Based on the official Playwright image PINNED to the installed Playwright version
# (1.61.1) so the sealed-PDF renderer (reports.ts → chromium) finds a matching,
# preinstalled Chromium + all its system libraries. Also installs poppler-utils so
# invoice parsing can use the fast pdftotext path (it falls back to Chromium-vision
# without it). tsx runs the TypeScript entrypoint directly — no build step.
#
# If the exact tag ever 404s, try the "-jammy" suffix, or bump to the current
# Playwright version (keep it equal to the `playwright` version in
# apps/server/package.json's lockfile).
FROM mcr.microsoft.com/playwright:v1.61.1-noble

# pdftotext for the fast invoice text-extraction path.
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*

# Bun for the workspace install (matches bun.lock). The base image already has Node.
RUN npm install -g bun@1.3.14

WORKDIR /app

# Install deps. Copy the whole repo (node_modules/.env excluded via .dockerignore),
# then a single workspace install resolves @sparks/db, @sparks/api, etc.
COPY . .
RUN bun install

ENV NODE_ENV=production
# Railway/Render inject PORT; the server reads process.env.PORT (default 3001).
EXPOSE 3001

# Run the TS entrypoint via tsx (same as dev), on Node.
CMD ["npx", "tsx", "apps/server/src/index.ts"]
