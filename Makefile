# EMOJI CLASH — build, publish, deploy.
#
# The build is a single self-contained dist/index.html, so deploying is one file
# landing in one directory. Nothing in the page depends on where it is served
# from, which is why any URL prefix works with no configuration.
#
# Deployment settings are personal and stay out of the repo. Put them in an
# untracked .envrc for direnv (copy .envrc.example, then `direnv allow`), export
# them yourself, or pass them inline:
#   make deploy EC_DEPLOY_HOST=myserver EC_DEPLOY_DIR=/var/www/game

HOST       ?= $(or $(EC_DEPLOY_HOST),example)
REMOTE_DIR ?= $(or $(EC_DEPLOY_DIR),/var/www/emoji-clash)
URL        ?= $(or $(EC_DEPLOY_URL),https://example.com/emoji-clash)

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

.PHONY: test
test: node_modules ## Run the test suite
	npm test

.PHONY: build
build: node_modules ## Build dist/index.html
	npm run build
	@echo "built $$(du -h dist/index.html | cut -f1) -> dist/index.html"

.PHONY: pages
pages: build ## Preview the Pages site locally (CI builds the real one)
	@mkdir -p docs/play
	cp dist/index.html docs/play/index.html
	@test -f dist/music.mp3 && cp dist/music.mp3 docs/play/music.mp3 || true
	@echo "preview at docs/index.html — publishing is done by CI on push to main"

.PHONY: deploy
deploy: build ## Build, then publish to your own server
	@test "$(HOST)" != "example" || { \
		echo "EC_DEPLOY_HOST is not set — copy .envrc.example to .envrc and run 'direnv allow'"; \
		exit 1; }
	@echo "deploying to $(HOST):$(REMOTE_DIR)"
	ssh $(HOST) 'mkdir -p $(REMOTE_DIR)'
	scp dist/index.html $(HOST):$(REMOTE_DIR)/index.html
	@test -f dist/music.mp3 && scp dist/music.mp3 $(HOST):$(REMOTE_DIR)/music.mp3 \
		|| echo "no dist/music.mp3 — deploying without the soundtrack"
	@echo "live at $(URL)"

.PHONY: clean
clean: ## Remove build output
	rm -rf dist
