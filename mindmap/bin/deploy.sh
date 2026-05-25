#!/usr/bin/env bash
# Build + deploy na Cloudflare Worker `fakan-cz`.
#
# Spuštění: bash bin/deploy.sh [--dry-run]
# Volitelné argumenty se předají rovnou wranglerovi.

set -euo pipefail

cd "$(dirname "$0")/.."

bash bin/build.sh
CLOUDFLARE_ACCOUNT_ID=1fb320ef69377e04c649dcc880044f71 wrangler deploy "$@"
