# Co-π-lot: web front end for oh-my-pi (omp), with omp installed inside the image.
FROM node:22-bookworm-slim

# git/ssh for projects and git clone, tini as PID 1 so omp children are reaped,
# procps for terminals, coreutils' sha256sum is needed by the omp installer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client bash procps tini less \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /workspace && chown node:node /workspace

# Run as the image's unprivileged "node" user (uid 1000).
USER node
ENV HOME=/home/node
WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# omp: prebuilt, checksum-verified binary from the official installer. Pin with --build-arg OMP_REF=v18.20.0.
ARG OMP_REF=""
RUN curl -fsSL https://omp.sh/install -o /tmp/omp-install.sh \
 && sh /tmp/omp-install.sh --binary ${OMP_REF:+--ref "$OMP_REF"} \
 && rm /tmp/omp-install.sh \
 && /home/node/.local/bin/omp --version

COPY --chown=node:node . .
RUN chmod +x /app/docker-entrypoint.sh && mkdir -p /home/node/.omp/agent /home/node/.ohmypi-web

ENV PATH=/home/node/.local/bin:$PATH \
    OHMYPI_WEB_HOST=0.0.0.0 \
    OHMYPI_WEB_PORT=7878 \
    OHMYPI_WEB_DATA=/home/node/.ohmypi-web \
    OHMYPI_WEB_WORKSPACE=/workspace \
    NODE_ENV=production

EXPOSE 7878
VOLUME ["/home/node/.omp", "/home/node/.ohmypi-web", "/workspace"]
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker-entrypoint.sh"]
CMD ["node", "server/index.mjs"]
