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
  const [selectedMode, setSelectedMode] = useState(() => session?.mode || null);

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
          const currentMode = session.mode || selectedMode || 'student';
          const nextSession = { token: session.token, user, mode: currentMode };
          if (canAccessKioskSession(nextSession, currentMode)) {
            setSession(nextSession);
            saveStoredSession(KIOSK_SESSION_STORAGE_KEY, nextSession);
            setAccessError('');
          } else {
            clearStoredSession(KIOSK_SESSION_STORAGE_KEY);
            setSession(null);
            const err = currentMode === 'staff'
              ? 'Staff Kiosk access is restricted to Admin accounts only.'
              : 'Student Kiosk access requires an Admin, HOD, Class Advisor, or Faculty account.';
            setAccessError(err);
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
    const currentMode = selectedMode || 'student';
    if (!canAccessKioskSession(nextSession, currentMode)) {
      clearStoredSession(KIOSK_SESSION_STORAGE_KEY);
      setSession(null);
      const err = currentMode === 'staff'
        ? 'Staff Kiosk access is restricted to Admin accounts only.'
        : 'Student Kiosk access requires an Admin, HOD, Class Advisor, or Faculty account.';
      setAccessError(err);
      return;
    }

    const sessionWithMode = { ...nextSession, mode: currentMode };
    saveStoredSession(KIOSK_SESSION_STORAGE_KEY, sessionWithMode);
    setSession(sessionWithMode);
    setAccessError('');
  }

  function handleLogout() {
    clearStoredSession(KIOSK_SESSION_STORAGE_KEY);
    setSession(null);
    setSelectedMode(null);
    setAccessError('');
  }

  if (checkingSession) {
    return (
      <div className="session-loader">
        <LoadingState label="Validating kiosk session..." />
      </div>
    );
  }

  if (!session?.token) {
    if (!selectedMode) {
      return (
        <div className="login-split-layout">
          <div className="product-watermark">6ixminds Labs</div>

          <section className="login-brand-side">
            <div className="brand-content">
              <div className="brand-logo-large">
                <img src="/image-r2.png" alt="MPNMJEC Logo" style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 'inherit' }} />
              </div>
              <h1>MPNMJEC Smart Attendance Kiosk</h1>
              <p>Select the biometric kiosk mode to launch terminal scanning</p>
            </div>
          </section>

          <section className="login-form-side" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: '2rem' }}>
            <div className="login-card" style={{ maxWidth: '460px', width: '100%' }}>
              <div className="login-header" style={{ marginBottom: '1.75rem', textAlign: 'center' }}>
                <h2 style={{ fontSize: '1.6rem', fontWeight: 700 }}>Biometric Kiosk Terminal</h2>
                <p style={{ color: 'var(--text-secondary, #64748b)', marginTop: '0.35rem', fontSize: '0.92rem' }}>
                  Choose the attendance terminal mode you wish to operate:
                </p>
              </div>

              {accessError ? (
                <div className="alert-banner danger" style={{ marginBottom: '1.25rem', padding: '0.85rem 1rem', borderRadius: '8px', fontSize: '0.88rem' }}>
                  {accessError}
                </div>
              ) : null}

              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => { setSelectedMode('student'); setAccessError(''); }}
                  style={{
                    padding: '1.25rem 1.5rem',
                    borderRadius: '14px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '1.05rem',
                    fontWeight: '600',
                    cursor: 'pointer',
                    background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
                    boxShadow: '0 4px 14px rgba(37, 99, 235, 0.25)',
                    border: 'none',
                    color: '#ffffff',
                    transition: 'transform 0.15s ease, box-shadow 0.15s ease',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', textAlign: 'left' }}>
                    <span style={{ fontSize: '1.75rem' }}>🎓</span>
                    <div>
                      <div>Launch Student Kiosk</div>
                      <div style={{ fontSize: '0.78rem', fontWeight: 400, opacity: 0.85, marginTop: '2px' }}>
                        Admin, HODs, Class Advisors & Faculty
                      </div>
                    </div>
                  </div>
                  <span style={{ fontSize: '1.25rem' }}>→</span>
                </button>

                <button
                  type="button"
                  onClick={() => { setSelectedMode('staff'); setAccessError(''); }}
                  style={{
                    padding: '1.25rem 1.5rem',
                    borderRadius: '14px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '1.05rem',
                    fontWeight: '600',
                    cursor: 'pointer',
                    background: 'var(--card-bg, #ffffff)',
                    border: '1.5px solid var(--border-color, #e2e8f0)',
                    color: 'var(--text-primary, #0f172a)',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
                    transition: 'transform 0.15s ease, border-color 0.15s ease',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', textAlign: 'left' }}>
                    <span style={{ fontSize: '1.75rem' }}>👨‍🏫</span>
                    <div>
                      <div>Launch Staff Kiosk</div>
                      <div style={{ fontSize: '0.78rem', fontWeight: 400, color: 'var(--text-secondary, #64748b)', marginTop: '2px' }}>
                        Admin Accounts Only
                      </div>
                    </div>
                  </div>
                  <span style={{ fontSize: '1.25rem', color: 'var(--text-secondary, #64748b)' }}>→</span>
                </button>
              </div>
            </div>
          </section>
        </div>
      );
    }

    const isStaffKiosk = selectedMode === 'staff';
    return (
      <div style={{ position: 'relative' }}>
        <div style={{ position: 'absolute', top: '1.25rem', left: '1.5rem', zIndex: 100 }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => { setSelectedMode(null); setAccessError(''); }}
            style={{
              padding: '0.5rem 0.9rem',
              borderRadius: '8px',
              fontSize: '0.85rem',
              fontWeight: 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
            }}
          >
            ← Change Kiosk Mode
          </button>
        </div>
        <LoginPage
          onLogin={handleLogin}
          initialTab="staff"
          allowedTabs={['staff']}
          title={isStaffKiosk ? 'Staff Kiosk Access' : 'Student Kiosk Access'}
          subtitle={
            isStaffKiosk
              ? 'Sign in with an authorized Admin account to launch Staff Biometric Kiosk mode.'
              : 'Sign in with an authorized account (Admin, HOD, Class Advisor, Faculty) to launch Student Biometric Kiosk mode.'
          }
          externalError={accessError}
        />
      </div>
    );
  }

  return (
    <KioskPage
      token={session.token}
      mode={session.mode || selectedMode || 'student'}
      onUnauthorized={handleLogout}
    />
  );
}
