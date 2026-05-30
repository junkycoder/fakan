-- Minimální účetní záznam plateb. NE pro provoz aplikace, jen pro účetnictví.
CREATE TABLE IF NOT EXISTS payments (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  email     TEXT,
  amount    INTEGER,      -- v nejmenší jednotce měny (centy/haléře)
  currency  TEXT,
  stripe_id TEXT UNIQUE,
  created   TEXT
);
