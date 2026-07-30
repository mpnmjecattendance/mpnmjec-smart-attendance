import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { attendanceApi, dashboardApi, getApiErrorMessage } from '../api';
import { EmptyState, LoadingState, Notice, PageHeader, Panel, ProgressBar, StatCard, StatGrid, StatusBadge, Table } from '../components/Ui';
import { formatPercent, roleLabel, studentSessionLabel } from '../utils';

const DAY_OPTIONS = [30, 60, 90];

function formatInputDate(dateValue) {
  const year = dateValue.getFullYear();
  const month = String(dateValue.getMonth() + 1).padStart(2, '0');
  const day = String(dateValue.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function clampInputDate(dateValue, minDate, maxDate) {
  let nextValue = dateValue;
  if (minDate && nextValue < minDate) {
    nextValue = minDate;
  }
  if (maxDate && nextValue > maxDate) {
    nextValue = maxDate;
  }
  return nextValue;
}

function shiftInputDate(dateValue, offsetDays) {
  const parsedDate = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(parsedDate.getTime())) {
    return dateValue;
  }

  parsedDate.setDate(parsedDate.getDate() + offsetDays);
  return formatInputDate(parsedDate);
}

function startOfMonthInputDate(dateValue) {
  const parsedDate = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(parsedDate.getTime())) {
    return dateValue;
  }

  parsedDate.setDate(1);
  return formatInputDate(parsedDate);
}

function buildExportPresetRange(presetKey, selectedDate, historyStart) {
  if (presetKey === 'last_7_days') {
    return {
      from_date: clampInputDate(shiftInputDate(selectedDate, -6), historyStart, selectedDate),
      to_date: selectedDate,
    };
  }

  if (presetKey === 'this_month') {
    return {
      from_date: clampInputDate(startOfMonthInputDate(selectedDate), historyStart, selectedDate),
      to_date: selectedDate,
    };
  }

  return { from_date: selectedDate, to_date: selectedDate };
}

