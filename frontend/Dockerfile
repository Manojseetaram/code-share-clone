# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# ── Serve with nginx ───────────────────────────────────────────────────────────
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html

# SPA fallback + reverse-proxy to backend container
# NOTE: no VITE_WS_URL needed — the browser connects to the same host/port
# and nginx proxies /api and /ws to the backend service.
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80