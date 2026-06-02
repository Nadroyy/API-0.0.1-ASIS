# ADMS multisede: operacion

## 1. Estado actual del sistema

- El servidor ADMS esta estable y funcionando en modo multisede basico.
- La sede `default` representa `Sede principal`.
- El reloj `UDP3253500049` esta permitido en `default`.
- La sede `almacen` existe como prueba con hostname `almacen.local` y sin dispositivos permitidos.
- Los dispositivos no autorizados se detectan como `discoveredOnly` y no deben usarse para registro.

## 2. Como funciona `targetDeviceSn`

- `targetDeviceSn` identifica el reloj fisico destino para comandos ADMS.
- Se envia desde el panel cuando hay un dispositivo valido seleccionado.
- El backend lo usa para asociar el comando a un reloj concreto.

## 3. Como funciona `siteId`

- `siteId` identifica la sede logica.
- El panel lo resuelve por hostname con `GET /adms/config/context`.
- El backend lo conserva junto con el comando para trazabilidad.

## 4. Como funciona `allowedDeviceSns`

- Cada sede tiene una lista `allowedDeviceSns`.
- Solo los SN incluidos alli pueden quedar habilitados para esa sede.
- Si la lista esta vacia, la sede no tiene dispositivos habilitados y el panel bloquea el registro.

## 5. Como crear una sede

Desde API:

```powershell
Invoke-RestMethod -Method POST `
  -Uri "http://localhost:3000/adms/config/sites/almacen" `
  -ContentType "application/json" `
  -Body '{"name":"Almacen","hostname":"almacen.local","enabled":true}'
```

Desde panel:

- Ir a `Configuracion ADMS`
- Clic en `Crear sede`
- Ingresar `siteId`, `name` y `hostname`

## 6. Como probar hostname con curl

```bash
curl -H "Host: almacen.local" http://localhost:3000/adms/config/context
curl -H "Host: 192.168.2.97" http://localhost:3000/adms/config/context
```

## 7. Como agregar un dispositivo nuevo

- Conectar el reloj al ADMS.
- Esperar a que aparezca en `GET /adms/records/devices`.
- Si aun no esta autorizado, aparecera como `discoveredOnly`.

## 8. Como autorizar un SN

Desde panel:

- Ir a `Configuracion ADMS`
- En la sede correcta usar `Agregar SN permitido`

Desde API:

```powershell
Invoke-RestMethod -Method POST `
  -Uri "http://localhost:3000/adms/config/sites/default/allowed-devices" `
  -ContentType "application/json" `
  -Body '{"sn":"UDP3253500049"}'
```

## 9. Como renombrar dispositivo

- Ir a `Configuracion ADMS`
- Clic en `Editar dispositivo`
- Ajustar nombre, ubicacion, `siteId` y `enabled`

## 10. Como validar que un reloj esta online

- Abrir el panel y revisar `Estado del dispositivo`
- O consultar:

```powershell
Invoke-RestMethod -Method GET -Uri "http://localhost:3000/adms/records/devices" | ConvertTo-Json -Depth 10
```

- El estado `online` indica conexion reciente.

## 11. Como registrar un PIN de prueba

- Abrir el panel en la sede correcta.
- Confirmar que exista un dispositivo habilitado en `Destino ADMS`.
- Ingresar `PIN`, `Nombre`, `Contrasena`, imagen y `sourceFacePin`.
- Pulsar `Registrar persona`.

## 12. Como consultar `command-status`

```powershell
Invoke-RestMethod -Method GET `
  -Uri "http://localhost:3000/adms/command-status?ids=182,183,184" |
  ConvertTo-Json -Depth 10
```

## 13. Como consultar `sync/status`

```powershell
Invoke-RestMethod -Method GET `
  -Uri "http://localhost:3000/adms/sync/status?pin=99892" |
  ConvertTo-Json -Depth 10
```

## 14. Como revisar logs ADMS

- Revisar `logs.txt`
- Revisar `data/adms-sites.json`
- Revisar `data/adms/` para colas, comandos enviados, resultados y auditorias

## 15. Significado de estados

- `queued`: comando en cola, aun no confirmado por el reloj
- `sent_waiting_ack`: comando entregado al flujo ADMS, esperando `Return`
- `accepted`: el reloj confirmo correctamente con `Return=0`
- `failed`: el reloj devolvio error o el procesamiento fallo
- `discoveredOnly`: el reloj fue detectado pero no esta autorizado para la sede
- `enabled`: el dispositivo esta habilitado logicamente para operar en su sede

## 16. Que hacer si un reloj no aparece

- Confirmar IP, red y configuracion ADMS del reloj
- Revisar `GET /adms/records/devices`
- Revisar si el reloj aparece como `offline`
- Validar que el reloj apunte al servidor correcto

## 17. Que hacer si el panel dice “sin dispositivos habilitados”

- Revisar la sede activa en `Destino ADMS`
- Confirmar el hostname con `GET /adms/config/context`
- Agregar un SN permitido en `Configuracion ADMS`
- O cambiar a una sede que ya tenga SN autorizados

## 18. Que NO tocar en operacion normal

- `USERINFO`
- `BIOPHOTO`
- `BIODATA`
- `/iclock/getrequest`
- `/iclock/devicecmd`
- parser multilinea
- cola ADMS funcional
- `command-status`
- `sync/status`
- asistencia
- borrado remoto
- ZKBio
- TCP/pyzk
