import { AlertTriangle } from "lucide-react";

export function AdminDados() {
  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Dados</h1>
          <p className="page-subtitle">Sincronizações operacionais</p>
        </div>
      </div>

      <div className="info-banner">
        <AlertTriangle size={14} />
        Em implementação — funcionalidades de sincronização (SH Oficina, His Estoque, PEACS, BKP) serão disponibilizadas na próxima fase.
      </div>
    </div>
  );
}
