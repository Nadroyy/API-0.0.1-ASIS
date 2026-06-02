# API-ZKTECO-0.0.1

## Que se copio

- `server.js`
- `package.json`
- `package-lock.json`
- `.gitignore`
- `docs/adms-multisede-operacion.md`
- `docs/almacenamiento-adms.md`
- `docs/api-postman.md`
- `docs/zk-postman.md`
- `database/migrations/001_multi_entity_base.sql`
- `public/adms-panel.html`
- `python/zk_tcp_bridge.py`
- `python/requirements-zk.txt`
- `src/services/zkTcpService.js`
- `src/services/zkLogStore.js`
- `src/python/zk_tcp_bridge.py`
- `src/python/requirements-zk.txt`

## Que no se copio

- `.env`
- `node_modules/`
- `logs/`
- `logs.txt`
- `uploads/`
- `data/`
- `artifacts/`
- `asistencias.txt`
- `python/__pycache__/`
- carpetas `src/config`, `src/controllers`, `src/middleware`, `src/routes`, `src/utils`
- `services/`
- `index.js`
- `scripts/`
- integracion ZKBio Access / browser automation

## Por que

- Se copiaron solo archivos requeridos por `server.js`, por imports locales directos o por rutas estaticas expuestas.
- `public/adms-panel.html` se mantiene porque `/panel` lo sirve directamente.
- `database/migrations` se mantiene por el alcance de base de datos pedido.
- El bridge Python se conserva en `python/` y tambien en `src/python/` para cubrir la ruta local usada por `src/services/zkTcpService.js`.
- ZKBio Access queda fuera de alcance en `0.0.1`.
- El flujo soportado es ADMS Push directo desde dispositivos ZKTeco (`/iclock/getrequest`, `/iclock/cdata`, `/iclock/devicecmd`).
- TCP ZKTeco por puerto `4370` queda como soporte opcional/legacy.
- ZKBio/browser automation no forma parte del runtime de esta version.
- No se copiaron datos de runtime, credenciales ni dependencias instaladas para mantener la carpeta limpia y reproducible.

## Comandos

```bash
npm install
npm run start:server
```

## Advertencias

- `npm run start:server` requiere un `.env` valido en esta carpeta porque el script usa `node --env-file=.env server.js`.
- La carpeta limpia no incluye datos previos de `data/`, `logs/` ni `uploads/`; `server.js` los recrea al arrancar.
- Si no defines `ZK_DEVICE_IP`, el health reporta `tcpZk.enabled=false` y la API sigue operando con ADMS como flujo principal.
