-- Persistencia MySQL para cola y estado de comandos ADMS.
-- No reemplaza runtime por si sola; server.js debe migrarse en fases.

CREATE TABLE IF NOT EXISTS adms_commands (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    entidad_id BIGINT UNSIGNED NULL,
    dispositivo_id BIGINT UNSIGNED NULL,
    persona_id BIGINT UNSIGNED NULL,
    pin_dispositivo VARCHAR(50) NULL,
    command_type VARCHAR(50) NOT NULL,
    command_text LONGTEXT NOT NULL,
    purpose VARCHAR(80) NULL,
    status ENUM('queued','retry_pending','sent_waiting_ack','accepted','failed') NOT NULL DEFAULT 'queued',
    return_code VARCHAR(20) NULL,
    sent_at DATETIME NULL,
    acknowledged_at DATETIME NULL,
    ack_device_sn VARCHAR(80) NULL,
    request_device_sn VARCHAR(80) NULL,
    target_device_sn VARCHAR(80) NULL,
    raw_result TEXT NULL,
    error TEXT NULL,
    request_attempts INT UNSIGNED NOT NULL DEFAULT 0,
    locked_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_adms_commands_device_status (dispositivo_id, status),
    KEY idx_adms_commands_target_status (target_device_sn, status),
    KEY idx_adms_commands_entity_person (entidad_id, persona_id),
    KEY idx_adms_commands_type (command_type),
    KEY idx_adms_commands_created_at (created_at),
    KEY idx_adms_commands_status (status),
    KEY idx_adms_commands_pin (pin_dispositivo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
