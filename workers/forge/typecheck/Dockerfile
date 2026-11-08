# The Forge type-check Container (ADR-0012 §5c). Owner decision 2026-11-08: Containers for the
# type-check only. The base image is pinned by digest; the compiler comes from package-lock.json.
FROM node:22.23.4-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
WORKDIR /opt/typecheck
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY server.mjs ./
USER node
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "--max-old-space-size=768", "server.mjs"]
