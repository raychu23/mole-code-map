FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci --omit=dev=false && npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
# T69: @mole/server's node_modules/@mole/* entries are workspace symlinks (e.g.
# node_modules/@mole/decisions -> ../../packages/decisions) -- copying only dist/src +
# package.json for @mole/server itself left every symlink target missing, so `node
# dist/src/index.js` failed at startup with ERR_MODULE_NOT_FOUND for @mole/decisions (found
# running `docker compose up` for this task, before this fix -- see 2 insights.md). Copy the
# whole built `packages/` tree so every workspace package a symlink can point to actually
# exists in the final image, not just @mole/server's own dist.
COPY --from=build /app/packages ./packages
EXPOSE 3000
CMD ["node", "packages/server/dist/src/index.js"]
