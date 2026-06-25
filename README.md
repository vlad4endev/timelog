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
| `web`      | Nginx — PWA + прокси `/rest/v1/` → PostgREST, `/auth/` → auth   |
| `auth`     | Выдача JWT по логину/паролю, изоляция данных на уровне БД       |
| `postgrest`| REST API (совместим с клиентом Supabase)                        |
| `postgres` | PostgreSQL 16 — проекты, записи, платежи, графики               |

Данные сохраняются в Docker volume `postgres_data`. При первом запуске БД инициализируется автоматически.

### Многопользовательский режим

Каждый пользователь регистрируется отдельно (логин + пароль). Данные изолированы на трёх уровнях:

1. **PostgreSQL RLS** — строки привязаны к `user_login`, политики проверяют JWT
2. **Auth-сервис** — после входа выдаётся персональный JWT (`role: timelog_user`, `login: …`)
3. **Клиент** — `localStorage` разделён по логину (`timelog_v1_{login}`), запросы фильтруются по пользователю

На экране входа: «Создать аккаунт» — для регистрации нового пользователя на том же сервере.

**Обновление существующей БД** (если volume уже был создан до RLS):

```bash
./scripts/migrate-rls.sh
docker compose up -d --build
```

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

**На сервере (первый раз):**

```bash
# 1. Установить Docker (Ubuntu/Debian)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # перелогиниться

# 2. Клонировать и настроить
git clone https://github.com/vlad4endev/timelog.git
cd timelog
cp .env.example .env
nano .env   # PUBLIC_URL, PUBLIC_HOST (для HTTPS), пароли уже сгенерирует setup

# 3a. С внешним reverse proxy (nginx/Caddy на хосте)
./scripts/deploy.sh prod
# Проксируйте HTTPS → 127.0.0.1:8080 (пример: docker/Caddyfile.host)

# 3b. С автоматическим HTTPS (Caddy в Docker, Let's Encrypt)
# DNS A-запись → IP сервера, в .env: PUBLIC_HOST=timelog.example.com, PUBLIC_URL=https://timelog.example.com
./scripts/deploy.sh tls
```

**Обновление после git pull:**

```bash
./scripts/deploy.sh update
# или: make deploy
```

**Бэкап БД:**

```bash
./scripts/backup-db.sh          # → backups/timelog-YYYYMMDD-HHMMSS.sql.gz
```

**Полезные команды:**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f web
docker compose -f docker-compose.yml -f docker-compose.prod.yml down
```

Рекомендации:

1. Задайте `PUBLIC_URL=https://your-domain.com` в `.env`
2. Не публикуйте порты `postgres` и `postgrest` наружу — только `web` (или Caddy)
3. Регулярный бэкап: `./scripts/backup-db.sh` или cron

## Мобильное приложение (Capacitor)

Нативная обёртка для Android и iOS с **постоянным виджетом таймера в шторке** (время + наработка).

### Требования

| Платформа | Инструменты |
|-----------|-------------|
| Android | Android Studio, JDK 17 |
| iOS | macOS, Xcode, CocoaPods |

### Сборка

```bash
npm install
npm run cap:sync          # скопировать web → www и синхронизировать с native
npm run cap:open:android  # открыть в Android Studio
npm run cap:open:ios      # открыть в Xcode
```

Запуск на устройстве:

```bash
npm run cap:run:android
npm run cap:run:ios
```

После изменений в `index.html` всегда выполняйте `npm run cap:sync` перед сборкой native.

### Таймер в шторке

- **Android** — foreground service (`specialUse: work_timer`): обновление каждую секунду, кнопки Пауза/Стоп
- **iOS** — local notification с тем же форматом (ограничения iOS на фоновое обновление)
- **PWA в браузере** — service worker notification (как раньше)

### API URL в native

По умолчанию приложение грузит `config.js` из bundle. Для подключения к серверу отредактируйте `config.js` перед `npm run cap:sync` или задайте URL в настройках приложения после установки.

## Локальная разработка (без Docker)

```bash
npm install
# icon-192.png и icon-512.png уже в репозитории (PWA)
npx http-server . -p 8080
# Данные в localStorage
```

## Статический деплой (Netlify / GitHub Pages)

```bash
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
| `docker-compose.prod.yml` | Production overlay (localhost bind + Caddy TLS) |
| `docker-compose.tls.yml` | Скрывает порт web при режиме TLS |
| `scripts/deploy.sh` | Деплой на сервер (prod / tls / update) |
| `scripts/backup-db.sh` | SQL-бэкап PostgreSQL |
| `docker/postgres/init/` | SQL-инициализация БД |
| `capacitor/` | JS-мост к нативным плагинам (таймер в шторке) |
| `capacitor.config.json` | Конфиг Capacitor |
| `android/`, `ios/` | Нативные проекты Capacitor |

## Главное для почасовой оплаты

1. **Проект** — ставка ₽/час (валюта в настройках).
2. **Таймер** — старт → работа → стоп → подтверждение с суммой.
3. **Округление** — шаг 15/30/60 мин, вверх или до ближайшего.
4. **Отчёты** — период + проект → печать PDF.
5. **Оплата** — отметьте платежи, видите остаток по проектам.
