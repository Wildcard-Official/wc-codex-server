FROM node:22-slim

ENV INTERNAL_DOCKER_SHARED_SECRET="qZ3RnLGtMY4eX2bpvUJ0dHAsCrfI5KwOZxB1NuE97kgmPAhoyTlVcSW68tFnjQCx"

# Install git (required for cloning target repos)
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install global Codex CLI
RUN npm install -g @openai/codex

# Enable corepack to use yarn
RUN corepack enable && corepack prepare yarn@stable --activate

# Create non-root user for security and prepare writable workspace
RUN useradd -ms /bin/bash worker \
    && mkdir /workspace \
    && chown worker:worker /workspace
USER worker

WORKDIR /home/worker/app

# Copy package files first for better layer caching
COPY --chown=worker:worker package.json tsconfig.json ./

# Install dependencies (including devDeps for compilation)
RUN yarn install --non-interactive

# Copy source code
COPY --chown=worker:worker src ./src

# Build TypeScript
RUN yarn build

EXPOSE 8080

CMD ["node", "dist/index.js"]