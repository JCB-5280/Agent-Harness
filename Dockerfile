# ---- stage 1: build the React/TS dashboard into public/ ----
FROM node:20-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY web/ ./
# vite is configured to output to ../public; redirect it into the stage's /public
RUN npm run build && ls -la /public/assets

# ---- stage 2: runtime ----
FROM node:20-bookworm-slim

# git + gh CLI are the agents' hands; curl/ca-certs for installs
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates gnupg \
    && (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg) \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (verify install method against current docs)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
# bring in the built dashboard from the web stage (overwrites any committed public/)
COPY --from=web /public ./public

# Non-root: the agent should not own the box it lives in
RUN useradd -m agent && chown -R agent:agent /app
USER agent

EXPOSE 8080
CMD ["node", "server/index.js"]
