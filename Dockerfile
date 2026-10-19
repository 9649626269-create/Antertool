FROM node:20-alpine

# tzdata + wget (dùng cho HEALTHCHECK)
RUN apk add --no-cache tzdata wget
ENV TZ=Asia/Ho_Chi_Minh

WORKDIR /app

COPY package.json package-lock.json ./

# Ưu tiên npm ci vì đã có package-lock.json khóa phiên bản
RUN npm ci --omit=dev --no-fund --no-audit \
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
