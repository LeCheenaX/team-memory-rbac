FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV HERMES_HOME=/root/.hermes
ENV PATH="/root/.local/bin:/root/.cargo/bin:/root/.hermes/bin:${PATH}"

WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    python-is-python3 \
    python3 \
    procps \
  && rm -rf /var/lib/apt/lists/*

# Official Hermes Agent installer for Linux/macOS/WSL2.
# It installs Hermes plus its runtime dependencies under the container user's home.
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash

# Vendor this repository so Hermes can import the Team Memory adapter package
# and run the local no-server Team Memory runtime from inside the container:
#   src.adapters.hermes.http_client.HermesTeamMemoryProvider
COPY package.json package-lock.json /opt/team-memory-rbac/
WORKDIR /opt/team-memory-rbac
RUN npm ci
COPY . /opt/team-memory-rbac

ENV PYTHONPATH="/opt/team-memory-rbac:${PYTHONPATH}"
ENV TEAM_MEMORY_URL="http://service:3000"

COPY docker/hermes/entrypoint.sh /usr/local/bin/hermes-container-entrypoint
RUN chmod +x /usr/local/bin/hermes-container-entrypoint

WORKDIR /workspace
ENTRYPOINT ["hermes-container-entrypoint"]
CMD ["hermes"]
