#!/bin/sh
# Seed omp's config on first start from base64 environment variables, so a stack can ship
# its model setup without baking private endpoints into the image or the repository.
#   OMP_CONFIG_YML_B64   -> ~/.omp/agent/config.yml
#   OMP_MODELS_YML_B64   -> ~/.omp/agent/models.yml
# Existing files are kept unless OMP_CONFIG_OVERWRITE=1.
set -e

AGENT_DIR="$HOME/.omp/agent"
mkdir -p "$AGENT_DIR" "${OHMYPI_WEB_WORKSPACE:-/workspace}" 2>/dev/null || true

seed() {
  value="$1"; file="$AGENT_DIR/$2"
  [ -n "$value" ] || return 0
  if [ -s "$file" ] && [ "${OMP_CONFIG_OVERWRITE:-0}" != "1" ]; then
    echo "pits: keeping existing $2 (set OMP_CONFIG_OVERWRITE=1 to replace it)"
    return 0
  fi
  if printf '%s' "$value" | base64 -d > "$file.tmp" 2>/dev/null && [ -s "$file.tmp" ]; then
    mv "$file.tmp" "$file"
    echo "pits: wrote $2 from environment"
  else
    rm -f "$file.tmp"
    echo "pits: could not decode the value for $2 (expected base64); skipped" >&2
  fi
}

seed "${OMP_CONFIG_YML_B64:-}" config.yml
seed "${OMP_MODELS_YML_B64:-}" models.yml

exec "$@"
