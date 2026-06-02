# Endpoints ZKTeco TCP

> Nota legacy/opcional: el flujo principal del MVP cliente es ADMS Push. Estos ejemplos TCP se conservan solo como referencia tecnica de pruebas locales.

## Variables sugeridas en Postman

- `baseUrl`: `http://localhost:3000`
- `zkIp`: `{{zkIp}}`

## Probar conectividad TCP

### `GET {{baseUrl}}/zk/ping?ip={{zkIp}}`

Respuesta esperada:

```json
{
  "ok": true,
  "type": "tcp",
  "ip": "{{zkIp}}",
  "port": 4370,
  "responseTimeMs": 16.73,
  "timestamp": "2026-04-20T18:00:00.000Z",
  "message": "Puerto TCP 4370 accesible"
}
```

## Validar handshake con pyzk

### `GET {{baseUrl}}/zk/test-connection?ip={{zkIp}}`

## Obtener informacion del equipo

### `GET {{baseUrl}}/zk/device-info?ip={{zkIp}}`

## Listar usuarios

### `GET {{baseUrl}}/zk/users?ip={{zkIp}}`

## Crear o actualizar usuario

### `POST {{baseUrl}}/zk/create-user`

```json
{
  "ip": "{{zkIp}}",
  "uid": "10",
  "userId": "10",
  "name": "Juan Perez",
  "password": "1234",
  "role": 0
}
```

## Actualizar nombre o password

### `POST {{baseUrl}}/zk/update-user`

```json
{
  "ip": "{{zkIp}}",
  "uid": "10",
  "userId": "10",
  "name": "Juan Perez Actualizado",
  "password": "4321"
}
```

## Eliminar usuario

### `DELETE {{baseUrl}}/zk/user/10?ip={{zkIp}}`

## Ver logs recientes

### `GET {{baseUrl}}/zk/logs`

## Probar perfil real BIOPHOTO por ADMS

### 1. Listar perfiles capturados del dispositivo

### `GET {{baseUrl}}/adms/biophoto-profiles`

Respuesta esperada:

```json
[
  {
    "fileName": "1-9-0.jpg",
    "pin": "1",
    "type": "9",
    "index": "0",
    "sizeBytes": 15616,
    "width": 480,
    "height": 640,
    "format": "jpeg",
    "density": 72,
    "hasAlpha": false,
    "modifiedAt": "2026-05-05T22:00:00.000Z"
  }
]
```

### 2. Consultar el perfil mas reciente de un PIN

### `GET {{baseUrl}}/adms/biophoto-profiles/1`

### 3. Registrar una persona nueva con `device-biophoto-profile`

### `POST {{baseUrl}}/adms/enroll-person`

Usa `form-data`:

- `pin`: nuevo PIN
- `name`: nombre visible
- `password`: clave del usuario
- `image`: archivo de imagen
- `imageMode`: `device-biophoto-profile`
- `profilePin`: `1`
- `contentTerminator`: `none`

Campos clave a validar en la respuesta:

- `imageMode`
- `profilePin`
- `originalImageSize`
- `finalImageSize`
- `profileSizeBytes`
- `profileWidth`
- `profileHeight`
- `userCommandId`
- `biophotoCommandId`
- `savedPhoto`

Validacion esperada:

- `profileSizeBytes` cercano a perfiles reales como `15616` o `17120`
- `finalImageSize` mucho menor que `161556`
- `USERINFO` con `Return=0`
- `BIOPHOTO` con `Return=0`
- Luego confirmar en el dispositivo: usuario visible, marcacion correcta y llegada de `ATTLOG`
