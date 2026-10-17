FROM node:20-alpine

RUN apk add --no-cache tzdata
ENV TZ=Asia/Ho_Chi_Minh

WORKDIR /app

COPY package.json package-lock.json* ./

# Có package-lock.json -> npm ci (đúng phiên bản đã khoá); chưa có -> npm install
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-fund --no-audit; else npm install --omit=dev --no-fund --no-audit; fi \
    && npm cache clean --force

COPY . .

# Không chạy bằng root
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=3000
ENV NODE_OPTIONS="--max-old-space-size=512"

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget -q -O- http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["node", "main.js"]
