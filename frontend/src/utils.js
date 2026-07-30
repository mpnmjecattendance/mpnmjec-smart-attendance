export function formatPercent(value) {
  const numeric = Number(value ?? 0);
  return `${numeric.toFixed(1)}%`;
}

export function formatDate(value) {
  if (!value) {
    return '--';
  }

  return new Date(value).toLocaleDateString([], {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function formatTime(value) {
  if (!value) {
    return '--';
  }

  return new Date(`1970-01-01T${value}`).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function toTitleCase(value) {
  return String(value || '')
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function roleLabel(role) {
  const normalized = String(role || '').toLowerCase();
  const labels = {
    admin: 'Administrator',
    hod: 'Head of Department',
    advisor: 'Faculty',
    staff: 'Staff',
    principal: 'Principal',
    student: 'Student',
  };
  return labels[normalized] || toTitleCase(normalized);
}

export function statusTone(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'present' || normalized === 'late') {
    return 'success';
  }
  if (normalized === 'absent') {
    return 'danger';
  }
  if (normalized === 'partial' || normalized === 'attendance_not_conducted') {
    return 'warning';
  }
  return 'neutral';
}

export function statusLabel(status) {
  const normalized = String(status || '').toLowerCase();
  if (!normalized) {
    return 'Unknown';
  }
  return toTitleCase(normalized);
}

export function studentSessionLabel(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'present' || normalized === 'late') {
    return 'Present';
  }
  if (normalized === 'absent') {
    return 'Absent';
  }
  if (normalized === 'pending') {
    return 'Not Marked';
  }
  if (normalized === 'no_session') {
    return 'No Session';
  }
  if (normalized === 'attendance_not_conducted') {
    return 'Not Conducted';
  }
  return toTitleCase(normalized);
}

export function sessionLabel(sessionName, audience = 'students') {
  const normalized = String(sessionName || '').toLowerCase();
  if (normalized === 'morning') {
    return 'Morning';
  }
  if (normalized === 'afternoon') {
    return audience === 'staff' ? 'Evening' : 'Afternoon';
  }
  return toTitleCase(normalized);
}

export function sessionStatusLabel(sessionName, audience = 'students') {
  return `${sessionLabel(sessionName, audience)} Status`;
}

export function mixedSessionLabel(sessionName) {
  const normalized = String(sessionName || '').toLowerCase();
  if (normalized === 'afternoon') {
    return 'Afternoon / Evening';
  }
  return sessionLabel(normalized, 'students');
}

export function userInitials(name) {
  return String(name || 'U')
    .split(' ')
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

export function classNames(...parts) {
  return parts.filter(Boolean).join(' ');
}
