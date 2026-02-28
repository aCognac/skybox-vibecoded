FROM node:20-alpine

# better-sqlite3 requires native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3001
ENV DB_PATH=/data/loads.db

EXPOSE 3001

CMD ["node", "index.js"]
