# Coyote Frontend

Portal web estático (HTML/CSS/JS) servido con nginx.

Proyecto independiente de la API. No comparte código con `../api`.

## Requisitos

- Docker y Docker Compose

## Inicio rápido

```bash
cd frontend
cp .env.example .env
docker compose up --build
```

El portal queda en http://localhost (puerto configurable con `FRONTEND_PORT`).

## Conectar con la API

Por defecto el frontend hace proxy de `/api/*` hacia el backend en `http://host.docker.internal:8000`. Levanta primero la API:

```bash
cd ../api
docker compose up --build
```

Luego el frontend:

```bash
cd ../frontend
docker compose up --build
```

### Sin proxy (dominios separados)

En `.env` del frontend:

```
API_PROXY_ENABLED=false
API_BASE_URL=http://localhost:8000/api/v1
```

En `.env` de la API, permitir CORS con cookies:

```
PORTAL_ALLOWED_ORIGINS=http://localhost:80
```

## AWS — un ALB compartido (HTTP)

Front y API detrás del **mismo ALB**. El navegador nunca llama a la IP privada de la API.

En `.env` del frontend:

```
API_PROXY_ENABLED=false
API_BASE_URL=/api/v1
```

Reglas del listener (puerto 80):

| Prioridad | Path | Destino |
|-----------|------|---------|
| 1 | `/api/*` | API :8000 |
| 2 | `/webhook/*` | API :8000 |
| default | `*` | Frontend :80 |

Abrir el portal: `http://<dns-del-alb>/`

En `.env` de la API (resumen):

```
APP_ENV=production
PORTAL_COOKIE_SECURE=false
PORTAL_ALLOWED_ORIGINS=
PUBLIC_BASE_URL=http://<dns-del-alb>
POSTGRES_HOST=<endpoint-rds>
```

Webhook Twilio (más adelante): `http://<dns-del-alb>/webhook/{doctor_id}`

## Estructura

- `public/` — archivos estáticos del portal
- `nginx/` — plantillas de configuración
- `docker-entrypoint.sh` — genera `config.js` y nginx al arrancar
