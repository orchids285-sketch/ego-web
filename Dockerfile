# ego-web — deployable browser for AI agents (web version of ego-lite)
# Chromium + its system libs are installed by playwright itself, so this image
# stays version-consistent with whatever playwright npm resolves.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    EGO_DATA_DIR=/data \
    EGO_HEADLESS=1

WORKDIR /app

# deps first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npx playwright install --with-deps chromium \
 && rm -rf /root/.npm

COPY server.mjs ./
COPY public ./public

# task spaces (persistent logged-in profiles) live here — mount a volume on /data
RUN mkdir -p /data/spaces
VOLUME ["/data"]

EXPOSE 8080
CMD ["node", "server.mjs"]
