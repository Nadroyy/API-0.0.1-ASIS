# API REST v1 para Postman

> Nota de mantenimiento: este documento conserva ejemplos historicos e internos de operacion. Para el contrato profesional de cliente final del MVP usa `docs/CLIENTE_FINAL.md`.

## Llaves por rol

- `ADMIN_API_KEY`: llave oficial para `/api/v1/*` y tambien valida `/api/v2/*`
- `CLIENT_API_KEY`: llave oficial para cliente final, solo valida:
- `GET /api/v2/persons`
- `POST /api/v2/persons`
- `GET /api/v2/persons/:nuip`
- `PATCH /api/v2/persons/:nuip`
- `DELETE /api/v2/persons/:nuip`
- `GET /api/v2/commands/:id`

Compatibilidad temporal:

- si `ADMIN_API_KEY` no esta definida, `/api/v1/*` usa `API_V1_KEY` como fallback admin

Headers soportados:

- `X-API-Key: {{adminApiKey}}`
- `X-API-Key: {{clientApiKey}}`
- `Authorization: Bearer {{adminApiKey}}`
- `Authorization: Bearer {{clientApiKey}}`

Respuestas de autenticacion:

```json
{
  "ok": false,
  "message": "API key requerida",
  "code": "API_KEY_REQUIRED"
}
```

```json
{
  "ok": false,
  "message": "API key invalida",
  "code": "API_KEY_INVALID"
}
```

```json
{
  "ok": false,
  "message": "La API key no tiene permisos para este recurso",
  "code": "API_KEY_FORBIDDEN"
}
```

Variables sugeridas para Postman:

- `adminApiKey = admin-cambia-esta-clave`
- `clientApiKey = cliente-cambia-esta-clave`
- Todos los ejemplos `/api/v1/*` de este documento deben ejecutarse con `{{adminApiKey}}`
- Para cliente final usa `/api/v2/*` con `{{clientApiKey}}`

Base sugerida:

- `baseUrl = {{baseUrl}}`
- `apiKey = cambia-esta-clave`
- `siteId = almacen`
- `targetDeviceSn = CNYG225160781`
 - `pin = 1913` (nota: ya no es parte del contrato público v2)

La variable exacta en `.env` que valida estos endpoints es:

- `API_V1_KEY`

Autenticacion requerida para todos los endpoints `/api/v1/*`:

- Header `X-API-Key: {{apiKey}}`
- o `Authorization: Bearer {{apiKey}}`

Errores comunes:

Sin API key:

```json
{
  "ok": false,
  "error": "API key requerida"
}
```

API key invalida:

```json
{
  "ok": false,
  "error": "API key invalida"
}
```

## 1. Health

`GET {{baseUrl}}/api/v1/health`

Respuesta esperada:

```json
{
  "ok": true,
  "estado": "Servidor activo",
  "puerto": 3000,
  "server": { "port": 3000 },
  "database": {
    "engine": "mysql",
    "name": "zkteco",
    "connected": true,
    "error": null
  }
}
```

## 2. Listar sedes

`GET {{baseUrl}}/api/v1/sites`

## 3. Crear sede

`POST {{baseUrl}}/api/v1/sites`

Body JSON:

```json
{
  "siteId": "almacen",
  "name": "Almacen",
  "hostname": "almacen.local",
  "enabled": true
}
```

## 4. Listar dispositivos

Todos:

`GET {{baseUrl}}/api/v1/devices?scope=all`

Por sede:

`GET {{baseUrl}}/api/v1/devices?siteId={{siteId}}`

## 5. Autorizar dispositivo en sede

`POST {{baseUrl}}/api/v1/sites/{{siteId}}/devices/{{targetDeviceSn}}/authorize`

Quitar autorizacion:

`DELETE {{baseUrl}}/api/v1/sites/{{siteId}}/devices/{{targetDeviceSn}}/authorize`

## 6. Editar dispositivo

`PATCH {{baseUrl}}/api/v1/devices/{{targetDeviceSn}}`

Body JSON:

```json
{
  "name": "Entrada almacen",
  "deviceName": "Entrada almacen",
  "locationName": "Puerta principal almacen",
  "siteId": "almacen",
  "enabled": true
}
```

## 7. Crear persona segura sin BIODATA

`POST {{baseUrl}}/api/v1/persons/enroll`

Tipo:

- `multipart/form-data`

Campos:

- `pin = {{pin}}`
- `name = Persona API`
- `password = 1234`
- `siteId = {{siteId}}`
- `targetDeviceSn = {{targetDeviceSn}}`
- `image =` archivo JPG/PNG

