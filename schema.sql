-- ClickHouse schema for the UniFi Protect air quality dashboard.
--
-- The app creates `readings` automatically on first run, so this file is only
-- needed if you want to provision the database, user, and grants up front.
-- Run it as an admin user, then put the same credentials in .env.

CREATE DATABASE IF NOT EXISTS unifi_aq;

CREATE TABLE IF NOT EXISTS unifi_aq.readings
(
    ts          DateTime64(3, 'UTC'),
    console     LowCardinality(String),
    sensor_id   LowCardinality(String),
    sensor_name LowCardinality(String),
    metric      LowCardinality(String),
    value       Float64,
    status      LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (sensor_id, metric, ts)
TTL toDateTime(ts) + INTERVAL 24 MONTH;

-- Dedicated least-privilege account for the app.
-- Replace the password before running.
CREATE USER IF NOT EXISTS unifi_aq IDENTIFIED WITH sha256_password BY 'change-me';

GRANT SELECT, INSERT, ALTER, CREATE TABLE, CREATE VIEW, DROP TABLE, OPTIMIZE, TRUNCATE
    ON unifi_aq.* TO unifi_aq;
