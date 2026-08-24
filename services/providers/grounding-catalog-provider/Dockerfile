ARG NODE_BASE_IMAGE=node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
FROM ${NODE_BASE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY services/stas/package.json services/stas/package-lock.json services/stas/
RUN npm --prefix services/stas ci --ignore-scripts
COPY tsconfig.json vitest.config.ts ./
COPY packages ./packages
COPY services ./services
COPY simulator ./simulator
COPY scripts ./scripts
COPY tests ./tests
RUN npm run build

FROM ${NODE_BASE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY services/stas/package.json services/stas/package-lock.json services/stas/
RUN npm --prefix services/stas ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8090 8091 8093
CMD ["node", "dist/services/providers/grounding-catalog-provider/src/index.js"]
