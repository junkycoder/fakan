-- userlist: lidé, kteří přes kontakt-form řekli „napište mi".
-- Email je primary key — opakovaný submit přepíše předchozí zápis (UPSERT).
-- Repo je dobrovolný — uložený jen pokud user zaškrtl opt-in checkbox.
CREATE TABLE IF NOT EXISTS userlist (
  email       TEXT PRIMARY KEY,
  repo        TEXT,
  ts          INTEGER NOT NULL,
  ip_hash     TEXT,
  user_agent  TEXT
);

CREATE INDEX IF NOT EXISTS userlist_ts_idx ON userlist (ts DESC);
