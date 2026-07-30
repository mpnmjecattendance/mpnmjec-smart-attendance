import { useEffect, useState } from 'react';
import { BrowserRouter as Router, Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { authApi } from './api';
import { AppShell } from './components/AppShell';
import { LoadingState, ToastStack } from './components/Ui';
import { AttendancePage, MyAttendancePage } from './pages/AttendancePage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { ClassAdvisorStudentExportPage } from './pages/ClassAdvisorStudentExportPage';
import { DataExportsPage } from './pages/DataExportsPage';
import { DashboardPage } from './pages/DashboardPage';
import { EditRecordsPage } from './pages/EditRecordsPage';
import { KioskPage } from './pages/KioskPage';
import { LoginPage } from './pages/LoginPage';
import { ReportsPage } from './pages/ReportsPage';
import { SettingsPage } from './pages/SettingsPage';
import { UsersPage } from './pages/UsersPage';
import {
  KIOSK_SESSION_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  canAccessKioskSession,
  canAccessStaffAttendance,
  clearStoredSession,
  loadStoredSession,
  normalizeRole,
  saveStoredSession,
} from './session';

function ProtectedPage({ allowedRoles, session, children }) {
  const role = String(session?.user?.role || '').toLowerCase();
  if (!session?.token) {
    return <Navigate to="/login" replace />;
  }
  if (allowedRoles && !allowedRoles.includes(role)) {
    return <Navigate to="/dashboard" replace />;
  }
  return children;
}

function KioskRoute({ session, kioskSession, onLogin, onMainLogout, onKioskLogout }) {
  const activeSession = canAccessKioskSession(kioskSession)
    ? kioskSession
    : canAccessKioskSession(session)
      ? session
      : null;

  if (!activeSession?.token) {
    return (
      <LoginPage
        onLogin={onLogin}
        initialTab="staff"
        allowedTabs={['staff']}
        title="Kiosk Access"
        subtitle="Sign in with an authorized staff account to launch biometric kiosk mode."
      />
    );
  }

  return (
    <KioskPage
      token={activeSession.token}
      onUnauthorized={activeSession === kioskSession ? onKioskLogout : onMainLogout}
    />
  );
}

function AppRoutes({
  session,
  kioskSession,
  toasts,
  notify,
  handleLogin,
  handleLogout,
  handleKioskLogin,
  handleKioskLogout,
}) {
  const location = useLocation();
  const hideToasts = location.pathname.startsWith('/kiosk');
  const currentRole = normalizeRole(session?.user?.role);

  return (
    <>
      {!hideToasts ? <ToastStack toasts={toasts} /> : null}
      <Routes>
        <Route path="/login" element={!session?.token ? <LoginPage onLogin={handleLogin} /> : <Navigate to="/dashboard" replace />} />
        <Route
          path="/kiosk"
          element={(
            <KioskRoute
              session={session}
              kioskSession={kioskSession}
              onLogin={handleKioskLogin}
              onMainLogout={handleLogout}
              onKioskLogout={handleKioskLogout}
            />
          )}
        />
        <Route
          path="/dashboard/*"
          element={
            session?.token ? (
              <AppShell user={session.user} onLogout={handleLogout}>
                <Routes>
                  <Route path="/" element={<DashboardPage token={session.token} user={session.user} notify={notify} />} />
                  <Route
                    path="users"
                    element={
                      <ProtectedPage allowedRoles={['admin', 'advisor']} session={session}>
                        <UsersPage token={session.token} user={session.user} notify={notify} />
                      </ProtectedPage>
                    }
                  />
                  <Route
                    path="data-exports"
                    element={
                      <ProtectedPage allowedRoles={['admin']} session={session}>
                        <DataExportsPage token={session.token} notify={notify} />
                      </ProtectedPage>
                    }
                  />
                  <Route
                    path="edit"
                    element={
                      <ProtectedPage allowedRoles={['admin', 'advisor']} session={session}>
                        <EditRecordsPage token={session.token} user={session.user} notify={notify} />
                      </ProtectedPage>
                    }
                  />
                  <Route
                    path="change-password"
                    element={
                      <ProtectedPage allowedRoles={['admin', 'hod', 'advisor', 'principal', 'staff']} session={session}>
                        <ChangePasswordPage token={session.token} user={session.user} notify={notify} />
                      </ProtectedPage>
                    }
                  />
                  <Route
                    path="attendance"
                    element={
                      currentRole === 'staff' && !canAccessStaffAttendance(session?.user)
                          ? <Navigate to="/dashboard/my-attendance" replace />
                        : <AttendancePage token={session.token} user={session.user} notify={notify} />
                    }
                  />
                  <Route
                    path="student-export"
                    element={
                      currentRole === 'staff' && canAccessStaffAttendance(session?.user)
                        ? <ClassAdvisorStudentExportPage token={session.token} user={session.user} notify={notify} />
                        : <Navigate to="/dashboard" replace />
                    }
                  />
                  <Route
                    path="my-attendance"
                    element={
                      currentRole === 'student'
                        ? <Navigate to="/dashboard/attendance" replace />
                        : currentRole === 'admin'
                          ? <Navigate to="/dashboard" replace />
                        : <MyAttendancePage token={session.token} user={session.user} />
                    }
                  />
                  <Route
                    path="reports"
                    element={
                      currentRole === 'admin'
                        ? <Navigate to="/dashboard" replace />
                        : currentRole === 'hod'
                          ? <Navigate to="/dashboard" replace />
                        : currentRole === 'advisor'
                          ? <Navigate to="/dashboard" replace />
                        : currentRole === 'principal'
                          ? <Navigate to="/dashboard/attendance" replace />
                        : currentRole === 'staff'
                          ? <Navigate to="/dashboard" replace />
                        : currentRole === 'student'
                          ? <Navigate to="/dashboard/attendance" replace />
                        : <ReportsPage token={session.token} user={session.user} />
                    }
                  />
                  <Route
                    path="settings"
                    element={
                      <ProtectedPage allowedRoles={['admin']} session={session}>
                        <SettingsPage token={session.token} notify={notify} />
                      </ProtectedPage>
                    }
                  />
                  <Route path="*" element={<Navigate to="/dashboard" replace />} />
                </Routes>
              </AppShell>
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />
        <Route path="*" element={<Navigate to={session?.token ? '/dashboard' : '/login'} replace />} />
      </Routes>
    </>
  );
}

export default function App() {
  const [session, setSession] = useState(() => loadStoredSession(SESSION_STORAGE_KEY));
  const [kioskSession, setKioskSession] = useState(() => loadStoredSession(KIOSK_SESSION_STORAGE_KEY));
  const [checkingMainSession, setCheckingMainSession] = useState(() => Boolean(loadStoredSession(SESSION_STORAGE_KEY)?.token));
  const [checkingKioskSession, setCheckingKioskSession] = useState(() => Boolean(loadStoredSession(KIOSK_SESSION_STORAGE_KEY)?.token));
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    let ignore = false;
    if (!session?.token) {
      setCheckingMainSession(false);
      return undefined;
    }

    async function validateSession() {
      setCheckingMainSession(true);
      try {
        const user = await authApi.me(session.token);
        if (!ignore) {
          const nextSession = { token: session.token, user };
          setSession(nextSession);
          saveStoredSession(SESSION_STORAGE_KEY, nextSession);
        }
      } catch {
        if (!ignore) {
          clearStoredSession(SESSION_STORAGE_KEY);
          setSession(null);
        }
      } finally {
        if (!ignore) {
          setCheckingMainSession(false);
        }
      }
    }

    validateSession();
    return () => {
      ignore = true;
    };
  }, [session?.token]);

  useEffect(() => {
    let ignore = false;
    if (!kioskSession?.token) {
      setCheckingKioskSession(false);
      return undefined;
    }

    async function validateKioskSession() {
      setCheckingKioskSession(true);
      try {
        const user = await authApi.me(kioskSession.token);
        if (!ignore) {
          const nextSession = { token: kioskSession.token, user };
          if (canAccessKioskSession(nextSession)) {
            setKioskSession(nextSession);
            saveStoredSession(KIOSK_SESSION_STORAGE_KEY, nextSession);
          } else {
            clearStoredSession(KIOSK_SESSION_STORAGE_KEY);
            setKioskSession(null);
          }
        }
      } catch {
        if (!ignore) {
          clearStoredSession(KIOSK_SESSION_STORAGE_KEY);
          setKioskSession(null);
        }
      } finally {
        if (!ignore) {
          setCheckingKioskSession(false);
        }
      }
    }

    validateKioskSession();
    return () => {
      ignore = true;
    };
  }, [kioskSession?.token]);

  useEffect(() => {
    if (!toasts.length) {
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      setToasts((current) => current.slice(1));
    }, 3500);
    return () => window.clearTimeout(timeout);
  }, [toasts]);

  function notify(tone, title, message) {
    setToasts((current) => [...current, { id: `${Date.now()}-${Math.random()}`, tone, title, message }]);
  }

  function handleLogin(nextSession) {
    saveStoredSession(SESSION_STORAGE_KEY, nextSession);
    setSession(nextSession);
    notify('success', 'Signed in', `Welcome back, ${nextSession.user.name}.`);
  }

  function handleLogout() {
    clearStoredSession(SESSION_STORAGE_KEY);
    setSession(null);
    notify('info', 'Signed out', 'Your session has been closed safely.');
  }

  function handleKioskLogin(nextSession) {
    if (!canAccessKioskSession(nextSession)) {
      clearStoredSession(KIOSK_SESSION_STORAGE_KEY);
      setKioskSession(null);
      notify('warning', 'Kiosk access denied', 'Kiosk mode is available only for staff accounts with class advisor attendance access.');
      return;
    }
    saveStoredSession(KIOSK_SESSION_STORAGE_KEY, nextSession);
    setKioskSession(nextSession);
  }

  function handleKioskLogout() {
    clearStoredSession(KIOSK_SESSION_STORAGE_KEY);
    setKioskSession(null);
  }

  if (checkingMainSession || checkingKioskSession) {
    return (
      <div className="session-loader">
        <LoadingState label="Validating your session..." />
      </div>
    );
  }

  return (
    <Router>
      <AppRoutes
        session={session}
        kioskSession={kioskSession}
        toasts={toasts}
        notify={notify}
        handleLogin={handleLogin}
        handleLogout={handleLogout}
        handleKioskLogin={handleKioskLogin}
        handleKioskLogout={handleKioskLogout}
      />
    </Router>
  );
}
