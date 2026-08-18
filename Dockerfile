FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates tar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=3016 \
    DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 3016

CMD ["node", "src/server.js"]
