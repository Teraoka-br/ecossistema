@echo off
cd /d "C:\Users\Rocha Telecom\Documents\SISTEMAS DE PEÇAS"
node scripts\backup-db.mjs >> logs\backup.log 2>&1
