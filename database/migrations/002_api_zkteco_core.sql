-- Core no destructivo para CRUD publico por NUIP.
-- usuarios queda como tabla legacy.
-- personas pasa a ser la tabla oficial nueva.
-- nuip = identificacion real de la persona.
-- pin_dispositivo = identificador tecnico usado por ZKTeco.

INSERT INTO entidades (nombre, codigo, descripcion, estado)
SELECT 'Entidad principal', 'default', 'Entidad por defecto para API-ZKTECO 0.0.1', 'activo'
WHERE NOT EXISTS (
    SELECT 1
    FROM entidades
    WHERE codigo COLLATE utf8mb4_unicode_ci = 'default'
);

CREATE TABLE IF NOT EXISTS sedes (
    id INT NOT NULL AUTO_INCREMENT,
    entidad_id INT NOT NULL,
    nombre VARCHAR(150) NOT NULL,
    codigo VARCHAR(100) NOT NULL,
    zona_horaria VARCHAR(100) NOT NULL DEFAULT 'America/Bogota',
    estado ENUM('activo', 'inactivo') NOT NULL DEFAULT 'activo',
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_sedes_entidad_codigo (entidad_id, codigo),
    KEY idx_sedes_entidad_id (entidad_id),
    CONSTRAINT fk_sedes_entidad
        FOREIGN KEY (entidad_id) REFERENCES entidades (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dispositivos (
    id INT NOT NULL AUTO_INCREMENT,
    entidad_id INT NOT NULL,
    sede_id INT NOT NULL,
    numero_serie VARCHAR(120) NOT NULL,
    nombre VARCHAR(150) NOT NULL,
    ip VARCHAR(45) NULL,
    puerto INT NOT NULL DEFAULT 4370,
    tipo_conexion VARCHAR(20) NOT NULL DEFAULT 'adms',
    estado VARCHAR(30) NOT NULL DEFAULT 'registrado',
    ultima_conexion DATETIME NULL,
    activo TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_dispositivos_numero_serie (numero_serie),
    KEY idx_dispositivos_entidad_sede (entidad_id, sede_id),
    CONSTRAINT fk_dispositivos_entidad
        FOREIGN KEY (entidad_id) REFERENCES entidades (id),
    CONSTRAINT fk_dispositivos_sede
        FOREIGN KEY (sede_id) REFERENCES sedes (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS personas (
    id INT NOT NULL AUTO_INCREMENT,
    entidad_id INT NOT NULL,
    sede_id INT NULL,
    nuip VARCHAR(50) NOT NULL,
    pin VARCHAR(50) NULL,
    nombres VARCHAR(150) NOT NULL,
    apellidos VARCHAR(150) NULL,
    nombre_completo VARCHAR(255) NOT NULL,
    estado ENUM('activo', 'inactivo') NOT NULL DEFAULT 'activo',
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_personas_entidad_nuip (entidad_id, nuip),
    KEY idx_personas_entidad_nuip (entidad_id, nuip),
    KEY idx_personas_sede_id (sede_id),
    CONSTRAINT fk_personas_entidad
        FOREIGN KEY (entidad_id) REFERENCES entidades (id),
    CONSTRAINT fk_personas_sede
        FOREIGN KEY (sede_id) REFERENCES sedes (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS persona_dispositivos (
    id INT NOT NULL AUTO_INCREMENT,
    persona_id INT NOT NULL,
    dispositivo_id INT NOT NULL,
    pin_dispositivo VARCHAR(50) NOT NULL,
    estado_sync VARCHAR(30) NOT NULL DEFAULT 'pendiente',
    ultimo_comando_id BIGINT NULL,
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_persona_dispositivos_persona_dispositivo (persona_id, dispositivo_id),
    KEY idx_persona_dispositivos_persona_id (persona_id),
    KEY idx_persona_dispositivos_dispositivo_id (dispositivo_id),
    CONSTRAINT fk_persona_dispositivos_persona
        FOREIGN KEY (persona_id) REFERENCES personas (id),
    CONSTRAINT fk_persona_dispositivos_dispositivo
        FOREIGN KEY (dispositivo_id) REFERENCES dispositivos (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO sedes (entidad_id, nombre, codigo, zona_horaria, estado)
SELECT e.id, 'Sede principal', 'default', 'America/Bogota', 'activo'
FROM entidades e
WHERE e.codigo COLLATE utf8mb4_unicode_ci = 'default'
  AND NOT EXISTS (
      SELECT 1
      FROM sedes s
      WHERE s.entidad_id = e.id
        AND s.codigo COLLATE utf8mb4_unicode_ci = 'default'
  )
LIMIT 1;

INSERT INTO dispositivos (
    entidad_id,
    sede_id,
    numero_serie,
    nombre,
    ip,
    puerto,
    tipo_conexion,
    estado,
    ultima_conexion,
    activo
)
SELECT
    e.id AS entidad_id,
    s.id AS sede_id,
    da.numero_serie,
    CONCAT('Dispositivo ', da.numero_serie) AS nombre,
    NULLIF(da.ultima_ip, '') AS ip,
    4370 AS puerto,
    'adms' AS tipo_conexion,
    COALESCE(NULLIF(da.estado, ''), 'registrado') AS estado,
    da.ultima_conexion,
    CASE
        WHEN COALESCE(NULLIF(da.estado, ''), 'offline') = 'inactivo' THEN 0
        ELSE 1
    END AS activo
FROM dispositivos_adms da
INNER JOIN entidades e
    ON e.codigo COLLATE utf8mb4_unicode_ci = 'default'
INNER JOIN sedes s
    ON s.entidad_id = e.id
   AND s.codigo COLLATE utf8mb4_unicode_ci = 'default'
LEFT JOIN dispositivos d
    ON d.numero_serie COLLATE utf8mb4_unicode_ci = da.numero_serie COLLATE utf8mb4_unicode_ci
WHERE d.id IS NULL;
