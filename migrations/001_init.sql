-- Tables owned by the alert app. They live in APP_DB (e.g. alert_app),
-- NOT in ptechview_cpcb. `{{APP_DB}}` is replaced by scripts/migrate.js.

CREATE TABLE IF NOT EXISTS `{{APP_DB}}`.`am_refresh_token` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` VARCHAR(20) NOT NULL,
  `token_hash` CHAR(64) NOT NULL,
  `family_id` CHAR(36) NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `revoked_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_token_hash` (`token_hash`),
  KEY `idx_user` (`user_id`),
  KEY `idx_family` (`family_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per alert episode. open_key is set while the alert is open and NULL once closed,
-- so the unique index guarantees one open alert per device+parameter (or per device for offline).
CREATE TABLE IF NOT EXISTS `{{APP_DB}}`.`am_alert` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `plant_id` INT NULL,
  `device_id` VARCHAR(50) NOT NULL,
  `param_id` VARCHAR(50) NULL,
  `alert_type` ENUM('critical','warning','offline') NOT NULL,
  `status` ENUM('open','acknowledged','closed') NOT NULL DEFAULT 'open',
  `message` VARCHAR(500) NOT NULL,
  `first_value` DECIMAL(18,2) NULL,
  `last_value` DECIMAL(18,2) NULL,
  `peak_value` DECIMAL(18,2) NULL,
  `min_limit` DECIMAL(18,2) NULL,
  `max_limit` DECIMAL(18,2) NULL,
  `started_at` DATETIME NOT NULL COMMENT 'reading time (IST) when the problem started',
  `last_reading_at` DATETIME NULL,
  `ended_at` DATETIME NULL,
  `ack_by` VARCHAR(20) NULL,
  `ack_at` DATETIME NULL,
  `ack_note` VARCHAR(500) NULL,
  `closed_by` VARCHAR(20) NULL COMMENT 'user id, or "system" when it auto-recovered',
  `open_key` VARCHAR(120) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_open_key` (`open_key`),
  KEY `idx_status` (`status`, `started_at`),
  KEY `idx_device` (`device_id`, `started_at`),
  KEY `idx_plant` (`plant_id`, `started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `{{APP_DB}}`.`am_device_token` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` VARCHAR(20) NOT NULL,
  `token` VARCHAR(512) NOT NULL,
  `platform` VARCHAR(20) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_seen_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_token` (`token`(255)),
  KEY `idx_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `{{APP_DB}}`.`am_notification_outbox` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `alert_id` BIGINT UNSIGNED NULL,
  `channel` ENUM('push','email') NOT NULL,
  `target` VARCHAR(512) NOT NULL,
  `title` VARCHAR(200) NOT NULL,
  `body` VARCHAR(2000) NOT NULL,
  `data_json` TEXT NULL,
  `status` ENUM('pending','sent','failed','skipped') NOT NULL DEFAULT 'pending',
  `attempts` INT NOT NULL DEFAULT 0,
  `next_attempt_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_error` VARCHAR(1000) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `sent_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  KEY `idx_due` (`status`, `next_attempt_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Optional: limit a non-admin user to some plants. No rows for a user = sees all plants.
CREATE TABLE IF NOT EXISTS `{{APP_DB}}`.`am_user_plant` (
  `user_id` VARCHAR(20) NOT NULL,
  `plant_id` INT NOT NULL,
  PRIMARY KEY (`user_id`, `plant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `{{APP_DB}}`.`am_worker_state` (
  `k` VARCHAR(50) NOT NULL,
  `v` VARCHAR(500) NULL,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
