FROM node:22-slim

# Install git (required for cloning target repos)
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install global Codex CLI
RUN npm install -g @openai/codex

# Create non-root user for security and prepare writable workspace
RUN useradd -ms /bin/bash worker \
    && mkdir /workspace \
    && chown worker:worker /workspace
USER worker

WORKDIR /home/worker/app

# Copy agent source
COPY --chown=worker:worker package.json ./
RUN npm install --production --no-audit --no-fund --prefer-online

COPY --chown=worker:worker . .

EXPOSE 8080

ENTRYPOINT ["node", "index.js"]