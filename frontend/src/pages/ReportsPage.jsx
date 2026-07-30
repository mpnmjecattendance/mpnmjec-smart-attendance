import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';

import { attendanceApi, dashboardApi, getApiErrorMessage } from '../api';
import { ComparisonBars, EmptyState, LoadingState, Notice, PageHeader, Panel, Table, TrendChart } from '../components/Ui';
import { formatDate, formatPercent, formatTime } from '../utils';

const DAY_OPTIONS = [30, 60, 90];

function ReportsContent({ token, role }) {
  const [days, setDays] = useState(30);
  const [overviewState, setOverviewState] = useState({ loading: true, data: null, error: '' });
  const [recordsState, setRecordsState] = useState({ loading: true, data: null, error: '' });
  const isStudent = role === 'student';

  const roleConfig = {
    advisor: {
      title: 'Basic Reports',
      subtitle: 'Student-wise attendance reporting and practical visibility for daily academic operations.',
      trendTitle: 'Attendance Trend',
      comparisonTitle: 'Basic Insight Snapshot',
      comparisonSubtitle: 'Current class-level comparison set',
      riskTitle: 'Low Attendance Summary',
      riskSubtitle: 'Students currently below threshold',
      activityTitle: 'Recent Report Records',
    },
    hod: {
      title: 'Comparative Reports',
      subtitle: 'Department-wide reporting, comparative attendance visibility, and insight-driven review.',
      trendTitle: 'Department Trend',
      comparisonTitle: 'Comparative View',
      comparisonSubtitle: 'Department comparison and attendance distribution',
      riskTitle: 'Department Risk Snapshot',
      riskSubtitle: 'Students currently below threshold in your visible department scope',
      activityTitle: 'Department Report Records',
    },
    principal: {
      title: 'Executive Reports',
      subtitle: 'High-level college reporting with institutional trends, summaries, and executive visibility.',
      trendTitle: 'College Trend',
      comparisonTitle: 'Executive Summary',
      comparisonSubtitle: 'Institution-level reporting snapshot',
      riskTitle: 'College Risk Snapshot',
      riskSubtitle: 'Students currently below threshold across the visible college scope',
      activityTitle: 'Executive Report Records',
    },
    student: {
      title: 'Attendance Reports',
      subtitle: 'Your personal attendance summaries, history, and recent attendance records.',
    },
  }[role] || {
    title: 'Reports & Analytics',
    subtitle: 'Attendance insights and filtered operational reporting for your current role scope.',
  };

  useEffect(() => {
    let ignore = false;

    async function loadReports() {
      setOverviewState({ loading: true, data: null, error: '' });
      setRecordsState({ loading: true, data: null, error: '' });

      try {
        const [overview, records] = await Promise.all([
          isStudent ? dashboardApi.studentSelf(token, days) : dashboardApi.overview(token, days),
          attendanceApi.list(token, { page: 1, page_size: 8 }),
        ]);

        if (!ignore) {
          setOverviewState({ loading: false, data: overview, error: '' });
          setRecordsState({ loading: false, data: records, error: '' });
        }
      } catch (requestError) {
        if (!ignore) {
          const message = getApiErrorMessage(requestError, 'Unable to load reporting data.');
          setOverviewState({ loading: false, data: null, error: message });
          setRecordsState({ loading: false, data: null, error: message });
        }
      }
    }

    loadReports();
    return () => {
      ignore = true;
    };
  }, [days, isStudent, token]);

  return (
    <div className="page-stack">
      <PageHeader
        title={roleConfig.title}
        subtitle={roleConfig.subtitle}
        action={(
          <div className="chip-group">
            {DAY_OPTIONS.map((option) => (
              <button key={option} type="button" className={`chip ${days === option ? 'active' : ''}`} onClick={() => setDays(option)}>
                Last {option} days
              </button>
            ))}
          </div>
        )}
      />

      {overviewState.error ? <Notice tone="danger" title="Report Error">{overviewState.error}</Notice> : null}

      {overviewState.loading ? (
        <LoadingState label="Loading report analytics..." />
      ) : overviewState.data ? (
        isStudent ? (
          <div className="dashboard-grid dashboard-grid-two">
            <Panel title="Student Attendance Summary" subtitle="Generated from recent working-day attendance history">
              <div className="profile-list">
                <div><span>Name</span><strong>{overviewState.data.user.name}</strong></div>
                <div><span>Register Number</span><strong>{overviewState.data.user.identifier}</strong></div>
                <div><span>Parent Phone</span><strong>{overviewState.data.user.parent_phone_number || 'Not provided'}</strong></div>
                <div><span>Attendance Rate</span><strong>{formatPercent(overviewState.data.attendance_rate)}</strong></div>
                <div><span>Present Days</span><strong>{overviewState.data.present_days}</strong></div>
                <div><span>Absent Days</span><strong>{overviewState.data.absent_days}</strong></div>
                <div><span>Current Streak</span><strong>{overviewState.data.current_streak} days</strong></div>
              </div>
            </Panel>

            <Panel title="Attendance Records" subtitle="Your latest attendance records from the secured backend">
              {recordsState.loading ? (
                <LoadingState label="Loading attendance records..." />
              ) : recordsState.data ? (
                <Table
                  columns={[
                    { key: 'date', label: 'Date', render: (row) => formatDate(row.date) },
                    { key: 'time', label: 'Time', render: (row) => formatTime(row.time) },
                    { key: 'session', label: 'Session' },
                    { key: 'status', label: 'Status' },
                  ]}
                  rows={recordsState.data.items}
                  emptyTitle="No attendance records"
                  emptyMessage="Attendance records will appear here once you are marked for sessions."
                  rowKey={(row) => row.id}
                />
              ) : (
                <EmptyState title="No records" message="Your attendance records are currently unavailable." />
              )}
            </Panel>
          </div>
        ) : (
          <>
          <div className="dashboard-grid dashboard-grid-two">
            <Panel title={roleConfig.trendTitle || 'Attendance Trend'} subtitle="Working-day attendance movement across the selected range">
              <TrendChart points={overviewState.data.trend} />
            </Panel>
            <Panel title={roleConfig.comparisonTitle || 'Comparison View'} subtitle={overviewState.data.breakdowns?.[0]?.subtitle || roleConfig.comparisonSubtitle || 'Current comparison set'}>
              <ComparisonBars items={overviewState.data.breakdowns?.[0]?.items || []} />
            </Panel>
          </div>

          <div className="dashboard-grid dashboard-grid-two">
            <Panel title={roleConfig.riskTitle || 'Low Attendance Summary'} subtitle={roleConfig.riskSubtitle || 'Students currently below threshold'}>
              <Table
                columns={[
                  { key: 'name', label: 'Student' },
                  { key: 'identifier', label: 'Identifier' },
                  { key: 'department', label: 'Department' },
                  { key: 'attendance_rate', label: 'Attendance', render: (row) => formatPercent(row.attendance_rate) },
                ]}
                rows={overviewState.data.low_attendance || []}
                emptyTitle="No students below threshold"
                emptyMessage="No low-attendance students are currently visible in this scope."
                rowKey={(row) => row.user_id}
              />
            </Panel>

            <Panel title={roleConfig.activityTitle || 'Recent Report Records'} subtitle={`Latest attendance activity visible to the ${role} role`}>
              {recordsState.loading ? (
                <LoadingState label="Loading recent report records..." />
              ) : recordsState.data ? (
                <Table
                  columns={[
                    { key: 'user_name', label: 'Student' },
                    { key: 'department', label: 'Department' },
                    { key: 'date', label: 'Date', render: (row) => formatDate(row.date) },
                    { key: 'time', label: 'Time', render: (row) => formatTime(row.time) },
                    { key: 'status', label: 'Status' },
                  ]}
                  rows={recordsState.data.items}
                  emptyTitle="No report rows"
                  emptyMessage="Attendance report rows will appear once records are available."
                  rowKey={(row) => row.id}
                />
              ) : (
                <EmptyState title="No report rows" message="No attendance records are available in the report view." />
              )}
            </Panel>
          </div>
          </>
        )
      ) : (
        <EmptyState title="Reports unavailable" message="Reporting data is not available right now." />
      )}
    </div>
  );
}

export function ReportsPage({ token, user }) {
  const role = String(user.role).toLowerCase();
  if (role === 'admin') {
    return <Navigate to="/dashboard/attendance" replace />;
  }
  return <ReportsContent token={token} role={role} />;
}