Respuesta esperada:

```json
{
  "ok": true,
  "operation": "create",
  "pin": "1913",
  "siteId": "almacen",
  "targetDeviceSn": "CNYG225160781",
  "userCommandId": 123,
  "biophotoCommandId": 124,
  "message": "Persona creada y encolada para enrolamiento ADMS"
}
```

Este endpoint usa el flujo seguro:

- USERINFO
- BIOPHOTO
- no envia BIODATA

Si el PIN ya existe, responde `409 Conflict` y no crea comandos nuevos:

```json
{
  "ok": false,
  "error": "La persona ya existe en el dispositivo",
  "pin": "1913",
  "siteId": "almacen",
  "targetDeviceSn": "CNYG225160781",
  "existsLocal": true,
  "existsInDevice": true,
  "canUpdate": true,
  "currentPerson": {
    "pin": "1913",
    "name": "Persona API",
    "status": "activo",
    "deviceSyncStatus": "accepted_by_device",
    "userCommandId": "123",
    "biophotoCommandId": "124"
  },
  "message": "Usa updateMode=update para actualizar nombre, contraseña o foto."
}
```

Si envias `updateMode=update` o `allowUpdate=true` por `POST`, la API responde indicando usar `PATCH`.

### 7.1 CRUD MySQL básico por NUIP (API pública v2)

Fuente principal:

- MySQL
- tabla `personas`
- `nuip` = identificación real de la persona (campo público que el consumidor envía)
- En v2, internamente el `nuip` también se usa como `pin_dispositivo` técnico para los relojes ZKTeco cuando no existe una relación previa específica.
- `targetDeviceSn` = número de serie del dispositivo físico (identifica el reloj)
- si no solicitas sincronización, no envía `USERINFO`
- si no solicitas sincronización, no envía `BIOPHOTO`

### Listar personas

`GET {{baseUrl}}/api/v1/persons`

Filtros opcionales:

- `nuip`
- `entidad_id`
- `sede_id`
- `estado`

Ejemplo curl:

```bash
curl.exe -H "X-API-Key: {{apiKey}}" "{{baseUrl}}/api/v1/persons?estado=activo"
```

### Crear persona

`POST {{baseUrl}}/api/v1/persons`

Tipo:

- `multipart/form-data`

Campos públicos (contrato v2):

- `nuip` requerido
- `name` requerido
- `password` opcional
- `siteId` opcional
- `targetDeviceSn` requerido si sincronizas reloj
- `image` opcional
- `syncDevice` opcional
- `estado` opcional
- `entidad_id` opcional
- `sede_id` opcional

Notas importantes:

- `nuip` requerido y es la identificación pública de la persona.
- `name` requerido.
- En v2, si se solicita sincronización con un reloj y no existe una relación previa en `persona_dispositivos`, la API usará internamente `nuip` como `pin_dispositivo` técnico para el reloj.
- Si no solicitas sincronización, solo se persiste en MySQL.
- `targetDeviceSn` identifica el reloj físico; sigue siendo obligatorio cuando pides sincronización.

Ejemplo solo MySQL:

```bash
curl.exe -X POST -H "X-API-Key: {{apiKey}}" -F "nuip=1234567890" -F "name=Yordan Perez" "{{baseUrl}}/api/v1/persons"
```

Ejemplo MySQL + reloj (v2 — sin `pin_dispositivo` público):

```bash
curl.exe -X POST -H "X-API-Key: {{apiKey}}" -F "nuip=1234567890" -F "name=Yordan Perez" -F "password=1234567" -F "siteId={{siteId}}" -F "targetDeviceSn={{targetDeviceSn}}" -F "syncDevice=true" -F "image=@foto.jpg" "{{baseUrl}}/api/v1/persons"
```

### Obtener persona por NUIP

`GET {{baseUrl}}/api/v1/persons/{{nuip}}`

Ejemplo curl:

```bash
curl.exe -H "X-API-Key: {{apiKey}}" "{{baseUrl}}/api/v1/persons/1234567890"
```

### Actualizar persona por NUIP

`PATCH {{baseUrl}}/api/v1/persons/{{nuip}}`

Tipo:

- JSON o `multipart/form-data`

Campos públicos (contrato v2):

- `name` opcional
- `password` opcional
- `image` opcional
- `siteId` opcional
- `targetDeviceSn` requerido si sincronizas reloj
- `syncDevice` opcional
- `estado` opcional
- `sede_id` opcional

Notas importantes sobre sincronización (v2):

