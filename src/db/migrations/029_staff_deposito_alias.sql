-- 029: Campo datasys_deposito em staff_members
-- Permite mapear o nome do depósito do Datasys (ex: "Técnico 1") ao técnico cadastrado.
ALTER TABLE staff_members ADD COLUMN datasys_deposito TEXT;
CREATE UNIQUE INDEX idx_staff_deposito ON staff_members(datasys_deposito) WHERE datasys_deposito IS NOT NULL;
