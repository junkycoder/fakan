# fakan — common workflow targets.
# Cílem je mít jeden vstup pro dev / build / deploy / test, ať to user i paralelní
# Claude sessions trefí konzistentně.

.DEFAULT_GOAL := help
.PHONY: help dev serve build deploy clean test test-ui promo report \
        ios ios-devices install-tests \
        agent agent-linux-arm64 agent-linux-amd64 agent-darwin-arm64 agent-all

PORT ?= 5173
TARGET ?=

help: ## Vypsat dostupné targety
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ── Dev ───────────────────────────────────────────────────────────────────────

dev: serve ## Alias pro `serve`

serve: ## Lokální dev server na portu $(PORT) (SPA fallback)
	python3 bin/serve.py $(PORT)

# ── Build & deploy ────────────────────────────────────────────────────────────

build: ## Připravit dist/ pro deploy
	bash bin/build.sh

deploy: ## Build + wrangler deploy na fakan.cz
	bash bin/deploy.sh

clean: ## Smazat dist/
	rm -rf dist

# ── Testy & promo ─────────────────────────────────────────────────────────────

install-tests: ## Nainstalovat Playwright deps v tests/
	cd tests && npm install

test: ## Playwright e2e (specs/)
	cd tests && npm test

test-ui: ## Playwright UI mode
	cd tests && npm run ui

promo: ## Regenerovat promo screenshoty
	cd tests && npm run promo

report: ## Otevřít poslední Playwright report
	cd tests && npm run report

# ── iOS (Capacitor) ───────────────────────────────────────────────────────────
# Rychlý sestav + spusť na reálném zařízení spárovaném s Xcode. Hloubková práce
# (signing, Pods, archive) probíhá v `mobile/` přes `cap` / Xcode přímo.
#
# Pre-requisity: jednou v Xcode otevřít projekt (`cd mobile && npx cap open ios`),
# nastavit Team / signing pro `App` target, povolit Developer Mode na zařízení.

ios: ## Build + sync + spustit na iOS zařízení (TARGET=<id> volitelně; bez něj interaktivní výběr)
	bash bin/build.sh
	cd mobile && npx cap run ios $(if $(TARGET),--target=$(TARGET),)

ios-devices: ## Vypsat spárovaná zařízení a simulátory (zkopíruj ID do TARGET=)
	cd mobile && npx cap run ios --list

# ── fakan-agent (Go binary pro tunel na vlastní stroj) ────────────────────────

agent: ## Build fakan-agent pro aktuální platformu → agent/fakan-agent
	cd agent && go build -o fakan-agent ./...
	@echo "Hotovo: agent/fakan-agent"

agent-linux-arm64: ## Cross-build pro Raspberry Pi 4/5 (linux/arm64)
	cd agent && GOOS=linux GOARCH=arm64 go build -o fakan-agent-linux-arm64 ./...

agent-linux-amd64: ## Cross-build pro klasický Linux server (linux/amd64)
	cd agent && GOOS=linux GOARCH=amd64 go build -o fakan-agent-linux-amd64 ./...

agent-darwin-arm64: ## Cross-build pro Apple Silicon Mac
	cd agent && GOOS=darwin GOARCH=arm64 go build -o fakan-agent-darwin-arm64 ./...

agent-all: agent-linux-arm64 agent-linux-amd64 agent-darwin-arm64 ## Vše najednou
