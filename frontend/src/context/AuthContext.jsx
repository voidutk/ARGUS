import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { auth } from '../api';
import { TOKEN_KEY, setUnauthorizedHandler, errorMessage } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
  }, []);

  // A 401 anywhere tears the session down once, centrally.
  useEffect(() => { setUnauthorizedHandler(() => setUser(null)); }, []);

  // Rehydrate on load. An expired token surfaces here as a 401 and is dropped.
  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) { setLoading(false); return; }
    auth.me().then(setUser).catch(() => localStorage.removeItem(TOKEN_KEY)).finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email, password) => {
    const data = await auth.login(email, password);
    localStorage.setItem(TOKEN_KEY, data.token);
    setUser(data.user);
    return data.user;
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, errorMessage }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
