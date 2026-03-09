# ── Stage 1: Build the webapp ─────────────────────────────────────────────────
FROM node:20-alpine AS webapp

WORKDIR /webapp
COPY webapp/package*.json ./
RUN npm install
COPY webapp/ .
RUN npm run build
# Output: /webapp/dist/

# ── Stage 2: Server ────────────────────────────────────────────────────────────
FROM node:20-alpine

# better-sqlite3 requires native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY server/package*.json ./
RUN npm install --omit=dev

COPY server/ .

# Serve the built webapp as the captive portal (Pi mode)
# In TrueNAS mode this is unused but harmless
COPY --from=webapp /webapp/dist ./public

ENV PORT=3001
ENV DB_PATH=/data/skybox.db

EXPOSE 3001

CMD ["node", "index.js"]
