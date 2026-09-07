# Multi-stage build for the standalone MCQ study site on Fly.io.
# Stage 1: build the client + server bundle
FROM node:20-slim AS builder

WORKDIR /app

# Native build tools needed for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: production runtime
FROM node:20-slim

WORKDIR /app

# better-sqlite3 needs libc runtime; python/build tools also needed for rebuild
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev && npm rebuild better-sqlite3

COPY --from=builder /app/dist ./dist

# Volume mount point for the SQLite database
RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/data/data.db

EXPOSE 8080

CMD ["node", "dist/index.cjs"]
