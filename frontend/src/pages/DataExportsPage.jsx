import { useEffect, useState } from 'react';

import { getApiErrorMessage, metaApi, usersApi } from '../api';
import { EmptyState, LoadingState, Notice, PageHeader, Pagination, Panel, StatCard, StatGrid, Table } from '../components/Ui';
import { formatDate } from '../utils';

const DEFAULT_FILTERS = {
  page: 1,
  page_size: 10,
  search: '',
  department: '',
};

const TAB_CONFIGS = {
  students: {
    title: 'Student Data Export',
    role: 'student',
    exportLabel: 'Export Students',
    searchPlaceholder: 'Student name or register number',
    includedFields: 'Name, register number, department, year, semester, DOB, blood group, phone, parent phone, address',
  },
  staff: {
    title: 'Staff Data Export',
    role: 'staff',
    exportLabel: 'Export Staff',
    searchPlaceholder: 'Staff name or identifier',
    includedFields: 'Name, identifier, department, phone, blood group, address, class advisor access, scope, assignments',
  },
  hods: {
    title: 'HOD Data Export',
    role: 'hod',
    exportLabel: 'Export HODs',
    searchPlaceholder: 'HOD name or identifier',
    includedFields: 'Name, identifier, department, phone, blood group, address, scope',
  },
  principals: {
    title: 'Principal Data Export',
    role: 'principal',
    exportLabel: 'Export Principals',
    searchPlaceholder: 'Principal name or identifier',
    includedFields: 'Name, identifier, department, phone, blood group, address, scope',
  },
};

