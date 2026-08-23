FROM node:22.14.0-bookworm-slim AS build
WORKDIR /workspace
COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
COPY services ./services
RUN npm ci --ignore-scripts && npm --workspace @gowm/elevation-mock-provider run build

FROM node:22.14.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/services/providers/elevation-mock/dist ./dist
USER node
EXPOSE 33010
CMD ["node", "dist/services/providers/elevation-mock/src/index.js"]
