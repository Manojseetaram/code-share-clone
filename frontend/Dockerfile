# Build stage
FROM node:20-alpine as builder
WORKDIR /app
ARG VITE_WS_URL=wss://yourdomain.com
ENV VITE_WS_URL=$VITE_WS_URL
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Serve with nginx
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
# SPA fallback — all routes go to index.html
RUN echo 'server { \
  listen 80; \
  root /usr/share/nginx/html; \
  location / { try_files $uri $uri/ /index.html; } \
  location /api { proxy_pass http://backend:3001; } \
  location /ws { \
    proxy_pass http://backend:3001; \
    proxy_http_version 1.1; \
    proxy_set_header Upgrade $http_upgrade; \
    proxy_set_header Connection "Upgrade"; \
  } \
}' > /etc/nginx/conf.d/default.conf
EXPOSE 80