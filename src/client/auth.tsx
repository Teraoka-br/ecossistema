import React, { createContext, useContext, useState, useEffect, useCallback } from "react";

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: "ADMIN" | "OPERATOR";
  active: number;
  sessionId?: number;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  setupDone: boolean | null;
  refetch: () => void;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  setupDone: null,
  refetch: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupDone, setSetupDone] = useState<boolean | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch("/api/auth/me")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setUser(d?.user ?? null))
        .catch(() => setUser(null)),
      fetch("/api/auth/setup-status")
        .then((r) => r.json())
        .then((d) => setSetupDone(Boolean(d.setupDone)))
        .catch(() => setSetupDone(true)),
    ]).finally(() => setLoading(false));
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  return (
    <AuthContext.Provider value={{ user, loading, setupDone, refetch }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