- Cuando se solicita sincronización con un reloj (`targetDeviceSn`), la API resolverá internamente el `pin_dispositivo` desde `persona_dispositivos` si existe una relación previa.
- Si no existe una relación previa, en v2 la API usará `nuip` como `pin_dispositivo` técnico para encolar comandos ADMS.
- Por tanto, el consumidor público **no** necesita enviar `pin_dispositivo` en v2.

Ejemplo solo MySQL:

```bash
curl.exe -X PATCH -H "X-API-Key: {{apiKey}}" -H "Content-Type: application/json" -d "{\"name\":\"Yordan Alejandro\",\"estado\":\"activo\"}" "{{baseUrl}}/api/v1/persons/1234567890"
```

Ejemplo password + dispositivo (v2 — sin `pin_dispositivo` público):

```bash
curl.exe -X PATCH -H "X-API-Key: {{apiKey}}" -F "password=1234567" -F "targetDeviceSn={{targetDeviceSn}}" -F "syncDevice=true" "{{baseUrl}}/api/v1/persons/1234567890"
```

Ejemplo image + dispositivo (v2):

```bash
curl.exe -X PATCH -H "X-API-Key: {{apiKey}}" -F "image=@foto.jpg" -F "targetDeviceSn={{targetDeviceSn}}" -F "syncDevice=true" "{{baseUrl}}/api/v1/persons/1234567890"
```

Ejemplo image + password (v2):

```bash
curl.exe -X PATCH -H "X-API-Key: {{apiKey}}" -F "image=@foto.jpg" -F "password=1234567" -F "targetDeviceSn={{targetDeviceSn}}" -F "syncDevice=true" "{{baseUrl}}/api/v1/persons/1234567890"
```

### Eliminar lógico por NUIP

`DELETE {{baseUrl}}/api/v1/persons/{{nuip}}`

Comportamiento:

- en esta versión hace borrado lógico con `estado = 'inactivo'` por defecto.
- Para borrar en dispositivo (legacy-style) se debe enviar `scope`/`confirmation` según el flujo legacy; cuando se borra en dispositivo la API resolverá internamente `pin_dispositivo` desde `persona_dispositivos` o usará `nuip` como fallback.

Ejemplo borrado lógico (solo MySQL):

```bash
curl.exe -X DELETE -H "X-API-Key: {{apiKey}}" "{{baseUrl}}/api/v1/persons/1234567890"
```

Ejemplo borrado que especifica contexto de dispositivo (body JSON):

```bash
curl.exe -X DELETE -H "X-API-Key: {{apiKey}}" -H "Content-Type: application/json" -d '{
  "siteId": "default",
  "targetDeviceSn": "UDP3253500049"
}' "{{baseUrl}}/api/v1/persons/1234567890"
```

## 8. Actualizar persona existente

`PATCH {{baseUrl}}/api/v1/persons/{{pin}}`

Tipo:

- `multipart/form-data`

Campos:

- `name = Persona API Actualizada`
- `password = 1234`
- `siteId = {{siteId}}`
- `targetDeviceSn = {{targetDeviceSn}}`
- `image =` archivo JPG/PNG

Respuesta esperada:

```json
{
  "ok": true,
  "operation": "update",
  "pin": "1913",
  "siteId": "almacen",
  "targetDeviceSn": "CNYG225160781",
  "userCommandId": 125,
  "biophotoCommandId": 126,
  "message": "Persona actualizada y encolada para sincronizacion ADMS"
}
```

Si el PIN no existe para esa sede/dispositivo:

```json
{
  "ok": false,
  "error": "La persona no existe. Usa POST /api/v1/persons/enroll para crearla."
}
```

## 8.1 Actualizar perfil de dispositivo por NUIP

`PATCH {{baseUrl}}/api/v1/persons/{{nuip}}/device-profile`

Tipo:

- `multipart/form-data`

Reglas:

- requiere API key
- endpoint experimental en `0.0.1`
- `nuip` es la identificacion real de la persona
- `pin_dispositivo` es el identificador tecnico usado por ZKTeco
- no se asume que `nuip` y `pin_dispositivo` sean iguales
- en esta version debes enviar siempre `pin_dispositivo`
 - `pin_dispositivo` es el identificador técnico usado por ZKTeco y **existe internamente** en la tabla `persona_dispositivos`.
 - En el contrato público v2 **no** se solicita `pin_dispositivo`; la API resuelve ese valor internamente (relación existente o `nuip` como fallback).
 - La ruta `PATCH /api/v1/persons/:nuip/device-profile` sigue siendo experimental y puede requerir `pin_dispositivo` según el uso interno; revisar el endpoint experimental antes de usarlo en producción.

