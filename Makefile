.PHONY: dev setup install build db migrate clean stop help

# ─── Main commands ───────────────────────────────────

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

dev: setup ## Start everything for local development
	@echo ""
	@echo "  Starting Hanzi dev environment..."
	@echo ""
	@$(MAKE) db
	@sleep 2
	@$(MAKE) migrate
	@echo ""
	@echo "  ✓ Postgres running on localhost:5433"
	@echo "  ✓ Schema migrated"
	@echo ""
	@echo "  Starting servers..."
	@echo ""
	@trap 'kill 0' INT; \
		cd server && node dist/managed/deploy.js & \
		cd server/dashboard && npx vite --port 5174 & \
		wait
	@echo ""

setup: .env install build ## Install deps + build everything
	@echo "  ✓ Setup complete"

install: ## Install all dependencies
	@echo "  Installing dependencies..."
	@npm install --silent 2>/dev/null || true
	@cd server && npm install --silent 2>/dev/null || true
	@cd server/dashboard && npm install --silent 2>/dev/null || true
	@cd sdk && npm install --silent 2>/dev/null || true
	@echo "  ✓ Dependencies installed"

build: ## Build server, dashboard, and extension
	@echo "  Building..."
	@cd server && npm run build 2>&1 | tail -1
	@npx vite build --config vite.config.js 2>&1 | tail -1
	@echo "  ✓ Build complete"

db: ## Start Postgres (Docker)
	@docker compose up -d postgres 2>/dev/null || docker-compose up -d postgres

migrate: ## Run database migrations
	@PGPASSWORD=hanzi_dev psql -h localhost -p 5433 -U hanzi -d hanzi -f server/src/managed/schema.sql -q 2>/dev/null || echo "  ⚠ Migration failed (is Postgres running? try: make db)"

stop: ## Stop all services
	@docker compose down 2>/dev/null || docker-compose down 2>/dev/null || true
	@echo "  ✓ Services stopped"

clean: stop ## Stop services and remove data
	@docker compose down -v 2>/dev/null || docker-compose down -v 2>/dev/null || true
	@echo "  ✓ Cleaned up"

# ─── Helpers ─────────────────────────────────────────

.env:
	@if [ ! -f .env ]; then \
		cp .env.example .env; \
		echo "  Created .env from .env.example — edit it with your credentials"; \
	fi

# Load .env if it exists
ifneq (,$(wildcard ./.env))
    include .env
    export
endif
