FROM node:24-alpine
LABEL org.opencontainers.image.title="EnergiMCP" \
      org.opencontainers.image.description="Read-only MCP server for Danish energy data from Energinet's Energi Data Service." \
      org.opencontainers.image.source="https://github.com/manas-katyal/energimcp" \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="io.github.manas-katyal/energimcp"
WORKDIR /app
ENV NODE_ENV=production CACHE_DIR=/cache PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY data ./data
COPY public ./public
RUN mkdir -p /cache && chown -R node:node /cache
USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "src/server.ts"]
