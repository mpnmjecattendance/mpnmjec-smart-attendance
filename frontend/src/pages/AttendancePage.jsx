import { useCallback, useEffect, useRef, useState } from 'react';

import { attendanceApi, dashboardApi, getApiErrorMessage, metaApi } from '../api';
import { EmptyState, LoadingState, Notice, PageHeader, Pagination, Panel, StatusBadge, Table, TrendChart, StatCard, StatGrid } from '../components/Ui';
import {
  classNames,
  formatDate,
  formatTime,
  formatPercent,
  mixedSessionLabel,
  sessionLabel,
  sessionStatusLabel,
  statusTone,
  studentSessionLabel,
} from '../utils';

const defaultOverride = {
  identifier: '',
  date: '',
  session: 'morning',
  status: 'present',
  time: '',
};

const DAY_OPTIONS = [30, 60, 90];
const STUDENT_ATTENDANCE_REFRESH_INTERVAL_MS = 30000;

function formatInputDate(dateValue) {
  const year = dateValue.getFullYear();
  const month = String(dateValue.getMonth() + 1).padStart(2, '0');
  const day = String(dateValue.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getDefaultStudentRange() {
  const today = new Date();
  return {
    from_date: formatInputDate(new Date(today.getFullYear(), today.getMonth(), 1)),
    to_date: formatInputDate(today),
  };
}

function formatDailyTotal(value) {
  const numeric = Number(value || 0);
  if (numeric === 1) {
    return '1';
  }
  if (numeric === 0.5) {
    return '0.5';
  }
  return '0';
}

function downloadBlob(blob, filename) {
  const blobUrl = window.URL.createObjectURL(blob);
  const downloadLink = document.createElement('a');
  downloadLink.href = blobUrl;
  downloadLink.download = filename;
  document.body.appendChild(downloadLink);
  downloadLink.click();
  downloadLink.remove();
  window.URL.revokeObjectURL(blobUrl);
}

function buildFilenameSlug(value, fallback = 'export') {
  const normalizedValue = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalizedValue || fallback;
}

function isPresentishStatus(status) {
  const normalized = String(status || '').toLowerCase();
  return normalized === 'present' || normalized === 'late';
}

function resolveSessionActionTime(sessionName, sessionDefaults) {
  const fallback = sessionName === 'morning' ? '08:30:00' : '13:30:00';
  return String(sessionDefaults?.[sessionName] || fallback).slice(0, 8);
}

function StudentStatusBadge({ status }) {
  return (
    <span className={classNames('badge', `badge-${statusTone(status)}`)}>
      {studentSessionLabel(status)}
    </span>
  );
}

function getSelfAttendanceCopy(user) {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'student') {
    return {
      title: 'Attendance',
      subtitle: 'Filter your attendance records and export the selected range to Excel.',
    };
  }
  return {
    title: 'My Attendance',
    subtitle: 'Review your own attendance history, today status, and export the selected range to Excel.',
  };
}

function getAttendanceAudience(user) {
  return String(user?.role || '').toLowerCase() === 'student' ? 'students' : 'staff';
}

function SelfAttendancePortal({
  token,
  user,
  loadAttendanceRequest,
  exportAttendanceRequest,
}) {
  const copy = getSelfAttendanceCopy(user);
  const audience = getAttendanceAudience(user);
  const [dateRange, setDateRange] = useState(() => getDefaultStudentRange());
  const [attendanceState, setAttendanceState] = useState({
    loading: true,
    refreshing: false,
    data: null,
    error: '',
  });
  const [exporting, setExporting] = useState(false);
  const isMountedRef = useRef(true);
  const latestRequestRef = useRef(0);

  useEffect(() => () => {
    isMountedRef.current = false;
  }, []);

  const loadStudentAttendance = useCallback(async ({ background = false } = {}) => {
    const requestId = latestRequestRef.current + 1;
    latestRequestRef.current = requestId;

    setAttendanceState((current) => {
      if (background && current.data) {
        return { ...current, refreshing: true, error: '' };
      }
      return {
        loading: true,
        refreshing: false,
        data: background ? current.data : null,
        error: '',
      };
    });

    try {
      const response = await loadAttendanceRequest(token, dateRange);
      if (!isMountedRef.current || latestRequestRef.current !== requestId) {
        return;
      }
      setAttendanceState({
        loading: false,
        refreshing: false,
        data: response,
        error: '',
      });
    } catch (requestError) {
      if (!isMountedRef.current || latestRequestRef.current !== requestId) {
        return;
      }
      const nextError = getApiErrorMessage(requestError, 'Unable to load attendance history.');
      setAttendanceState((current) => {
        if (background && current.data) {
          return {
            ...current,
            loading: false,
            refreshing: false,
            error: nextError,
          };
        }
        return {
          loading: false,
          refreshing: false,
          data: null,
          error: nextError,
        };
      });
    }
  }, [dateRange, loadAttendanceRequest, token]);

  useEffect(() => {
    loadStudentAttendance();
  }, [loadStudentAttendance]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      loadStudentAttendance({ background: true });
    }, STUDENT_ATTENDANCE_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [loadStudentAttendance]);

  useEffect(() => {
    function refreshOnFocus() {
      loadStudentAttendance({ background: true });
    }

    function refreshOnVisibilityChange() {
      if (document.visibilityState === 'visible') {
        loadStudentAttendance({ background: true });
      }
    }

    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnVisibilityChange);

    return () => {
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshOnVisibilityChange);
    };
  }, [loadStudentAttendance]);

  function handleRangeChange(field, value) {
    setDateRange((current) => {
      const nextRange = { ...current, [field]: value };
      if (field === 'from_date' && nextRange.to_date && value > nextRange.to_date) {
        nextRange.to_date = value;
      }
      if (field === 'to_date' && nextRange.from_date && value < nextRange.from_date) {
        nextRange.from_date = value;
      }
      return nextRange;
    });
  }

  async function handleExport() {
    setExporting(true);
    setAttendanceState((current) => ({ ...current, error: '' }));

    try {
      const blob = await exportAttendanceRequest(token, dateRange);
      const blobUrl = window.URL.createObjectURL(blob);
      const downloadLink = document.createElement('a');
      downloadLink.href = blobUrl;
      downloadLink.download = `${user.identifier}_attendance_${dateRange.from_date}_to_${dateRange.to_date}.xlsx`;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      downloadLink.remove();
      window.URL.revokeObjectURL(blobUrl);
    } catch (requestError) {
      setAttendanceState((current) => ({
        ...current,
        error: getApiErrorMessage(requestError, 'Unable to export attendance data.'),
      }));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title={copy.title}
        subtitle={copy.subtitle}
      />

      {attendanceState.error ? <Notice tone="danger" title="Attendance Error">{attendanceState.error}</Notice> : null}

      <Panel title="Attendance History" subtitle="Session-wise attendance with daily totals">
        <div className="form-grid">
          <label className="field">
            <span>From Date</span>
            <input
              className="input"
              type="date"
              value={dateRange.from_date}
              max={dateRange.to_date}
              onChange={(event) => handleRangeChange('from_date', event.target.value)}
            />
          </label>
          <label className="field">
            <span>To Date</span>
            <input
              className="input"
              type="date"
              value={dateRange.to_date}
              min={dateRange.from_date}
              max={formatInputDate(new Date())}
              onChange={(event) => handleRangeChange('to_date', event.target.value)}
            />
          </label>
          <div className="field">
            <span>Export</span>
            <button type="button" className="btn-primary btn-block" onClick={handleExport} disabled={exporting}>
              {exporting ? 'Exporting...' : 'Export Excel'}
            </button>
          </div>
          <div className="field">
            <span>Refresh</span>
            <button
              type="button"
              className="btn-secondary btn-block"
              onClick={() => loadStudentAttendance()}
              disabled={attendanceState.loading || attendanceState.refreshing || exporting}
            >
              {attendanceState.loading || attendanceState.refreshing ? 'Refreshing...' : 'Refresh Data'}
            </button>
          </div>
        </div>
        <p className="panel-subtitle">Updates automatically every 30 seconds and whenever you return to this tab.</p>

        {attendanceState.loading ? (
          <LoadingState label="Loading attendance history..." />
        ) : attendanceState.data ? (
          <Table
            columns={[
              { key: 'date', label: 'Date', render: (row) => formatDate(row.date) },
              { key: 'morning_status', label: sessionStatusLabel('morning', audience), render: (row) => <StudentStatusBadge status={row.morning_status} /> },
              { key: 'afternoon_status', label: sessionStatusLabel('afternoon', audience), render: (row) => <StudentStatusBadge status={row.afternoon_status} /> },
              { key: 'daily_total', label: 'Daily Total', render: (row) => formatDailyTotal(row.daily_total) },
            ]}
            rows={attendanceState.data.attendance_rows || []}
            emptyTitle="No attendance records"
            emptyMessage="No attendance data is available for the selected date range."
            rowKey={(row) => row.date}
          />
        ) : (
          <EmptyState title="Attendance unavailable" message="Unable to load attendance records right now." />
        )}
      </Panel>
    </div>
  );
}

function StudentAttendancePortal({ token, user }) {
  return (
    <SelfAttendancePortal
      token={token}
      user={user}
      loadAttendanceRequest={dashboardApi.studentSelf}
      exportAttendanceRequest={dashboardApi.exportStudentAttendance}
    />
  );
}

function InstitutionSelfAttendancePortal({ token, user }) {
  return (
    <SelfAttendancePortal
      token={token}
      user={user}
      loadAttendanceRequest={dashboardApi.myAttendance}
      exportAttendanceRequest={dashboardApi.exportMyAttendance}
    />
  );
}

