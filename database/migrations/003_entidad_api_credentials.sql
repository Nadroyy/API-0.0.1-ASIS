CREATE TABLE IF NOT EXISTS entidad_api_credentials (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    entidad_id INT NOT NULL,
    nombre VARCHAR(150) NOT NULL,
    key_prefix VARCHAR(24) NOT NULL,
    key_hash VARCHAR(255) NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    last_used_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_entidad_api_credentials_key_prefix (key_prefix),
    KEY idx_entidad_api_credentials_entidad_id (entidad_id),
    CONSTRAINT fk_entidad_api_credentials_entidad
        FOREIGN KEY (entidad_id) REFERENCES entidades (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;