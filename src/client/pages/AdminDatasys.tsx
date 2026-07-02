import { useEffect, useRef, useState } from "react";
import { Upload, Search } from "lucide-react";

interface DatasysImport {
  id: number;
  filename: string;
  status: string;
  rowsFound: number;
  rowsImported: number;
  warningsCount: number;
  startedAt: string;
  finishedAt: string | null;
}

interface PreviewResult {
  importId: number;
  filename: string;
  rowsFound: number;
  rowsValid: number;
  alreadyImported: boolean;
  existingImportId: number | null;
  columnMapping: Record<string, string>;
  issues: { rowNumber: number | null; severity: string; code: string; message: string }[];
  filePath?: string;
}

interface DatasysRecord {
  id: number;
  imei: string | null;
  os: string | null;
  brand: string | null;
  model: string | null;
  ageDays: number | null;
  cost: number | null;
}

export function AdminDatasys() {
  const [imports, setImports] = useState<DatasysImport[]>([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Busca
  const [searchQ, setSearchQ] = useState("");
  const [searchType, setSearchType] = useState<"imei" | "os">("imei");
  const [searchResults, setSearchResults] = useState<DatasysRecord[]>([]);
  const [searching, setSearching] = useState(false);

  async function load() {
    setLoading(true);
    const r = await fetch("/api/datasys/imports");
    if (r.ok) { const d = await r.json(); setImports(d.imports); }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    setPreview(null);
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("/api/datasys/import/preview", { method: "POST", body: fd });
    const d = await r.json();
    if (r.ok) {
      setPreview(d);
      // Captura o filePath do response (o backend salva o temp file e poderia retorná-lo)
      // Nesta fase, usamos o importId para confirmar e passamos o path via body
      setUploadedPath(null); // será resolvido no confirm via importId
    } else {
      setError(d.error ?? "Erro ao fazer preview.");
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleConfirm() {
    if (!preview) return;
    if (preview.alreadyImported) { setMsg("Arquivo já importado anteriormente."); setPreview(null); return; }
    setConfirming(true);
    setError(null);
    const r = await fetch("/api/datasys/import/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ importId: preview.importId, filePath: uploadedPath }),
    });
    const d = await r.json();
    if (r.ok) {
      setMsg(`Importação confirmada: ${d.imported} registros.`);
      setPreview(null);
      load();
    } else {
      setError(d.error ?? "Erro ao confirmar.");
    }
    setConfirming(false);
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQ.trim()) return;
    setSearching(true);
    const r = await fetch(`/api/datasys/search?${searchType}=${encodeURIComponent(searchQ.trim())}`);
    if (r.ok) { const d = await r.json(); setSearchResults(d.records); }
    setSearching(false);
  }

  return (
    <div>
      <div className="page-header"><h1>Dados do Datasys</h1></div>

      {msg && <div className="alert alert-ok">{msg}</div>}
      {error && <div className="alert alert-err">{error}</div>}

      {/* Upload */}
      <div className="card">
        <h2>Nova importação</h2>
        <p className="muted text-sm">Envie o relatório consolidado (RELATORIO.xlsx ou similar).</p>
        <label className="btn btn-secondary" style={{ cursor: "pointer", display: "inline-flex" }}>
          <Upload size={14} />
          {uploading ? "Carregando…" : "Selecionar arquivo"}
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.ods,.csv" style={{ display: "none" }} onChange={handleUpload} disabled={uploading} />
        </label>

        {preview && (
          <div style={{ marginTop: "1rem" }}>
            <div className="alert alert-info" style={{ marginBottom: "0.75rem" }}>
              <strong>{preview.filename}</strong> — {preview.rowsFound} linhas encontradas, {preview.rowsValid} válidas.
              {preview.alreadyImported && <span className="badge badge-warn" style={{ marginLeft: 8 }}>Já importado</span>}
            </div>
            {Object.keys(preview.columnMapping).length > 0 && (
              <div className="text-sm muted" style={{ marginBottom: "0.5rem" }}>
                Colunas mapeadas: {Object.entries(preview.columnMapping).map(([k, v]) => `${k}→${v}`).join(", ")}
              </div>
            )}
            {preview.issues.slice(0, 5).map((iss, i) => (
              <div key={i} className={`alert alert-${iss.severity === "ERROR" ? "err" : "warn"}`} style={{ marginBottom: "0.25rem" }}>
                {iss.rowNumber ? `Linha ${iss.rowNumber}: ` : ""}{iss.message}
              </div>
            ))}
            <div className="gap-row" style={{ marginTop: "0.75rem" }}>
              <button className="btn btn-primary btn-sm" onClick={handleConfirm} disabled={confirming || preview.alreadyImported}>
                {confirming ? "Confirmando…" : "Confirmar importação"}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setPreview(null)}>Cancelar</button>
            </div>
          </div>
        )}
      </div>

      {/* Busca */}
      <div className="card">
        <h2>Buscar registro</h2>
        <form onSubmit={handleSearch}>
          <div className="gap-row">
            <select value={searchType} onChange={(e) => setSearchType(e.target.value as "imei" | "os")} style={{ width: "auto" }}>
              <option value="imei">IMEI</option>
              <option value="os">OS</option>
            </select>
            <input value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="Digite para buscar…" style={{ flex: 1 }} />
            <button type="submit" className="btn btn-secondary btn-sm" disabled={searching}>
              <Search size={13} /> {searching ? "Buscando…" : "Buscar"}
            </button>
          </div>
        </form>
        {searchResults.length > 0 && (
          <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
            <table>
              <thead><tr><th>IMEI</th><th>OS</th><th>Marca</th><th>Modelo</th><th>Idade</th><th>Custo</th></tr></thead>
              <tbody>
                {searchResults.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.imei ?? "—"}</td>
                    <td className="mono">{r.os ?? "—"}</td>
                    <td>{r.brand ?? "—"}</td>
                    <td>{r.model ?? "—"}</td>
                    <td>{r.ageDays != null ? `${r.ageDays}d` : "—"}</td>
                    <td>{r.cost != null ? `R$${r.cost.toFixed(2)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Histórico */}
      <div className="card">
        <h2>Histórico de importações</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>ID</th><th>Arquivo</th><th>Status</th><th>Linhas</th><th>Importadas</th><th>Avisos</th><th>Iniciada em</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={7} className="muted">Carregando…</td></tr>}
              {imports.map((imp) => (
                <tr key={imp.id}>
                  <td className="mono">{imp.id}</td>
                  <td className="text-sm">{imp.filename}</td>
                  <td><span className={`badge badge-${imp.status === "COMPLETED" ? "ok" : imp.status === "FAILED" ? "err" : "warn"}`}>{imp.status}</span></td>
                  <td>{imp.rowsFound}</td>
                  <td>{imp.rowsImported}</td>
                  <td>{imp.warningsCount > 0 ? <span className="badge badge-warn">{imp.warningsCount}</span> : "0"}</td>
                  <td className="text-sm">{imp.startedAt.slice(0, 16)}</td>
                </tr>
              ))}
              {!loading && imports.length === 0 && <tr><td colSpan={7} className="muted">Nenhuma importação realizada.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
