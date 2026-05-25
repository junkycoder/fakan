# fakan monorepo — delegace na podsložky.
# Vyplývá z konvence "jedna složka = jedna subdoména = jeden worker".
# Každá složka má vlastní Makefile / wrangler.jsonc. Top-level je jen orchestrátor.

.DEFAULT_GOAL := help
.PHONY: help dev deploy deploy-all test list

# Složky, které jsou plnohodnotné deployable projekty (apex/www/new přibudou,
# jak budou mít obsah). mindmap je hotový, ostatní zatím skeleton.
PROJECTS := mindmap apex www new

DIR ?= mindmap

help: ## Vypsat dostupné targety
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo ""
	@echo "  Projekty: $(PROJECTS)"
	@echo "  Použití: make deploy DIR=www   (default DIR=$(DIR))"

list: ## Vypsat dostupné projekty
	@for p in $(PROJECTS); do \
		if [ -d "$$p" ]; then \
			has_wrangler="$$( [ -f $$p/wrangler.jsonc ] && echo yes || echo --- )"; \
			has_make="$$( [ -f $$p/Makefile ] && echo yes || echo --- )"; \
			printf "  %-10s wrangler:%s  Makefile:%s\n" "$$p" "$$has_wrangler" "$$has_make"; \
		fi; \
	done

dev: ## Lokální dev server konkrétního projektu (DIR=mindmap default)
	$(MAKE) -C $(DIR) dev

deploy: ## wrangler deploy konkrétního projektu (DIR=mindmap default)
	cd $(DIR) && wrangler deploy

deploy-all: ## Deploy všech projektů, které mají wrangler.jsonc
	@for p in $(PROJECTS); do \
		if [ -f "$$p/wrangler.jsonc" ]; then \
			echo "→ deploying $$p"; \
			(cd $$p && wrangler deploy) || exit 1; \
		else \
			echo "→ skipping $$p (no wrangler.jsonc)"; \
		fi; \
	done

test: ## Spustit testy v daném projektu (DIR=mindmap default)
	$(MAKE) -C $(DIR) test