Campos opcionales:

- `image =` archivo JPG/PNG
- `password = 1234`
- `name = Persona API Actualizada`
- `pin_dispositivo = 1913`
- `targetDeviceSn = {{targetDeviceSn}}`
- `siteId = {{siteId}}`

Validaciones:

- `nuip` requerido en la URL
- debes enviar al menos uno de `image`, `password` o `name`
- `pin_dispositivo` requerido en esta version experimental
- si envias `name` sin `password`, responde `400`
- si envias `password` sin `name`, solo funciona si existe un nombre local confiable
- si envias imagen, se normaliza antes de `BIOPHOTO` a JPEG baseline, RGB, sin metadata y evitando progressive

Combinaciones soportadas:

- solo `image`
- solo `password`
- `image + password`
- `name + password`
- `name + image + password`

Fuente actual:

- encola comandos ADMS `USERINFO` y/o `BIOPHOTO`
- mantiene modo `compat` con el flujo actual
- preparado para evolucion posterior sin asumir que `nuip == pin_dispositivo`

Respuesta esperada:

```json
{
  "ok": true,
  "message": "Perfil de dispositivo actualizado",
  "nuip": "1234567890",
  "pin_dispositivo": "1913",
  "updated": {
    "name": false,
    "password": true,
    "photo": true
  },
  "commands": [
    {
      "commandId": "125",
      "commandType": "USERINFO",
      "status": "pending",
      "acceptedByDevice": false,
      "targetDeviceSn": "CNYG225160781",
      "siteId": "almacen"
    },
    {
      "commandId": "126",
      "commandType": "BIOPHOTO",
      "status": "pending",
      "acceptedByDevice": false,
      "targetDeviceSn": "CNYG225160781",
      "siteId": "almacen"
    }
  ]
}
```

Ejemplos curl:

Solo password:

```bash
curl.exe -X PATCH -H "X-API-Key: {{apiKey}}" -F "password=1234567" -F "pin_dispositivo=1913" -F "siteId={{siteId}}" -F "targetDeviceSn={{targetDeviceSn}}" "{{baseUrl}}/api/v1/persons/1234567890/device-profile"
```

Solo image:

```bash
curl.exe -X PATCH -H "X-API-Key: {{apiKey}}" -F "image=@foto.jpg" -F "pin_dispositivo=1913" -F "siteId={{siteId}}" -F "targetDeviceSn={{targetDeviceSn}}" "{{baseUrl}}/api/v1/persons/1234567890/device-profile"
```

Image + password:

```bash
curl.exe -X PATCH -H "X-API-Key: {{apiKey}}" -F "image=@foto.jpg" -F "password=1234567" -F "pin_dispositivo=1913" -F "siteId={{siteId}}" -F "targetDeviceSn={{targetDeviceSn}}" "{{baseUrl}}/api/v1/persons/1234567890/device-profile"
```

## 9. Consultar comandos por PIN

`GET {{baseUrl}}/api/v1/commands?pin={{pin}}`

Por sede y dispositivo:

`GET {{baseUrl}}/api/v1/commands?siteId={{siteId}}&targetDeviceSn={{targetDeviceSn}}&sn={{targetDeviceSn}}`

Estado de comandos puntuales:

`GET {{baseUrl}}/api/v1/commands/status?ids=123,124`

## 10. Consultar asistencia por PIN

`GET {{baseUrl}}/api/v1/attendance?siteId={{siteId}}&sn={{targetDeviceSn}}&pin={{pin}}`

Con rango:

`GET {{baseUrl}}/api/v1/attendance?siteId={{siteId}}&sn={{targetDeviceSn}}&pin={{pin}}&from=2026-05-01&to=2026-05-31`

Requiere API key:

- `X-API-Key: {{apiKey}}`
- o `Authorization: Bearer {{apiKey}}`

Fuente temporal actual:

- `data/adms-attlog.log`
- usando la misma lectura que `/adms/records/attendance`

Estado del endpoint:

- endpoint publico actual en modo `compat`
- preparado para evolucion futura a `MySQL-first`

Filtros soportados:

- `pin`
- `from`
- `to`
- `limit`
- `siteId`
- `sn`

Respuesta estable esperada:

```json
{
  "ok": true,
  "source": "adms-attlog-file",
  "mode": "compat",
  "filters": {
    "pin": "1913",
    "from": "2026-05-01",
    "to": "2026-05-31",
    "limit": 100,
    "siteId": "almacen",
    "sn": "CNYG225160781"
  },
  "count": 2,
  "records": [
    {
      "pin": "1913",
      "timestamp": "2026-05-26T13:05:00.000Z",
      "verifyMode": "1",
      "sn": "CNYG225160781",
      "siteId": "almacen"
    }
  ]
}
```

