FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.app.json ./
COPY postcss.config.cjs tailwind.config.ts vite.config.ts index.html ./
COPY src ./src

ARG VITE_API_TOKEN
ARG VITE_API_BASE_URL
ENV VITE_API_TOKEN=$VITE_API_TOKEN
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN npm run build

FROM nginx:stable-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 5173
