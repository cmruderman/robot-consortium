FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Install gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Install Claude CLI (unpinned — always use latest)
RUN npm install -g @anthropic-ai/claude-code

# Copy and build RC
WORKDIR /rc
COPY package*.json tsconfig.json ./
COPY src/ src/
RUN npm ci && npm run build && npm link

# Create non-root user (Claude CLI refuses --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash rcuser
RUN mkdir -p /work && chown rcuser:rcuser /work
USER rcuser

WORKDIR /work
ENTRYPOINT ["rc"]
