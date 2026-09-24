# 多重测序条码子库审计页面 —— 零运行时依赖，Node 原生 ESM
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

# 无需 npm install：服务端与测试均仅使用 Node 内置模块
COPY package.json ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "src/server/server.js"]
