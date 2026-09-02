ARG NODE_BASE_IMAGE=node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
FROM ${NODE_BASE_IMAGE} AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY adapters ./adapters
COPY services ./services
COPY openapi ./openapi
COPY grids ./grids
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --no-fund --fetch-retries=3 --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=60000
RUN --mount=type=cache,target=/root/.npm \
    for attempt in 1 2 3; do \
      if npm rebuild gdal-async --foreground-scripts --no-audit --no-fund \
        && node -e "import('gdal-async').then(() => process.stdout.write('gdal-async runtime OK\\n'))"; then break; fi; \
      test "$attempt" -lt 3 || exit 1; \
      rm -rf /app/node_modules/gdal-async/lib/binding; \
    done
RUN npm run build
RUN cp -R grids/. node_modules/gdal-async/deps/libproj/proj/data/
RUN npm --prefix node_modules/gdal-async run prune
RUN npm prune --omit=dev

FROM ${NODE_BASE_IMAGE} AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    PROJ_NETWORK=OFF \
    PROJ_ONLY_BEST_DEFAULT=YES \
    CRS_MAX_POINTS=100000 \
    CRS_MAX_VERTICES=100000 \
    CRS_MAX_REQUEST_BYTES=16777216 \
    CRS_REQUEST_TIMEOUT_MS=30000

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/adapters ./adapters
COPY --from=build --chown=node:node /app/services ./services
COPY --from=build --chown=node:node /app/openapi ./openapi

USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "services/crs-api/dist/main.js"]
