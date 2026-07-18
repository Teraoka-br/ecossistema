-- Consolida técnicos duplicados criados durante testes.
-- Canônicos (com userId e datasysDeposito): 8=Luiz Eduardo, 9=Bruno Teodoro, 10=Cauã Felipe
-- Órfãos a migrar: 1=Luiz, 5=Luiz Eduardo → 8; 2=Bruno, 6=Bruno Teodoro → 9; 3=cauã, 7=Cauã Felipe → 10; 4=teste

UPDATE repair_cases SET directed_technician_id = 8 WHERE directed_technician_id IN (1, 5);
UPDATE repair_cases SET directed_technician_id = 9 WHERE directed_technician_id IN (2, 6);
UPDATE repair_cases SET directed_technician_id = 10 WHERE directed_technician_id IN (3, 7);

DELETE FROM staff_members WHERE id IN (1, 2, 3, 4, 5, 6, 7);
