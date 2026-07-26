# ==================== Stage 1: Dependencies ====================
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# ==================== Stage 2: Build ====================
FROM node:20-alpine AS builder
WORKDIR /app

# TypeScript already exceeds a 1 GiB heap in the multi-platform GitHub image build.
# Keep enough headroom for type-checking while still bounding Node's memory use.
ENV NODE_OPTIONS=--max-old-space-size=3072
ENV NEXT_BUILD_LOW_MEMORY=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Run strict gates serially so type-checking, linting, and webpack do not overlap in memory.
RUN npm run typecheck
RUN npm run lint:all

# Prisma generate + Next.js build (the low-memory config skips only the duplicate internal gates)
RUN npm run build

# ==================== Stage 3: Production ====================
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Install process supervision, video analysis, and public share-link import.
RUN apk add --no-cache tini ffmpeg yt-dlp

# node_modules（含 devDeps，因为 npm run start 需要 concurrently + tsx）
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Next.js 构建产物
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public

# Prisma schema（db push 需要）
COPY --from=builder /app/prisma ./prisma

# Worker 和 Watchdog 源码（tsx 运行 TypeScript）
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/lib ./lib

# 定价和配置标准
COPY --from=builder /app/standards ./standards

# 国际化 + 配置文件
COPY --from=builder /app/messages ./messages
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/middleware.ts ./middleware.ts
COPY --from=builder /app/postcss.config.mjs ./postcss.config.mjs

# 运行日志目录 + 空 .env（tsx --env-file=.env 需要文件存在，实际 env 由 docker-compose 注入）
RUN mkdir -p /app/logs && touch /app/.env

EXPOSE 3000 3010

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "run", "start"]