function formatDisplayDate(dateValue) {
  const parsedDate = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(parsedDate.getTime())) {
    return dateValue || '--';
  }

  return parsedDate.toLocaleDateString([], {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function countInclusiveDays(fromDate, toDate) {
  const startDate = new Date(`${fromDate}T00:00:00`);
  const endDate = new Date(`${toDate}T00:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || startDate > endDate) {
    return 0;
  }

  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((endDate - startDate) / millisecondsPerDay) + 1;
}

function toneForAttendanceRate(attendanceRate) {
  if (attendanceRate >= 75) {
    return 'good';
  }
  if (attendanceRate >= 60) {
    return 'warning';
  }
  return 'danger';
}

function feedbackToneForAttendanceRate(attendanceRate) {
  if (attendanceRate >= 75) {
    return 'success';
  }
  if (attendanceRate >= 60) {
    return 'warning';
  }
  return 'danger';
}

function formatDayCount(value) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(1);
}

function getDayOutcome(overview) {
  const dailyTotal = Number(overview.today_daily_total || 0);
  const morningStatus = String(overview.today_morning_status || '').toLowerCase();
  const afternoonStatus = String(overview.today_afternoon_status || '').toLowerCase();
  if (morningStatus === 'no_session' && afternoonStatus === 'no_session') {
    return 'No Session';
  }
  if (morningStatus === 'pending' || afternoonStatus === 'pending') {
    return 'Not Marked';
  }
  if (dailyTotal >= 1) {
    return 'Full Present';
  }
  if (dailyTotal >= 0.5) {
    return 'Half Day';
  }
  return 'Absent';
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

function isPresentishStatus(status) {
  const normalized = String(status || '').toLowerCase();
  return normalized === 'present' || normalized === 'late';
}

function resolveSessionActionTime(sessionName, sessionDefaults) {
  const fallback = sessionName === 'morning' ? '08:30:00' : '13:30:00';
  return String(sessionDefaults?.[sessionName] || fallback).slice(0, 8);
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

function DashboardToolbar({ days, setDays }) {
  return (
    <div className="toolbar-inline">
      <span className="toolbar-label">Time Range</span>
      <div className="chip-group">
        {DAY_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            className={`chip ${days === option ? 'active' : ''}`}
            onClick={() => setDays(option)}
          >
            Last {option} days
          </button>
        ))}
      </div>
    </div>
  );
}

function MyAttendanceShortcut() {
  return (
    <Notice tone="info" title="Personal Attendance">
      Open your personal attendance page at{' '}
      <Link to="/dashboard/my-attendance">
        My Attendance
      </Link>
      {' '}to review your own morning and afternoon records separately from role-based attendance operations.
    </Notice>
  );
}

function StudentDashboard({ overview }) {
  const attendanceRate = Number(overview.attendance_rate || 0);
  const dayOutcome = getDayOutcome(overview);
  const summaryCards = [
    {
      label: 'Total Days Present',
      value: formatDayCount(overview.present_days),
      tone: overview.present_days ? 'good' : 'neutral',
      helper: `${overview.attended_sessions || 0} sessions marked present or late`,
    },
    {
      label: 'Total Days Absent',
      value: formatDayCount(overview.absent_days),
      tone: overview.absent_days ? 'danger' : 'neutral',
      helper: `${overview.absent_sessions || 0} sessions missed`,
    },
    {
      label: 'Attendance Percentage',
      value: `${attendanceRate.toFixed(1)}%`,
      tone: toneForAttendanceRate(attendanceRate),
      helper: `${overview.total_sessions || 0} total sessions counted`,
    },
  ];

  return (
    <>
      <Panel title="Student Details" subtitle="Personal and academic information">
        <div className="profile-list">
          <div><span>Full Name</span><strong>{overview.user?.name || '--'}</strong></div>
          <div><span>Register Number</span><strong>{overview.user?.identifier || '--'}</strong></div>
          <div><span>Department</span><strong>{overview.user?.department || 'Not assigned'}</strong></div>
          <div><span>Year</span><strong>{overview.user?.year || '--'}</strong></div>
          <div><span>Semester</span><strong>{overview.user?.semester || '--'}</strong></div>
        </div>
      </Panel>

      <Panel title="Today Status" subtitle="Current attendance state for both sessions">
        <div className="profile-list">
          <div><span>Morning</span><strong>{studentSessionLabel(overview.today_morning_status)}</strong></div>
          <div><span>Afternoon</span><strong>{studentSessionLabel(overview.today_afternoon_status)}</strong></div>
          <div><span>Daily Result</span><strong>{dayOutcome}</strong></div>
        </div>
      </Panel>

      <StatGrid>
        {summaryCards.map((card) => (
          <StatCard
            key={card.label}
            label={card.label}
            value={card.value}
            tone={card.tone}
            helper={card.helper}
          />
        ))}
      </StatGrid>

      {attendanceRate < 75 ? (
        <Notice tone="warning" title="Attendance Alert">
          Attendance below required level
        </Notice>
      ) : null}
    </>
  );
}

function ManagerDashboard({ overview }) {
  const breakdowns = overview.breakdowns || [];

  return (
    <>
      <StatGrid>
        {overview.cards.map((card) => (
          <StatCard key={card.label} label={card.label} value={card.value} tone={card.tone} />
        ))}
      </StatGrid>

      {breakdowns.length > 0 ? (
        <div className="dashboard-grid dashboard-grid-two">
          {breakdowns.map((section) => (
            <Panel key={section.title} title={section.title} subtitle={section.subtitle}>
              <Table
                columns={[
                  { key: 'label', label: 'Label' },
                  { key: 'value', label: 'Value', render: (row) => formatPercent(row.value) },
                  { key: 'meta', label: 'Context' },
                ]}
                rows={section.items || []}
                emptyTitle="No comparison data"
                emptyMessage="No analytics available yet."
                rowKey={(row) => row.label}
              />
            </Panel>
          ))}
        </div>
      ) : null}
    </>
  );
}

function PrincipalDashboard({ token }) {
  const [days, setDays] = useState(30);
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let ignore = false;

    async function loadPrincipalDashboard() {
      setLoading(true);
      setError('');

      try {
        const response = await dashboardApi.principalDashboard(token, days);
        if (!ignore) {
          setOverview(response);
        }
      } catch (requestError) {
        if (!ignore) {
          setError(getApiErrorMessage(requestError, 'Unable to load the principal dashboard right now.'));
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }

    loadPrincipalDashboard();
    return () => {
      ignore = true;
    };
  }, [days, token]);

  return (
    <div className="page-stack">
      <PageHeader
        title="Principal Dashboard"
        subtitle="Institute-wide attendance summary and department health overview."
        action={<DashboardToolbar days={days} setDays={setDays} />}
      />

      {error ? <Notice tone="danger" title="Dashboard Error">{error}</Notice> : null}
      <MyAttendanceShortcut />

      {loading ? (
        <LoadingState label="Loading principal dashboard..." />
      ) : overview ? (
        <>
          <Notice tone={feedbackToneForAttendanceRate(overview.institute_attendance_rate)} title="Attendance Window">
            Institute attendance is {formatPercent(overview.institute_attendance_rate)} for the last {days} days. Open{' '}
            <Link to="/dashboard/attendance">
              Institute Insights
            </Link>
            {' '}for HOD attendance trigger, staff monitoring, and student export.
          </Notice>

          <StatGrid>
            {(overview.summary_cards || []).map((card) => (
              <StatCard
                key={card.label}
                label={card.label}
                value={card.value}
                tone={card.tone}
                helper={card.helper}
              />
            ))}
          </StatGrid>
        </>
      ) : (
        <EmptyState title="Dashboard unavailable" message="No principal dashboard payload was returned from the server." />
      )}
    </div>
  );
}

function FacultyDashboard({ token, user, notify }) {
  const isStaffAdvisor = String(user.role).toLowerCase() === 'staff';
  const dashboardTitle = isStaffAdvisor
    ? 'Class Advisor Dashboard'
    : 'Faculty Dashboard';
  const dashboardSubtitle = isStaffAdvisor
    ? 'Review your assigned class summary and use the sidebar to open Attendance Management or Student Data Export.'
    : 'See class status, fix missed scans quickly, and export attendance without leaving the page.';
  const todayString = formatInputDate(new Date());
  const [selectedDate, setSelectedDate] = useState(todayString);
  const [exportRange, setExportRange] = useState({ from_date: todayString, to_date: todayString });
  const [savingSessionKey, setSavingSessionKey] = useState('');
  const [exporting, setExporting] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [facultyState, setFacultyState] = useState({
    loading: true,
    data: null,
    error: '',
  });

  useEffect(() => {
    let ignore = false;

    async function loadFacultyDashboard() {
      setFacultyState((current) => ({
        loading: true,
        data: current.data,
        error: '',
      }));

      try {
        const response = await dashboardApi.facultyDashboard(token, { selected_date: selectedDate });
        if (!ignore) {
          setFacultyState({
            loading: false,
            data: response,
            error: '',
          });
          if (response.selected_date && response.selected_date !== selectedDate) {
            setSelectedDate(response.selected_date);
          }
        }
      } catch (requestError) {
        if (!ignore) {
          setFacultyState({
            loading: false,
            data: null,
            error: getApiErrorMessage(requestError, 'Unable to load the faculty dashboard right now.'),
          });
        }
      }
    }

    loadFacultyDashboard();
    return () => {
      ignore = true;
    };
  }, [refreshNonce, selectedDate, token]);

  const overview = facultyState.data;
  const historyStart = overview?.history_start || todayString;
  const dailyRows = overview?.daily_attendance || [];
  const exportPresets = [
    { key: 'selected_day', label: 'Selected Day' },
    { key: 'last_7_days', label: 'Last 7 Days' },
    { key: 'this_month', label: 'This Month' },
  ].map((preset) => ({
    ...preset,
    range: buildExportPresetRange(preset.key, selectedDate, historyStart),
  }));
  const exportRangeDayCount = countInclusiveDays(exportRange.from_date, exportRange.to_date);

  async function handleAttendanceUpdate(row, sessionName, nextStatus) {
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
        `${row.name} was marked ${nextStatus} for the ${sessionName} session.`,
      );
      setRefreshNonce((current) => current + 1);
    } catch (requestError) {
      notify('danger', 'Update failed', getApiErrorMessage(requestError, 'Unable to update attendance.'));
    } finally {
      setSavingSessionKey('');
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      const blob = await dashboardApi.exportFacultyAttendance(token, exportRange);
      downloadBlob(
        blob,
        `${String(user.department || 'faculty').replace(/\s+/g, '_').toLowerCase()}_attendance_${exportRange.from_date}_to_${exportRange.to_date}.xlsx`,
      );
    } catch (requestError) {
      notify('danger', 'Export failed', getApiErrorMessage(requestError, 'Unable to export attendance data.'));
    } finally {
      setExporting(false);
    }
  }

  function handleExportRangeChange(field, value) {
    setExportRange((current) => {
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

  return (
    <div className="page-stack">
      <PageHeader
        title={dashboardTitle}
        subtitle={dashboardSubtitle}
        action={(
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setRefreshNonce((current) => current + 1)}
            disabled={facultyState.loading || exporting || Boolean(savingSessionKey)}
          >
            {facultyState.loading ? 'Refreshing...' : 'Refresh'}
          </button>
        )}
      />

      {facultyState.error ? <Notice tone="danger" title="Dashboard Error">{facultyState.error}</Notice> : null}
      <MyAttendanceShortcut />

      {facultyState.loading && !overview ? (
        <LoadingState label="Loading faculty dashboard..." />
      ) : overview ? (
        <>
          {overview.scope_warning ? (
            <Notice tone="warning" title="Advisor Scope Check">
              {overview.scope_warning}
            </Notice>
          ) : null}

          <StatGrid>
            <StatCard
              label="Total Students"
              value={overview.total_students}
              tone="neutral"
              helper={`${overview.scope_label} student list`}
            />
            <StatCard
              label="Today Present Count"
              value={overview.today_present_count}
              tone="good"
              helper="Students marked in at least one session today"
            />
            <StatCard
              label="Today Absent Count"
              value={overview.today_absent_count}
              tone={overview.today_absent_count ? 'warning' : 'neutral'}
              helper="Includes students still not marked today"
            />
            <StatCard
              label="Attendance Percentage"
              value={`${Number(overview.attendance_rate || 0).toFixed(1)}%`}
              tone={toneForAttendanceRate(overview.attendance_rate)}
              helper="Overall class average"
            />
          </StatGrid>

          {!isStaffAdvisor ? (
            <Panel title="Daily Attendance" subtitle="Daily attendance view with quick manual correction and export">
              <div className="faculty-attendance-toolbar">
                <div className="faculty-toolbar-card faculty-day-card">
                  <div className="faculty-toolbar-heading">
                    <strong>Selected Day</strong>
                    <p>Review one class day at a time and make quick attendance corrections here.</p>
                  </div>
                  <label className="field">
                    <span>Attendance Date</span>
                    <input
                      className="input"
                      type="date"
                      value={selectedDate}
                      min={historyStart}
                      max={todayString}
                      onChange={(event) => setSelectedDate(event.target.value)}
                    />
                  </label>
                  <p className="faculty-toolbar-note">
                    Showing attendance for <strong>{formatDisplayDate(selectedDate)}</strong>.
                  </p>
                </div>

                <div className="faculty-toolbar-card faculty-export-card">
                  <div className="faculty-toolbar-heading">
                    <strong>Export Range</strong>
                    <p>Choose a date window for Excel export without changing the on-screen daily view.</p>
                  </div>
                  <div className="faculty-range-presets">
                    {exportPresets.map((preset) => {
                      const isActive = (
                        exportRange.from_date === preset.range.from_date
                        && exportRange.to_date === preset.range.to_date
                      );
                      return (
                        <button
                          key={preset.key}
                          type="button"
                          className={`chip ${isActive ? 'active' : ''}`}
                          onClick={() => setExportRange(preset.range)}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="faculty-export-grid">
                    <label className="field">
                      <span>From Date</span>
                      <input
                        className="input"
                        type="date"
                        value={exportRange.from_date}
                        min={historyStart}
                        max={exportRange.to_date}
                        onChange={(event) => handleExportRangeChange('from_date', event.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>To Date</span>
                      <input
                        className="input"
                        type="date"
                        value={exportRange.to_date}
                        min={exportRange.from_date}
                        max={todayString}
                        onChange={(event) => handleExportRangeChange('to_date', event.target.value)}
                      />
                    </label>
                    <div className="field">
                      <span>Export</span>
                      <button type="button" className="btn-primary btn-block" onClick={handleExport} disabled={exporting}>
                        {exporting ? 'Exporting...' : 'Export Excel'}
                      </button>
                    </div>
                  </div>
                  <p className="faculty-toolbar-note">
                    {exportRangeDayCount === 1 ? '1 day selected' : `${exportRangeDayCount} days selected`} from{' '}
                    <strong>{formatDisplayDate(exportRange.from_date)}</strong> to{' '}
                    <strong>{formatDisplayDate(exportRange.to_date)}</strong>.
                  </p>
                </div>
              </div>

              {!overview.selected_date_is_working_day ? (
                <Notice tone="warning" title="Selected date has no scheduled attendance">
                  The selected date is outside the student working-day schedule, marked as a holiday, or flagged as not conducted, so quick attendance actions are disabled.
                </Notice>
              ) : null}

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
                  { key: 'morning_status', label: 'Morning Status', render: (row) => <StatusBadge status={row.morning_status} /> },
                  { key: 'afternoon_status', label: 'Afternoon Status', render: (row) => <StatusBadge status={row.afternoon_status} /> },
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
                              disabled={!overview.selected_date_is_working_day || savingSessionKey === `${row.user_id}:morning`}
                            >
                              Present
                            </button>
                            <button
                              type="button"
                              className={`quick-action-btn ${String(row.morning_status).toLowerCase() === 'absent' ? 'active danger' : ''}`}
                              onClick={() => handleAttendanceUpdate(row, 'morning', 'absent')}
                              disabled={!overview.selected_date_is_working_day || savingSessionKey === `${row.user_id}:morning`}
                            >
                              Absent
                            </button>
                          </div>
                        </div>
                        <div className="faculty-action-row">
                          <span className="faculty-action-label">Afternoon</span>
                          <div className="faculty-quick-actions">
                            <button
                              type="button"
                              className={`quick-action-btn ${isPresentishStatus(row.afternoon_status) ? 'active success' : ''}`}
                              onClick={() => handleAttendanceUpdate(row, 'afternoon', 'present')}
                              disabled={!overview.selected_date_is_working_day || savingSessionKey === `${row.user_id}:afternoon`}
                            >
                              Present
                            </button>
                            <button
                              type="button"
                              className={`quick-action-btn ${String(row.afternoon_status).toLowerCase() === 'absent' ? 'active danger' : ''}`}
                              onClick={() => handleAttendanceUpdate(row, 'afternoon', 'absent')}
                              disabled={!overview.selected_date_is_working_day || savingSessionKey === `${row.user_id}:afternoon`}
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
            </Panel>
          ) : null}
        </>
      ) : (
        <EmptyState title="Dashboard unavailable" message="No dashboard payload was returned from the server." />
      )}
    </div>
  );
}

export function DashboardPage({ token, user, notify }) {
  const role = String(user.role).toLowerCase();
  const isStudent = role === 'student';
  const isPrincipal = role === 'principal';
  const isStaffAdvisor = role === 'staff' && Boolean(user.is_class_advisor);
  const isFaculty = role === 'advisor' || role === 'hod' || isStaffAdvisor;
  const [days, setDays] = useState(30);
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isFaculty || isPrincipal) {
      setLoading(false);
      setOverview(null);
      setError('');
      return undefined;
    }

    let ignore = false;

    async function loadDashboard() {
      setLoading(true);
      setError('');

      try {
        const response = isStudent
          ? await dashboardApi.studentSelf(token)
          : await dashboardApi.overview(token, days);
        if (!ignore) {
          setOverview(response);
        }
      } catch (requestError) {
        if (!ignore) {
          setError(getApiErrorMessage(requestError, 'Unable to load the dashboard right now.'));
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }

    loadDashboard();
    return () => {
      ignore = true;
    };
  }, [days, isFaculty, isPrincipal, isStudent, token]);

  if (isStudent) {
    return (
      <div className="page-stack">
        <PageHeader
          title={`${roleLabel(user.role)} Dashboard`}
          subtitle="Your overall attendance percentage and today session status."
        />
        {error ? <Notice tone="danger" title="Dashboard Error">{error}</Notice> : null}
        {loading ? (
          <LoadingState label="Loading dashboard analytics..." />
        ) : overview ? (
          <StudentDashboard overview={overview} />
        ) : (
          <EmptyState title="Dashboard unavailable" message="No dashboard payload was returned from the server." />
        )}
      </div>
    );
  }

  if (isFaculty) {
    return <FacultyDashboard token={token} user={user} notify={notify} />;
  }

  if (isPrincipal) {
    return <PrincipalDashboard token={token} />;
  }

  return (
    <div className="page-stack">
      <PageHeader
        title={`${roleLabel(user.role)} Dashboard`}
        subtitle={role === 'admin'
          ? 'Institution setup, enrollment, and administrative account visibility.'
          : 'Live analytics and attendance operations tailored to your role.'}
        action={role === 'admin' ? null : <DashboardToolbar days={days} setDays={setDays} />}
      />

      {role === 'staff' && user.is_class_advisor && user.scope_label ? (
        <Notice tone="info" title="Assigned Scope">
          Your dashboard and attendance tools are limited to {user.scope_label}.
        </Notice>
      ) : null}

      {role === 'staff' && !user.is_class_advisor ? (
        <Notice tone="info" title="Personal Staff Access">
          This staff account includes a personal dashboard and My Attendance view only.
        </Notice>
      ) : null}

      {role !== 'student' && role !== 'admin' ? <MyAttendanceShortcut /> : null}

      {role === 'principal' ? (
        <Notice tone="info" title="Institute Insights Access">
          Use Institute Insights to review institute-wide attendance, trigger HOD attendance when needed, and keep staff and student views read-only.
        </Notice>
      ) : null}

      {error ? <Notice tone="danger" title="Dashboard Error">{error}</Notice> : null}

      {loading ? (
        <LoadingState label="Loading dashboard analytics..." />
      ) : overview ? (
        <ManagerDashboard overview={overview} />
      ) : (
        <EmptyState title="Dashboard unavailable" message="No dashboard payload was returned from the server." />
      )}
    </div>
  );
}
