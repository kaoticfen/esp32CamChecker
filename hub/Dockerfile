# Node 24 runs the server's TypeScript directly via type stripping, so the
# image ships the sources -- only the browser bundle needs a build step.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.web.json esbuild.config.mjs ./
COPY src ./src
RUN npm run build && npm run typecheck

FROM node:24-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PUBLIC_DIR=/app/public \
    HUB_HOST=0.0.0.0
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/public ./public
COPY src/server ./src/server
COPY tools/healthcheck.mjs ./tools/healthcheck.mjs

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080 8443

HEALTHCHECK --interval=30s --timeout=6s --start-period=10s --retries=3 \
  CMD ["node", "tools/healthcheck.mjs"]

CMD ["node", "src/server/main.ts"]
