# Almacenamiento ADMS en `api-zkteco`

Este documento explica, en espanol simple, que guarda el proyecto cuando trabaja por ADMS con dispositivos ZKTeco, donde se guarda y para que sirve cada cosa.

## Resumen rapido

- La fuente oficial de asistencias es la tabla MySQL `asistencias`.
- Los archivos en `data/` y `logs/` se conservan como respaldo, auditoria o evidencia cruda.
- `data/adms/adms-attlog.log` ya no es la fuente principal de asistencia.
- `asistencias.txt` ya no debe usarse porque duplicaba informacion y generaba confusion.

## Que guarda cada carpeta o archivo

### `uploads/`

Guarda archivos subidos desde formularios o pruebas del backend.

Sirve como almacenamiento temporal o de apoyo para imagenes y otros archivos cargados manualmente.

### `uploads/faces/`

Guarda la imagen final de rostro asociada a un PIN, normalmente como `uploads/faces/<pin>.jpg`.

Sirve para:

- conservar la imagen usada para enviar `BIOPHOTO`
- revisar manualmente que archivo se uso en una prueba
- comparar hashes, tamanos y modos de imagen

### `data/adms/adms-attlog.log`

Guarda el respaldo en archivo de las lineas de asistencia recibidas por ADMS.

Sirve para:

- auditoria
- respaldo si MySQL falla
- revisar exactamente que llego desde el dispositivo

No es la fuente principal de asistencia.

### `data/adms/adms-biodata.log`

Guarda las plantillas `BIODATA` recibidas por ADMS.

Sirve para auditoria y pruebas biometrico-faciales.

### `data/adms/biophotos/`

Guarda archivos `BIOPHOTO` recibidos o reconstruidos desde el trafico ADMS.

Sirve para analisis tecnico, comparaciones y clonacion controlada de perfiles cuando se necesite.

### `logs/adms-traffic.log`

Guarda el trafico crudo de las rutas ADMS:

- `/iclock/getrequest`
- `/iclock/cdata`
- `/iclock/devicecmd`

Sirve como auditoria de bajo nivel. No es una fuente funcional de asistencia.

### `logs/adms-command-sent.log`

Guarda cada comando ADMS enviado al dispositivo.

Sirve para saber:

- que comando salio
- a que PIN iba
- si el `Content` llevaba coma final o no
- el tamano del contenido
- el modo de imagen usado

No guarda el Base64 completo en la vista resumida del comando.

### `logs/adms-command-results.log`

Guarda las respuestas del dispositivo a comandos ADMS.

Sirve para auditoria y para verificar resultados como `Return=0`.

### `data/adms/adms-persons.jsonl`

Guarda un historial simple de personas encoladas o tratadas por los flujos ADMS del proyecto.

Sirve como referencia operativa y respaldo ligero.

## Tablas MySQL oficiales

### Tabla `asistencias`

Esta es la fuente principal y oficial de asistencia.

Guarda:

- `numero_serie_dispositivo`
- `pin`
- `fecha_hora_dispositivo`
- `estado_verificacion`
- `modo_verificacion`
- `codigo_trabajo`
- `linea_original`
- `recibido_en`
- `origen`
- `creado_en`

Se usa para:

- consultas por PIN y rango de fechas
- resumenes de asistencia
- evitar depender del archivo plano como fuente principal

### Tabla `dispositivos_adms`

Guarda el estado conocido de cada dispositivo ADMS.

Campos importantes:

- `numero_serie`
- `ultima_conexion`
- `ultima_ip`
- `estado`
- `ultimo_user_count`
- `ultimo_face_count`
- `actualizado_en`

Se actualiza cuando llega trafico por:

- `/iclock/getrequest`
- `/iclock/cdata`
- `/iclock/devicecmd`

### Tabla `sincronizaciones_adms`

Guarda solicitudes de sincronizacion pendientes o completadas.

Campos importantes:

- `numero_serie_dispositivo`
- `tipo`
- `estado`
- `solicitado_en`
- `entregado_en`
- `completado_en`
- `resultado`

Se usa para registrar pedidos como `sincronizar_asistencias`.

## Cual es el registro oficial de asistencias

El registro oficial es MySQL, tabla `asistencias`.

Los endpoints del backend deben consultar primero esta tabla.

El archivo `data/adms/adms-attlog.log` queda solo como respaldo o auditoria.

## Que archivos son solo respaldo o auditoria

Estos archivos no deben tratarse como fuente principal:

- `data/adms/adms-attlog.log`
- `data/adms/adms-biodata.log`
- `data/adms/biophotos/`
- `logs/adms-traffic.log`
- `logs/adms-command-sent.log`
- `logs/adms-command-results.log`
- `data/adms/adms-persons.jsonl`

## Por que ya no se debe usar `asistencias.txt`

Porque duplicaba informacion y no tenia control serio de integridad.

Problemas de `asistencias.txt`:

- no era la fuente oficial
- podia repetir registros
- no era facil consultar por fechas o por dispositivo
- generaba confusion frente a `data/adms/adms-attlog.log` y MySQL

## Que pasa si el dispositivo esta desconectado

Si el dispositivo esta desconectado, el servidor no puede leer asistencias en tiempo real.

En ese caso:

1. se crea una solicitud en `sincronizaciones_adms`
2. la solicitud queda `pending`
3. cuando el dispositivo vuelve a conectarse por ADMS, el backend actualiza su estado
4. cuando llegan nuevos `ATTLOG`, se guardan en MySQL y la sincronizacion se marca como `completed`

## Como se evita guardar la misma asistencia dos veces

La tabla `asistencias` tiene una clave unica basada en:

- `numero_serie_dispositivo`
- `pin`
- `fecha_hora_dispositivo`
- `estado_verificacion`
- `modo_verificacion`
- `codigo_trabajo`

El backend inserta con `INSERT IGNORE`.

Eso permite:

- aceptar trafico repetido del dispositivo
- evitar duplicados al reintentar sincronizaciones
- mantener limpio el registro oficial

## Fuentes y jerarquia recomendada

Orden recomendado de confianza:

1. MySQL tabla `asistencias`
2. `data/adms/adms-attlog.log` como fallback tecnico
3. `logs/adms-traffic.log` para auditoria cruda

## Endpoints relacionados

- `GET /adms/attendance`: consulta principal de asistencias
- `GET /adms/attendance-summary`: resumen por PIN y fecha
- `GET /adms/attendance/raw-log`: auditoria del archivo de respaldo
- `GET /adms/devices`: estado de dispositivos ADMS conocidos
- `POST /adms/sync/attendance`: crea una sincronizacion pendiente de asistencias
