.PHONY: setup up down logs restart icons clean prod prod-tls deploy backup health migrate diagnose cap-sync cap-android cap-ios

setup:
	./scripts/setup.sh

icons:
	npm run icons

cap-sync:
	npm run cap:sync

cap-android:
	npm run cap:open:android

cap-ios:
	npm run cap:open:ios

up: setup
	docker compose up -d --build

prod: setup
	./scripts/deploy.sh prod

prod-tls: setup
	./scripts/deploy.sh tls

deploy:
	./scripts/deploy.sh update

backup:
	./scripts/backup-db.sh

down:
	docker compose down

logs:
	docker compose logs -f

restart:
	docker compose restart

clean:
	docker compose down -v

migrate:
	./scripts/migrate-db.sh

diagnose:
	./scripts/diagnose.sh

health:
	@curl -sf "http://localhost:$${HTTP_PORT:-8080}/health" && echo " web ok"
	@curl -sf "http://localhost:$${HTTP_PORT:-8080}/rest/v1/projects?limit=1" \
		-H "apikey: $$(grep '^ANON_KEY=' .env | cut -d= -f2-)" \
		-H "Authorization: Bearer $$(grep '^ANON_KEY=' .env | cut -d= -f2-)" \
		&& echo " api ok" || echo " api check failed (run make setup first)"
