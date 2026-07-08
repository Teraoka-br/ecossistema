-- Timestamps de início e conclusão do reparo (para indicador futuro de tempo médio)
ALTER TABLE repair_cases ADD COLUMN repair_started_at       TEXT;
ALTER TABLE repair_cases ADD COLUMN repair_started_by_user_id  INTEGER REFERENCES users(id);
ALTER TABLE repair_cases ADD COLUMN repair_completed_at     TEXT;
ALTER TABLE repair_cases ADD COLUMN repair_completed_by_user_id INTEGER REFERENCES users(id);
