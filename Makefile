# EMOJI CLASH — build and deploy.
#
# The build is a single self-contained dist/index.html with no external
# references, so deploying is one file landing in one directory. Nothing in the
# page depends on where it is served from, which is why the /ec prefix needs no
# configuration anywhere.

HOST       ?= example
REMOTE_DIR ?= /var/www/emoji-clash
URL        ?= https://example.com/emoji-clash

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

.PHONY: install
install: ## Install dependencies
	npm install

node_modules: package.json
	npm install
	@touch node_modules

.PHONY: dev
dev: node_modules ## Run the dev server
	npm run dev

.PHONY: check
check: node_modules ## Typecheck only
	npm run check

.PHONY: build
build: node_modules ## Build dist/index.html
	npm run build
	@echo "built $$(du -h dist/index.html | cut -f1) -> dist/index.html"

.PHONY: deploy
deploy: build ## Build, then publish to the live site
	@echo "deploying to $(HOST):$(REMOTE_DIR)"
	ssh $(HOST) 'mkdir -p $(REMOTE_DIR)'
	scp dist/index.html $(HOST):$(REMOTE_DIR)/index.html
	@test -f dist/music.mp3 && scp dist/music.mp3 $(HOST):$(REMOTE_DIR)/music.mp3 \
		|| echo "no dist/music.mp3 — deploying without the soundtrack"
	@echo "live at $(URL)"

.PHONY: clean
clean: ## Remove build output
	rm -rf dist
