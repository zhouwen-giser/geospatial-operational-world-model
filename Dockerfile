ARG NODE_BASE_IMAGE=node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
FROM ${NODE_BASE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY services/stas/package.json services/stas/package-lock.json services/stas/
RUN npm --prefix services/stas ci --ignore-scripts
COPY tsconfig.json tsconfig.runtime.json ./
COPY packages ./packages
COPY services ./services
COPY simulator ./simulator
COPY scripts ./scripts
COPY validation ./validation
COPY contracts ./contracts
COPY config ./config
RUN npm run build:runtime

FROM ${NODE_BASE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY services/stas/package.json services/stas/package-lock.json services/stas/
RUN npm --prefix services/stas ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/services/stas/dist ./services/stas/dist
COPY --chown=node:node database ./database
COPY --chown=node:node config ./config
COPY --chown=node:node contracts ./contracts
COPY --chown=node:node scripts ./scripts
USER node
# Fail closed when a normalized archive context produces stale COPY bytes.
RUN node --input-type=module -e 'import fs from "node:fs"; import {createOperationalRealityProvider} from "./dist/services/providers/operational-reality-provider/src/provider.js"; const actual=createOperationalRealityProvider({pool:{}}).runtime.manifest; const declared=JSON.parse(fs.readFileSync("contracts/manifests/providers/operational-reality-provider.json","utf8")); if(JSON.stringify(actual)!==JSON.stringify(declared)) throw new Error("Operational Provider manifest/runtime mismatch");'
CMD ["node", "dist/services/world-api/src/index.js"]
