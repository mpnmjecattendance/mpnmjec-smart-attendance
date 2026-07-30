import axios from 'axios';

function trimTrailingSlash(value = '') {
  return String(value).replace(/\/+$/, '');
}

function resolveApiBaseUrl() {
  const configuredUrl = trimTrailingSlash(import.meta.env.VITE_API_URL || '');
  if (configuredUrl) {
    return configuredUrl;
  }

  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    return `${protocol}//${window.location.hostname}:8000`;
  }

  return 'http://127.0.0.1:8000';
}

const API_BASE_URL = resolveApiBaseUrl();
const FACE_ENROLLMENT_TIMEOUT_MS = 60000;
const RECOGNITION_TIMEOUT_MS = 45000;
const ATTENDANCE_MARK_TIMEOUT_MS = 15000;

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
});

export function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

function withAuth(token) {
  return { headers: authHeaders(token) };
}

function cleanParams(params = {}) {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== '' && value !== null && value !== undefined)
  );
}

export function getApiErrorMessage(error, fallbackMessage = 'Something went wrong.') {
  if (!axios.isAxiosError(error)) {
    return fallbackMessage;
  }

  if (error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '')) {
    if (String(error.config?.url || '').includes('/recognize/')) {
      return 'Face recognition is taking too long to warm up. Restart the backend once and try the kiosk again.';
    }
    return 'The server took too long to respond. Make sure the backend API is running and the database connection is healthy.';
  }

  if (error.code === 'ERR_NETWORK') {
    return `Unable to reach the backend API at ${API_BASE_URL}.`;
  }

  const detail = error.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) {
    return detail;
  }

  const message = error.response?.data?.message;
  if (typeof message === 'string' && message.trim()) {
    return message;
  }

  if (typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }

  return fallbackMessage;
}

