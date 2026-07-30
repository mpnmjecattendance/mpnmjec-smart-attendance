import { useEffect, useState } from 'react';

import { authApi } from './api';
import { LoadingState } from './components/Ui';
import { KioskPage } from './pages/KioskPage';
import { LoginPage } from './pages/LoginPage';
import {
  KIOSK_SESSION_STORAGE_KEY,
  canAccessKioskSession,
  clearStoredSession,
  loadStoredSession,
  saveStoredSession,
} from './session';

export default function KioskStandaloneApp() {
  const [session, setSession] = useState(() => loadStoredSession(KIOSK_SESSION_STORAGE_KEY));
  const [checkingSession, setCheckingSession] = useState(() => Boolean(loadStoredSession(KIOSK_SESSION_STORAGE_KEY)?.token));
  const [accessError, setAccessError] = useState('');

  useEffect(() => {
    let ignore = false;
    if (!session?.token) {
      setCheckingSession(false);
      return undefined;
    }

    async function validateSession() {
      setCheckingSession(true);
      try {
        const user = await authApi.me(session.token);
        if (!ignore) {
          const nextSession = { token: session.token, user };
          if (canAccessKioskSession(nextSession)) {
            setSession(nextSession);
            saveStoredSession(KIOSK_SESSION_STORAGE_KEY, nextSession);
            setAccessError('');
          } else {
            clearStoredSession(KIOSK_SESSION_STORAGE_KEY);
            setSession(null);
            setAccessError('Kiosk access is available only for authorized attendance operators.');
          }
        }
      } catch {
        if (!ignore) {
          clearStoredSession(KIOSK_SESSION_STORAGE_KEY);
          setSession(null);
        }
      } finally {
        if (!ignore) {
          setCheckingSession(false);
        }
      }
    }

    validateSession();
    return () => {
      ignore = true;
    };
  }, [session?.token]);

  function handleLogin(nextSession) {
    if (!canAccessKioskSession(nextSession)) {
      clearStoredSession(KIOSK_SESSION_STORAGE_KEY);
      setSession(null);
      setAccessError('Kiosk access is available only for authorized attendance operators.');
      return;
    }

    saveStoredSession(KIOSK_SESSION_STORAGE_KEY, nextSession);
    setSession(nextSession);
    setAccessError('');
  }

  function handleLogout() {
    clearStoredSession(KIOSK_SESSION_STORAGE_KEY);
    setSession(null);
  }

  if (checkingSession) {
    return (
      <div className="session-loader">
        <LoadingState label="Validating kiosk session..." />
      </div>
    );
  }

  if (!session?.token) {
    return (
      <LoginPage
        onLogin={handleLogin}
        initialTab="staff"
        allowedTabs={['staff']}
        title="Kiosk Access"
        subtitle="Sign in with an authorized attendance account to launch biometric kiosk mode."
        externalError={accessError}
      />
    );
  }

  return <KioskPage token={session.token} onUnauthorized={handleLogout} />;
}
