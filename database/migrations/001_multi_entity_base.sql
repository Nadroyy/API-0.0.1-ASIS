-- Base inicial para modelo multi-entidad / multi-sede.
-- No modifica tablas existentes ni elimina datos.
-- nuip = identidad de negocio/persona.
-- pin_dispositivo = identificador tecnico usado por ZKTeco.
-- pin queda temporalmente por compatibilidad.

CREATE TABLE IF NOT EXISTS entidades (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    nombre VARCHAR(150) NOT NULL,
    codigo VARCHAR(100) NOT NULL,
    activo TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_entidades_codigo (codigo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sedes (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    entidad_id BIGINT UNSIGNED NOT NULL,
    nombre VARCHAR(150) NOT NULL,
    codigo VARCHAR(100) NOT NULL,
    zona_horaria VARCHAR(100) NOT NULL DEFAULT 'America/Bogota',
    activo TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_sedes_entidad_codigo (entidad_id, codigo),
    KEY idx_sedes_entidad_id (entidad_id),
    CONSTRAINT fk_sedes_entidad
        FOREIGN KEY (entidad_id) REFERENCES entidades (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dispositivos (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    entidad_id BIGINT UNSIGNED NOT NULL,
    sede_id BIGINT UNSIGNED NOT NULL,
    numero_serie VARCHAR(100) NOT NULL,
    nombre VARCHAR(150) NOT NULL,
    ip VARCHAR(45) NULL,
    puerto INT NOT NULL DEFAULT 4370,
    tipo_conexion VARCHAR(20) NOT NULL DEFAULT 'adms',
    estado VARCHAR(30) NOT NULL DEFAULT 'registrado',
    ultima_conexion DATETIME NULL,
    activo TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_dispositivos_numero_serie (numero_serie),
    KEY idx_dispositivos_entidad_sede (entidad_id, sede_id),
    CONSTRAINT fk_dispositivos_entidad
        FOREIGN KEY (entidad_id) REFERENCES entidades (id),
    CONSTRAINT fk_dispositivos_sede
        FOREIGN KEY (sede_id) REFERENCES sedes (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS personas (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    entidad_id BIGINT UNSIGNED NOT NULL,
    sede_id BIGINT UNSIGNED NULL,
    nuip VARCHAR(50) NOT NULL,
    pin VARCHAR(50) NULL,
    nombres VARCHAR(150) NOT NULL,
    apellidos VARCHAR(150) NULL,
    nombre_completo VARCHAR(255) NOT NULL,
    estado VARCHAR(30) NOT NULL DEFAULT 'activo',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
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
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    persona_id BIGINT UNSIGNED NOT NULL,
    dispositivo_id BIGINT UNSIGNED NOT NULL,
    pin_dispositivo VARCHAR(50) NOT NULL,
    estado_sync VARCHAR(30) NOT NULL DEFAULT 'pendiente',
    ultimo_comando_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_persona_dispositivos_persona_dispositivo (persona_id, dispositivo_id),
    KEY idx_persona_dispositivos_persona_id (persona_id),
    KEY idx_persona_dispositivos_dispositivo_id (dispositivo_id),
    CONSTRAINT fk_persona_dispositivos_persona
        FOREIGN KEY (persona_id) REFERENCES personas (id),
    CONSTRAINT fk_persona_dispositivos_dispositivo
        FOREIGN KEY (dispositivo_id) REFERENCES dispositivos (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
