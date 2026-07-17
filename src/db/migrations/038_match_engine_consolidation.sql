-- Migration 038 — Consolidação do motor de match em uma única implementação.
--
-- 1. match_rule_sets.name — nome legível da regra (exibido na tela de regras).
-- 2. repair_match_case_results — resultado canônico POR CASO de cada execução:
--    elegibilidade, motivos de VERIFICAR, margem, pontos decimais (SEM
--    arredondamento), score, posição na disputa e regra/versão utilizadas.
--    É a base de explicabilidade do card ("por que este aparelho ganhou/perdeu").
--
-- Observações:
-- - As colunas margin_points/age_points/score de repair_match_results (013)
--   passam a receber valores DECIMAIS. Em SQLite a afinidade INTEGER preserva
--   REAL quando a conversão não é exata — nenhum rebuild é necessário.
-- - As tabelas do motor legado (match_runs, match_results, match_device_results,
--   decision_rules) são mantidas como histórico imutável, porém DESCONECTADAS
--   do código a partir desta versão (nenhuma rota/serviço as lê ou escreve).

ALTER TABLE match_rule_sets ADD COLUMN name TEXT;

UPDATE match_rule_sets SET name = 'Regra v' || version WHERE name IS NULL;

CREATE TABLE repair_match_case_results (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id              INTEGER NOT NULL REFERENCES repair_match_runs(id) ON DELETE CASCADE,
  repair_case_id      INTEGER NOT NULL REFERENCES repair_cases(id) ON DELETE CASCADE,
  eligible            INTEGER NOT NULL CHECK (eligible IN (0,1)),
  result_status       TEXT    NOT NULL
                        CHECK (result_status IN ('VERIFICAR','MATCH','MATCH_PARCIAL','PEDIR_PECA','AGUARDANDO_RECEBIMENTO')),
  verify_reasons_json TEXT,
  margin              REAL,
  margin_points       REAL,
  age_points          REAL,
  score               REAL,
  priority_rank       INTEGER,
  rule_set_id         INTEGER REFERENCES match_rule_sets(id) ON DELETE SET NULL,
  rule_set_version    INTEGER,
  deposito_atual      TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (run_id, repair_case_id)
);

CREATE INDEX idx_rmcr_run    ON repair_match_case_results(run_id);
CREATE INDEX idx_rmcr_case   ON repair_match_case_results(repair_case_id);
CREATE INDEX idx_rmcr_status ON repair_match_case_results(run_id, result_status);
