import { useEffect, useState } from 'react';

import { dashboardApi, getApiErrorMessage, usersApi } from '../api';
import { EmptyState, LoadingState, Notice, PageHeader, Pagination, Panel, StatCard, StatGrid, Table } from '../components/Ui';
import { formatDate } from '../utils';

function buildFilenameSlug(value, fallback = 'assigned_scope') {
  const normalizedValue = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalizedValue || fallback;
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

export function ClassAdvisorStudentExportPage({ token, user, notify }) {
  const [summaryState, setSummaryState] = useState({
    loading: true,
    data: null,
    error: '',
  });
  const [studentState, setStudentState] = useState({
    loading: true,
    data: null,
    error: '',
  });
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let ignore = false;

    async function loadSummary() {
      setSummaryState({
        loading: true,
        data: null,
        error: '',
      });

      try {
        const response = await dashboardApi.summary(token);
        if (!ignore) {
          setSummaryState({
            loading: false,
            data: response,
            error: '',
          });
        }
      } catch (requestError) {
        if (!ignore) {
          setSummaryState({
            loading: false,
            data: null,
            error: getApiErrorMessage(requestError, 'Unable to load the assigned class summary right now.'),
          });
        }
      }
    }

    loadSummary();
    return () => {
      ignore = true;
    };
  }, [token]);

  useEffect(() => {
    let ignore = false;

    async function loadStudents() {
      setStudentState((current) => ({
        loading: true,
        data: current.data,
        error: '',
      }));

      try {
        const response = await usersApi.listClassAdvisorStudents(token, {
          page,
          page_size: 10,
        });
        if (!ignore) {
          setStudentState({
            loading: false,
            data: response,
            error: '',
          });
        }
      } catch (requestError) {
        if (!ignore) {
          setStudentState({
            loading: false,
            data: null,
            error: getApiErrorMessage(requestError, 'Unable to load student records right now.'),
          });
        }
      }
    }

    loadStudents();
    return () => {
      ignore = true;
    };
  }, [page, token]);

  async function handleExport() {
    setExporting(true);
    try {
      const blob = await usersApi.exportClassAdvisorStudents(token);
      downloadBlob(
        blob,
        `${buildFilenameSlug(user.scope_label)}_student_data.xlsx`,
      );
      notify('success', 'Export ready', 'Student data export downloaded successfully.');
    } catch (requestError) {
      notify('danger', 'Export failed', getApiErrorMessage(requestError, 'Unable to export student data.'));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="Student Data Export"
        subtitle="Download the complete student master data for your assigned class."
      />

      <Notice tone="info" title="Assigned Scope">
        Student export is limited to {user.scope_label || 'your assigned class scope'}.
      </Notice>

      {summaryState.error ? <Notice tone="danger" title="Export Error">{summaryState.error}</Notice> : null}
      {studentState.error ? <Notice tone="danger" title="Student Records Error">{studentState.error}</Notice> : null}

      {summaryState.loading ? (
        <LoadingState label="Loading class export summary..." />
      ) : summaryState.data ? (
        <>
          <StatGrid>
            <StatCard
              label="Total Students"
              value={summaryState.data.total_students}
              tone="neutral"
              helper="Students included in this class export"
            />
            <StatCard
              label="Present Today"
              value={summaryState.data.present_today}
              tone="good"
              helper="Students marked present in at least one session today"
            />
          </StatGrid>

          <Panel
            title="Export Student Records"
            subtitle="One click downloads the complete student master data for this class."
            action={(
              <button
                type="button"
                className="btn-primary"
                onClick={handleExport}
                disabled={exporting}
              >
                {exporting ? 'Exporting...' : 'Export Excel'}
              </button>
            )}
          >
            <div className="profile-list">
              <div><span>Scope</span><strong>{user.scope_label || 'Assigned Scope'}</strong></div>
              <div><span>Total Students</span><strong>{summaryState.data.total_students}</strong></div>
              <div><span>Included Fields</span><strong>Name, register number, department, year, semester, DOB, blood group, phone, parent phone, address</strong></div>
            </div>
          </Panel>

          <Panel
            title="Student Records Preview"
            subtitle="Preview the student master data that will be included in the Excel export."
          >
            {studentState.loading && !studentState.data ? (
              <LoadingState label="Loading student records..." />
            ) : studentState.data ? (
              <>
                <div className={studentState.loading ? 'loading-fade' : ''}>
                  <Table
                    columns={[
                      { key: 'name', label: 'Student Name' },
                      { key: 'identifier', label: 'Register Number' },
                      { key: 'department', label: 'Department', render: (row) => row.department || '--' },
                      { key: 'year', label: 'Year', render: (row) => row.year || '--' },
                      { key: 'semester', label: 'Semester', render: (row) => row.semester || '--' },
                      { key: 'dob', label: 'DOB', render: (row) => row.dob ? formatDate(row.dob) : '--' },
                      { key: 'blood_group', label: 'Blood Group', render: (row) => row.blood_group || '--' },
                      { key: 'phone_number', label: 'Phone', render: (row) => row.phone_number || '--' },
                      { key: 'parent_phone_number', label: 'Parent Phone', render: (row) => row.parent_phone_number || '--' },
                      { key: 'address', label: 'Address', render: (row) => row.address || '--' },
                    ]}
                    rows={studentState.data.items || []}
                    emptyTitle="No students available"
                    emptyMessage="No student records were found for this assigned class."
                    rowKey={(row) => row.id}
                  />
                </div>
                <Pagination
                  page={studentState.data.page}
                  pageSize={studentState.data.page_size}
                  total={studentState.data.total}
                  onPageChange={setPage}
                  isLoading={studentState.loading}
                />
              </>
            ) : (
              <EmptyState title="Preview unavailable" message="Student record preview is not available right now." />
            )}
          </Panel>
        </>
      ) : (
        <EmptyState title="Export unavailable" message="The assigned class summary could not be loaded." />
      )}
    </div>
  );
}
