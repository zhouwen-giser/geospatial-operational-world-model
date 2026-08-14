.PHONY: install verify config build up migrate fixtures stas-e2e evidence down package

install:
	npm ci
	npm --prefix services/stas ci

verify:
	npm run verify

config:
	docker compose config --quiet

build:
	docker compose build postgres migrate stas

up:
	docker compose up -d postgres
	docker compose run --rm migrate
	docker compose up -d stas

migrate:
	docker compose run --rm migrate

fixtures:
	docker compose exec -T postgres psql -X -U gowm -d gowm -v ON_ERROR_STOP=1 -v ANALYSIS_SRID=$${ANALYSIS_SRID} < database/fixtures/001_integrated_stas_scenarios.sql
	docker compose exec -T postgres psql -X -U gowm -d gowm -v ON_ERROR_STOP=1 -v ANALYSIS_SRID=$${ANALYSIS_SRID} < database/fixtures/002_candidate_cap_10001.sql

stas-e2e:
	npm run validate:stas
	npm run validate:ingest-stas
	npm run validate:evidence

evidence:
	npm run validate:evidence

down:
	docker compose down

package:
	bash scripts/package-release.sh
