.PHONY: setup up down logs restart icons clean

setup:
	./scripts/setup.sh

icons:
	npm run icons

up: setup
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f

restart:
	docker compose restart

clean:
	docker compose down -v

health:
	@curl -sf "http://localhost:$${HTTP_PORT:-8080}/health" && echo " web ok"
	@curl -sf "http://localhost:$${HTTP_PORT:-8080}/rest/v1/projects?limit=1" \
		-H "apikey: $$(grep '^ANON_KEY=' .env | cut -d= -f2-)" \
		-H "Authorization: Bearer $$(grep '^ANON_KEY=' .env | cut -d= -f2-)" \
		&& echo " api ok" || echo " api check failed (run make setup first)"
