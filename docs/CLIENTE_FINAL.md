# Guia Cliente Final

Esta guia describe el contrato publico del MVP para consumidores de la API v2. No incluye detalles internos de dispositivos, base de datos, archivos de runtime, `.env`, logs ni funcionamiento ADMS.

## Acceso

El proveedor entrega al cliente:

- `baseUrl`: URL base del servicio.
- `clientApiKey`: llave API cliente.
- `deviceSerial`: identificador del dispositivo asignado al cliente, cuando el flujo requiera sincronizacion con reloj.

Todas las solicitudes cliente usan:

```http
X-API-Key: {{clientApiKey}}
```

Tambien puede usarse:

```http
Authorization: Bearer {{clientApiKey}}
```

No envies llaves reales por correo sin cifrado, tickets publicos, repositorios ni capturas compartidas.

## Que envia el cliente

Para crear o actualizar personas:

- `nuip`: identificacion unica de la persona.
- `name`: nombre visible de la persona.
- `password`: opcional, si aplica al flujo contratado.
- `image`: opcional, archivo JPG/PNG en `multipart/form-data`.
- `targetDeviceSn`: requerido cuando el endpoint debe sincronizar con el dispositivo asignado. En Postman se recomienda usar el valor `{{deviceSerial}}`.

Para consultar asistencia:

- `nuip`: opcional, filtra por persona.
- `from`: opcional, fecha `YYYY-MM-DD`.
- `to`: opcional, fecha `YYYY-MM-DD`.
- `limit`: opcional, entero entre 1 y 1000.

## Que recibe el cliente

Las respuestas usan JSON. En general incluyen:

- `ok`: indica si la operacion fue aceptada.
- `message`: descripcion legible cuando aplica.
- `person`: datos publicos de una persona.
- `deviceSync`: estado de sincronizacion solicitada.
- `command`: estado publico de un comando.
- `records`: registros publicos de asistencia.

Ejemplo de persona publica:

```json
{
  "nuip": "123456789",
  "name": "Juan Perez",
  "status": "activo",
  "device": {
    "serial": "DEVICE-DEMO-001",
    "syncStatus": "pending"
  }
}
```

## Endpoints cliente

### Listar dispositivos asignados

```http
GET {{baseUrl}}/api/v2/devices
```

### Listar personas

```http
GET {{baseUrl}}/api/v2/persons
```

Filtros:

- `status=activo`
- `status=inactivo`
- `status=all`
- `nuip={{nuip}}`

### Crear persona

```http
POST {{baseUrl}}/api/v2/persons
```

Tipo recomendado:

```text
multipart/form-data
```

Campos:

- `nuip`
- `name`
- `password` opcional
- `targetDeviceSn` con valor `{{deviceSerial}}`
- `image` opcional

### Obtener persona

```http
GET {{baseUrl}}/api/v2/persons/{{nuip}}
```

### Actualizar persona

```http
PATCH {{baseUrl}}/api/v2/persons/{{nuip}}
```

Tipo recomendado:

```text
multipart/form-data
```

Campos opcionales:

- `name`
- `password`
- `image`
- `targetDeviceSn` con valor `{{deviceSerial}}`

### Desactivar persona

```http
DELETE {{baseUrl}}/api/v2/persons/{{nuip}}
```

Body JSON:

```json
{
  "targetDeviceSn": "{{deviceSerial}}"
}
```

### Consultar comando

```http
GET {{baseUrl}}/api/v2/commands/{{commandId}}
```

### Consultar asistencia

```http
GET {{baseUrl}}/api/v2/attendance?nuip={{nuip}}&from=2026-05-01&to=2026-05-31&limit=100
```

Respuesta de ejemplo:

```json
{
  "ok": true,
  "filters": {
    "from": "2026-05-01",
    "to": "2026-05-31",
    "nuip": "123456789",
    "limit": 100
  },
  "count": 1,
  "records": [
    {
      "nuip": "123456789",
      "timestamp": "2026-05-26T13:05:00.000Z",
      "deviceSerial": "DEVICE-DEMO-001",
      "receivedAt": "2026-05-26T13:05:03.000Z"
    }
  ]
}
```

## Webhook

El cliente puede entregar una URL HTTPS para recibir eventos. El proveedor configura esa URL en la administracion del sistema.

Evento disponible en el MVP:

```text
attendance.created
```

Payload:

```json
{
  "event": "attendance.created",
  "nuip": "123456789",
  "timestamp": "2026-05-26T13:05:00.000Z",
  "deviceSerial": "DEVICE-DEMO-001",
  "receivedAt": "2026-05-26T13:05:03.000Z"
}
```

Recomendaciones para la URL del webhook:

- Usar HTTPS.
- Responder con codigo 2xx cuando el evento sea recibido.
- No depender de IPs privadas ni URLs temporales.
- Registrar los eventos recibidos del lado cliente para auditoria propia.

## Codigos de error comunes

- `400 INVALID_REQUEST`: faltan campos requeridos o hay campos no permitidos.
- `400 VALIDATION_ERROR`: parametro invalido.
- `401 API_KEY_REQUIRED`: falta la llave API.
- `401 API_KEY_INVALID`: la llave API no es valida.
- `403 API_KEY_FORBIDDEN`: la llave no tiene permisos para el recurso.
- `403 DEVICE_NOT_ALLOWED`: el dispositivo no pertenece al alcance de la llave.
- `404 PERSON_NOT_FOUND`: no existe la persona solicitada.
- `404 DEVICE_NOT_FOUND`: no existe el dispositivo asignado.
- `404`: recurso no encontrado.
- `409 PERSON_ALREADY_EXISTS`: ya existe una persona activa con ese NUIP.
- `409 PERSON_INACTIVE`: la persona esta inactiva y debe reactivarse antes de actualizarla.

## Postman

Usa la coleccion:

```text
docs/postman/ADMS API v2.postman_collection.json
```

Variables recomendadas:

- `{{baseUrl}}`
- `{{clientApiKey}}`
- `{{nuip}}`
- `{{name}}`
- `{{password}}`
- `{{deviceSerial}}`

No guardes llaves reales dentro de la coleccion compartida.
