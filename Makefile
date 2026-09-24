.PHONY: help install lint fmt typecheck test build size check clean

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dev dependencies from the lockfile
	npm ci

lint: ## ESLint with zero warnings, plus the Prettier check
	npm run lint

fmt: ## Format the code
	npm run format

typecheck: ## tsc --noEmit in strict mode
	npm run typecheck

test: ## Vitest unit tests
	npm test

build: ## ESM + CJS + type declarations into dist/
	npm run build

size: build ## Browser bundle against its byte budget
	npm run size

check: lint typecheck test size ## Everything that must pass before a commit

clean:
	rm -rf dist coverage
