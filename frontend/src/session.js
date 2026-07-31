export const SESSION_STORAGE_KEY = 'attendance-session';
export const KIOSK_SESSION_STORAGE_KEY = 'attendance-kiosk-session';

const KIOSK_ALLOWED_ROLES = ['admin', 'hod', 'advisor', 'principal', 'staff'];

export function loadStoredSession(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    localStorage.removeItem(storageKey);
    return null;
  }
}

export function saveStoredSession(storageKey, session) {
  localStorage.setItem(storageKey, JSON.stringify(session));
}

export function clearStoredSession(storageKey) {
  localStorage.removeItem(storageKey);
}

export function normalizeRole(role) {
  return String(role || '').toLowerCase();
}

export function canAccessStaffAttendance(user) {
  return normalizeRole(user?.role) === 'staff' && Boolean(user?.is_class_advisor);
}

export function canAccessKioskSession(activeSession, kioskMode = null) {
  const role = normalizeRole(activeSession?.user?.role);
  if (!activeSession?.token || !KIOSK_ALLOWED_ROLES.includes(role)) {
    return false;
  }
  if (kioskMode === 'staff') {
    return role === 'admin' || role === 'principal';
  }
  if (role === 'staff') {
    return Boolean(activeSession?.user?.can_take_attendance);
  }
  return true;
}
