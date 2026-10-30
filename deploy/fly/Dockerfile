# Same image as ../../Dockerfile, for Fly.io (see fly.toml and docs/04-despliegue.md).
# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY server server
COPY web web
RUN npm run build -w web && npm run build -w server && npm prune --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /data && chown -R node:node /data
# Fly.io mounts volumes owned by root: start as root only to hand /data to the node user, then
# run the app as node (setpriv comes with Debian's util-linux).
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Listens on 8080, the internal_port Fly's launcher configures. Without a PUBLIC_URL of its own (or
# with the example one), the app's address is <app>.fly.dev, from FLY_APP_NAME that Fly sets.
CMD ["sh", "-c", "chown -R node:node /data; case \"$PUBLIC_URL\" in ''|*leadlibre-tucomunidad*) [ -n \"$FLY_APP_NAME\" ] && export PUBLIC_URL=https://$FLY_APP_NAME.fly.dev;; esac; export PORT=8080; exec setpriv --reuid=node --regid=node --init-groups node server/dist/index.js"]
