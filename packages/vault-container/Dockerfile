FROM node:22-slim

# better-sqlite3 ships a prebuilt binary for this platform; if the postinstall
# ever needs to compile instead, this build fails loudly rather than shipping
# a CLI that dies at first sync.
RUN npm install -g obsidian-headless@0.0.14 \
  && ob --version

WORKDIR /app
COPY server.mjs ./

# Secrets are mounted read-only at /secrets: auth_token plus the per-vault
# sync config carrying the derived encryption key. The E2E password itself
# never enters the image or the container.
ENV VAULT_DIR=/vault \
    SECRETS_DIR=/secrets \
    DEVICE_NAME=opti-container \
    PORT=8788

EXPOSE 8788
CMD ["node", "server.mjs"]
