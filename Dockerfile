# syntax=docker/dockerfile:1.7-labs
ARG CHROMEX_VERSION=0.1.3
ARG PNPM_VERSION=12.15.0

ARG USER_ID=1000
ARG GROUP_ID=1000
ARG USER_NAME=node

FROM node:26.8.2-bookworm-slim AS node-base
# Re-declared so they are in scope in this stage only; the ENV values below are what the later
# stages consume, so no other stage needs the user ARGs.
ARG PNPM_VERSION
ARG USER_ID
ARG GROUP_ID
ARG USER_NAME

ENV CI=true
ENV npm_config_update_notifier=false
ENV SHELL=/bin/bash
ENV USER_NAME="${USER_NAME}"
ENV USER_HOME="/home/${USER_NAME}"
ENV PNPM_HOME="/opt/pnpm"
ENV PATH="${PNPM_HOME}/bin:${PATH}"

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    curl git procps chromium \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "pnpm@${PNPM_VERSION}"

# Normalize the base image's node:node 1000:1000 identity to the requested name/uid/gid and give
# it a home. groupmod/usermod reuse the existing account, so no stray user is left behind.
RUN groupmod --gid "${GROUP_ID}" --new-name "${USER_NAME}" node \
  && usermod --uid "${USER_ID}" --gid "${GROUP_ID}" \
       --login "${USER_NAME}" --home "${USER_HOME}" --shell /bin/bash node \
  && passwd --delete "${USER_NAME}" \
  && install -d -o "${USER_NAME}" -g "${USER_NAME}" \
       "${USER_HOME}" "${PNPM_HOME}" "${PNPM_HOME}/bin" /projects \
  && chown -R "${USER_NAME}:${USER_NAME}" "${USER_HOME}"

ENV HOME="${USER_HOME}"

RUN mkdir -p /app
RUN touch /app/.gitignore && chown -R "${USER_NAME}:${USER_NAME}" /app

WORKDIR /app
USER "${USER_NAME}"

FROM node-base AS manifests
# Manifests first, so editing source does not reinstall the workspace. The root workspace files
# are copied unchanged, which keeps the catalogs, the overrides and the lockfile with one owner;
# `packages/*` then discovers exactly the package directories named here and no others.
COPY --chown=${USER_NAME}:${USER_NAME} package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY --chown=${USER_NAME}:${USER_NAME} --parents packages/*/package.json packages/

RUN pnpm install --frozen-lockfile

FROM node-base AS sources
# Source last: an edit to any of these rebuilds only the layers after this point. Only files that
# exist in the repository are named here; the build reads tsconfig.base.json, not tsconfig.json.
COPY --chown=${USER_NAME}:${USER_NAME} \
  tsconfig.base.json eslint.config.mjs .jscpd.json vitest.config.ts LICENSE ./
COPY --chown=${USER_NAME}:${USER_NAME} packages/ packages/
COPY --chown=${USER_NAME}:${USER_NAME} skills/ skills/

FROM scratch AS full-source
COPY --from=manifests /app/ /app/
COPY --from=sources /app/ /app/

FROM node-base AS app-build
# Version asserted at build time; the global ARG is out of stage scope, so it is re-declared here.
ARG CHROMEX_VERSION
COPY --from=full-source /app/ /app/
RUN test "$(node -p "require('./package.json').version")" = "${CHROMEX_VERSION}"
RUN pnpm lint
RUN pnpm check:code:duplicity
RUN pnpm typecheck
RUN pnpm exec vitest run --project unit
RUN pnpm build
RUN mkdir -p /app/build \
  && cd packages/plugin \
  && npm pack --pack-destination /app/build \
  && cd /app/build \
  && sha256sum ./*.tgz > SHA256SUMS

FROM scratch AS artifact
COPY --from=app-build /app/build/ /

FROM node-base AS app-base
WORKDIR /app
USER ${USER_NAME}:${USER_NAME}

FROM app-base AS runtime
# OpenCode lets the agent stage validate the packed MCP with a real client (DEC-80).
RUN pnpm -g add --allow-build=@opencode/cli @opencode/cli@2.2.6

COPY --from=app-build --chown="${USER_NAME}:${USER_NAME}" /app/ /app/

# Build-time proof: npx installs the packed tarball into a throwaway HOME, and setup writes the
# stable runtime, config and native host without touching the host.
FROM runtime AS install
ARG CHROMEX_VERSION
ENV HOME=/tmp/chromex-home
RUN install -d -m 0700 "$HOME" \
  && npm_config_offline=true npm exec --yes --package="/app/build/tasarren-chromex-${CHROMEX_VERSION}.tgz" -- chromex setup --no-open --scope global --skills none --browsers all \
  && test -f "$HOME/plugins/chromex/dist/mcp-server.mjs" \
  && test -f "$HOME/.config/chromex/config.json" \
  && test -f "$HOME/.config/chromium/NativeMessagingHosts/io.tasarren.chromex.json"
CMD ["true"]

# Clean-room verification image. Build: network allowed. Run: offline, non-root, no mounts.
FROM app-build AS verify
ENV CHROMEX_HEADLESS=1
ENV CHROMEX_BROWSER=/usr/bin/chromium
CMD ["pnpm", "exec", "vitest", "run", "--project", "e2e", "--project", "browser"]

# Report only (DEC-80): installs the packed tarball, runs the agent, records output in /app/reports.
FROM runtime AS agent
ENV CHROMEX_HEADLESS=1
ENV CHROMEX_BROWSER=/usr/bin/chromium
RUN npm install --global --prefix /app/.agent /app/build/*.tgz
ENV PATH="/app/.agent/bin:${PATH}"
COPY --chown=${USER_NAME}:${USER_NAME} docker/ /app/docker/
CMD ["sh", "/app/docker/agent-entrypoint.sh"]
