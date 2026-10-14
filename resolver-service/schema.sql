CREATE TABLE IF NOT EXISTS shinyatlas_resolver_jobs (
  job_id CHAR(36) NOT NULL PRIMARY KEY,
  synthetic_discord_id BIGINT UNSIGNED NOT NULL UNIQUE,
  status ENUM('pending','linked','failed') NOT NULL DEFAULT 'pending',
  player_id VARCHAR(32) NULL,
  trainer_name VARCHAR(32) NULL,
  error VARCHAR(160) NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  KEY status_created (status, created_at),
  KEY updated_at_idx (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