Errores:

- `400` si `pin`, `from`, `to`, `limit`, `siteId` o `sn` son invalidos
- `401` si falta API key

Ejemplo curl:

```bash
curl.exe -H "X-API-Key: {{apiKey}}" "{{baseUrl}}/api/v1/attendance?siteId={{siteId}}&sn={{targetDeviceSn}}&pin={{pin}}&from=2026-05-01&to=2026-05-31&limit=100"
```

## 11. Borrar persona local

`DELETE {{baseUrl}}/api/v1/persons/{{pin}}`

Body JSON:

```json
{
  "scope": "local",
  "deleteAttendance": false,
  "deletePhoto": false,
  "deleteBiodata": false,
  "reason": "Borrado desde API"
}
```

## 12. Borrar persona local + dispositivo

`DELETE {{baseUrl}}/api/v1/persons/{{pin}}`

Body JSON:

```json
{
  "scope": "local+device",
  "targetDeviceSn": "CNYG225160781",
  "siteId": "almacen",
  "confirmation": "BORRAR PIN 1913",
  "reason": "Borrado desde API"
}
```

## Extra utiles

Persona puntual:

`GET {{baseUrl}}/api/v1/persons/{{pin}}`

Dispositivo puntual:

`GET {{baseUrl}}/api/v1/devices/{{targetDeviceSn}}`

Sync por PIN:

`GET {{baseUrl}}/api/v1/sync/status/{{pin}}`

## Asistencia ADMS actual

Estos endpoints ADMS existen hoy por compatibilidad y operacion interna.

Fuente operativa actual:

- `data/adms-attlog.log`
- se lee mediante `readJsonLinesFile(...)` y `readAttendanceEntries(...)`
- actualmente no consultan MySQL para responder

Evolucion esperada:

- `/api/v1/attendance` ya existe como endpoint publico protegido con API key
- MySQL sera la fuente oficial en la siguiente evolucion de ese endpoint

Nota importante:

- no uses `/adms/attendance-summary` como resumen de nomina
- hoy es solo un resumen crudo diario de marcaciones

### 1. GET /adms/attendance

Tipo:

- legacy/simple

Parametros:

- `pin` opcional
- `from` opcional en formato `YYYY-MM-DD`
- `to` opcional en formato `YYYY-MM-DD`
- `limit` opcional

Fuente actual de datos:

- `data/adms-attlog.log`

Ejemplo curl:

```bash
curl.exe "{{baseUrl}}/adms/attendance?pin={{pin}}&from=2026-05-01&to=2026-05-31&limit=50"
```

### 2. GET /adms/attendance/:pin

Tipo:

- legacy/simple

Parametros:

- `:pin` requerido
- `from` opcional en formato `YYYY-MM-DD`
- `to` opcional en formato `YYYY-MM-DD`
- `limit` opcional

Fuente actual de datos:

- `data/adms-attlog.log`

Ejemplo curl:

```bash
curl.exe "{{baseUrl}}/adms/attendance/{{pin}}?from=2026-05-01&to=2026-05-31&limit=50"
```

### 3. GET /adms/attendance-summary

Tipo:

- legacy/simple

Parametros:

- `pin` requerido
- `date` requerido en formato `YYYY-MM-DD`

Fuente actual de datos:

- `data/adms-attlog.log`

Comportamiento:

- devuelve primer marcaje, ultimo marcaje, total y lista cruda de checks del dia

Ejemplo curl:

```bash
curl.exe "{{baseUrl}}/adms/attendance-summary?pin={{pin}}&date=2026-05-26"
```

### 4. GET /adms/records/attendance

Tipo:

- operativo/multisede actual

Parametros:

- `pin` opcional
- `from` opcional en formato `YYYY-MM-DD`
- `to` opcional en formato `YYYY-MM-DD`
- `limit` opcional
- `siteId` opcional
- `sn` opcional
- `targetDeviceSn` opcional
- `scope` opcional, por ejemplo `all`

Fuente actual de datos:

- `data/adms-attlog.log`

Uso recomendado:

- este es el endpoint actual para lectura operativa y multisede de asistencia ADMS

Ejemplo curl:

```bash
curl.exe "{{baseUrl}}/adms/records/attendance?siteId={{siteId}}&targetDeviceSn={{targetDeviceSn}}&pin={{pin}}&from=2026-05-01&to=2026-05-31&limit=100"
```
