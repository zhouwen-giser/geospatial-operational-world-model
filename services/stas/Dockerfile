ARG NODE_BASE_IMAGE=node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
FROM ${NODE_BASE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_BASE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --gid 10001 stas && useradd --uid 10001 --gid stas --no-create-home --shell /usr/sbin/nologin stas
COPY --from=build --chown=stas:stas /app/package.json ./package.json
COPY --from=build --chown=stas:stas /app/node_modules ./node_modules
COPY --from=build --chown=stas:stas /app/dist ./dist
USER 10001:10001
EXPOSE 8080
CMD ["node", "dist/server.js"]
