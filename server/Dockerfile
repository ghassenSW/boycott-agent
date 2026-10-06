# Boycott Agent API.
# Build context is the PROJECT ROOT (see docker-compose.yml), because the server
# reads ../schema.sql and ../schema-verifier.sql at boot.

FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app/server

# Dependencies first, so editing code doesn't reinstall them on every build.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/src ./src
COPY schema.sql schema-verifier.sql schema-budget.sql /app/

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node directly (not npm start) so docker stop's SIGTERM reaches the server and it shuts down cleanly.
CMD ["node", "src/index.js"]
