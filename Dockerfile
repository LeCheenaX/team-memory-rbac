FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv \
  && python3 -m venv /opt/team-memory-spacy \
  && /opt/team-memory-spacy/bin/pip install --no-cache-dir "click==8.1.8" "spacy==3.8.7" \
  && /opt/team-memory-spacy/bin/python -m pip check \
  && rm -rf /var/lib/apt/lists/*
ENV TEAM_MEMORY_SPACY_PYTHON=/opt/team-memory-spacy/bin/python
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev:server"]
