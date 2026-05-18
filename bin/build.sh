#!/usr/bin/env bash
# Build krok pro Cloudflare Worker deploy.
#
# Zkopíruje do `dist/` jen ty soubory, které mají být veřejně dostupné na
# fakan.cz. Žádné CLAUDE.md, FOK.md, .claude/, tests/, promo/, bin/, .git/
# atd. — všechno to zůstává v repu, ale nehraje se to do produkce.
#
# Spuštění: bash bin/build.sh

set -euo pipefail

cd "$(dirname "$0")/.."

rm -rf dist
mkdir -p dist

cp index.html dist/
cp styles.css dist/
cp main.js boot.js mindmap.js panels.js keyboard.js sources.js state.js url.js editor.js dist/
cp -R vendor dist/

echo "dist/ připravený ($(find dist -type f | wc -l | tr -d ' ') souborů)"
