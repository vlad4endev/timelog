# TimeLog — учёт рабочего времени

PWA для фрилансера/разработчика с **почасовой оплатой**: таймер, округление часов, отчёты и контроль неоплаченного времени.

## Быстрый старт (Docker) — рекомендуется

```bash
git clone https://github.com/vlad4endev/timelog.git
cd timelog
./scripts/setup.sh          # создаёт .env, секреты, JWT, иконки
docker compose up -d --build
# Открыть http://localhost:8080
```

Или через Make:

```bash
make up      # setup + docker compose up
make logs    # логи
make down    # остановить
make health  # проверить web + API
```

### Стек

| Сервис     | Назначение                                      |
|------------|-------------------------------------------------|
| `web`      | Nginx — PWA + прокси `/rest/v1/` → PostgREST   |
| `postgrest`| REST API (совместим с клиентом Supabase)        |
| `postgres` | PostgreSQL 16 — проекты, записи, платежи        |

Данные сохраняются в Docker volume `postgres_data`. При первом запуске БД инициализируется автоматически.

### Переменные окружения

Скопируйте `.env.example` → `.env` или запустите `./scripts/setup.sh`:

| Переменная | Описание |
|------------|----------|
| `HTTP_PORT` | Порт на хосте (по умолчанию `8080`) |
| `PUBLIC_URL` | Публичный URL для PostgREST OpenAPI |
| `POSTGRES_PASSWORD` | Пароль PostgreSQL |
| `JWT_SECRET` | Секрет JWT (мин. 32 символа) |
| `ANON_KEY` | JWT для API (генерируется setup-скриптом) |
| `AUTO_CONNECT` | Авто-подключение фронтенда к API (`true`) |

### Production

1. Задайте `PUBLIC_URL=https://your-domain.com` в `.env`
2. Поставьте reverse proxy (Caddy/Traefik/nginx) с TLS перед портом `8080`
3. Не публикуйте порты `postgres` и `postgrest` наружу — только `web`
4. Регулярный бэкап volume: `docker run --rm -v timelog_postgres_data:/data -v $(pwd):/backup alpine tar czf /backup/pg-backup.tar.gz /data`

## Локальная разработка (без Docker)

```bash
npm install
npm run icons          # icon-192.png, icon-512.png
npx http-server . -p 8080
# Данные в localStorage
```

## Статический деплой (Netlify / GitHub Pages)

```bash
npm run icons
# Загрузить папку на Netlify Drop или подключить репозиторий
```

Конфиг: `netlify.toml`. Без Docker данные хранятся в `localStorage`; опционально — внешний Supabase.

## Внешний Supabase (опционально)

Настройки → База данных → URL + anon key → SQL из интерфейса → «Подключить».

SQL-схема также в `docker/postgres/init/01-schema.sql`.

## Файлы

| Файл / папка | Назначение |
|--------------|------------|
| `index.html` | Приложение (PWA) |
| `manifest.json`, `sw.js` | PWA и офлайн |
| `config.js` | Авто-конфиг API (генерируется в Docker) |
| `docker-compose.yml` | Оркестрация контейнеров |
| `Dockerfile` | Образ веб-сервера |
| `docker/postgres/init/` | SQL-инициализация БД |
| `scripts/setup.sh` | Подготовка `.env` и секретов |

## Главное для почасовой оплаты

1. **Проект** — ставка ₽/час (валюта в настройках).
2. **Таймер** — старт → работа → стоп → подтверждение с суммой.
3. **Округление** — шаг 15/30/60 мин, вверх или до ближайшего.
4. **Отчёты** — период + проект → печать PDF.
5. **Оплата** — отметьте платежи, видите остаток по проектам.
