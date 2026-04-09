FROM node:22-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app

COPY tsconfig.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY src ./src
RUN npx prisma generate && npm run build

FROM node:22-bookworm-slim AS production
WORKDIR /app

ENV NODE_ENV=production

# libheif + libvips for HEIC/HEIF thumbnail generation, ffmpeg for video frames
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev libheif-dev ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY --from=build /app/dist ./dist
COPY --from=build /app/src/generated ./dist/generated
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts

# Run as non-root user
USER node

EXPOSE 3000
CMD ["npm", "run", "start"]