# framer-cms-sync: HTTP API + MCP over HTTP, with the terminal app available inside.
#   docker build -t framer-cms-sync .
#   docker run -d --name framer-cms-sync -v "$PWD/my-site:/config" -p 127.0.0.1:8080:8080 framer-cms-sync
#   docker exec -it framer-cms-sync sh                   # opens the terminal app (first time: setup); q for the shell
# /config holds framer-cms-sync.config.yaml, .env and local state. On a fresh volume the service
# waits for setup, then starts serving as soon as a site and an access token exist.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /config
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
COPY package.json /app/package.json
# Guides for people and agents: `framer-cms-sync skills`.
COPY skills /app/skills
# Put the CLI on the PATH, so `docker exec -it <container> framer-cms-sync` opens the terminal app.
RUN chmod +x /app/dist/cli/index.js && ln -s /app/dist/cli/index.js /usr/local/bin/framer-cms-sync
ENV TERM=xterm-256color
# Any interactive shell (docker exec -it … sh/bash, Docker Desktop's Exec tab) opens the terminal app first.
COPY docker/open-app.sh /etc/framer-cms-sync/open-app.sh
RUN echo ". /etc/framer-cms-sync/open-app.sh" >> /etc/bash.bashrc
ENV ENV=/etc/framer-cms-sync/open-app.sh
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
# Listen on all interfaces inside the container; publish the port on 127.0.0.1 on the host.
CMD ["node", "/app/dist/cli/index.js", "serve", "--host", "0.0.0.0"]