export const authApi = {
  async login(identifier, password) {
    const formData = new URLSearchParams();
    formData.append('username', identifier.trim());
    formData.append('password', password);

    const response = await api.post('/token', formData, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return response.data;
  },
  async studentAccess(identifier, dob) {
    const response = await api.post('/students/access', {
      identifier: identifier.trim(),
      dob,
    });
    return response.data;
  },
  async me(token) {
    const response = await api.get('/me', withAuth(token));
    return response.data;
  },
  async changePassword(token, payload) {
    const response = await api.post('/me/change-password', payload, withAuth(token));
    return response.data;
  },
};

export const metaApi = {
  async options(token) {
    const response = await api.get('/meta/options', withAuth(token));
    return response.data;
  },
};

export const dashboardApi = {
  async overview(token, days = 30) {
    const response = await api.get('/dashboard/overview', {
      ...withAuth(token),
      params: cleanParams({ days }),
    });
    return response.data;
  },
  async principalDashboard(token, days = 30) {
    const response = await api.get('/principal/dashboard', {
      ...withAuth(token),
      params: cleanParams({ days }),
    });
    return response.data;
  },
  async summary(token) {
    const response = await api.get('/dashboard/summary', withAuth(token));
    return response.data;
  },
  async studentSelf(token, filtersOrDays) {
    const params = typeof filtersOrDays === 'number'
      ? { days: filtersOrDays }
      : (filtersOrDays || {});
    const response = await api.get('/students/me', {
      ...withAuth(token),
      params: cleanParams(params),
    });
    return response.data;
  },
  async exportStudentAttendance(token, filtersOrDays) {
    const params = typeof filtersOrDays === 'number'
      ? { days: filtersOrDays }
      : (filtersOrDays || {});
    const response = await api.get('/students/me/attendance/export', {
      ...withAuth(token),
      params: cleanParams(params),
      responseType: 'blob',
    });
    return response.data;
  },
  async myAttendance(token, filtersOrDays) {
    const params = typeof filtersOrDays === 'number'
      ? { days: filtersOrDays }
      : (filtersOrDays || {});
    const response = await api.get('/me/attendance', {
      ...withAuth(token),
      params: cleanParams(params),
    });
    return response.data;
  },
  async exportMyAttendance(token, filtersOrDays) {
    const params = typeof filtersOrDays === 'number'
      ? { days: filtersOrDays }
      : (filtersOrDays || {});
    const response = await api.get('/me/attendance/export', {
      ...withAuth(token),
      params: cleanParams(params),
      responseType: 'blob',
    });
    return response.data;
  },
  async facultyDashboard(token, params) {
    const response = await api.get('/faculty/dashboard', {
      ...withAuth(token),
      params: cleanParams(params),
    });
    return response.data;
  },
  async exportFacultyAttendance(token, params) {
    const response = await api.get('/faculty/attendance/export', {
      ...withAuth(token),
      params: cleanParams(params),
      responseType: 'blob',
    });
    return response.data;
  },
};

export const usersApi = {
  async list(token, params) {
    const response = await api.get('/users/', {
      ...withAuth(token),
      params: cleanParams(params),
    });
    return response.data;
  },
  async create(token, payload) {
    const response = await api.post('/users/', payload, withAuth(token));
    return response.data;
  },
  async updateStudentProfile(token, userId, payload) {
    const response = await api.put(`/users/${userId}/student-profile`, payload, withAuth(token));
    return response.data;
  },
  async bulkPromote(token, payload) {
    const response = await api.post('/users/student-bulk-promote', payload, withAuth(token));
    return response.data;
  },
  async updateStaffAccess(token, userId, payload) {
    const response = await api.put(`/users/${userId}/staff-access`, payload, withAuth(token));
    return response.data;
  },
  async resetPassword(token, userId, payload) {
    const response = await api.post(`/users/${userId}/reset-password`, payload, withAuth(token));
    return response.data;
  },
  async extractFaceEmbedding(token, imageBase64) {
    const response = await api.post('/users/face-embedding', { image_base64: imageBase64 }, {
      ...withAuth(token),
      timeout: FACE_ENROLLMENT_TIMEOUT_MS,
    });
    return response.data;
  },
  async attendanceSnapshot(token, userId, days = 30) {
    const response = await api.get(`/users/${userId}/attendance`, {
      ...withAuth(token),
      params: cleanParams({ days }),
    });
    return response.data;
  },
  async exportClassAdvisorStudents(token) {
    const response = await api.get('/class-advisor/students/export', {
      ...withAuth(token),
      responseType: 'blob',
    });
    return response.data;
  },
  async listClassAdvisorStudents(token, params) {
    const response = await api.get('/class-advisor/students', {
      ...withAuth(token),
      params: cleanParams(params),
    });
    return response.data;
  },
  async exportAdminStudentsData(token, params) {
    const response = await api.get('/admin-user-exports/students/export', {
      ...withAuth(token),
      params: cleanParams(params),
      responseType: 'blob',
    });
    return response.data;
  },
  async exportAdminStaffData(token, params) {
    const response = await api.get('/admin-user-exports/staff/export', {
      ...withAuth(token),
      params: cleanParams(params),
      responseType: 'blob',
    });
    return response.data;
  },
  async exportAdminHODsData(token, params) {
    const response = await api.get('/admin-user-exports/hods/export', {
      ...withAuth(token),
      params: cleanParams(params),
      responseType: 'blob',
    });
    return response.data;
  },
  async exportAdminPrincipalsData(token, params) {
    const response = await api.get('/admin-user-exports/principals/export', {
      ...withAuth(token),
      params: cleanParams(params),
      responseType: 'blob',
    });
    return response.data;
  },
};

export const attendanceApi = {
  async recent(token, limit = 8) {
    const response = await api.get('/attendance/recent', {
      ...withAuth(token),
      params: cleanParams({ limit }),
    });
    return response.data;
  },
  async list(token, params) {
    const response = await api.get('/attendance/records', {
      ...withAuth(token),
      params: cleanParams(params),
    });
    return response.data;
  },
  async listDepartmentStudents(token, params) {
    const response = await api.get('/department-attendance/students', {
      ...withAuth(token),
      params: cleanParams(params),
    });
    return response.data;
  },
  async exportDepartmentStudents(token, params) {
    const response = await api.get('/department-attendance/students/export', {
      ...withAuth(token),
      params: cleanParams(params),
      responseType: 'blob',
    });
    return response.data;
  },
  async listDepartmentStaff(token, params) {
    const response = await api.get('/department-attendance/staff', {
      ...withAuth(token),
      params: cleanParams(params),
    });
    return response.data;
  },
  async exportDepartmentStaff(token, params) {
    const response = await api.get('/department-attendance/staff/export', {
      ...withAuth(token),
      params: cleanParams(params),
      responseType: 'blob',
    });
    return response.data;
  },
  async listPrincipalHODs(token, params) {
    const response = await api.get('/principal-attendance/hods', {
      ...withAuth(token),
      params: cleanParams(params),
    });
    return response.data;
  },
  async listPrincipalStaff(token, params) {
    const response = await api.get('/principal-attendance/staff', {
      ...withAuth(token),
      params: cleanParams(params),
    });
    return response.data;
  },
  async listPrincipalStudents(token, params) {
    const response = await api.get('/principal-attendance/students', {
      ...withAuth(token),
      params: cleanParams(params),
    });
    return response.data;
  },
  async exportPrincipalStudents(token, params) {
    const response = await api.get('/principal-attendance/students/export', {
      ...withAuth(token),
      params: cleanParams(params),
      responseType: 'blob',
    });
    return response.data;
  },
  async listAdminStudents(token, params) {
    const response = await api.get('/admin-attendance/students', {
      ...withAuth(token),
      params: cleanParams(params),
    });
    return response.data;
  },
  async exportAdminStudents(token, params) {
    const response = await api.get('/admin-attendance/students/export', {
      ...withAuth(token),
      params: cleanParams(params),
      responseType: 'blob',
    });
    return response.data;
  },
  async listAdminStaff(token, params) {
    const response = await api.get('/admin-attendance/staff', {
      ...withAuth(token),
      params: cleanParams(params),
    });
    return response.data;
  },
  async exportAdminStaff(token, params) {
    const response = await api.get('/admin-attendance/staff/export', {
      ...withAuth(token),
      params: cleanParams(params),
      responseType: 'blob',
    });
    return response.data;
  },
  async listAdminHODs(token, params) {
    const response = await api.get('/admin-attendance/hods', {
      ...withAuth(token),
      params: cleanParams(params),
    });
    return response.data;
  },
  async exportAdminHODs(token, params) {
    const response = await api.get('/admin-attendance/hods/export', {
      ...withAuth(token),
      params: cleanParams(params),
      responseType: 'blob',
    });
    return response.data;
  },
  async listAdminPrincipals(token, params) {
    const response = await api.get('/admin-attendance/principals', {
      ...withAuth(token),
      params: cleanParams(params),
    });
    return response.data;
  },
  async exportAdminPrincipals(token, params) {
    const response = await api.get('/admin-attendance/principals/export', {
      ...withAuth(token),
      params: cleanParams(params),
      responseType: 'blob',
    });
    return response.data;
  },
  async windowStatus(token) {
    const response = await api.get('/attendance/window', withAuth(token));
    return response.data;
  },
  async recognize(token, imageBase64) {
    const response = await api.post('/recognize/', { image_base64: imageBase64 }, {
      ...withAuth(token),
      timeout: RECOGNITION_TIMEOUT_MS,
    });
    return response.data;
  },
  async mark(token, userId) {
    const response = await api.post('/attendance/', { user_id: userId }, {
      ...withAuth(token),
      timeout: ATTENDANCE_MARK_TIMEOUT_MS,
    });
    return response.data;
  },
  async manualOverride(token, payload) {
    const response = await api.post('/attendance/manual', payload, withAuth(token));
    return response.data;
  },
};

export const settingsApi = {
  async get(token) {
    const response = await api.get('/settings', withAuth(token));
    return response.data;
  },
  async update(token, payload) {
    const response = await api.put('/settings', payload, withAuth(token));
    return response.data;
  },
};
