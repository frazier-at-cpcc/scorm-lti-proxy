FROM node:20-bookworm

# Install useful development tools
RUN apt-get update && apt-get install -y \
    git \
    curl \
    vim \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /workspace

# Create non-root user
ARG USERNAME=node
ARG USER_UID=1000
ARG USER_GID=$USER_UID

# Create directories for content and uploads
RUN mkdir -p /workspace/content /workspace/uploads \
    && chown -R node:node /workspace

USER node

# Install global npm packages
RUN npm install -g tsx typescript
