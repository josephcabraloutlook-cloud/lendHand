FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production DATABASE_PATH=/data/lendhand.db PORT=3000
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
