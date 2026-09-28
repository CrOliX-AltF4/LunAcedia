FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY source/ ./source/
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Every persisted file (dedup, the box, guard rules and journal, tiers, tokens) goes here — the volume the
# deployment mounts. Unset, it fell back to ~/.lunacedia inside the container and died with each update.
ENV STORAGE_DIR=/data
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/index.js"]