function ClassAdvisorAttendancePortal({ token, user, notify }) {
  const defaultRange = getDefaultStudentRange();
  const [historyFilters, setHistoryFilters] = useState({
    page: 1,
    page_size: 10,
    from_date: defaultRange.from_date,
    to_date: defaultRange.to_date,
  });
  const [selectedDate, setSelectedDate] = useState(defaultRange.to_date);
  const [recordsState, setRecordsState] = useState({ loading: true, data: null, error: '' });
  const [dailyState, setDailyState] = useState({ loading: true, data: null, error: '' });
  const [exporting, setExporting] = useState(false);
  const [savingSessionKey, setSavingSessionKey] = useState('');
  const [refreshNonce, setRefreshNonce] = useState(0);

  const loadHistoryRecords = useCallback(async () => {
    setRecordsState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const response = await attendanceApi.list(token, historyFilters);
      setRecordsState({ loading: false, data: response, error: '' });
    } catch (requestError) {
      setRecordsState({
        loading: false,
        data: null,
        error: getApiErrorMessage(requestError, 'Unable to load attendance records.'),
      });
    }
  }, [historyFilters, token]);

  const loadDailyAttendance = useCallback(async () => {
    setDailyState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const response = await dashboardApi.facultyDashboard(token, { selected_date: selectedDate });
      setDailyState({ loading: false, data: response, error: '' });
      if (response.selected_date && response.selected_date !== selectedDate) {
        setSelectedDate(response.selected_date);
      }
    } catch (requestError) {
      setDailyState({
        loading: false,
        data: null,
        error: getApiErrorMessage(requestError, 'Unable to load class attendance for the selected date.'),
      });
    }
  }, [selectedDate, token]);

  useEffect(() => {
    loadHistoryRecords();
  }, [loadHistoryRecords, refreshNonce]);

  useEffect(() => {
    loadDailyAttendance();
  }, [loadDailyAttendance, refreshNonce]);

  function handleRangeChange(field, value) {
    setHistoryFilters((current) => {
      const nextFilters = { ...current, page: 1, [field]: value };
      if (field === 'from_date' && nextFilters.to_date && value > nextFilters.to_date) {
        nextFilters.to_date = value;
      }
      if (field === 'to_date' && nextFilters.from_date && value < nextFilters.from_date) {
        nextFilters.from_date = value;
      }
      return nextFilters;
    });
  }

  async function handleExport() {
    setExporting(true);
    try {
      const blob = await dashboardApi.exportFacultyAttendance(token, {
        from_date: historyFilters.from_date,
        to_date: historyFilters.to_date,
      });
      downloadBlob(
        blob,
        `${buildFilenameSlug(user.scope_label, 'assigned_scope')}_attendance_${historyFilters.from_date}_to_${historyFilters.to_date}.xlsx`,
      );
      notify('success', 'Export ready', 'Attendance export downloaded successfully.');
    } catch (requestError) {
      notify('danger', 'Export failed', getApiErrorMessage(requestError, 'Unable to export attendance data.'));
    } finally {
      setExporting(false);
    }
  }

  async function handleAttendanceUpdate(row, sessionName, nextStatus) {
    const overview = dailyState.data;
    if (!overview?.selected_date_is_working_day) {
      notify('warning', 'Attendance closed', 'Attendance can only be corrected on student working days.');
      return;
    }

    const currentStatus = String(row?.[`${sessionName}_status`] || '').toLowerCase();
    if ((nextStatus === 'present' && isPresentishStatus(currentStatus)) || currentStatus === nextStatus) {
      return;
    }

    const sessionKey = `${row.user_id}:${sessionName}`;
    setSavingSessionKey(sessionKey);

    try {
      await attendanceApi.manualOverride(token, {
        user_id: row.user_id,
        date: overview.selected_date,
        session: sessionName,
        status: nextStatus,
        time: nextStatus === 'present'
          ? resolveSessionActionTime(sessionName, overview.session_defaults)
          : null,
      });
      notify(
        'success',
        'Attendance updated',
        `${row.name} was marked ${nextStatus} for the ${sessionLabel(sessionName, 'students').toLowerCase()} session.`,
      );
      setRefreshNonce((current) => current + 1);
    } catch (requestError) {
      notify('danger', 'Update failed', getApiErrorMessage(requestError, 'Unable to update attendance.'));
    } finally {
      setSavingSessionKey('');
    }
  }

  const dailyRows = dailyState.data?.daily_attendance || [];

  return (
    <div className="page-stack">
      <PageHeader
        title="Attendance Management"
        subtitle="Review attendance for your assigned class, filter by date range, export to Excel, and trigger Present or Absent status updates."
      />

      <Notice tone="info" title="Assigned Scope">
        Attendance management is limited to {user.scope_label || 'your assigned class'}.
      </Notice>

      <Panel title="Attendance History" subtitle="Filter class attendance by date range and export the selected window to Excel.">
        <div className="form-grid">
          <label className="field">
            <span>From Date</span>
            <input
              className="input"
              type="date"
              value={historyFilters.from_date}
              max={historyFilters.to_date}
              onChange={(event) => handleRangeChange('from_date', event.target.value)}
            />
          </label>
          <label className="field">
            <span>To Date</span>
            <input
              className="input"
              type="date"
              value={historyFilters.to_date}
              min={historyFilters.from_date}
              max={formatInputDate(new Date())}
              onChange={(event) => handleRangeChange('to_date', event.target.value)}
            />
          </label>
          <div className="field">
            <span>Export</span>
            <button type="button" className="btn-primary btn-block" onClick={handleExport} disabled={exporting}>
              {exporting ? 'Exporting...' : 'Export Excel'}
            </button>
          </div>
          <div className="field">
            <span>Refresh</span>
            <button
              type="button"
              className="btn-secondary btn-block"
              onClick={() => setRefreshNonce((current) => current + 1)}
              disabled={recordsState.loading || dailyState.loading || exporting || Boolean(savingSessionKey)}
            >
              {recordsState.loading || dailyState.loading ? 'Refreshing...' : 'Refresh Data'}
            </button>
          </div>
        </div>

        {recordsState.error ? <Notice tone="danger" title="Attendance Error">{recordsState.error}</Notice> : null}

        {recordsState.loading && !recordsState.data ? (
          <LoadingState label="Loading attendance history..." />
        ) : recordsState.data ? (
          <>
            <div className={recordsState.loading ? 'loading-fade' : ''}>
              <Table
                columns={[
                  { key: 'user_name', label: 'Student' },
                  { key: 'identifier', label: 'Register Number' },
                  { key: 'date', label: 'Date', render: (row) => formatDate(row.date) },
                  { key: 'time', label: 'Time', render: (row) => formatTime(row.time) },
                  { key: 'session', label: 'Session', render: (row) => sessionLabel(row.session, 'students') },
                  { key: 'status', label: 'Status', render: (row) => <StatusBadge status={row.status} /> },
                ]}
                rows={recordsState.data.items}
                emptyTitle="No attendance records"
                emptyMessage="No attendance records match the selected date range."
                rowKey={(row) => row.id}
              />
            </div>
            <Pagination
              page={recordsState.data.page}
              pageSize={recordsState.data.page_size}
              total={recordsState.data.total}
              onPageChange={(page) => setHistoryFilters((current) => ({ ...current, page }))}
              isLoading={recordsState.loading}
            />
          </>
        ) : (
          <EmptyState title="Attendance unavailable" message="Attendance data is not available right now." />
        )}
      </Panel>

      <Panel title="Daily Trigger" subtitle="Pick a date and use quick Present or Absent actions for morning and afternoon sessions.">
        <div className="form-grid">
          <label className="field">
            <span>Attendance Date</span>
            <input
              className="input"
              type="date"
              value={selectedDate}
              max={formatInputDate(new Date())}
              onChange={(event) => setSelectedDate(event.target.value)}
            />
          </label>
          <div className="field">
            <span>Scope</span>
            <button type="button" className="btn-secondary btn-block" disabled>
              {user.scope_label || 'Assigned Scope'}
            </button>
          </div>
        </div>

        {dailyState.error ? <Notice tone="danger" title="Daily Attendance Error">{dailyState.error}</Notice> : null}
        {!dailyState.loading && dailyState.data && !dailyState.data.selected_date_is_working_day ? (
          <Notice tone="warning" title="Selected date has no scheduled attendance">
            The selected date is outside the student working-day schedule, marked as a holiday, or flagged as not conducted, so quick attendance actions are disabled.
          </Notice>
        ) : null}

        {dailyState.loading ? (
          <LoadingState label="Loading daily attendance..." />
        ) : dailyState.data ? (
          <Table
            tableClassName="faculty-daily-table"
            columns={[
              {
                key: 'name',
                label: 'Student Name',
                cellClassName: 'faculty-name-cell',
                render: (row) => (
                  <div className="faculty-student-cell">
                    <strong>{row.name}</strong>
                  </div>
                ),
              },
              {
                key: 'identifier',
                label: 'Register Number',
                cellClassName: 'faculty-register-cell',
                render: (row) => <span className="faculty-register-value">{row.identifier}</span>,
              },
              { key: 'morning_status', label: 'Morning Status', render: (row) => <StudentStatusBadge status={row.morning_status} /> },
              { key: 'afternoon_status', label: 'Afternoon Status', render: (row) => <StudentStatusBadge status={row.afternoon_status} /> },
              {
                key: 'daily_total',
                label: 'Total',
                className: 'faculty-total-cell',
                render: (row) => formatDailyTotal(row.daily_total),
              },
              {
                key: 'actions',
                label: 'Fix Attendance',
                cellClassName: 'faculty-actions-cell',
                render: (row) => (
                  <div className="faculty-action-stack">
                    <div className="faculty-action-row">
                      <span className="faculty-action-label">Morning</span>
                      <div className="faculty-quick-actions">
                        <button
                          type="button"
                          className={`quick-action-btn ${isPresentishStatus(row.morning_status) ? 'active success' : ''}`}
                          onClick={() => handleAttendanceUpdate(row, 'morning', 'present')}
                          disabled={!dailyState.data.selected_date_is_working_day || savingSessionKey === `${row.user_id}:morning`}
                        >
                          Present
                        </button>
                        <button
                          type="button"
                          className={`quick-action-btn ${String(row.morning_status).toLowerCase() === 'absent' ? 'active danger' : ''}`}
                          onClick={() => handleAttendanceUpdate(row, 'morning', 'absent')}
                          disabled={!dailyState.data.selected_date_is_working_day || savingSessionKey === `${row.user_id}:morning`}
                        >
                          Absent
                        </button>
                      </div>
                    </div>
                    <div className="faculty-action-row">
                          <span className="faculty-action-label">{sessionLabel('afternoon', 'students')}</span>
                      <div className="faculty-quick-actions">
                        <button
                          type="button"
                          className={`quick-action-btn ${isPresentishStatus(row.afternoon_status) ? 'active success' : ''}`}
                          onClick={() => handleAttendanceUpdate(row, 'afternoon', 'present')}
                          disabled={!dailyState.data.selected_date_is_working_day || savingSessionKey === `${row.user_id}:afternoon`}
                        >
                          Present
                        </button>
                        <button
                          type="button"
                          className={`quick-action-btn ${String(row.afternoon_status).toLowerCase() === 'absent' ? 'active danger' : ''}`}
                          onClick={() => handleAttendanceUpdate(row, 'afternoon', 'absent')}
                          disabled={!dailyState.data.selected_date_is_working_day || savingSessionKey === `${row.user_id}:afternoon`}
                        >
                          Absent
                        </button>
                      </div>
                    </div>
                  </div>
                ),
              },
            ]}
            rows={dailyRows}
            emptyTitle="No attendance rows"
            emptyMessage="No attendance rows are available for the selected date."
            rowKey={(row) => row.user_id}
          />
        ) : (
          <EmptyState title="Daily attendance unavailable" message="Daily attendance could not be loaded right now." />
        )}
      </Panel>
    </div>
  );
}

