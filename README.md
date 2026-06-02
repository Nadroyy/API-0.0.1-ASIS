# API ZKTeco ADMS MVP

Backend Node.js/Express para integrar dispositivos ZKTeco por ADMS Push, administrar personas y dispositivos, consultar asistencia y entregar eventos de asistencia por webhook.

## Estado del MVP

El MVP funcional esta protegido en `main` y en el tag `v0.1.0-mvp`. La rama `cleanup/project-structure` se usa para limpieza segura de estructura y documentacion, sin cambiar contratos ni logica funcional.

Flujo principal del MVP:

- Recepcion ADMS desde relojes ZKTeco.
- Persistencia MySQL del modelo limpio del MVP.
- API administrativa protegida por llave admin.
- API cliente v2 protegida por llave cliente.
- Webhook `attendance.created` para notificar nuevas marcaciones.

## Requisitos

- Node.js compatible con `node --env-file` (Node 20+ recomendado).
- npm.
- MySQL 8 o compatible.
- Un archivo `.env` local basado en `.env.example`.
- Dispositivos ZKTeco configurados para enviar ADMS al servidor publicado.

## Instalacion

```bash
npm install
```

Copia `.env.example` a `.env` y completa los valores locales. No subas `.env` al repositorio.

Variables principales:

- `PORT`
- `MYSQL_HOST`
- `MYSQL_PORT`
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `MYSQL_DATABASE`
- `ADMIN_API_KEY`
- `NODE_ENV`

Las llaves cliente no se escriben en `.env`; se crean desde la API administrativa y se entregan al consumidor final por un canal seguro.

## Schema limpio

El schema del MVP esta en:

```text
database/migrations/MYSQL_MVP_LIMPIO_DESDE_CERO.sql
```

Aplicalo solo en un entorno controlado. Ese script crea la base `control_asistencia` si no existe y elimina/recrea tablas del MVP dentro de esa base.

Ejemplo:

```bash
mysql -u <usuario> -p < database/migrations/MYSQL_MVP_LIMPIO_DESDE_CERO.sql
```

No ejecutes migraciones contra una base con datos productivos sin respaldo.

## Iniciar servidor

```bash
npm run start:server
```

Por defecto el servidor escucha en el puerto configurado en `.env`.

## Estructura

```text
server.js                         Aplicacion Express principal
src/middleware/apiKeyAuth.js      Autenticacion por API key
src/services/webhookService.js    Registro y entrega de webhooks
src/services/zk*.js               Soporte TCP ZKTeco opcional/legacy
database/migrations/              Scripts SQL del proyecto
docs/                             Documentacion operativa y cliente
docs/postman/                     Colecciones Postman sanitizadas
public/                           Paneles HTML servidos por el backend
data/                             Archivos runtime ignorados por Git
uploads/                          Archivos subidos ignorados por Git
logs/                             Logs runtime ignorados por Git
```

## Endpoints principales

Administracion, con `X-API-Key: {{adminApiKey}}`:

- `GET /api/v1/admin/entities`
- `POST /api/v1/admin/entities`
- `GET /api/v1/admin/devices`
- `POST /api/v1/admin/devices`
- `GET /api/v1/admin/api-clients`
- `POST /api/v1/admin/api-clients`
- `GET /api/v1/admin/webhooks`
- `POST /api/v1/admin/webhooks`
- `POST /api/v1/admin/webhooks/:id/test`

Cliente final, con `X-API-Key: {{clientApiKey}}`:

- `GET /api/v2/devices`
- `GET /api/v2/persons`
- `POST /api/v2/persons`
- `GET /api/v2/persons/:nuip`
- `PATCH /api/v2/persons/:nuip`
- `DELETE /api/v2/persons/:nuip`
- `GET /api/v2/commands/:id`
- `GET /api/v2/attendance`

Rutas ADMS como `/iclock/cdata` y `/iclock/devicecmd` son callbacks tecnicos para los dispositivos y no forman parte del contrato publico de cliente.

## Documentacion

- `docs/CLIENTE_FINAL.md`: guia segura para consumidores de la API v2.
- `docs/postman/ADMS API v2.postman_collection.json`: coleccion Postman para cliente final.
- `docs/postman/ADMS Admin API.postman_collection.json`: coleccion Postman administrativa.

## Postman

Colecciones disponibles:

- `docs/postman/ADMS Admin API.postman_collection.json`
- `docs/postman/ADMS API v2.postman_collection.json`

Usan variables como `{{baseUrl}}`, `{{adminApiKey}}`, `{{clientApiKey}}`, `{{entityId}}`, `{{deviceSerial}}` y `{{webhookUrl}}`. No contienen llaves reales.

## Seguridad

No subir al repositorio:

- `.env`
- llaves API reales
- tokens
- hashes de llaves
- dumps de base de datos
- datos personales reales
- archivos de `data/`
- archivos de `uploads/`
- archivos de `logs/`

`.env`, `data/`, `uploads/`, `logs/`, `logs.txt` y `asistencias.txt` estan ignorados por Git.
