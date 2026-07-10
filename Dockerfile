FROM node:20-bookworm-slim

WORKDIR /app

COPY server/package.json ./server/
RUN cd server && npm install --omit=dev

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
VOLUME /data

CMD ["node", "server/server.js"]