function HODAttendancePortal({ token, user, notify }) {
  const defaultRange = getDefaultStudentRange();
  const [activeTab, setActiveTab] = useState('students');
  const [studentFilters, setStudentFilters] = useState({
    page: 1,
    page_size: 10,
    year: '',
    semester: '',
    from_date: defaultRange.from_date,
    to_date: defaultRange.to_date,
  });
  const [staffFilters, setStaffFilters] = useState({
    page: 1,
    page_size: 10,
    from_date: defaultRange.from_date,
    to_date: defaultRange.to_date,
  });
  const [studentState, setStudentState] = useState({ loading: true, data: null, error: '' });
  const [staffState, setStaffState] = useState({ loading: false, data: null, error: '' });
  const [savingSessionKey, setSavingSessionKey] = useState('');
  const [studentExporting, setStudentExporting] = useState(false);
  const [staffExporting, setStaffExporting] = useState(false);

  const loadStudentAttendance = useCallback(async () => {
    setStudentState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const response = await attendanceApi.listDepartmentStudents(token, {
        ...studentFilters,
        year: studentFilters.year ? Number(studentFilters.year) : undefined,
        semester: studentFilters.semester ? Number(studentFilters.semester) : undefined,
      });
      setStudentState({ loading: false, data: response, error: '' });
    } catch (requestError) {
      setStudentState({
        loading: false,
        data: null,
        error: getApiErrorMessage(requestError, 'Unable to load student attendance records.'),
      });
    }
  }, [studentFilters, token]);

  const loadStaffAttendance = useCallback(async () => {
    setStaffState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const response = await attendanceApi.listDepartmentStaff(token, staffFilters);
      setStaffState({ loading: false, data: response, error: '' });
    } catch (requestError) {
      setStaffState({
        loading: false,
        data: null,
        error: getApiErrorMessage(requestError, 'Unable to load staff attendance records.'),
      });
    }
  }, [staffFilters, token]);

  useEffect(() => {
    if (activeTab === 'students') {
      loadStudentAttendance();
    }
  }, [activeTab, loadStudentAttendance]);

  useEffect(() => {
    if (activeTab === 'staff') {
      loadStaffAttendance();
    }
  }, [activeTab, loadStaffAttendance]);

  function updateRangeFilters(setter, field, value) {
    setter((current) => {
      const nextFilters = { ...current, page: 1, [field]: value };
      if (field === 'from_date' && nextFilters.to_date && value > nextFilters.to_date) {
        nextFilters.to_date = value;
      }
      if (field === 'to_date' && nextFilters.from_date && value < nextFilters.from_date) {
        nextFilters.from_date = value;
      }
      return nextFilters;
    });
  }

  async function handleStudentAttendanceUpdate(row, sessionName, nextStatus) {
    if (!row.is_working_day) {
      notify('warning', 'Attendance closed', 'Attendance can only be corrected on student working days.');
      return;
    }

    const currentStatus = String(row?.[`${sessionName}_status`] || '').toLowerCase();
    if ((nextStatus === 'present' && isPresentishStatus(currentStatus)) || currentStatus === nextStatus) {
      return;
    }

    const sessionKey = `${row.user_id}:${row.date}:${sessionName}`;
    setSavingSessionKey(sessionKey);

    try {
      await attendanceApi.manualOverride(token, {
        user_id: row.user_id,
        date: row.date,
        session: sessionName,
        status: nextStatus,
        time: nextStatus === 'present'
          ? resolveSessionActionTime(sessionName, studentState.data?.session_defaults)
          : null,
      });
      notify(
        'success',
        'Attendance updated',
        `${row.name} was marked ${nextStatus} for the ${sessionLabel(sessionName, 'students').toLowerCase()} session.`,
      );
      loadStudentAttendance();
    } catch (requestError) {
      notify('danger', 'Update failed', getApiErrorMessage(requestError, 'Unable to update student attendance.'));
    } finally {
      setSavingSessionKey('');
    }
  }

  async function handleStaffAttendanceUpdate(row, sessionName, nextStatus) {
    if (!row.is_working_day) {
      notify('warning', 'Attendance closed', 'Attendance can only be corrected on staff working days.');
      return;
    }

    const currentStatus = String(row?.[`${sessionName}_status`] || '').toLowerCase();
    if ((nextStatus === 'present' && isPresentishStatus(currentStatus)) || currentStatus === nextStatus) {
      return;
    }

    const sessionKey = `${row.user_id}:${row.date}:${sessionName}`;
    setSavingSessionKey(sessionKey);

    try {
      await attendanceApi.manualOverride(token, {
        user_id: row.user_id,
        date: row.date,
        session: sessionName,
        status: nextStatus,
        time: nextStatus === 'present'
          ? resolveSessionActionTime(sessionName, staffState.data?.session_defaults)
          : null,
      });
      notify(
        'success',
        'Attendance updated',
        `${row.name} was marked ${nextStatus} for the ${sessionLabel(sessionName, 'staff').toLowerCase()} session.`,
      );
      loadStaffAttendance();
    } catch (requestError) {
      notify('danger', 'Update failed', getApiErrorMessage(requestError, 'Unable to update staff attendance.'));
    } finally {
      setSavingSessionKey('');
    }
  }

  async function handleStudentExport() {
    setStudentExporting(true);
    try {
      const blob = await attendanceApi.exportDepartmentStudents(token, {
        year: studentFilters.year ? Number(studentFilters.year) : undefined,
        semester: studentFilters.semester ? Number(studentFilters.semester) : undefined,
        from_date: studentFilters.from_date,
        to_date: studentFilters.to_date,
      });
      downloadBlob(
        blob,
        `${buildFilenameSlug(user.department || user.scope_label, 'department')}_students_${studentFilters.from_date}_to_${studentFilters.to_date}.xlsx`,
      );
      notify('success', 'Export ready', 'Student attendance export downloaded successfully.');
    } catch (requestError) {
      notify('danger', 'Export failed', getApiErrorMessage(requestError, 'Unable to export student attendance.'));
    } finally {
      setStudentExporting(false);
    }
  }

  async function handleStaffExport() {
    setStaffExporting(true);
    try {
      const blob = await attendanceApi.exportDepartmentStaff(token, {
        from_date: staffFilters.from_date,
        to_date: staffFilters.to_date,
      });
      downloadBlob(
        blob,
        `${buildFilenameSlug(user.department || user.scope_label, 'department')}_staff_${staffFilters.from_date}_to_${staffFilters.to_date}.xlsx`,
      );
      notify('success', 'Export ready', 'Staff attendance export downloaded successfully.');
    } catch (requestError) {
      notify('danger', 'Export failed', getApiErrorMessage(requestError, 'Unable to export staff attendance.'));
    } finally {
      setStaffExporting(false);
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="Department Attendance"
        subtitle="Review student attendance in read-only mode and manage staff attendance separately for your department."
      />

      <Notice tone="info" title="Assigned Department">
        Department attendance is fixed to {user.department || user.scope_label || 'your assigned department'}.
      </Notice>

      <div className="chip-group">
        <button
          type="button"
          className={`chip ${activeTab === 'students' ? 'active' : ''}`}
          onClick={() => setActiveTab('students')}
        >
          Student Attendance
        </button>
        <button
          type="button"
          className={`chip ${activeTab === 'staff' ? 'active' : ''}`}
          onClick={() => setActiveTab('staff')}
        >
          Staff Attendance
        </button>
      </div>

      {activeTab === 'students' ? (
        <Panel
          title="Student Attendance"
          subtitle="Review student attendance for your department, apply Present or Absent triggers, and export the filtered attendance data."
        >
          <div className="form-grid">
            <label className="field">
              <span>Department</span>
              <input className="input" value={user.department || ''} readOnly />
            </label>
            <label className="field">
              <span>Year</span>
              <select
                className="input"
                value={studentFilters.year}
                onChange={(event) => setStudentFilters((current) => ({ ...current, page: 1, year: event.target.value }))}
              >
                <option value="">All Years</option>
                {[1, 2, 3, 4].map((year) => (
                  <option key={year} value={year}>{`Year ${year}`}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Semester</span>
              <select
                className="input"
                value={studentFilters.semester}
                onChange={(event) => setStudentFilters((current) => ({ ...current, page: 1, semester: event.target.value }))}
              >
                <option value="">All Semesters</option>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((semester) => (
                  <option key={semester} value={semester}>{`Sem ${semester}`}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>From Date</span>
              <input
                className="input"
                type="date"
                value={studentFilters.from_date}
                max={studentFilters.to_date}
                onChange={(event) => updateRangeFilters(setStudentFilters, 'from_date', event.target.value)}
              />
            </label>
            <label className="field">
              <span>To Date</span>
              <input
                className="input"
                type="date"
                value={studentFilters.to_date}
                min={studentFilters.from_date}
                max={formatInputDate(new Date())}
                onChange={(event) => updateRangeFilters(setStudentFilters, 'to_date', event.target.value)}
              />
            </label>
            <div className="field">
              <span>Refresh</span>
              <button
                type="button"
                className="btn-secondary btn-block"
                onClick={() => loadStudentAttendance()}
                disabled={studentState.loading}
              >
                {studentState.loading ? 'Refreshing...' : 'Refresh Data'}
              </button>
            </div>
            <div className="field">
              <span>Export</span>
              <button
                type="button"
                className="btn-primary btn-block"
                onClick={handleStudentExport}
                disabled={studentExporting}
              >
                {studentExporting ? 'Exporting...' : 'Export Student Attendance'}
              </button>
            </div>
          </div>

          {studentState.error ? <Notice tone="danger" title="Student Attendance Error">{studentState.error}</Notice> : null}

          {studentState.loading && !studentState.data ? (
            <LoadingState label="Loading student attendance..." />
          ) : studentState.data ? (
            <>
              <div className={studentState.loading ? 'loading-fade' : ''}>
                <Table
                  tableClassName="faculty-daily-table"
                  columns={[
                    { key: 'name', label: 'Student Name' },
                    { key: 'identifier', label: 'Register Number' },
                    { key: 'year', label: 'Year', render: (row) => row.year || '--' },
                    { key: 'semester', label: 'Semester', render: (row) => row.semester || '--' },
                    { key: 'date', label: 'Date', render: (row) => formatDate(row.date) },
                    { key: 'morning_status', label: sessionLabel('morning', 'students'), render: (row) => <StudentStatusBadge status={row.morning_status} /> },
                    { key: 'afternoon_status', label: sessionLabel('afternoon', 'students'), render: (row) => <StudentStatusBadge status={row.afternoon_status} /> },
                    { key: 'daily_total', label: 'Total', render: (row) => formatDailyTotal(row.daily_total) },
                    { key: 'attendance_rate', label: 'Attendance %', render: (row) => formatPercent(row.attendance_rate) },
                    {
                      key: 'actions',
                      label: 'Fix Attendance',
                      cellClassName: 'faculty-actions-cell',
                      render: (row) => (
                        <div className="faculty-action-stack">
                          <div className="faculty-action-row">
                            <span className="faculty-action-label">{sessionLabel('morning', 'students')}</span>
                            <div className="faculty-quick-actions">
                              <button
                                type="button"
                                className={`quick-action-btn ${isPresentishStatus(row.morning_status) ? 'active success' : ''}`}
                                onClick={() => handleStudentAttendanceUpdate(row, 'morning', 'present')}
                                disabled={!row.is_working_day || savingSessionKey === `${row.user_id}:${row.date}:morning`}
                              >
                                Present
                              </button>
                              <button
                                type="button"
                                className={`quick-action-btn ${String(row.morning_status).toLowerCase() === 'absent' ? 'active danger' : ''}`}
                                onClick={() => handleStudentAttendanceUpdate(row, 'morning', 'absent')}
                                disabled={!row.is_working_day || savingSessionKey === `${row.user_id}:${row.date}:morning`}
                              >
                                Absent
                              </button>
                            </div>
                          </div>
                          <div className="faculty-action-row">
                            <span className="faculty-action-label">{sessionLabel('afternoon', 'students')}</span>
                            <div className="faculty-quick-actions">
                              <button
                                type="button"
                                className={`quick-action-btn ${isPresentishStatus(row.afternoon_status) ? 'active success' : ''}`}
                                onClick={() => handleStudentAttendanceUpdate(row, 'afternoon', 'present')}
                                disabled={!row.is_working_day || savingSessionKey === `${row.user_id}:${row.date}:afternoon`}
                              >
                                Present
                              </button>
                              <button
                                type="button"
                                className={`quick-action-btn ${String(row.afternoon_status).toLowerCase() === 'absent' ? 'active danger' : ''}`}
                                onClick={() => handleStudentAttendanceUpdate(row, 'afternoon', 'absent')}
                                disabled={!row.is_working_day || savingSessionKey === `${row.user_id}:${row.date}:afternoon`}
                              >
                                Absent
                              </button>
                            </div>
                          </div>
                        </div>
                      ),
                    },
                  ]}
                  rows={studentState.data.items || []}
                  emptyTitle="No student attendance rows"
                  emptyMessage="No student attendance rows match the selected filters."
                  rowKey={(row) => `${row.user_id}:${row.date}`}
                />
              </div>
              <Pagination
                page={studentState.data.page}
                pageSize={studentState.data.page_size}
                total={studentState.data.total}
                onPageChange={(page) => setStudentFilters((current) => ({ ...current, page }))}
                isLoading={studentState.loading}
              />
            </>
          ) : (
            <EmptyState title="Student attendance unavailable" message="Student attendance data could not be loaded right now." />
          )}
        </Panel>
      ) : (
        <Panel
          title="Staff Attendance"
          subtitle="Review staff attendance separately, use Present or Absent triggers when needed, and export the filtered attendance data."
        >
          <div className="form-grid">
            <label className="field">
              <span>Department</span>
              <input className="input" value={user.department || ''} readOnly />
            </label>
            <label className="field">
              <span>From Date</span>
              <input
                className="input"
                type="date"
                value={staffFilters.from_date}
                max={staffFilters.to_date}
                onChange={(event) => updateRangeFilters(setStaffFilters, 'from_date', event.target.value)}
              />
            </label>
            <label className="field">
              <span>To Date</span>
              <input
                className="input"
                type="date"
                value={staffFilters.to_date}
                min={staffFilters.from_date}
                max={formatInputDate(new Date())}
                onChange={(event) => updateRangeFilters(setStaffFilters, 'to_date', event.target.value)}
              />
            </label>
            <div className="field">
              <span>Refresh</span>
              <button
                type="button"
                className="btn-secondary btn-block"
                onClick={() => loadStaffAttendance()}
                disabled={staffState.loading || Boolean(savingSessionKey)}
              >
                {staffState.loading ? 'Refreshing...' : 'Refresh Data'}
              </button>
            </div>
            <div className="field">
              <span>Export</span>
              <button
                type="button"
                className="btn-primary btn-block"
                onClick={handleStaffExport}
                disabled={staffExporting}
              >
                {staffExporting ? 'Exporting...' : 'Export Staff Attendance'}
              </button>
            </div>
          </div>

          {staffState.error ? <Notice tone="danger" title="Staff Attendance Error">{staffState.error}</Notice> : null}

          {staffState.loading && !staffState.data ? (
            <LoadingState label="Loading staff attendance..." />
          ) : staffState.data ? (
            <>
              <div className={staffState.loading ? 'loading-fade' : ''}>
                <Table
                  tableClassName="faculty-daily-table"
                  columns={[
                    { key: 'name', label: 'Staff Name', className: 'faculty-name-cell' },
                    { key: 'identifier', label: 'Staff ID', className: 'faculty-register-cell' },
                    { key: 'date', label: 'Date', render: (row) => formatDate(row.date) },
                    { key: 'morning_status', label: sessionLabel('morning', 'staff'), render: (row) => <StudentStatusBadge status={row.morning_status} /> },
                    { key: 'afternoon_status', label: sessionLabel('afternoon', 'staff'), render: (row) => <StudentStatusBadge status={row.afternoon_status} /> },
                    {
                      key: 'daily_total',
                      label: 'Total',
                      className: 'faculty-total-cell',
                      render: (row) => formatDailyTotal(row.daily_total),
                    },
                    {
                      key: 'actions',
                      label: 'Fix Attendance',
                      cellClassName: 'faculty-actions-cell',
                      render: (row) => (
                        <div className="faculty-action-stack">
                          <div className="faculty-action-row">
                            <span className="faculty-action-label">{sessionLabel('morning', 'staff')}</span>
                            <div className="faculty-quick-actions">
                              <button
                                type="button"
                                className={`quick-action-btn ${isPresentishStatus(row.morning_status) ? 'active success' : ''}`}
                                onClick={() => handleStaffAttendanceUpdate(row, 'morning', 'present')}
                                disabled={!row.is_working_day || savingSessionKey === `${row.user_id}:${row.date}:morning`}
                              >
                                Present
                              </button>
                              <button
                                type="button"
                                className={`quick-action-btn ${String(row.morning_status).toLowerCase() === 'absent' ? 'active danger' : ''}`}
                                onClick={() => handleStaffAttendanceUpdate(row, 'morning', 'absent')}
                                disabled={!row.is_working_day || savingSessionKey === `${row.user_id}:${row.date}:morning`}
                              >
                                Absent
                              </button>
                            </div>
                          </div>
                          <div className="faculty-action-row">
                            <span className="faculty-action-label">{sessionLabel('afternoon', 'staff')}</span>
                            <div className="faculty-quick-actions">
                              <button
                                type="button"
                                className={`quick-action-btn ${isPresentishStatus(row.afternoon_status) ? 'active success' : ''}`}
                                onClick={() => handleStaffAttendanceUpdate(row, 'afternoon', 'present')}
                                disabled={!row.is_working_day || savingSessionKey === `${row.user_id}:${row.date}:afternoon`}
                              >
                                Present
                              </button>
                              <button
                                type="button"
                                className={`quick-action-btn ${String(row.afternoon_status).toLowerCase() === 'absent' ? 'active danger' : ''}`}
                                onClick={() => handleStaffAttendanceUpdate(row, 'afternoon', 'absent')}
                                disabled={!row.is_working_day || savingSessionKey === `${row.user_id}:${row.date}:afternoon`}
                              >
                                Absent
                              </button>
                            </div>
                          </div>
                        </div>
                      ),
                    },
                  ]}
                  rows={staffState.data.items || []}
                  emptyTitle="No staff attendance rows"
                  emptyMessage="No staff attendance rows match the selected date range."
                  rowKey={(row) => `${row.user_id}:${row.date}`}
                />
              </div>
              <Pagination
                page={staffState.data.page}
                pageSize={staffState.data.page_size}
                total={staffState.data.total}
                onPageChange={(page) => setStaffFilters((current) => ({ ...current, page }))}
                isLoading={staffState.loading}
              />
            </>
          ) : (
            <EmptyState title="Staff attendance unavailable" message="Staff attendance data could not be loaded right now." />
          )}
        </Panel>
      )}
    </div>
  );
}

function PrincipalInstituteInsightsPortal({ token, notify }) {
  const defaultRange = getDefaultStudentRange();
  const [activeTab, setActiveTab] = useState('hods');
  const [meta, setMeta] = useState({ departments: [] });
  const [hodFilters, setHodFilters] = useState({
    page: 1,
    page_size: 10,
    from_date: defaultRange.from_date,
    to_date: defaultRange.to_date,
  });
  const [staffFilters, setStaffFilters] = useState({
    page: 1,
    page_size: 10,
    department: '',
    from_date: defaultRange.from_date,
    to_date: defaultRange.to_date,
  });
  const [studentFilters, setStudentFilters] = useState({
    page: 1,
    page_size: 10,
    department: '',
    from_date: defaultRange.from_date,
    to_date: defaultRange.to_date,
  });
  const [hodState, setHodState] = useState({ loading: true, data: null, error: '' });
  const [staffState, setStaffState] = useState({ loading: false, data: null, error: '' });
  const [studentState, setStudentState] = useState({ loading: false, data: null, error: '' });
  const [savingSessionKey, setSavingSessionKey] = useState('');
  const [studentExporting, setStudentExporting] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function loadMeta() {
      try {
        const response = await metaApi.options(token);
        if (!ignore) {
          setMeta({
            departments: response.departments || [],
          });
        }
      } catch {
        if (!ignore) {
          setMeta({ departments: [] });
        }
      }
    }
    loadMeta();
    return () => {
      ignore = true;
    };
  }, [token]);

  const loadHODAttendance = useCallback(async () => {
    setHodState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const response = await attendanceApi.listPrincipalHODs(token, hodFilters);
      setHodState({ loading: false, data: response, error: '' });
    } catch (requestError) {
      setHodState({
        loading: false,
        data: null,
        error: getApiErrorMessage(requestError, 'Unable to load HOD attendance records.'),
      });
    }
  }, [hodFilters, token]);

  const loadStaffAttendance = useCallback(async () => {
    setStaffState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const response = await attendanceApi.listPrincipalStaff(token, staffFilters);
      setStaffState({ loading: false, data: response, error: '' });
    } catch (requestError) {
      setStaffState({
        loading: false,
        data: null,
        error: getApiErrorMessage(requestError, 'Unable to load staff attendance records.'),
      });
    }
  }, [staffFilters, token]);

  const loadStudentAttendance = useCallback(async () => {
    setStudentState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const response = await attendanceApi.listPrincipalStudents(token, studentFilters);
      setStudentState({ loading: false, data: response, error: '' });
    } catch (requestError) {
      setStudentState({
        loading: false,
        data: null,
        error: getApiErrorMessage(requestError, 'Unable to load student attendance records.'),
      });
    }
  }, [studentFilters, token]);

  useEffect(() => {
    if (activeTab === 'hods') {
      loadHODAttendance();
    }
  }, [activeTab, loadHODAttendance]);

  useEffect(() => {
    if (activeTab === 'staff') {
      loadStaffAttendance();
    }
  }, [activeTab, loadStaffAttendance]);

  useEffect(() => {
    if (activeTab === 'students') {
      loadStudentAttendance();
    }
  }, [activeTab, loadStudentAttendance]);

  function updateRangeFilters(setter, field, value) {
    setter((current) => {
      const nextFilters = { ...current, page: 1, [field]: value };
      if (field === 'from_date' && nextFilters.to_date && value > nextFilters.to_date) {
        nextFilters.to_date = value;
      }
      if (field === 'to_date' && nextFilters.from_date && value < nextFilters.from_date) {
        nextFilters.from_date = value;
      }
      return nextFilters;
    });
  }

  async function handleHODAttendanceUpdate(row, sessionName, nextStatus) {
    if (!row.is_working_day) {
      notify('warning', 'Attendance closed', 'Attendance can only be corrected on staff working days.');
      return;
    }

    const currentStatus = String(row?.[`${sessionName}_status`] || '').toLowerCase();
    if ((nextStatus === 'present' && isPresentishStatus(currentStatus)) || currentStatus === nextStatus) {
      return;
    }

    const sessionKey = `${row.user_id}:${row.date}:${sessionName}`;
    setSavingSessionKey(sessionKey);

    try {
      await attendanceApi.manualOverride(token, {
        user_id: row.user_id,
        date: row.date,
        session: sessionName,
        status: nextStatus,
        time: nextStatus === 'present'
          ? resolveSessionActionTime(sessionName, hodState.data?.session_defaults)
          : null,
      });
      notify(
        'success',
        'Attendance updated',
        `${row.name} was marked ${nextStatus} for the ${sessionLabel(sessionName, 'staff').toLowerCase()} session.`,
      );
      loadHODAttendance();
    } catch (requestError) {
      notify('danger', 'Update failed', getApiErrorMessage(requestError, 'Unable to update HOD attendance.'));
    } finally {
      setSavingSessionKey('');
    }
  }

  async function handleStudentExport() {
    setStudentExporting(true);
    try {
      const blob = await attendanceApi.exportPrincipalStudents(token, {
        department: studentFilters.department,
        from_date: studentFilters.from_date,
        to_date: studentFilters.to_date,
      });
      downloadBlob(
        blob,
        `${buildFilenameSlug(studentFilters.department || 'institute_students', 'institute_students')}_${studentFilters.from_date}_to_${studentFilters.to_date}.xlsx`,
      );
      notify('success', 'Export ready', 'Student attendance export downloaded successfully.');
    } catch (requestError) {
      notify('danger', 'Export failed', getApiErrorMessage(requestError, 'Unable to export student attendance.'));
    } finally {
      setStudentExporting(false);
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="Institute Insights"
        subtitle="Manage HOD attendance when needed and review institute-wide staff and student attendance in focused read-only views."
      />

      <Notice tone="info" title="Institute-wide Visibility">
        HOD attendance includes Present and Absent triggers. Staff and student attendance stay read-only, with export available for students.
      </Notice>

      <div className="chip-group">
        <button
          type="button"
          className={`chip ${activeTab === 'hods' ? 'active' : ''}`}
          onClick={() => setActiveTab('hods')}
        >
          HOD Attendance
        </button>
        <button
          type="button"
          className={`chip ${activeTab === 'staff' ? 'active' : ''}`}
          onClick={() => setActiveTab('staff')}
        >
          Staff Attendance
        </button>
        <button
          type="button"
          className={`chip ${activeTab === 'students' ? 'active' : ''}`}
          onClick={() => setActiveTab('students')}
        >
          Student Attendance
        </button>
      </div>

      {activeTab === 'hods' ? (
        <Panel
          title="HOD Attendance"
          subtitle="Review HOD attendance across the institute and use Present or Absent triggers when a correction is needed."
        >
          <div className="form-grid">
            <label className="field">
              <span>From Date</span>
              <input
                className="input"
                type="date"
                value={hodFilters.from_date}
                max={hodFilters.to_date}
                onChange={(event) => updateRangeFilters(setHodFilters, 'from_date', event.target.value)}
              />
            </label>
            <label className="field">
              <span>To Date</span>
              <input
                className="input"
                type="date"
                value={hodFilters.to_date}
                min={hodFilters.from_date}
                max={formatInputDate(new Date())}
                onChange={(event) => updateRangeFilters(setHodFilters, 'to_date', event.target.value)}
              />
            </label>
            <div className="field">
              <span>Refresh</span>
              <button
                type="button"
                className="btn-secondary btn-block"
                onClick={() => loadHODAttendance()}
                disabled={hodState.loading || Boolean(savingSessionKey)}
              >
                {hodState.loading ? 'Refreshing...' : 'Refresh Data'}
              </button>
            </div>
          </div>

          {hodState.error ? <Notice tone="danger" title="HOD Attendance Error">{hodState.error}</Notice> : null}

          {hodState.loading && !hodState.data ? (
            <LoadingState label="Loading HOD attendance..." />
          ) : hodState.data ? (
            <>
              <div className={hodState.loading ? 'loading-fade' : ''}>
                <Table
                  tableClassName="faculty-daily-table"
                  columns={[
                    { key: 'name', label: 'HOD Name', className: 'faculty-name-cell' },
                    { key: 'identifier', label: 'Identifier', className: 'faculty-register-cell' },
                    { key: 'department', label: 'Department', render: (row) => row.department || '--' },
                    { key: 'date', label: 'Date', render: (row) => formatDate(row.date) },
                    { key: 'morning_status', label: sessionLabel('morning', 'staff'), render: (row) => <StudentStatusBadge status={row.morning_status} /> },
                    { key: 'afternoon_status', label: sessionLabel('afternoon', 'staff'), render: (row) => <StudentStatusBadge status={row.afternoon_status} /> },
                    {
                      key: 'daily_total',
                      label: 'Total',
                      className: 'faculty-total-cell',
                      render: (row) => formatDailyTotal(row.daily_total),
                    },
                    {
                      key: 'actions',
                      label: 'Fix Attendance',
                      cellClassName: 'faculty-actions-cell',
                      render: (row) => (
                        <div className="faculty-action-stack">
                          <div className="faculty-action-row">
                            <span className="faculty-action-label">{sessionLabel('morning', 'staff')}</span>
                            <div className="faculty-quick-actions">
                              <button
                                type="button"
                                className={`quick-action-btn ${isPresentishStatus(row.morning_status) ? 'active success' : ''}`}
                                onClick={() => handleHODAttendanceUpdate(row, 'morning', 'present')}
                                disabled={!row.is_working_day || savingSessionKey === `${row.user_id}:${row.date}:morning`}
                              >
                                Present
                              </button>
                              <button
                                type="button"
                                className={`quick-action-btn ${String(row.morning_status).toLowerCase() === 'absent' ? 'active danger' : ''}`}
                                onClick={() => handleHODAttendanceUpdate(row, 'morning', 'absent')}
                                disabled={!row.is_working_day || savingSessionKey === `${row.user_id}:${row.date}:morning`}
                              >
                                Absent
                              </button>
                            </div>
                          </div>
                          <div className="faculty-action-row">
                            <span className="faculty-action-label">{sessionLabel('afternoon', 'staff')}</span>
                            <div className="faculty-quick-actions">
                              <button
                                type="button"
                                className={`quick-action-btn ${isPresentishStatus(row.afternoon_status) ? 'active success' : ''}`}
                                onClick={() => handleHODAttendanceUpdate(row, 'afternoon', 'present')}
                                disabled={!row.is_working_day || savingSessionKey === `${row.user_id}:${row.date}:afternoon`}
                              >
                                Present
                              </button>
                              <button
                                type="button"
                                className={`quick-action-btn ${String(row.afternoon_status).toLowerCase() === 'absent' ? 'active danger' : ''}`}
                                onClick={() => handleHODAttendanceUpdate(row, 'afternoon', 'absent')}
                                disabled={!row.is_working_day || savingSessionKey === `${row.user_id}:${row.date}:afternoon`}
                              >
                                Absent
                              </button>
                            </div>
                          </div>
                        </div>
                      ),
                    },
                  ]}
                  rows={hodState.data.items || []}
                  emptyTitle="No HOD attendance rows"
                  emptyMessage="No HOD attendance rows match the selected date range."
                  rowKey={(row) => `${row.user_id}:${row.date}`}
                />
              </div>
              <Pagination
                page={hodState.data.page}
                pageSize={hodState.data.page_size}
                total={hodState.data.total}
                onPageChange={(page) => setHodFilters((current) => ({ ...current, page }))}
                isLoading={hodState.loading}
              />
            </>
          ) : (
            <EmptyState title="HOD attendance unavailable" message="HOD attendance data could not be loaded right now." />
          )}
        </Panel>
      ) : null}

      {activeTab === 'staff' ? (
        <Panel
          title="Staff Attendance"
          subtitle="Read-only staff attendance view with department and date filters across the institute."
        >
          <div className="form-grid">
            <label className="field">
              <span>Department</span>
              <select
                className="input"
                value={staffFilters.department}
                onChange={(event) => setStaffFilters((current) => ({ ...current, page: 1, department: event.target.value }))}
              >
                <option value="">All Departments</option>
                {meta.departments.map((department) => (
                  <option key={department} value={department}>{department}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>From Date</span>
              <input
                className="input"
                type="date"
                value={staffFilters.from_date}
                max={staffFilters.to_date}
                onChange={(event) => updateRangeFilters(setStaffFilters, 'from_date', event.target.value)}
              />
            </label>
            <label className="field">
              <span>To Date</span>
              <input
                className="input"
                type="date"
                value={staffFilters.to_date}
                min={staffFilters.from_date}
                max={formatInputDate(new Date())}
                onChange={(event) => updateRangeFilters(setStaffFilters, 'to_date', event.target.value)}
              />
            </label>
            <div className="field">
              <span>Refresh</span>
              <button
                type="button"
                className="btn-secondary btn-block"
                onClick={() => loadStaffAttendance()}
                disabled={staffState.loading}
              >
                {staffState.loading ? 'Refreshing...' : 'Refresh Data'}
              </button>
            </div>
          </div>

          <Notice tone="info" title="Read-only Staff View">
            Staff attendance is visible for monitoring only. Principal attendance actions are restricted to HOD records.
          </Notice>

          {staffState.error ? <Notice tone="danger" title="Staff Attendance Error">{staffState.error}</Notice> : null}

          {staffState.loading && !staffState.data ? (
            <LoadingState label="Loading staff attendance..." />
          ) : staffState.data ? (
            <>
              <div className={staffState.loading ? 'loading-fade' : ''}>
                <Table
                  columns={[
                    { key: 'name', label: 'Staff Name' },
                    { key: 'identifier', label: 'Identifier' },
                    { key: 'department', label: 'Department', render: (row) => row.department || '--' },
                    { key: 'date', label: 'Date', render: (row) => formatDate(row.date) },
                    { key: 'morning_status', label: sessionLabel('morning', 'staff'), render: (row) => <StudentStatusBadge status={row.morning_status} /> },
                    { key: 'afternoon_status', label: sessionLabel('afternoon', 'staff'), render: (row) => <StudentStatusBadge status={row.afternoon_status} /> },
                    { key: 'daily_total', label: 'Total', render: (row) => formatDailyTotal(row.daily_total) },
                  ]}
                  rows={staffState.data.items || []}
                  emptyTitle="No staff attendance rows"
                  emptyMessage="No staff attendance rows match the selected filters."
                  rowKey={(row) => `${row.user_id}:${row.date}`}
                />
              </div>
              <Pagination
                page={staffState.data.page}
                pageSize={staffState.data.page_size}
                total={staffState.data.total}
                onPageChange={(page) => setStaffFilters((current) => ({ ...current, page }))}
                isLoading={staffState.loading}
              />
            </>
          ) : (
            <EmptyState title="Staff attendance unavailable" message="Staff attendance data could not be loaded right now." />
          )}
        </Panel>
      ) : null}

      {activeTab === 'students' ? (
        <Panel
          title="Student Attendance"
          subtitle="Read-only student attendance view with department filter and Excel export."
        >
          <div className="form-grid">
            <label className="field">
              <span>Department</span>
              <select
                className="input"
                value={studentFilters.department}
                onChange={(event) => setStudentFilters((current) => ({ ...current, page: 1, department: event.target.value }))}
              >
                <option value="">All Departments</option>
                {meta.departments.map((department) => (
                  <option key={department} value={department}>{department}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>From Date</span>
              <input
                className="input"
                type="date"
                value={studentFilters.from_date}
                max={studentFilters.to_date}
                onChange={(event) => updateRangeFilters(setStudentFilters, 'from_date', event.target.value)}
              />
            </label>
            <label className="field">
              <span>To Date</span>
              <input
                className="input"
                type="date"
                value={studentFilters.to_date}
                min={studentFilters.from_date}
                max={formatInputDate(new Date())}
                onChange={(event) => updateRangeFilters(setStudentFilters, 'to_date', event.target.value)}
              />
            </label>
            <div className="field">
              <span>Refresh</span>
              <button
                type="button"
                className="btn-secondary btn-block"
                onClick={() => loadStudentAttendance()}
                disabled={studentState.loading || studentExporting}
              >
                {studentState.loading ? 'Refreshing...' : 'Refresh Data'}
              </button>
            </div>
            <div className="field">
              <span>Export</span>
              <button
                type="button"
                className="btn-primary btn-block"
                onClick={handleStudentExport}
                disabled={studentExporting}
              >
                {studentExporting ? 'Exporting...' : 'Export Student Attendance'}
              </button>
            </div>
          </div>

          <Notice tone="info" title="Read-only Student View">
            Student attendance is available here for institute-wide review and export only.
          </Notice>

          {studentState.error ? <Notice tone="danger" title="Student Attendance Error">{studentState.error}</Notice> : null}

          {studentState.loading ? (
            <LoadingState label="Loading student attendance..." />
          ) : studentState.data ? (
            <>
              <Table
                columns={[
                  { key: 'name', label: 'Student Name' },
                  { key: 'identifier', label: 'Register Number' },
                  { key: 'department', label: 'Department', render: (row) => row.department || '--' },
                  { key: 'year', label: 'Year', render: (row) => row.year || '--' },
                  { key: 'semester', label: 'Semester', render: (row) => row.semester || '--' },
                  { key: 'date', label: 'Date', render: (row) => formatDate(row.date) },
                  { key: 'morning_status', label: sessionLabel('morning', 'students'), render: (row) => <StudentStatusBadge status={row.morning_status} /> },
                  { key: 'afternoon_status', label: sessionLabel('afternoon', 'students'), render: (row) => <StudentStatusBadge status={row.afternoon_status} /> },
                  { key: 'daily_total', label: 'Total', render: (row) => formatDailyTotal(row.daily_total) },
                  { key: 'attendance_rate', label: 'Attendance %', render: (row) => formatPercent(row.attendance_rate) },
                ]}
                rows={studentState.data.items || []}
                emptyTitle="No student attendance rows"
                emptyMessage="No student attendance rows match the selected filters."
                rowKey={(row) => `${row.user_id}:${row.date}`}
              />
              <Pagination
                page={studentState.data.page}
                pageSize={studentState.data.page_size}
                total={studentState.data.total}
                onPageChange={(page) => setStudentFilters((current) => ({ ...current, page }))}
              />
            </>
          ) : (
            <EmptyState title="Student attendance unavailable" message="Student attendance data could not be loaded right now." />
          )}
        </Panel>
      ) : null}
    </div>
  );
}

function AdminInstituteAttendancePortal({ token, notify }) {
  const defaultRange = getDefaultStudentRange();
  const [activeTab, setActiveTab] = useState('students');
  const [meta, setMeta] = useState({ departments: [] });
  const [studentFilters, setStudentFilters] = useState({
    page: 1,
    page_size: 10,
    search: '',
    department: '',
    year: '',
    semester: '',
    from_date: defaultRange.from_date,
    to_date: defaultRange.to_date,
  });
  const [staffFilters, setStaffFilters] = useState({
    page: 1,
    page_size: 10,
    search: '',
    department: '',
    from_date: defaultRange.from_date,
    to_date: defaultRange.to_date,
  });
  const [hodFilters, setHodFilters] = useState({
    page: 1,
    page_size: 10,
    search: '',
    department: '',
    from_date: defaultRange.from_date,
    to_date: defaultRange.to_date,
  });
  const [principalFilters, setPrincipalFilters] = useState({
    page: 1,
    page_size: 10,
    search: '',
    department: '',
    from_date: defaultRange.from_date,
    to_date: defaultRange.to_date,
  });
  const [studentState, setStudentState] = useState({ loading: true, data: null, error: '' });
  const [staffState, setStaffState] = useState({ loading: false, data: null, error: '' });
  const [hodState, setHodState] = useState({ loading: false, data: null, error: '' });
  const [principalState, setPrincipalState] = useState({ loading: false, data: null, error: '' });
  const [savingSessionKey, setSavingSessionKey] = useState('');
  const [studentExporting, setStudentExporting] = useState(false);
  const [staffExporting, setStaffExporting] = useState(false);
  const [hodExporting, setHodExporting] = useState(false);
  const [principalExporting, setPrincipalExporting] = useState(false);

  useEffect(() => {
    let ignore = false;

    async function loadMeta() {
      try {
        const response = await metaApi.options(token);
        if (!ignore) {
          setMeta({
            departments: response.departments || [],
          });
        }
      } catch {
        if (!ignore) {
          setMeta({ departments: [] });
        }
      }
    }

    loadMeta();
    return () => {
      ignore = true;
    };
  }, [token]);

  const loadStudentAttendance = useCallback(async () => {
    setStudentState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const response = await attendanceApi.listAdminStudents(token, {
        ...studentFilters,
        year: studentFilters.year ? Number(studentFilters.year) : undefined,
        semester: studentFilters.semester ? Number(studentFilters.semester) : undefined,
      });
      setStudentState({ loading: false, data: response, error: '' });
    } catch (requestError) {
      setStudentState({
        loading: false,
        data: null,
        error: getApiErrorMessage(requestError, 'Unable to load institute student attendance.'),
      });
    }
  }, [studentFilters, token]);

  const loadStaffAttendance = useCallback(async () => {
    setStaffState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const response = await attendanceApi.listAdminStaff(token, staffFilters);
      setStaffState({ loading: false, data: response, error: '' });
    } catch (requestError) {
      setStaffState({
        loading: false,
        data: null,
        error: getApiErrorMessage(requestError, 'Unable to load institute staff attendance.'),
      });
    }
  }, [staffFilters, token]);

  const loadHODAttendance = useCallback(async () => {
    setHodState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const response = await attendanceApi.listAdminHODs(token, hodFilters);
      setHodState({ loading: false, data: response, error: '' });
    } catch (requestError) {
      setHodState({
        loading: false,
        data: null,
        error: getApiErrorMessage(requestError, 'Unable to load institute HOD attendance.'),
      });
    }
  }, [hodFilters, token]);

  const loadPrincipalAttendance = useCallback(async () => {
    setPrincipalState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const response = await attendanceApi.listAdminPrincipals(token, principalFilters);
      setPrincipalState({ loading: false, data: response, error: '' });
    } catch (requestError) {
      setPrincipalState({
        loading: false,
        data: null,
        error: getApiErrorMessage(requestError, 'Unable to load institute principal attendance.'),
      });
    }
  }, [principalFilters, token]);

  useEffect(() => {
    if (activeTab === 'students') {
      loadStudentAttendance();
    }
  }, [activeTab, loadStudentAttendance]);

  useEffect(() => {
    if (activeTab === 'staff') {
      loadStaffAttendance();
    }
  }, [activeTab, loadStaffAttendance]);

  useEffect(() => {
    if (activeTab === 'hods') {
      loadHODAttendance();
    }
  }, [activeTab, loadHODAttendance]);

  useEffect(() => {
    if (activeTab === 'principals') {
      loadPrincipalAttendance();
    }
  }, [activeTab, loadPrincipalAttendance]);

  function updateRangeFilters(setter, field, value) {
    setter((current) => {
      const nextFilters = { ...current, page: 1, [field]: value };
      if (field === 'from_date' && nextFilters.to_date && value > nextFilters.to_date) {
        nextFilters.to_date = value;
      }
      if (field === 'to_date' && nextFilters.from_date && value < nextFilters.from_date) {
        nextFilters.from_date = value;
      }
      return nextFilters;
    });
  }

  async function handleRoleAttendanceUpdate({
    row,
    sessionName,
    nextStatus,
    audience,
    sessionDefaults,
    reloadAttendance,
  }) {
    if (!row.is_working_day) {
      notify(
        'warning',
        'Attendance closed',
        `Attendance can only be corrected on ${audience === 'students' ? 'student' : 'staff'} working days.`,
      );
      return;
    }

    const currentStatus = String(row?.[`${sessionName}_status`] || '').toLowerCase();
    if ((nextStatus === 'present' && isPresentishStatus(currentStatus)) || currentStatus === nextStatus) {
      return;
    }

    const sessionKey = `${row.user_id}:${row.date}:${sessionName}`;
    setSavingSessionKey(sessionKey);

    try {
      await attendanceApi.manualOverride(token, {
        user_id: row.user_id,
        date: row.date,
        session: sessionName,
        status: nextStatus,
        time: nextStatus === 'present'
          ? resolveSessionActionTime(sessionName, sessionDefaults)
          : null,
      });
      notify(
        'success',
        'Attendance updated',
        `${row.name} was marked ${nextStatus} for the ${sessionLabel(sessionName, audience).toLowerCase()} session.`,
      );
      await reloadAttendance();
    } catch (requestError) {
      notify('danger', 'Update failed', getApiErrorMessage(requestError, 'Unable to update attendance.'));
    } finally {
      setSavingSessionKey('');
    }
  }

  function renderActionCell(row, audience, sessionDefaults, reloadAttendance) {
    return (
      <div className="faculty-action-stack">
        <div className="faculty-action-row">
          <span className="faculty-action-label">{sessionLabel('morning', audience)}</span>
          <div className="faculty-quick-actions">
            <button
              type="button"
              className={`quick-action-btn ${isPresentishStatus(row.morning_status) ? 'active success' : ''}`}
              onClick={() => handleRoleAttendanceUpdate({
                row,
                sessionName: 'morning',
                nextStatus: 'present',
                audience,
                sessionDefaults,
                reloadAttendance,
              })}
              disabled={!row.is_working_day || savingSessionKey === `${row.user_id}:${row.date}:morning`}
            >
              Present
            </button>
            <button
              type="button"
              className={`quick-action-btn ${String(row.morning_status).toLowerCase() === 'absent' ? 'active danger' : ''}`}
              onClick={() => handleRoleAttendanceUpdate({
                row,
                sessionName: 'morning',
                nextStatus: 'absent',
                audience,
                sessionDefaults,
                reloadAttendance,
              })}
              disabled={!row.is_working_day || savingSessionKey === `${row.user_id}:${row.date}:morning`}
            >
              Absent
            </button>
          </div>
        </div>
        <div className="faculty-action-row">
          <span className="faculty-action-label">{sessionLabel('afternoon', audience)}</span>
          <div className="faculty-quick-actions">
            <button
              type="button"
              className={`quick-action-btn ${isPresentishStatus(row.afternoon_status) ? 'active success' : ''}`}
              onClick={() => handleRoleAttendanceUpdate({
                row,
                sessionName: 'afternoon',
                nextStatus: 'present',
                audience,
                sessionDefaults,
                reloadAttendance,
              })}
              disabled={!row.is_working_day || savingSessionKey === `${row.user_id}:${row.date}:afternoon`}
            >
              Present
            </button>
            <button
              type="button"
              className={`quick-action-btn ${String(row.afternoon_status).toLowerCase() === 'absent' ? 'active danger' : ''}`}
              onClick={() => handleRoleAttendanceUpdate({
                row,
                sessionName: 'afternoon',
                nextStatus: 'absent',
                audience,
                sessionDefaults,
                reloadAttendance,
              })}
              disabled={!row.is_working_day || savingSessionKey === `${row.user_id}:${row.date}:afternoon`}
            >
              Absent
            </button>
          </div>
        </div>
      </div>
    );
  }

  async function handleStudentExport() {
    setStudentExporting(true);
    try {
      const blob = await attendanceApi.exportAdminStudents(token, {
        ...studentFilters,
        year: studentFilters.year ? Number(studentFilters.year) : undefined,
        semester: studentFilters.semester ? Number(studentFilters.semester) : undefined,
      });
      downloadBlob(
        blob,
        `${buildFilenameSlug(studentFilters.department || 'institute', 'institute')}_students_${studentFilters.from_date}_to_${studentFilters.to_date}.xlsx`,
      );
      notify('success', 'Export ready', 'Institute student attendance export downloaded successfully.');
    } catch (requestError) {
      notify('danger', 'Export failed', getApiErrorMessage(requestError, 'Unable to export institute student attendance.'));
    } finally {
      setStudentExporting(false);
    }
  }

  async function handleStaffExport() {
    setStaffExporting(true);
    try {
      const blob = await attendanceApi.exportAdminStaff(token, staffFilters);
      downloadBlob(
        blob,
        `${buildFilenameSlug(staffFilters.department || 'institute', 'institute')}_staff_${staffFilters.from_date}_to_${staffFilters.to_date}.xlsx`,
      );
      notify('success', 'Export ready', 'Institute staff attendance export downloaded successfully.');
    } catch (requestError) {
      notify('danger', 'Export failed', getApiErrorMessage(requestError, 'Unable to export institute staff attendance.'));
    } finally {
      setStaffExporting(false);
    }
  }

  async function handleHODExport() {
    setHodExporting(true);
    try {
      const blob = await attendanceApi.exportAdminHODs(token, hodFilters);
      downloadBlob(
        blob,
        `${buildFilenameSlug(hodFilters.department || 'institute', 'institute')}_hods_${hodFilters.from_date}_to_${hodFilters.to_date}.xlsx`,
      );
      notify('success', 'Export ready', 'Institute HOD attendance export downloaded successfully.');
    } catch (requestError) {
      notify('danger', 'Export failed', getApiErrorMessage(requestError, 'Unable to export institute HOD attendance.'));
    } finally {
      setHodExporting(false);
    }
  }

  async function handlePrincipalExport() {
    setPrincipalExporting(true);
    try {
      const blob = await attendanceApi.exportAdminPrincipals(token, principalFilters);
      downloadBlob(
        blob,
        `${buildFilenameSlug(principalFilters.department || 'institute', 'institute')}_principals_${principalFilters.from_date}_to_${principalFilters.to_date}.xlsx`,
      );
      notify('success', 'Export ready', 'Institute principal attendance export downloaded successfully.');
    } catch (requestError) {
      notify('danger', 'Export failed', getApiErrorMessage(requestError, 'Unable to export institute principal attendance.'));
    } finally {
      setPrincipalExporting(false);
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="Institute Attendance"
        subtitle="Review attendance across the whole institute, filter by scope, export Excel, and correct Present or Absent status where needed."
      />

      <Notice tone="info" title="Admin Institute Control">
        Admin can review and correct attendance for students, staff, HODs, and principals across every visible department.
      </Notice>

      <div className="chip-group">
        <button
          type="button"
          className={`chip ${activeTab === 'students' ? 'active' : ''}`}
          onClick={() => setActiveTab('students')}
        >
          Student Attendance
        </button>
        <button
          type="button"
          className={`chip ${activeTab === 'staff' ? 'active' : ''}`}
          onClick={() => setActiveTab('staff')}
        >
          Staff Attendance
        </button>
        <button
          type="button"
          className={`chip ${activeTab === 'hods' ? 'active' : ''}`}
          onClick={() => setActiveTab('hods')}
        >
          HOD Attendance
        </button>
        <button
          type="button"
          className={`chip ${activeTab === 'principals' ? 'active' : ''}`}
          onClick={() => setActiveTab('principals')}
        >
          Principal Attendance
        </button>
      </div>

      {activeTab === 'students' ? (
        <Panel
          title="Student Attendance"
          subtitle="Filter by department, year, semester, and date range, then export or correct student attendance."
        >
          <div className="form-grid">
            <label className="field">
              <span>Search</span>
              <input
                className="input"
                value={studentFilters.search}
                onChange={(event) => setStudentFilters((current) => ({ ...current, page: 1, search: event.target.value }))}
                placeholder="Student name or register number"
              />
            </label>
            <label className="field">
              <span>Department</span>
              <select
                className="input"
                value={studentFilters.department}
                onChange={(event) => setStudentFilters((current) => ({ ...current, page: 1, department: event.target.value }))}
              >
                <option value="">All Departments</option>
                {meta.departments.map((department) => (
                  <option key={department} value={department}>{department}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Year</span>
              <select
                className="input"
                value={studentFilters.year}
                onChange={(event) => setStudentFilters((current) => ({ ...current, page: 1, year: event.target.value }))}
              >
                <option value="">All Years</option>
                {[1, 2, 3, 4].map((year) => (
                  <option key={year} value={year}>{`Year ${year}`}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Semester</span>
              <select
                className="input"
                value={studentFilters.semester}
                onChange={(event) => setStudentFilters((current) => ({ ...current, page: 1, semester: event.target.value }))}
              >
                <option value="">All Semesters</option>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((semester) => (
                  <option key={semester} value={semester}>{`Sem ${semester}`}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>From Date</span>
              <input
                className="input"
                type="date"
                value={studentFilters.from_date}
                max={studentFilters.to_date}
                onChange={(event) => updateRangeFilters(setStudentFilters, 'from_date', event.target.value)}
              />
            </label>
            <label className="field">
              <span>To Date</span>
              <input
                className="input"
                type="date"
                value={studentFilters.to_date}
                min={studentFilters.from_date}
                max={formatInputDate(new Date())}
                onChange={(event) => updateRangeFilters(setStudentFilters, 'to_date', event.target.value)}
              />
            </label>
            <div className="field">
              <span>Refresh</span>
              <button
                type="button"
                className="btn-secondary btn-block"
                onClick={() => loadStudentAttendance()}
                disabled={studentState.loading || Boolean(savingSessionKey)}
              >
                {studentState.loading ? 'Refreshing...' : 'Refresh Data'}
              </button>
            </div>
            <div className="field">
              <span>Export</span>
              <button
                type="button"
                className="btn-primary btn-block"
                onClick={handleStudentExport}
                disabled={studentExporting}
              >
                {studentExporting ? 'Exporting...' : 'Export Student Attendance'}
              </button>
            </div>
          </div>

          {studentState.error ? <Notice tone="danger" title="Student Attendance Error">{studentState.error}</Notice> : null}

          {studentState.loading && !studentState.data ? (
            <LoadingState label="Loading institute student attendance..." />
          ) : studentState.data ? (
            <>
              <div className={studentState.loading ? 'loading-fade' : ''}>
                <Table
                  tableClassName="faculty-daily-table"
                  columns={[
                    { key: 'name', label: 'Student Name' },
                    { key: 'identifier', label: 'Register Number' },
                    { key: 'department', label: 'Department', render: (row) => row.department || '--' },
                    { key: 'year', label: 'Year', render: (row) => row.year || '--' },
                    { key: 'semester', label: 'Semester', render: (row) => row.semester || '--' },
                    { key: 'date', label: 'Date', render: (row) => formatDate(row.date) },
                    { key: 'morning_status', label: sessionLabel('morning', 'students'), render: (row) => <StudentStatusBadge status={row.morning_status} /> },
                    { key: 'afternoon_status', label: sessionLabel('afternoon', 'students'), render: (row) => <StudentStatusBadge status={row.afternoon_status} /> },
                    { key: 'daily_total', label: 'Total', render: (row) => formatDailyTotal(row.daily_total) },
                    { key: 'attendance_rate', label: 'Attendance %', render: (row) => formatPercent(row.attendance_rate) },
                    {
                      key: 'actions',
                      label: 'Fix Attendance',
                      cellClassName: 'faculty-actions-cell',
                      render: (row) => renderActionCell(row, 'students', studentState.data?.session_defaults, loadStudentAttendance),
                    },
                  ]}
                  rows={studentState.data.items || []}
                  emptyTitle="No student attendance rows"
                  emptyMessage="No student attendance rows match the selected filters."
                  rowKey={(row) => `${row.user_id}:${row.date}`}
                />
              </div>
              <Pagination
                page={studentState.data.page}
                pageSize={studentState.data.page_size}
                total={studentState.data.total}
                onPageChange={(page) => setStudentFilters((current) => ({ ...current, page }))}
                isLoading={studentState.loading}
              />
            </>
          ) : (
            <EmptyState title="Student attendance unavailable" message="Institute student attendance could not be loaded right now." />
          )}
        </Panel>
      ) : null}

      {activeTab === 'staff' ? (
        <Panel
          title="Staff Attendance"
          subtitle="Filter by department and date range, then export or correct staff attendance."
        >
          <div className="form-grid">
            <label className="field">
              <span>Search</span>
              <input
                className="input"
                value={staffFilters.search}
                onChange={(event) => setStaffFilters((current) => ({ ...current, page: 1, search: event.target.value }))}
                placeholder="Staff name or identifier"
              />
            </label>
            <label className="field">
              <span>Department</span>
              <select
                className="input"
                value={staffFilters.department}
                onChange={(event) => setStaffFilters((current) => ({ ...current, page: 1, department: event.target.value }))}
              >
                <option value="">All Departments</option>
                {meta.departments.map((department) => (
                  <option key={department} value={department}>{department}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>From Date</span>
              <input
                className="input"
                type="date"
                value={staffFilters.from_date}
                max={staffFilters.to_date}
                onChange={(event) => updateRangeFilters(setStaffFilters, 'from_date', event.target.value)}
              />
            </label>
            <label className="field">
              <span>To Date</span>
              <input
                className="input"
                type="date"
                value={staffFilters.to_date}
                min={staffFilters.from_date}
                max={formatInputDate(new Date())}
                onChange={(event) => updateRangeFilters(setStaffFilters, 'to_date', event.target.value)}
              />
            </label>
            <div className="field">
              <span>Refresh</span>
              <button
                type="button"
                className="btn-secondary btn-block"
                onClick={() => loadStaffAttendance()}
                disabled={staffState.loading || Boolean(savingSessionKey)}
              >
                {staffState.loading ? 'Refreshing...' : 'Refresh Data'}
              </button>
            </div>
            <div className="field">
              <span>Export</span>
              <button
                type="button"
                className="btn-primary btn-block"
                onClick={handleStaffExport}
                disabled={staffExporting}
              >
                {staffExporting ? 'Exporting...' : 'Export Staff Attendance'}
              </button>
            </div>
          </div>

          {staffState.error ? <Notice tone="danger" title="Staff Attendance Error">{staffState.error}</Notice> : null}

          {staffState.loading ? (
            <LoadingState label="Loading institute staff attendance..." />
          ) : staffState.data ? (
            <>
              <Table
                tableClassName="faculty-daily-table"
                columns={[
                  { key: 'name', label: 'Staff Name', className: 'faculty-name-cell' },
                  { key: 'identifier', label: 'Identifier', className: 'faculty-register-cell' },
                  { key: 'department', label: 'Department', render: (row) => row.department || '--' },
                  { key: 'date', label: 'Date', render: (row) => formatDate(row.date) },
                  { key: 'morning_status', label: sessionLabel('morning', 'staff'), render: (row) => <StudentStatusBadge status={row.morning_status} /> },
                  { key: 'afternoon_status', label: sessionLabel('afternoon', 'staff'), render: (row) => <StudentStatusBadge status={row.afternoon_status} /> },
                  { key: 'daily_total', label: 'Total', render: (row) => formatDailyTotal(row.daily_total) },
                  {
                    key: 'actions',
                    label: 'Fix Attendance',
                    cellClassName: 'faculty-actions-cell',
                    render: (row) => renderActionCell(row, 'staff', staffState.data?.session_defaults, loadStaffAttendance),
                  },
                ]}
                rows={staffState.data.items || []}
                emptyTitle="No staff attendance rows"
                emptyMessage="No staff attendance rows match the selected filters."
                rowKey={(row) => `${row.user_id}:${row.date}`}
              />
              <Pagination
                page={staffState.data.page}
                pageSize={staffState.data.page_size}
                total={staffState.data.total}
                onPageChange={(page) => setStaffFilters((current) => ({ ...current, page }))}
              />
            </>
          ) : (
            <EmptyState title="Staff attendance unavailable" message="Institute staff attendance could not be loaded right now." />
          )}
        </Panel>
      ) : null}

      {activeTab === 'hods' ? (
        <Panel
          title="HOD Attendance"
          subtitle="Filter by department and date range, then export or correct HOD attendance."
        >
          <div className="form-grid">
            <label className="field">
              <span>Search</span>
              <input
                className="input"
                value={hodFilters.search}
                onChange={(event) => setHodFilters((current) => ({ ...current, page: 1, search: event.target.value }))}
                placeholder="HOD name or identifier"
              />
            </label>
            <label className="field">
              <span>Department</span>
              <select
                className="input"
                value={hodFilters.department}
                onChange={(event) => setHodFilters((current) => ({ ...current, page: 1, department: event.target.value }))}
              >
                <option value="">All Departments</option>
                {meta.departments.map((department) => (
                  <option key={department} value={department}>{department}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>From Date</span>
              <input
                className="input"
                type="date"
                value={hodFilters.from_date}
                max={hodFilters.to_date}
                onChange={(event) => updateRangeFilters(setHodFilters, 'from_date', event.target.value)}
              />
            </label>
            <label className="field">
              <span>To Date</span>
              <input
                className="input"
                type="date"
                value={hodFilters.to_date}
                min={hodFilters.from_date}
                max={formatInputDate(new Date())}
                onChange={(event) => updateRangeFilters(setHodFilters, 'to_date', event.target.value)}
              />
            </label>
            <div className="field">
              <span>Refresh</span>
              <button
                type="button"
                className="btn-secondary btn-block"
                onClick={() => loadHODAttendance()}
                disabled={hodState.loading || Boolean(savingSessionKey)}
              >
                {hodState.loading ? 'Refreshing...' : 'Refresh Data'}
              </button>
            </div>
            <div className="field">
              <span>Export</span>
              <button
                type="button"
                className="btn-primary btn-block"
                onClick={handleHODExport}
                disabled={hodExporting}
              >
                {hodExporting ? 'Exporting...' : 'Export HOD Attendance'}
              </button>
            </div>
          </div>

          {hodState.error ? <Notice tone="danger" title="HOD Attendance Error">{hodState.error}</Notice> : null}

          {hodState.loading ? (
            <LoadingState label="Loading institute HOD attendance..." />
          ) : hodState.data ? (
            <>
              <Table
                tableClassName="faculty-daily-table"
                columns={[
                  { key: 'name', label: 'HOD Name', className: 'faculty-name-cell' },
                  { key: 'identifier', label: 'Identifier', className: 'faculty-register-cell' },
                  { key: 'department', label: 'Department', render: (row) => row.department || '--' },
                  { key: 'date', label: 'Date', render: (row) => formatDate(row.date) },
                  { key: 'morning_status', label: sessionLabel('morning', 'staff'), render: (row) => <StudentStatusBadge status={row.morning_status} /> },
                  { key: 'afternoon_status', label: sessionLabel('afternoon', 'staff'), render: (row) => <StudentStatusBadge status={row.afternoon_status} /> },
                  { key: 'daily_total', label: 'Total', render: (row) => formatDailyTotal(row.daily_total) },
                  {
                    key: 'actions',
                    label: 'Fix Attendance',
                    cellClassName: 'faculty-actions-cell',
                    render: (row) => renderActionCell(row, 'staff', hodState.data?.session_defaults, loadHODAttendance),
                  },
                ]}
                rows={hodState.data.items || []}
                emptyTitle="No HOD attendance rows"
                emptyMessage="No HOD attendance rows match the selected filters."
                rowKey={(row) => `${row.user_id}:${row.date}`}
              />
              <Pagination
                page={hodState.data.page}
                pageSize={hodState.data.page_size}
                total={hodState.data.total}
                onPageChange={(page) => setHodFilters((current) => ({ ...current, page }))}
              />
            </>
          ) : (
            <EmptyState title="HOD attendance unavailable" message="Institute HOD attendance could not be loaded right now." />
          )}
        </Panel>
      ) : null}

      {activeTab === 'principals' ? (
        <Panel
          title="Principal Attendance"
          subtitle="Filter by department and date range, then export or correct principal attendance."
        >
          <div className="form-grid">
            <label className="field">
              <span>Search</span>
              <input
                className="input"
                value={principalFilters.search}
                onChange={(event) => setPrincipalFilters((current) => ({ ...current, page: 1, search: event.target.value }))}
                placeholder="Principal name or identifier"
              />
            </label>
            <label className="field">
              <span>Department</span>
              <select
                className="input"
                value={principalFilters.department}
                onChange={(event) => setPrincipalFilters((current) => ({ ...current, page: 1, department: event.target.value }))}
              >
                <option value="">All Departments</option>
                {meta.departments.map((department) => (
                  <option key={department} value={department}>{department}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>From Date</span>
              <input
                className="input"
                type="date"
                value={principalFilters.from_date}
                max={principalFilters.to_date}
                onChange={(event) => updateRangeFilters(setPrincipalFilters, 'from_date', event.target.value)}
              />
            </label>
            <label className="field">
              <span>To Date</span>
              <input
                className="input"
                type="date"
                value={principalFilters.to_date}
                min={principalFilters.from_date}
                max={formatInputDate(new Date())}
                onChange={(event) => updateRangeFilters(setPrincipalFilters, 'to_date', event.target.value)}
              />
            </label>
            <div className="field">
              <span>Refresh</span>
              <button
                type="button"
                className="btn-secondary btn-block"
                onClick={() => loadPrincipalAttendance()}
                disabled={principalState.loading || Boolean(savingSessionKey)}
              >
                {principalState.loading ? 'Refreshing...' : 'Refresh Data'}
              </button>
            </div>
            <div className="field">
              <span>Export</span>
              <button
                type="button"
                className="btn-primary btn-block"
                onClick={handlePrincipalExport}
                disabled={principalExporting}
              >
                {principalExporting ? 'Exporting...' : 'Export Principal Attendance'}
              </button>
            </div>
          </div>

          {principalState.error ? <Notice tone="danger" title="Principal Attendance Error">{principalState.error}</Notice> : null}

          {principalState.loading ? (
            <LoadingState label="Loading institute principal attendance..." />
          ) : principalState.data ? (
            <>
              <Table
                tableClassName="faculty-daily-table"
                columns={[
                  { key: 'name', label: 'Principal Name', className: 'faculty-name-cell' },
                  { key: 'identifier', label: 'Identifier', className: 'faculty-register-cell' },
                  { key: 'department', label: 'Department', render: (row) => row.department || '--' },
                  { key: 'date', label: 'Date', render: (row) => formatDate(row.date) },
                  { key: 'morning_status', label: sessionLabel('morning', 'staff'), render: (row) => <StudentStatusBadge status={row.morning_status} /> },
                  { key: 'afternoon_status', label: sessionLabel('afternoon', 'staff'), render: (row) => <StudentStatusBadge status={row.afternoon_status} /> },
                  { key: 'daily_total', label: 'Total', render: (row) => formatDailyTotal(row.daily_total) },
                  {
                    key: 'actions',
                    label: 'Fix Attendance',
                    cellClassName: 'faculty-actions-cell',
                    render: (row) => renderActionCell(row, 'staff', principalState.data?.session_defaults, loadPrincipalAttendance),
                  },
                ]}
                rows={principalState.data.items || []}
                emptyTitle="No principal attendance rows"
                emptyMessage="No principal attendance rows match the selected filters."
                rowKey={(row) => `${row.user_id}:${row.date}`}
              />
              <Pagination
                page={principalState.data.page}
                pageSize={principalState.data.page_size}
                total={principalState.data.total}
                onPageChange={(page) => setPrincipalFilters((current) => ({ ...current, page }))}
              />
            </>
          ) : (
            <EmptyState title="Principal attendance unavailable" message="Institute principal attendance could not be loaded right now." />
          )}
        </Panel>
      ) : null}
    </div>
  );
}

function StaffAttendancePortal({ token, user, notify }) {
  const role = String(user.role).toLowerCase();
  const isAdmin = role === 'admin';
  const isPrincipal = role === 'principal';
  const isStaffAdvisor = role === 'staff' && Boolean(user.is_class_advisor);

  const [filters, setFilters] = useState({
    page: 1,
    page_size: 10,
    search: '',
    attendance_date: '',
    status_filter: '',
    department: '',
    session_name: '',
  });
  const [recordsState, setRecordsState] = useState({ loading: true, data: null, error: '' });
  const [meta, setMeta] = useState({ departments: [], statuses: [], sessions: [] });
  const [overrideForm, setOverrideForm] = useState(defaultOverride);
  const [savingOverride, setSavingOverride] = useState(false);
  const [insightDays, setInsightDays] = useState(30);
  const [overviewState, setOverviewState] = useState({ loading: isAdmin, data: null, error: '' });

  const canOverride = ['hod', 'advisor'].includes(role) || isStaffAdvisor;

  useEffect(() => {
    let ignore = false;
    async function loadMeta() {
      try {
        const response = await metaApi.options(token);
        if (!ignore) {
          setMeta(response);
        }
      } catch {
        // The page still works without metadata; filters simply stay minimal.
      }
    }
    loadMeta();
    return () => {
      ignore = true;
    };
  }, [token]);

  useEffect(() => {
    if (!isAdmin) {
      setOverviewState({ loading: false, data: null, error: '' });
      return undefined;
    }

    let ignore = false;

    async function loadOverview() {
      setOverviewState({ loading: true, data: null, error: '' });

      try {
        const response = await dashboardApi.overview(token, insightDays);
        if (!ignore) {
          setOverviewState({ loading: false, data: response, error: '' });
        }
      } catch (requestError) {
        if (!ignore) {
          setOverviewState({
            loading: false,
            data: null,
            error: getApiErrorMessage(requestError, 'Unable to load analytics insights.'),
          });
        }
      }
    }

    loadOverview();
    return () => {
      ignore = true;
    };
  }, [insightDays, isAdmin, token]);

  useEffect(() => {
    let ignore = false;

    async function loadRecords() {
      setRecordsState((current) => ({ ...current, loading: true, error: '' }));
      try {
        const response = await attendanceApi.list(token, filters);
        if (!ignore) {
          setRecordsState({ loading: false, data: response, error: '' });
        }
      } catch (requestError) {
        if (!ignore) {
          setRecordsState({
            loading: false,
            data: null,
            error: getApiErrorMessage(requestError, 'Unable to load attendance records.'),
          });
        }
      }
    }

    loadRecords();
    return () => {
      ignore = true;
    };
  }, [filters, token]);

  async function handleOverrideSubmit(event) {
    event.preventDefault();
    setSavingOverride(true);
    try {
      const payload = {
        ...overrideForm,
        time: overrideForm.time || null,
      };
      await attendanceApi.manualOverride(token, payload);
      notify('success', 'Attendance updated', 'The attendance record has been saved successfully.');
      setOverrideForm(defaultOverride);
      setFilters((current) => ({ ...current }));
    } catch (requestError) {
      notify('danger', 'Override failed', getApiErrorMessage(requestError, 'Unable to save the manual override.'));
    } finally {
      setSavingOverride(false);
    }
  }

  const headerConfig = {
    admin: {
      title: 'Analytics & Insights',
      subtitle: 'Monitor system-wide attendance analytics, audit activity, and institutional records without operational controls.',
    },
    advisor: {
      title: 'Attendance Management',
      subtitle: 'Manage student-wise attendance records, review activity, and apply controlled manual overrides.',
    },
    staff: isStaffAdvisor
      ? {
          title: 'Class Attendance',
          subtitle: 'Take attendance for your assigned class and correct missed scans when needed.',
        }
      : {
          title: 'Attendance Operations',
          subtitle: 'Review attendance records and take attendance within your assigned class scope.',
        },
    hod: {
      title: 'Department Attendance',
      subtitle: 'Review department-wide attendance records and apply controlled overrides when needed.',
    },
    principal: {
      title: 'Analytics & Insights',
      subtitle: 'Review college-wide attendance visibility in read-only mode for executive oversight.',
    },
    student: {
      title: 'Attendance Records',
      subtitle: 'Review your attendance history and recorded session outcomes.',
    },
  }[role] || {
    title: 'Attendance',
    subtitle: 'Review attendance records for your current role scope.',
  };

  const readonlyConfig = isAdmin
    ? {
        title: 'System Audit Mode',
        subtitle: 'Operational attendance controls are intentionally assigned to Faculty and HOD roles.',
        noticeTitle: 'Admin oversight',
        noticeText: 'This workspace focuses on analytics, auditing, and institutional visibility rather than manual attendance operations.',
      }
    : isPrincipal
      ? {
          title: 'Read-only Access',
          subtitle: 'Principal access is optimized for analytics and executive review.',
          noticeTitle: 'Executive visibility',
          noticeText: 'Principal access is intentionally read-only. Use reports and summaries to review college-wide trends without operational changes.',
        }
      : {
          title: 'Read-only Access',
          subtitle: 'Your role can review attendance records but cannot mutate them.',
          noticeTitle: 'Read-only mode',
          noticeText: 'Attendance visibility is available, but operational changes are restricted for this role.',
        };

  const tableConfig = isAdmin
    ? {
        title: 'Audit Records',
        subtitle: 'System-wide attendance records for monitoring, verification, and institutional auditing.',
      }
    : {
        title: 'Attendance Table',
        subtitle: 'Operational table with pagination, filters, and status visibility.',
      };

  const filtersConfig = isAdmin
    ? {
        title: 'Audit Filters',
        subtitle: 'Refine system-wide attendance records for oversight and verification.',
      }
    : isPrincipal
      ? {
          title: 'Visibility Filters',
          subtitle: 'Refine the read-only attendance record view for executive oversight.',
        }
      : {
          title: 'Filters',
          subtitle: 'Refine the live attendance table.',
        };

  return (
    <div className="page-stack">
      <PageHeader
        title={headerConfig.title}
        subtitle={headerConfig.subtitle}
        action={
          isAdmin ? (
            <div className="chip-group">
              {DAY_OPTIONS.map((option) => (
                <button key={option} type="button" className={`chip ${insightDays === option ? 'active' : ''}`} onClick={() => setInsightDays(option)}>
                  Last {option} days
                </button>
              ))}
            </div>
          ) : null
        }
      />

      {role === 'staff' && user.scope_label ? (
        <Notice tone="info" title="Assigned Scope">
          Attendance access is limited to {user.scope_label}.
        </Notice>
      ) : null}

      {isAdmin && overviewState.error ? <Notice tone="danger" title="Analytics Error">{overviewState.error}</Notice> : null}

      {isAdmin && overviewState.loading ? (
        <LoadingState label="Loading analytics and insights..." />
      ) : null}

      {isAdmin && overviewState.data ? (
        <>
          <StatGrid>
            {overviewState.data.cards.map((card) => (
              <StatCard key={card.label} label={card.label} value={card.value} tone={card.tone} />
            ))}
          </StatGrid>

          <div className="dashboard-grid dashboard-grid-two">
            <Panel title="Attendance Trend" subtitle="Institution-wide attendance movement across the selected range">
              <TrendChart points={overviewState.data.trend || []} />
            </Panel>

            <Panel title="Low Attendance Summary" subtitle="Students currently below the recommended attendance threshold">
              <Table
                columns={[
                  { key: 'name', label: 'Student' },
                  { key: 'identifier', label: 'Identifier' },
                  { key: 'department', label: 'Department' },
                  { key: 'attendance_rate', label: 'Attendance', render: (row) => formatPercent(row.attendance_rate) },
                ]}
                rows={overviewState.data.low_attendance || []}
                emptyTitle="No low-attendance students"
                emptyMessage="No low-attendance students are visible in the current system scope."
                rowKey={(row) => row.user_id}
              />
            </Panel>
          </div>
        </>
      ) : null}

      <div className="dashboard-grid dashboard-grid-two">
        <Panel title={filtersConfig.title} subtitle={filtersConfig.subtitle}>
          <div className="form-grid">
            <label className="field">
              <span>Search</span>
              <input className="input" value={filters.search} onChange={(event) => setFilters((current) => ({ ...current, page: 1, search: event.target.value }))} placeholder="Student or staff name / identifier" />
            </label>
            <label className="field">
              <span>Date</span>
              <input className="input" type="date" value={filters.attendance_date} onChange={(event) => setFilters((current) => ({ ...current, page: 1, attendance_date: event.target.value }))} />
            </label>
            <label className="field">
              <span>Status</span>
              <select className="input" value={filters.status_filter} onChange={(event) => setFilters((current) => ({ ...current, page: 1, status_filter: event.target.value }))}>
                <option value="">All statuses</option>
                {meta.statuses.map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Department</span>
              <select className="input" value={filters.department} onChange={(event) => setFilters((current) => ({ ...current, page: 1, department: event.target.value }))}>
                <option value="">All departments</option>
                {meta.departments.map((department) => (
                  <option key={department} value={department}>{department}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Session</span>
              <select className="input" value={filters.session_name} onChange={(event) => setFilters((current) => ({ ...current, page: 1, session_name: event.target.value }))}>
                <option value="">All sessions</option>
                {meta.sessions.map((session) => (
                  <option key={session} value={session}>{mixedSessionLabel(session)}</option>
                ))}
              </select>
            </label>
          </div>
        </Panel>

        {canOverride ? (
          <Panel title="Manual Override" subtitle="Create or update attendance entries for the selected date and session">
            <form className="form-grid" onSubmit={handleOverrideSubmit}>
              <label className="field">
                <span>User Identifier</span>
                <input className="input" value={overrideForm.identifier} onChange={(event) => setOverrideForm((current) => ({ ...current, identifier: event.target.value }))} placeholder="Register number or institutional identifier" required />
              </label>
              <label className="field">
                <span>Date</span>
                <input className="input" type="date" value={overrideForm.date} onChange={(event) => setOverrideForm((current) => ({ ...current, date: event.target.value }))} required />
              </label>
              <label className="field">
                <span>Session</span>
                <select className="input" value={overrideForm.session} onChange={(event) => setOverrideForm((current) => ({ ...current, session: event.target.value }))}>
                  {meta.sessions.map((session) => (
                    <option key={session} value={session}>{mixedSessionLabel(session)}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Status</span>
                <select className="input" value={overrideForm.status} onChange={(event) => setOverrideForm((current) => ({ ...current, status: event.target.value }))}>
                  {meta.statuses.map((status) => (
                    <option key={status} value={status}>{status}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Time</span>
                <input className="input" type="time" value={overrideForm.time} onChange={(event) => setOverrideForm((current) => ({ ...current, time: event.target.value }))} />
              </label>
              <button type="submit" className="btn-primary" disabled={savingOverride}>
                {savingOverride ? 'Saving...' : 'Save Override'}
              </button>
            </form>
          </Panel>
        ) : (
          <Panel title={readonlyConfig.title} subtitle={readonlyConfig.subtitle}>
            <Notice tone="info" title={readonlyConfig.noticeTitle}>
              {readonlyConfig.noticeText}
            </Notice>
          </Panel>
        )}
      </div>

      <Panel title={tableConfig.title} subtitle={tableConfig.subtitle}>
        {recordsState.error ? <Notice tone="danger" title="Attendance Error">{recordsState.error}</Notice> : null}
        {recordsState.loading && !recordsState.data ? (
          <LoadingState label="Loading attendance records..." />
        ) : recordsState.data ? (
          <>
            <div className={recordsState.loading ? 'loading-fade' : ''}>
              <Table
                columns={[
                  { key: 'user_name', label: 'User' },
                  { key: 'identifier', label: 'Identifier' },
                  { key: 'department', label: 'Department', render: (row) => row.department || 'Not assigned' },
                  { key: 'date', label: 'Date', render: (row) => formatDate(row.date) },
                  { key: 'time', label: 'Time', render: (row) => formatTime(row.time) },
                  { key: 'session', label: 'Session', render: (row) => mixedSessionLabel(row.session) },
                  { key: 'status', label: 'Status', render: (row) => <StatusBadge status={row.status} /> },
                ]}
                rows={recordsState.data.items}
                emptyTitle="No attendance records"
                emptyMessage="No records match the selected filters."
                rowKey={(row) => row.id}
              />
            </div>
            <Pagination
              page={recordsState.data.page}
              pageSize={recordsState.data.page_size}
              total={recordsState.data.total}
              onPageChange={(page) => setFilters((current) => ({ ...current, page }))}
              isLoading={recordsState.loading}
            />
          </>
        ) : (
          <EmptyState title="No attendance data" message="Attendance data is not available right now." />
        )}
      </Panel>
    </div>
  );
}

export function AttendancePage({ token, user, notify }) {
  const role = String(user.role).toLowerCase();
  if (role === 'student') {
    return <StudentAttendancePortal token={token} user={user} />;
  }
  if (role === 'admin') {
    return <AdminInstituteAttendancePortal token={token} notify={notify} />;
  }
  if (role === 'principal') {
    return <PrincipalInstituteInsightsPortal token={token} notify={notify} />;
  }
  if (role === 'hod') {
    return <HODAttendancePortal token={token} user={user} notify={notify} />;
  }
  if (role === 'staff' && user.is_class_advisor) {
    return <ClassAdvisorAttendancePortal token={token} user={user} notify={notify} />;
  }
  return <StaffAttendancePortal token={token} user={user} notify={notify} />;
}

export function MyAttendancePage({ token, user }) {
  return <InstitutionSelfAttendancePortal token={token} user={user} />;
}
