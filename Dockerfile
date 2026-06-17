FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production \
    DATA_FILE=/app/data/accounts.json

# Зависимостей нет (только stdlib Node) — копируем код как есть.
COPY package.json server.js index.html ./

RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "server.js"]
