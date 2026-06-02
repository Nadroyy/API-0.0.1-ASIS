/*
  API-ZKTECO / ADMS - MYSQL MVP LIMPIO DESDE CERO
  VERSION SEGURA SIN FOREIGN KEYS BLOQUEANTES

  Motivo:
  - MySQL devolvio ER_CANNOT_ADD_FOREIGN al crear constraints.
  - Para desbloquear MVP, se crean tablas limpias con indices y relaciones logicas.
  - Las foreign keys se pueden agregar despues de confirmar version/engine/schema exacto.

  IMPORTANTE:
  - Este script elimina/recrea tablas dentro de control_asistencia.
  - Usar en entorno controlado.
*/

CREATE DATABASE IF NOT EXISTS control_asistencia
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE control_asistencia;

SET FOREIGN_KEY_CHECKS = 0;

DROP VIEW IF EXISTS v_admin_entities;

DROP TABLE IF EXISTS entidad_urls;
DROP TABLE IF EXISTS asistencias;
DROP TABLE IF EXISTS persona_dispositivos;
DROP TABLE IF EXISTS personas;
DROP TABLE IF EXISTS dispositivos;
DROP TABLE IF EXISTS entidad_api_credentials;
DROP TABLE IF EXISTS entidades;

DROP TABLE IF EXISTS sincronizaciones_adms;
DROP TABLE IF EXISTS dispositivos_adms;
DROP TABLE IF EXISTS usuarios;
DROP TABLE IF EXISTS sedes;

SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE entidades (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  nombre VARCHAR(150) NOT NULL,
  codigo VARCHAR(100) NOT NULL,
  descripcion VARCHAR(255) NULL,
  estado ENUM('activo', 'inactivo') NOT NULL DEFAULT 'activo',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_entidades_codigo (codigo),
  KEY idx_entidades_estado (estado)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE entidad_api_credentials (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  entidad_id INT UNSIGNED NOT NULL,
  nombre VARCHAR(150) NOT NULL,
  key_prefix VARCHAR(80) NOT NULL,
  key_hash CHAR(64) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  last_used_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_entidad_api_credentials_prefix (key_prefix),
  KEY idx_entidad_api_credentials_entidad (entidad_id),
  KEY idx_entidad_api_credentials_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dispositivos (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  entidad_id INT UNSIGNED NOT NULL,
  numero_serie VARCHAR(80) NOT NULL,
  nombre VARCHAR(150) NOT NULL,
  ip VARCHAR(80) NULL,
  estado ENUM('activo', 'inactivo') NOT NULL DEFAULT 'activo',
  ultima_conexion TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_dispositivos_numero_serie (numero_serie),
  KEY idx_dispositivos_entidad (entidad_id),
  KEY idx_dispositivos_estado (estado)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE personas (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  entidad_id INT UNSIGNED NOT NULL,
  nuip VARCHAR(50) NOT NULL,
  nombres VARCHAR(150) NOT NULL,
  apellidos VARCHAR(150) NULL,
  nombre_completo VARCHAR(255) NOT NULL,
  estado ENUM('activo', 'inactivo') NOT NULL DEFAULT 'activo',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_personas_entidad_nuip (entidad_id, nuip),
  KEY idx_personas_entidad_estado (entidad_id, estado),
  KEY idx_personas_nuip (nuip)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE persona_dispositivos (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  persona_id INT UNSIGNED NOT NULL,
  dispositivo_id INT UNSIGNED NOT NULL,
  pin_dispositivo VARCHAR(50) NOT NULL,
  estado_sync ENUM('pending', 'synced', 'failed', 'inactive') NOT NULL DEFAULT 'pending',
  ultimo_comando_id VARCHAR(50) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_persona_dispositivo (persona_id, dispositivo_id),
  UNIQUE KEY uk_dispositivo_pin (dispositivo_id, pin_dispositivo),
  KEY idx_persona_dispositivos_persona (persona_id),
  KEY idx_persona_dispositivos_dispositivo (dispositivo_id),
  KEY idx_persona_dispositivos_sync (estado_sync)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE asistencias (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  entidad_id INT UNSIGNED NOT NULL,
  dispositivo_id INT UNSIGNED NOT NULL,
  nuip VARCHAR(50) NOT NULL,
  timestamp DATETIME NOT NULL,
  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  raw_line TEXT NULL,
  PRIMARY KEY (id),
  KEY idx_asistencias_entidad_timestamp (entidad_id, timestamp),
  KEY idx_asistencias_dispositivo_timestamp (dispositivo_id, timestamp),
  KEY idx_asistencias_nuip_timestamp (nuip, timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE entidad_urls (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  entidad_id INT UNSIGNED NOT NULL,
  event_type VARCHAR(100) NOT NULL DEFAULT 'attendance.created',
  url VARCHAR(500) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_entidad_urls_entidad_event_enabled (entidad_id, event_type, enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO entidades (id, nombre, codigo, descripcion, estado)
VALUES
  (1, 'Entidad principal', 'default', 'Entidad base del sistema', 'activo');

CREATE OR REPLACE VIEW v_admin_entities AS
SELECT
  e.id,
  e.nombre,
  e.codigo,
  e.estado,
  e.created_at,
  e.updated_at,
  (
    SELECT COUNT(*)
    FROM dispositivos d
    WHERE d.entidad_id = e.id
  ) AS devicesCount,
  (
    SELECT COUNT(*)
    FROM entidad_api_credentials c
    WHERE c.entidad_id = e.id
  ) AS apiClientsCount
FROM entidades e;

SHOW TABLES;

SELECT id, nombre, codigo, estado
FROM entidades
ORDER BY id;