function buildFilenameSlug(value, fallback = 'institute') {
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

function getInitialFilters() {
  return {
    students: {
      ...DEFAULT_FILTERS,
      year: '',
      semester: '',
    },
    staff: { ...DEFAULT_FILTERS },
    hods: { ...DEFAULT_FILTERS },
    principals: { ...DEFAULT_FILTERS },
  };
}

function buildPreviewParams(tab, filters) {
  const config = TAB_CONFIGS[tab];
  return {
    page: filters.page,
    page_size: filters.page_size,
    search: filters.search,
    department: filters.department,
    role: config.role,
    year: tab === 'students' && filters.year ? Number(filters.year) : undefined,
    semester: tab === 'students' && filters.semester ? Number(filters.semester) : undefined,
  };
}

function buildExportParams(tab, filters) {
  return {
    search: filters.search,
    department: filters.department,
    year: tab === 'students' && filters.year ? Number(filters.year) : undefined,
    semester: tab === 'students' && filters.semester ? Number(filters.semester) : undefined,
  };
}

function buildExportFilename(tab, filters) {
  const filenameParts = [
    buildFilenameSlug(filters.department, 'institute'),
    TAB_CONFIGS[tab].role,
    'data',
  ];
  if (tab === 'students' && filters.year) {
    filenameParts.push(`year_${filters.year}`);
  }
  if (tab === 'students' && filters.semester) {
    filenameParts.push(`semester_${filters.semester}`);
  }
  return `${filenameParts.join('_')}.xlsx`;
}

function getColumnsForTab(tab) {
  if (tab === 'students') {
    return [
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
    ];
  }

  if (tab === 'staff') {
    return [
      { key: 'name', label: 'Staff Name' },
      { key: 'identifier', label: 'Identifier' },
      { key: 'department', label: 'Department', render: (row) => row.department || '--' },
      { key: 'is_class_advisor', label: 'Class Advisor', render: (row) => row.is_class_advisor ? 'Yes' : 'No' },
      { key: 'scope_label', label: 'Scope', render: (row) => row.scope_label || '--' },
      { key: 'phone_number', label: 'Phone', render: (row) => row.phone_number || '--' },
      { key: 'blood_group', label: 'Blood Group', render: (row) => row.blood_group || '--' },
      { key: 'address', label: 'Address', render: (row) => row.address || '--' },
    ];
  }

  return [
    { key: 'name', label: tab === 'hods' ? 'HOD Name' : 'Principal Name' },
    { key: 'identifier', label: 'Identifier' },
    { key: 'department', label: 'Department', render: (row) => row.department || '--' },
    { key: 'scope_label', label: 'Scope', render: (row) => row.scope_label || '--' },
    { key: 'phone_number', label: 'Phone', render: (row) => row.phone_number || '--' },
    { key: 'blood_group', label: 'Blood Group', render: (row) => row.blood_group || '--' },
    { key: 'address', label: 'Address', render: (row) => row.address || '--' },
  ];
}

export function DataExportsPage({ token, notify }) {
  const [activeTab, setActiveTab] = useState('students');
  const [meta, setMeta] = useState({ departments: [] });
  const [filtersByTab, setFiltersByTab] = useState(getInitialFilters);
  const [previewState, setPreviewState] = useState({
    loading: true,
    data: null,
    error: '',
  });
  const [exporting, setExporting] = useState(false);

  const activeConfig = TAB_CONFIGS[activeTab];
  const activeFilters = filtersByTab[activeTab];
  const previewColumns = getColumnsForTab(activeTab);

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

  useEffect(() => {
    let ignore = false;

    async function loadPreview() {
      setPreviewState((current) => ({
        loading: true,
        data: current.data,
        error: '',
      }));

      try {
        const response = await usersApi.list(token, buildPreviewParams(activeTab, activeFilters));
        if (!ignore) {
          setPreviewState({
            loading: false,
            data: response,
            error: '',
          });
        }
      } catch (requestError) {
        if (!ignore) {
          setPreviewState({
            loading: false,
            data: null,
            error: getApiErrorMessage(requestError, 'Unable to load data export preview.'),
          });
        }
      }
    }

    loadPreview();
    return () => {
      ignore = true;
    };
  }, [activeFilters, activeTab, token]);

  function updateActiveFilters(patch, options = {}) {
    const { resetPage = true } = options;
    setFiltersByTab((current) => ({
      ...current,
      [activeTab]: {
        ...current[activeTab],
        ...(resetPage ? { page: 1 } : {}),
        ...patch,
      },
    }));
  }

  async function handleExport() {
    const exportParams = buildExportParams(activeTab, activeFilters);
    const exportRequest = {
      students: usersApi.exportAdminStudentsData,
      staff: usersApi.exportAdminStaffData,
      hods: usersApi.exportAdminHODsData,
      principals: usersApi.exportAdminPrincipalsData,
    }[activeTab];

    setExporting(true);
    try {
      const blob = await exportRequest(token, exportParams);
      downloadBlob(blob, buildExportFilename(activeTab, activeFilters));
      notify('success', 'Export ready', `${activeConfig.exportLabel} downloaded successfully.`);
    } catch (requestError) {
      notify('danger', 'Export failed', getApiErrorMessage(requestError, 'Unable to export user data.'));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="Data Exports"
        subtitle="Download separate master data sheets for students, staff, HODs, and principals."
      />

      <Notice tone="info" title="Master Data Only">
        This page exports user master data only. Attendance exports remain available in the Institute Attendance workspace.
      </Notice>

      <div className="chip-group">
        <button
          type="button"
          className={`chip ${activeTab === 'students' ? 'active' : ''}`}
          onClick={() => setActiveTab('students')}
        >
          Students
        </button>
        <button
          type="button"
          className={`chip ${activeTab === 'staff' ? 'active' : ''}`}
          onClick={() => setActiveTab('staff')}
        >
          Staff
        </button>
        <button
          type="button"
          className={`chip ${activeTab === 'hods' ? 'active' : ''}`}
          onClick={() => setActiveTab('hods')}
        >
          HODs
        </button>
        <button
          type="button"
          className={`chip ${activeTab === 'principals' ? 'active' : ''}`}
          onClick={() => setActiveTab('principals')}
        >
          Principals
        </button>
      </div>

      <StatGrid>
        <StatCard
          label="Matching Records"
          value={previewState.data?.total ?? 0}
          tone="neutral"
          helper={`${activeConfig.title} preview count`}
        />
        <StatCard
          label="Preview Page Size"
          value={activeFilters.page_size}
          tone="neutral"
          helper="Rows shown per preview page"
        />
      </StatGrid>

      <Panel
        title={activeConfig.title}
        subtitle="Apply filters, review the matching records, and download the Excel file."
        action={(
          <button
            type="button"
            className="btn-primary"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? 'Exporting...' : activeConfig.exportLabel}
          </button>
        )}
      >
        <div className="form-grid">
          <label className="field">
            <span>Search</span>
            <input
              className="input"
              value={activeFilters.search}
              onChange={(event) => updateActiveFilters({ search: event.target.value })}
              placeholder={activeConfig.searchPlaceholder}
            />
          </label>
          <label className="field">
            <span>Department</span>
            <select
              className="input"
              value={activeFilters.department}
              onChange={(event) => updateActiveFilters({ department: event.target.value })}
            >
              <option value="">All Departments</option>
              {meta.departments.map((department) => (
                <option key={department} value={department}>{department}</option>
              ))}
            </select>
          </label>
          {activeTab === 'students' ? (
            <label className="field">
              <span>Year</span>
              <select
                className="input"
                value={activeFilters.year}
                onChange={(event) => updateActiveFilters({ year: event.target.value })}
              >
                <option value="">All Years</option>
                {[1, 2, 3, 4].map((year) => (
                  <option key={year} value={year}>{`Year ${year}`}</option>
                ))}
              </select>
            </label>
          ) : null}
          {activeTab === 'students' ? (
            <label className="field">
              <span>Semester</span>
              <select
                className="input"
                value={activeFilters.semester}
                onChange={(event) => updateActiveFilters({ semester: event.target.value })}
              >
                <option value="">All Semesters</option>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((semester) => (
                  <option key={semester} value={semester}>{`Sem ${semester}`}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        <div className="profile-list">
          <div><span>Export Type</span><strong>{activeConfig.title}</strong></div>
          <div><span>Included Fields</span><strong>{activeConfig.includedFields}</strong></div>
          <div><span>Current Filters</span><strong>{activeFilters.department || 'All Departments'}{activeTab === 'students' && activeFilters.year ? ` / Year ${activeFilters.year}` : ''}{activeTab === 'students' && activeFilters.semester ? ` / Sem ${activeFilters.semester}` : ''}</strong></div>
        </div>
      </Panel>

      <Panel
        title="Preview"
        subtitle="Preview the records that match the current filters before downloading the Excel file."
      >
        {previewState.error ? <Notice tone="danger" title="Preview Error">{previewState.error}</Notice> : null}

        {previewState.loading && !previewState.data ? (
          <LoadingState label="Loading export preview..." />
        ) : previewState.data ? (
          <>
            <div className={previewState.loading ? 'loading-fade' : ''}>
              <Table
                columns={previewColumns}
                rows={previewState.data.items || []}
                emptyTitle="No records available"
                emptyMessage="No records match the selected export filters."
                rowKey={(row) => row.id}
              />
            </div>
            <Pagination
              page={previewState.data.page}
              pageSize={previewState.data.page_size}
              total={previewState.data.total}
              onPageChange={(page) => updateActiveFilters({ page }, { resetPage: false })}
              isLoading={previewState.loading}
            />
          </>
        ) : (
          <EmptyState title="Preview unavailable" message="The export preview is not available right now." />
        )}
      </Panel>
    </div>
  );
}
