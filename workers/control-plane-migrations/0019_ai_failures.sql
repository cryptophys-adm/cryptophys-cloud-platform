CREATE TABLE ai_failures (
  service_id TEXT NOT NULL,
  day TEXT NOT NULL,
  task TEXT NOT NULL,
  category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 64),
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (service_id, day, task, category)
);
