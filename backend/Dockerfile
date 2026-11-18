# ---- deps: all dependencies (used for tests and building) ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- dev: source + dev tools, used by the `test` service ----
FROM deps AS dev
COPY . .

# ---- build: compile TypeScript ----
FROM dev AS build
RUN npm run build && cp -r src/db/migrations dist/db/migrations

# ---- runtime: small production image shared by api / worker / dispatcher / scheduler ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
ENV STORAGE_DIR=/data
CMD ["node", "dist/bin/api.js"]
