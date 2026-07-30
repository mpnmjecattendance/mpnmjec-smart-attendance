import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

import { getApiErrorMessage, metaApi, usersApi } from '../api';
import { LoadingState, Notice, PageHeader, Pagination, Panel, PasswordField, Table } from '../components/Ui';
import { roleLabel } from '../utils';

const BLOOD_GROUP_OPTIONS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const EDITABLE_ACCOUNT_ROLES = ['staff', 'hod', 'principal', 'admin'];

function normalizeAccountRole(role) {
  return String(role || '').toLowerCase();
}

function isAdvisorEligibleRole(role) {
  return normalizeAccountRole(role) === 'staff';
}

function requiresDepartment(role) {
  return !['admin', 'principal'].includes(normalizeAccountRole(role));
}

function buildTemporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(new Uint8Array(8)) : null;
  let suffix = '';

  for (let index = 0; index < 8; index += 1) {
    const value = bytes ? bytes[index] : Math.floor(Math.random() * alphabet.length);
    suffix += alphabet[value % alphabet.length];
  }

  return `MPNM-${suffix}`;
}

function getAdvisorAssignment(userRecord) {
  return (userRecord?.class_assignments || []).find((assignment) => String(assignment.assignment_type || '').toLowerCase() === 'class_advisor') || null;
}

function buildStaffAccessDraft(userRecord) {
  const normalizedRole = normalizeAccountRole(userRecord?.role);
  const advisorAssignment = getAdvisorAssignment(userRecord);
  const supportsAdvisorAccess = isAdvisorEligibleRole(normalizedRole);
  return {
    id: userRecord.id,
    name: userRecord.name || '',
    role: normalizedRole,
    identifier: userRecord.identifier || '',
    department: userRecord.department || '',
    phone_number: userRecord.phone_number || '',
    blood_group: userRecord.blood_group || '',
    address: userRecord.address || '',
    is_class_advisor: supportsAdvisorAccess && Boolean(userRecord.is_class_advisor),
    scope_year: supportsAdvisorAccess && advisorAssignment?.year ? String(advisorAssignment.year) : '',
    scope_semester: supportsAdvisorAccess && advisorAssignment?.semester ? String(advisorAssignment.semester) : '',
    reset_password: '',
    confirm_reset_password: '',
  };
}

function formatStaffScope(userRecord) {
  const advisorAssignment = getAdvisorAssignment(userRecord);
  if (!advisorAssignment) {
    return 'Personal dashboard only';
  }
  return `${advisorAssignment.department} / Year ${advisorAssignment.year} / Sem ${advisorAssignment.semester}`;
}

function formatAccountScope(userRecord) {
  const role = normalizeAccountRole(userRecord?.role);
  if (role === 'staff') {
    return formatStaffScope(userRecord);
  }
  if (role === 'hod') {
    return userRecord.scope_label || userRecord.department || 'Department scope';
  }
  if (role === 'principal' || role === 'admin') {
    return userRecord.scope_label || 'College-wide';
  }
  return userRecord.scope_label || 'Not assigned';
}

function buildStudentDraft(userRecord) {
  return {
    id: userRecord.id,
    name: userRecord.name || '',
    identifier: userRecord.identifier || '',
    department: userRecord.department || '',
    year: userRecord.year ? String(userRecord.year) : '',
    semester: userRecord.semester ? String(userRecord.semester) : '',
    dob: userRecord.dob || '',
    address: userRecord.address || '',
    blood_group: userRecord.blood_group || '',
    parent_phone_number: userRecord.parent_phone_number || '',
    phone_number: userRecord.phone_number || '',
  };
}

export function EditRecordsPage({ token, user, notify }) {
  const role = String(user?.role || '').toLowerCase();
  const canManageStaffAccess = role === 'admin';
  const departmentLocked = role === 'hod' || role === 'advisor';
  const preferredDepartment = departmentLocked ? String(user?.department || '') : '';

  const [meta, setMeta] = useState({ departments: [] });
  const [studentFilterInput, setStudentFilterInput] = useState({
    department: preferredDepartment,
    year: '',
    semester: '',
    search: '',
  });
  const [studentFilters, setStudentFilters] = useState({
    department: preferredDepartment,
    year: '',
    semester: '',
    search: '',
  });
  const [studentPage, setStudentPage] = useState(1);
  const [studentRefreshKey, setStudentRefreshKey] = useState(0);
  const [studentListState, setStudentListState] = useState({
    loading: true,
    items: [],
    total: 0,
    page: 1,
    page_size: 10,
    error: '',
  });
  const [studentDraft, setStudentDraft] = useState(null);
  const [studentSaving, setStudentSaving] = useState(false);

  const [staffAccessListState, setStaffAccessListState] = useState({
    loading: false,
    items: [],
    total: 0,
    page: 1,
    page_size: 8,
    error: '',
  });
  const [staffAccessPage, setStaffAccessPage] = useState(1);
  const [staffAccessSearchInput, setStaffAccessSearchInput] = useState('');
  const [staffAccessSearch, setStaffAccessSearch] = useState('');
  const [staffAccessRoleFilter, setStaffAccessRoleFilter] = useState('staff');
  const [staffAccessRefreshKey, setStaffAccessRefreshKey] = useState(0);
  const [staffAccessDraft, setStaffAccessDraft] = useState(null);
  const [staffAccessSaving, setStaffAccessSaving] = useState(false);
  const [resetPasswordSaving, setResetPasswordSaving] = useState(false);
  const [staffScopePreview, setStaffScopePreview] = useState({
    loading: false,
    total: null,
    error: '',
  });

  const [activeTab, setActiveTab] = useState('students');
  const [promoteFilters, setPromoteFilters] = useState({
    department: preferredDepartment,
    year: '',
    semester: '',
  });
  const [promoteAction, setPromoteAction] = useState('increment_semester');
  const [promoteCustomYear, setPromoteCustomYear] = useState('');
  const [promoteCustomSemester, setPromoteCustomSemester] = useState('');
  const [promoting, setPromoting] = useState(false);
  const [promotionPreviewCount, setPromotionPreviewCount] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    let ignore = false;
    if (!promoteFilters.department || !promoteFilters.year || !promoteFilters.semester) {
      setPromotionPreviewCount(null);
      return;
    }

    async function fetchPreviewCount() {
      setPreviewLoading(true);
      try {
        const response = await usersApi.list(token, {
          role: 'student',
          department: promoteFilters.department,
          year: Number(promoteFilters.year),
          semester: Number(promoteFilters.semester),
          page: 1,
          page_size: 1,
        });
        if (!ignore) {
          setPromotionPreviewCount(response.total || 0);
        }
      } catch {
        if (!ignore) {
          setPromotionPreviewCount(0);
        }
      } finally {
        if (!ignore) {
          setPreviewLoading(false);
        }
      }
    }

    fetchPreviewCount();
    return () => {
      ignore = true;
    };
  }, [token, promoteFilters.department, promoteFilters.year, promoteFilters.semester]);

  async function handleBulkPromote(event) {
    event.preventDefault();
    if (!promoteFilters.department || !promoteFilters.year || !promoteFilters.semester) {
      notify('warning', 'Missing filters', 'Please select a source department, year, and semester.');
      return;
    }

    setPromoting(true);
    try {
      const payload = {
        department: promoteFilters.department,
        current_year: Number(promoteFilters.year),
        current_semester: Number(promoteFilters.semester),
        action: promoteAction,
      };
      if (promoteAction === 'custom') {
        payload.target_year = Number(promoteCustomYear);
        payload.target_semester = Number(promoteCustomSemester);
      }
      const response = await usersApi.bulkPromote(token, payload);
      notify('success', 'Promotion complete', response.message || `Successfully updated students.`);
      setPromoteFilters((current) => ({ ...current, year: '', semester: '' }));
      setPromotionPreviewCount(null);
      setStudentRefreshKey((current) => current + 1);
      setConfirmOpen(false);
    } catch (requestError) {
      notify('danger', 'Promotion failed', getApiErrorMessage(requestError, 'Unable to promote students.'));
    } finally {
      setPromoting(false);
    }
  }


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

    async function loadStudents() {
      setStudentListState((current) => ({
        ...current,
        loading: true,
        error: '',
      }));

      try {
        const response = await usersApi.list(token, {
          page: studentPage,
          page_size: 10,
          role: 'student',
          department: studentFilters.department,
          year: studentFilters.year ? Number(studentFilters.year) : '',
          semester: studentFilters.semester ? Number(studentFilters.semester) : '',
          search: studentFilters.search,
        });

        if (!ignore) {
          setStudentListState({
            loading: false,
            items: response.items || [],
            total: response.total || 0,
            page: response.page || studentPage,
            page_size: response.page_size || 10,
            error: '',
          });

          setStudentDraft((current) => {
            if (!current) {
              return current;
            }
            const refreshed = (response.items || []).find((item) => item.id === current.id);
            return refreshed ? buildStudentDraft(refreshed) : current;
          });
        }
      } catch (requestError) {
        if (!ignore) {
          setStudentListState((current) => ({
            ...current,
            loading: false,
            error: getApiErrorMessage(requestError, 'Unable to load students right now.'),
          }));
        }
      }
    }

    loadStudents();
    return () => {
      ignore = true;
    };
  }, [studentFilters, studentPage, studentRefreshKey, token]);

  useEffect(() => {
    if (!canManageStaffAccess) {
      return undefined;
    }

    let ignore = false;

    async function loadStaffDirectory() {
      setStaffAccessListState((current) => ({
        ...current,
        loading: true,
        error: '',
      }));

      try {
        const response = await usersApi.list(token, {
          page: staffAccessPage,
          page_size: 8,
          role: staffAccessRoleFilter,
          search: staffAccessSearch,
        });
        if (!ignore) {
          setStaffAccessListState({
            loading: false,
            items: response.items || [],
            total: response.total || 0,
            page: response.page || staffAccessPage,
            page_size: response.page_size || 8,
            error: '',
          });

          setStaffAccessDraft((current) => {
            if (!current) {
              return current;
            }
            if (normalizeAccountRole(current.role) !== staffAccessRoleFilter) {
              return current;
            }
            const refreshed = (response.items || []).find((item) => item.id === current.id);
            return refreshed ? buildStaffAccessDraft(refreshed) : current;
          });
        }
      } catch (requestError) {
        if (!ignore) {
          setStaffAccessListState((current) => ({
            ...current,
            loading: false,
            error: getApiErrorMessage(requestError, 'Unable to load account records right now.'),
          }));
        }
      }
    }

    loadStaffDirectory();
    return () => {
      ignore = true;
    };
  }, [canManageStaffAccess, staffAccessPage, staffAccessRefreshKey, staffAccessRoleFilter, staffAccessSearch, token]);

  useEffect(() => {
    let ignore = false;

    async function loadStaffScopePreview() {
      if (!isAdvisorEligibleRole(staffAccessDraft?.role) || !staffAccessDraft?.is_class_advisor) {
        setStaffScopePreview({
          loading: false,
          total: null,
          error: '',
        });
        return;
      }

      if (!String(staffAccessDraft.department || '').trim() || !String(staffAccessDraft.scope_year || '').trim() || !String(staffAccessDraft.scope_semester || '').trim()) {
        setStaffScopePreview({
          loading: false,
          total: null,
          error: '',
        });
        return;
      }

      setStaffScopePreview((current) => ({
        ...current,
        loading: true,
        error: '',
      }));

      try {
        const response = await usersApi.list(token, {
          page: 1,
          page_size: 1,
          role: 'student',
          department: staffAccessDraft.department,
          year: Number(staffAccessDraft.scope_year),
          semester: Number(staffAccessDraft.scope_semester),
        });

        if (!ignore) {
          setStaffScopePreview({
            loading: false,
            total: Number(response.total || 0),
            error: '',
          });
        }
      } catch (requestError) {
        if (!ignore) {
          setStaffScopePreview({
            loading: false,
            total: null,
            error: getApiErrorMessage(requestError, 'Unable to verify the selected advisor scope right now.'),
          });
        }
      }
    }

    loadStaffScopePreview();
    return () => {
      ignore = true;
    };
  }, [
    staffAccessDraft?.department,
    staffAccessDraft?.role,
    staffAccessDraft?.is_class_advisor,
    staffAccessDraft?.scope_semester,
    staffAccessDraft?.scope_year,
    token,
  ]);

  function handleStudentFilterSubmit(event) {
    event.preventDefault();
    setStudentPage(1);
    setStudentFilters({
      department: studentFilterInput.department,
      year: studentFilterInput.year,
      semester: studentFilterInput.semester,
      search: studentFilterInput.search.trim(),
    });
  }

  function handleEditStudent(userRecord) {
    setStudentDraft(buildStudentDraft(userRecord));
  }

  async function handleUpdateStudent(event) {
    event.preventDefault();
    if (!studentDraft) {
      return;
    }

    setStudentSaving(true);

    try {
      const updatedStudent = await usersApi.updateStudentProfile(token, studentDraft.id, {
        name: studentDraft.name.trim(),
        identifier: studentDraft.identifier.trim(),
        department: studentDraft.department.trim(),
        year: Number(studentDraft.year),
        semester: Number(studentDraft.semester),
        dob: studentDraft.dob,
        address: studentDraft.address.trim(),
        blood_group: studentDraft.blood_group,
        parent_phone_number: studentDraft.parent_phone_number.trim(),
        phone_number: studentDraft.phone_number.trim() || null,
      });
      setStudentDraft(buildStudentDraft(updatedStudent));
      setStudentRefreshKey((current) => current + 1);
      notify('success', 'Student updated', `${updatedStudent.name} has been updated successfully.`);
    } catch (requestError) {
      notify('danger', 'Student update failed', getApiErrorMessage(requestError, 'Unable to update the student profile.'));
    } finally {
      setStudentSaving(false);
    }
  }

  function handleStaffAccessSearchSubmit(event) {
    event.preventDefault();
    setStaffAccessPage(1);
    setStaffAccessSearch(staffAccessSearchInput.trim());
  }

  function handleEditStaffAccess(userRecord) {
    setStaffAccessDraft(buildStaffAccessDraft(userRecord));
  }

  async function handleUpdateStaffAccess(event) {
    event.preventDefault();
    if (!staffAccessDraft) {
      return;
    }

    setStaffAccessSaving(true);

    try {
      const updatedUser = await usersApi.updateStaffAccess(token, staffAccessDraft.id, {
        department: staffAccessDraft.department.trim(),
        phone_number: staffAccessDraft.phone_number.trim(),
        blood_group: staffAccessDraft.blood_group || null,
        address: staffAccessDraft.address.trim() || null,
        is_class_advisor: isAdvisorEligibleRole(staffAccessDraft.role) ? staffAccessDraft.is_class_advisor : false,
        scope_year: isAdvisorEligibleRole(staffAccessDraft.role) && staffAccessDraft.is_class_advisor ? Number(staffAccessDraft.scope_year) : null,
        scope_semester: isAdvisorEligibleRole(staffAccessDraft.role) && staffAccessDraft.is_class_advisor ? Number(staffAccessDraft.scope_semester) : null,
      });

      setStaffAccessDraft(buildStaffAccessDraft(updatedUser));
      setStaffAccessRefreshKey((current) => current + 1);
      notify('success', 'Account updated', `${updatedUser.name} has been updated successfully.`);
    } catch (requestError) {
      notify('danger', 'Update failed', getApiErrorMessage(requestError, 'Unable to update the selected account.'));
    } finally {
      setStaffAccessSaving(false);
    }
  }

  async function handleResetAccountPassword() {
    if (!staffAccessDraft) {
      return;
    }

    if (staffAccessDraft.reset_password.length < 6) {
      notify('warning', 'Password too short', 'Choose a new password with at least 6 characters.');
      return;
    }

    if (staffAccessDraft.reset_password !== staffAccessDraft.confirm_reset_password) {
      notify('warning', 'Passwords do not match', 'The reset password and confirmation password must match.');
      return;
    }

    setResetPasswordSaving(true);

    try {
      const response = await usersApi.resetPassword(token, staffAccessDraft.id, {
        new_password: staffAccessDraft.reset_password,
      });
      setStaffAccessDraft((current) => (current ? {
        ...current,
        reset_password: '',
        confirm_reset_password: '',
      } : current));
      notify('success', 'Password reset', response.message || `Password reset successfully for ${staffAccessDraft.name}.`);
    } catch (requestError) {
      notify('danger', 'Password reset failed', getApiErrorMessage(requestError, 'Unable to reset the account password.'));
    } finally {
      setResetPasswordSaving(false);
    }
  }

  const studentCompletion = !studentDraft || Boolean(
    [
      studentDraft.name,
      studentDraft.identifier,
      studentDraft.department,
      studentDraft.year,
      studentDraft.semester,
      studentDraft.dob,
      studentDraft.address,
      studentDraft.blood_group,
      studentDraft.parent_phone_number,
    ].every((value) => String(value || '').trim())
  );

  const staffAccessCompletion = !staffAccessDraft || Boolean(
    (!requiresDepartment(staffAccessDraft.role) || String(staffAccessDraft.department || '').trim())
    && (!isAdvisorEligibleRole(staffAccessDraft.role) || !staffAccessDraft.is_class_advisor || [
      staffAccessDraft.scope_year,
      staffAccessDraft.scope_semester,
    ].every((value) => String(value || '').trim()))
  );
  const resetPasswordMismatch = Boolean(
    staffAccessDraft?.confirm_reset_password
    && staffAccessDraft?.reset_password !== staffAccessDraft?.confirm_reset_password
  );
  const resetPasswordTooShort = Boolean(
    staffAccessDraft?.reset_password
    && staffAccessDraft.reset_password.length < 6
  );
  const canResetPassword = Boolean(
    staffAccessDraft
    && staffAccessDraft.reset_password.length >= 6
    && staffAccessDraft.reset_password === staffAccessDraft.confirm_reset_password
  );

  return (
    <div className="page-stack">
      <PageHeader
        title="Edit Records"
        subtitle="Filter students quickly, update enrollment details, and manage staff advisor access from one editing workspace."
      />

      <div className="tab-navigation">
        <button
          type="button"
          className={`tab-btn ${activeTab === 'students' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('students');
            setStudentDraft(null);
          }}
        >
          Students
        </button>
        {canManageStaffAccess && (
          <button
            type="button"
            className={`tab-btn ${activeTab === 'staff' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('staff');
              setStaffAccessDraft(null);
            }}
          >
            Staff Directory
          </button>
        )}
        <button
          type="button"
          className={`tab-btn ${activeTab === 'promote' ? 'active' : ''}`}
          onClick={() => setActiveTab('promote')}
        >
          Bulk Promotion
        </button>
      </div>

      {activeTab === 'students' ? (
        <Panel
        title="Student Enrollment Edit"
        subtitle="Filter by department, year, and semester to load the exact student list you want to edit."
        action={(
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setStudentRefreshKey((current) => current + 1)}
            disabled={studentListState.loading || studentSaving}
          >
            {studentListState.loading ? 'Refreshing...' : 'Refresh'}
          </button>
        )}
      >
        <form className="form-grid form-grid-compact" onSubmit={handleStudentFilterSubmit}>
          <div className="details-grid details-grid-compact">
            <label className="field">
              <span>Department</span>
              <select
                className="input"
                value={studentFilterInput.department}
                onChange={(event) => setStudentFilterInput((current) => ({ ...current, department: event.target.value }))}
                disabled={departmentLocked}
              >
                {!departmentLocked ? <option value="">All departments</option> : null}
                {meta.departments.map((department) => (
                  <option key={department} value={department}>{department}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Year</span>
              <input
                className="input"
                type="number"
                min="1"
                max="4"
                value={studentFilterInput.year}
                onChange={(event) => setStudentFilterInput((current) => ({ ...current, year: event.target.value }))}
                placeholder="All"
              />
            </label>
            <label className="field">
              <span>Semester</span>
              <input
                className="input"
                type="number"
                min="1"
                max="8"
                value={studentFilterInput.semester}
                onChange={(event) => setStudentFilterInput((current) => ({ ...current, semester: event.target.value }))}
                placeholder="All"
              />
            </label>
            <label className="field field-span-2">
              <span>Search</span>
              <input
                className="input"
                value={studentFilterInput.search}
                onChange={(event) => setStudentFilterInput((current) => ({ ...current, search: event.target.value }))}
                placeholder="Search by name or register number"
              />
            </label>
            <div className="field">
              <span>Load Students</span>
              <button type="submit" className="btn-primary btn-block">
                Apply Filters
              </button>
            </div>
          </div>
        </form>

        <Notice tone="info" title="Student edit flow">
          Filter the class first, pick a student from the table, then update any enrollment detail and save it immediately.
        </Notice>

        {studentListState.error ? (
          <Notice tone="danger" title="Student list error">
            {studentListState.error}
          </Notice>
        ) : null}

        {studentListState.loading && !studentListState.items.length ? (
          <LoadingState label="Loading student records..." />
        ) : (
          <>
            <div className={studentListState.loading ? 'loading-fade' : ''}>
              <Table
                columns={[
                  { key: 'name', label: 'Student Name' },
                  { key: 'identifier', label: 'Register Number' },
                  { key: 'department', label: 'Department' },
                  { key: 'year', label: 'Year' },
                  { key: 'semester', label: 'Semester' },
                  {
                    key: 'attendance_rate',
                    label: 'Attendance %',
                    render: (row) => row.attendance_rate != null ? `${Number(row.attendance_rate).toFixed(1)}%` : '--',
                  },
                  {
                    key: 'actions',
                    label: 'Action',
                    render: (row) => (
                      <button type="button" className="btn-secondary" onClick={() => handleEditStudent(row)}>
                        Edit Student
                      </button>
                    ),
                  },
                ]}
                rows={studentListState.items}
                emptyTitle="No students found"
                emptyMessage="Adjust the department, year, semester, or search filters to find student records."
                rowKey={(row) => row.id}
              />
            </div>

            <Pagination
              page={studentListState.page}
              pageSize={studentListState.page_size}
              total={studentListState.total}
              onPageChange={setStudentPage}
              isLoading={studentListState.loading}
            />
          </>
        )}

        {studentDraft ? (
          <form className="form-grid form-grid-compact" onSubmit={handleUpdateStudent}>
            <Notice tone="info" title="Edit Student Details">
              Updating {studentDraft.name}. Save here to update the student enrollment record without re-enrolling face data.
            </Notice>

            <div className="details-grid details-grid-compact">
              <label className="field">
                <span>Full Name</span>
                <input
                  className="input"
                  value={studentDraft.name}
                  onChange={(event) => setStudentDraft((current) => ({ ...current, name: event.target.value }))}
                  required
                />
              </label>
              <label className="field">
                <span>Register Number</span>
                <input
                  className="input"
                  value={studentDraft.identifier}
                  onChange={(event) => setStudentDraft((current) => ({ ...current, identifier: event.target.value }))}
                  required
                />
              </label>
              <label className="field">
                <span>Department</span>
                <select
                  className="input"
                  value={studentDraft.department}
                  onChange={(event) => setStudentDraft((current) => ({ ...current, department: event.target.value }))}
                  disabled={departmentLocked}
                  required
                >
                  <option value="" disabled hidden>Select department</option>
                  {meta.departments.map((department) => (
                    <option key={department} value={department}>{department}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Year</span>
                <input
                  className="input"
                  type="number"
                  min="1"
                  max="4"
                  value={studentDraft.year}
                  onChange={(event) => setStudentDraft((current) => ({ ...current, year: event.target.value }))}
                  required
                />
              </label>
              <label className="field">
                <span>Semester</span>
                <input
                  className="input"
                  type="number"
                  min="1"
                  max="8"
                  value={studentDraft.semester}
                  onChange={(event) => setStudentDraft((current) => ({ ...current, semester: event.target.value }))}
                  required
                />
              </label>
              <label className="field">
                <span>DOB</span>
                <input
                  className="input"
                  type="date"
                  value={studentDraft.dob}
                  onChange={(event) => setStudentDraft((current) => ({ ...current, dob: event.target.value }))}
                  required
                />
              </label>
              <label className="field">
                <span>Parent Phone</span>
                <input
                  className="input"
                  type="tel"
                  value={studentDraft.parent_phone_number}
                  onChange={(event) => setStudentDraft((current) => ({ ...current, parent_phone_number: event.target.value }))}
                  required
                />
              </label>
              <label className="field">
                <span>Student Phone</span>
                <input
                  className="input"
                  type="tel"
                  value={studentDraft.phone_number}
                  onChange={(event) => setStudentDraft((current) => ({ ...current, phone_number: event.target.value }))}
                  placeholder="Optional"
                />
              </label>
              <label className="field">
                <span>Blood Group</span>
                <input
                  className="input"
                  type="text"
                  list="blood-groups"
                  value={studentDraft.blood_group}
                  onChange={(event) => setStudentDraft((current) => ({ ...current, blood_group: event.target.value.toUpperCase() }))}
                  placeholder="e.g. O+"
                  required
                />
              </label>
              <label className="field field-span-2">
                <span>Address</span>
                <textarea
                  className="input input-textarea input-textarea-compact"
                  rows={3}
                  value={studentDraft.address}
                  onChange={(event) => setStudentDraft((current) => ({ ...current, address: event.target.value }))}
                  required
                />
              </label>
            </div>

            <div className="enrollment-actions">
              <button type="button" className="btn-secondary" onClick={() => setStudentDraft(null)} disabled={studentSaving}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={!studentCompletion || studentSaving}>
                {studentSaving ? 'Saving Student...' : 'Save Student Changes'}
              </button>
            </div>
          </form>
        ) : null}
      </Panel>
      ) : null}

      {activeTab === 'staff' && canManageStaffAccess ? (
        <Panel
          title="Account Access Management"
          subtitle="Update enrolled staff, HOD, principal, and admin records from one workspace. Class advisor access remains staff-only."
          action={(
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setStaffAccessRefreshKey((current) => current + 1)}
              disabled={staffAccessListState.loading || staffAccessSaving || resetPasswordSaving}
            >
              {staffAccessListState.loading ? 'Refreshing...' : 'Refresh'}
            </button>
          )}
        >
          <form className="form-grid form-grid-compact" onSubmit={handleStaffAccessSearchSubmit}>
            <div className="details-grid details-grid-compact">
              <label className="field">
                <span>Role</span>
                <select
                  className="input"
                  value={staffAccessRoleFilter}
                  onChange={(event) => {
                    setStaffAccessRoleFilter(event.target.value);
                    setStaffAccessPage(1);
                    setStaffAccessDraft(null);
                  }}
                >
                  {EDITABLE_ACCOUNT_ROLES.map((accountRole) => (
                    <option key={accountRole} value={accountRole}>{roleLabel(accountRole)}</option>
                  ))}
                </select>
              </label>
              <label className="field field-span-2">
                <span>Search Accounts</span>
                <input
                  className="input"
                  value={staffAccessSearchInput}
                  onChange={(event) => setStaffAccessSearchInput(event.target.value)}
                  placeholder="Search by name or identifier"
                />
              </label>
              <div className="field">
                <span>Find</span>
                <button type="submit" className="btn-primary btn-block">
                  Search
                </button>
              </div>
            </div>
          </form>

          <Notice tone="info" title="Account updates">
            Use this panel to update non-student records by role. Staff accounts can still be promoted into class advisor access later, while HOD, principal, and admin accounts keep their existing role-based platform access.
          </Notice>

          {staffAccessListState.error ? (
            <Notice tone="danger" title="Account directory error">
              {staffAccessListState.error}
            </Notice>
          ) : null}

          {staffAccessListState.loading && !staffAccessListState.items.length ? (
            <LoadingState label={`Loading ${roleLabel(staffAccessRoleFilter).toLowerCase()} accounts...`} />
          ) : (
            <>
              <div className={staffAccessListState.loading ? 'loading-fade' : ''}>
                <Table
                  columns={[
                    { key: 'name', label: 'Name' },
                    { key: 'identifier', label: 'Identifier' },
                    { key: 'role', label: 'Role', render: (row) => roleLabel(row.role) },
                    { key: 'department', label: 'Department', render: (row) => row.department || 'Not assigned' },
                    {
                      key: 'advisor',
                      label: 'Class Advisor',
                      render: (row) => (normalizeAccountRole(row.role) === 'staff' ? (row.is_class_advisor ? 'Enabled' : 'No') : '--'),
                    },
                    { key: 'scope', label: 'Access Scope', render: (row) => formatAccountScope(row) },
                    {
                      key: 'actions',
                      label: 'Action',
                      render: (row) => (
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => handleEditStaffAccess(row)}
                        >
                          Edit Record
                        </button>
                      ),
                    },
                  ]}
                  rows={staffAccessListState.items}
                  emptyTitle="No accounts found"
                  emptyMessage={`No ${roleLabel(staffAccessRoleFilter).toLowerCase()} accounts matched the current search.`}
                  rowKey={(row) => row.id}
                />
              </div>

              <Pagination
                page={staffAccessListState.page}
                pageSize={staffAccessListState.page_size}
                total={staffAccessListState.total}
                onPageChange={setStaffAccessPage}
                isLoading={staffAccessListState.loading}
              />
            </>
          )}

          {staffAccessDraft ? (
            <form className="form-grid form-grid-compact" onSubmit={handleUpdateStaffAccess}>
              <Notice tone="info" title="Edit Account Record">
                Updating {staffAccessDraft.name} ({roleLabel(staffAccessDraft.role)}). Save changes here to update this enrolled account without re-enrolling face data.
              </Notice>
              <Notice tone="info" title="Password Reset">
                Admin password reset is separate from account-profile editing. The current password is never shown, and the new password is applied only when you use the reset action below.
              </Notice>
              {resetPasswordTooShort ? (
                <Notice tone="warning" title="Password Too Short">
                  The new password must be at least 6 characters long.
                </Notice>
              ) : null}
              {resetPasswordMismatch ? (
                <Notice tone="warning" title="Passwords Do Not Match">
                  Enter the same value in both password fields before resetting the account password.
                </Notice>
              ) : null}

              <div className="details-grid details-grid-compact">
                <label className="field">
                  <span>Full Name</span>
                  <input className="input" value={staffAccessDraft.name} readOnly />
                </label>
                <label className="field">
                  <span>Role</span>
                  <input className="input" value={roleLabel(staffAccessDraft.role)} readOnly />
                </label>
                <label className="field">
                  <span>Identifier</span>
                  <input className="input" value={staffAccessDraft.identifier} readOnly />
                </label>
                <label className="field">
                  <span>Department</span>
                  <select
                    className="input"
                    value={staffAccessDraft.department}
                    onChange={(event) => setStaffAccessDraft((current) => ({
                      ...current,
                      department: event.target.value,
                    }))}
                    required={requiresDepartment(staffAccessDraft.role)}
                  >
                    {requiresDepartment(staffAccessDraft.role) ? (
                      <option value="" disabled hidden>Select department</option>
                    ) : (
                      <option value="">No department</option>
                    )}
                    {meta.departments.map((department) => (
                      <option key={department} value={department}>{department}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Phone Number</span>
                  <input
                    className="input"
                    type="tel"
                    value={staffAccessDraft.phone_number}
                    onChange={(event) => setStaffAccessDraft((current) => ({
                      ...current,
                      phone_number: event.target.value,
                    }))}
                    placeholder="e.g. 9876543210"
                  />
                </label>
                {isAdvisorEligibleRole(staffAccessDraft.role) ? (
                  <>
                    <label className="field">
                      <span>Class Advisor Access</span>
                      <select
                        className="input"
                        value={staffAccessDraft.is_class_advisor ? 'yes' : 'no'}
                        onChange={(event) => setStaffAccessDraft((current) => ({
                          ...current,
                          is_class_advisor: event.target.value === 'yes',
                          ...(event.target.value === 'yes' ? {} : { scope_year: '', scope_semester: '' }),
                        }))}
                      >
                        <option value="no">No</option>
                        <option value="yes">Yes</option>
                      </select>
                    </label>
                    {staffAccessDraft.is_class_advisor ? (
                      <>
                        <label className="field">
                          <span>Attendance Year</span>
                          <input
                            className="input"
                            type="number"
                            min="1"
                            max="4"
                            value={staffAccessDraft.scope_year}
                            onChange={(event) => setStaffAccessDraft((current) => ({
                              ...current,
                              scope_year: event.target.value,
                            }))}
                            required
                          />
                        </label>
                        <label className="field">
                          <span>Attendance Semester</span>
                          <input
                            className="input"
                            type="number"
                            min="1"
                            max="8"
                            value={staffAccessDraft.scope_semester}
                            onChange={(event) => setStaffAccessDraft((current) => ({
                              ...current,
                              scope_semester: event.target.value,
                            }))}
                            required
                          />
                        </label>
                      </>
                    ) : null}
                    {staffAccessDraft.is_class_advisor && staffScopePreview.total !== null ? (
                      <div className="field field-span-2">
                        <Notice tone={staffScopePreview.total > 0 ? 'success' : 'warning'} title="Advisor Scope Preview">
                          {staffScopePreview.total > 0
                            ? `${staffScopePreview.total} student record(s) currently match ${staffAccessDraft.department} / Year ${staffAccessDraft.scope_year} / Sem ${staffAccessDraft.scope_semester}.`
                            : `No student records currently match ${staffAccessDraft.department} / Year ${staffAccessDraft.scope_year} / Sem ${staffAccessDraft.scope_semester}.`}
                        </Notice>
                      </div>
                    ) : null}
                    {staffAccessDraft.is_class_advisor && staffScopePreview.error ? (
                      <div className="field field-span-2">
                        <Notice tone="warning" title="Advisor Scope Preview">
                          {staffScopePreview.error}
                        </Notice>
                      </div>
                    ) : null}
                  </>
                ) : null}
                <label className="field">
                  <span>Blood Group</span>
                  <input
                    className="input"
                    type="text"
                    list="blood-groups"
                    value={staffAccessDraft.blood_group || ''}
                    onChange={(event) => setStaffAccessDraft((current) => ({
                      ...current,
                      blood_group: event.target.value.toUpperCase(),
                    }))}
                    placeholder="e.g. O+ (optional)"
                  />
                  <datalist id="blood-groups">
                    {BLOOD_GROUP_OPTIONS.map((group) => (
                      <option key={group} value={group} />
                    ))}
                  </datalist>
                </label>
                <label className="field field-span-2">
                  <span>Address</span>
                  <textarea
                    className="input input-textarea input-textarea-compact"
                    rows={3}
                    value={staffAccessDraft.address}
                    onChange={(event) => setStaffAccessDraft((current) => ({
                      ...current,
                      address: event.target.value,
                    }))}
                    placeholder="Optional contact address"
                  />
                </label>
                <label className="field">
                  <span>New Password</span>
                  <PasswordField
                    className="input"
                    value={staffAccessDraft.reset_password}
                    onChange={(event) => setStaffAccessDraft((current) => ({
                      ...current,
                      reset_password: event.target.value,
                    }))}
                    placeholder="Enter a new password"
                    autoComplete="new-password"
                    minLength={6}
                  />
                </label>
                <label className="field">
                  <span>Confirm New Password</span>
                  <PasswordField
                    className="input"
                    value={staffAccessDraft.confirm_reset_password}
                    onChange={(event) => setStaffAccessDraft((current) => ({
                      ...current,
                      confirm_reset_password: event.target.value,
                    }))}
                    placeholder="Re-enter the new password"
                    autoComplete="new-password"
                    minLength={6}
                  />
                </label>
                <div className="field field-span-2">
                  <span>Admin Password Reset</span>
                  <div className="enrollment-actions">
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => {
                        const generatedPassword = buildTemporaryPassword();
                        setStaffAccessDraft((current) => (current ? {
                          ...current,
                          reset_password: generatedPassword,
                          confirm_reset_password: generatedPassword,
                        } : current));
                      }}
                      disabled={staffAccessSaving || resetPasswordSaving}
                    >
                      Generate Password
                    </button>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={handleResetAccountPassword}
                      disabled={!canResetPassword || staffAccessSaving || resetPasswordSaving}
                    >
                      {resetPasswordSaving ? 'Resetting Password...' : 'Reset Password'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="enrollment-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setStaffAccessDraft(null)}
                  disabled={staffAccessSaving || resetPasswordSaving}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={!staffAccessCompletion || staffAccessSaving || resetPasswordSaving}
                >
                  {staffAccessSaving ? 'Saving Changes...' : 'Save Account Changes'}
                </button>
              </div>
            </form>
          ) : null}
        </Panel>
      ) : null}

      {activeTab === 'promote' ? (
        <Panel
          title="Bulk Student Promotion"
          subtitle="Promote all students matching the selected criteria to the next semester, next year, or a custom target class in a few steps."
        >
          <form className="form-grid form-grid-compact" onSubmit={(e) => { e.preventDefault(); setConfirmOpen(true); }}>
            <div className="details-grid details-grid-compact">
              <label className="field">
                <span>Department</span>
                <select
                  className="input"
                  value={promoteFilters.department}
                  onChange={(event) => setPromoteFilters((current) => ({ ...current, department: event.target.value }))}
                  disabled={departmentLocked || promoting}
                  required
                >
                  {!departmentLocked ? <option value="">Select department</option> : null}
                  {meta.departments.map((dep) => (
                    <option key={dep} value={dep}>{dep}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Current Year</span>
                <input
                  className="input"
                  type="number"
                  min="1"
                  max="4"
                  value={promoteFilters.year}
                  onChange={(event) => setPromoteFilters((current) => ({ ...current, year: event.target.value }))}
                  placeholder="e.g. 2"
                  disabled={promoting}
                  required
                />
              </label>
              <label className="field">
                <span>Current Semester</span>
                <input
                  className="input"
                  type="number"
                  min="1"
                  max="8"
                  value={promoteFilters.semester}
                  onChange={(event) => setPromoteFilters((current) => ({ ...current, semester: event.target.value }))}
                  placeholder="e.g. 4"
                  disabled={promoting}
                  required
                />
              </label>

              <div className="field field-span-3">
                <span className="label-spacing">Promotion Action</span>
                <div className="radio-group-vertical">
                  <label className="radio-label">
                    <input
                      type="radio"
                      name="promoteAction"
                      value="increment_semester"
                      checked={promoteAction === 'increment_semester'}
                      onChange={() => setPromoteAction('increment_semester')}
                      disabled={promoting}
                    />
                    <span>Next Semester (+1 Semester)</span>
                  </label>
                  <label className="radio-label">
                    <input
                      type="radio"
                      name="promoteAction"
                      value="increment_year"
                      checked={promoteAction === 'increment_year'}
                      onChange={() => setPromoteAction('increment_year')}
                      disabled={promoting}
                    />
                    <span>Next Academic Year (+1 Year & +1 Semester)</span>
                  </label>
                  <label className="radio-label">
                    <input
                      type="radio"
                      name="promoteAction"
                      value="custom"
                      checked={promoteAction === 'custom'}
                      onChange={() => setPromoteAction('custom')}
                      disabled={promoting}
                    />
                    <span>Custom Target Year & Semester</span>
                  </label>
                </div>
              </div>

              {promoteAction === 'custom' ? (
                <>
                  <label className="field">
                    <span>Target Year</span>
                    <input
                      className="input"
                      type="number"
                      min="1"
                      max="4"
                      value={promoteCustomYear}
                      onChange={(event) => setPromoteCustomYear(event.target.value)}
                      placeholder="e.g. 3"
                      disabled={promoting}
                      required
                    />
                  </label>
                  <label className="field">
                    <span>Target Semester</span>
                    <input
                      className="input"
                      type="number"
                      min="1"
                      max="8"
                      value={promoteCustomSemester}
                      onChange={(event) => setPromoteCustomSemester(event.target.value)}
                      placeholder="e.g. 5"
                      disabled={promoting}
                      required
                    />
                  </label>
                  <div className="field" />
                </>
              ) : null}
            </div>

            {previewLoading ? (
              <Notice tone="neutral" title="Checking student list...">
                Counting active records matching your filter...
              </Notice>
            ) : promotionPreviewCount !== null ? (
              <Notice
                tone={promotionPreviewCount > 0 ? 'info' : 'warning'}
                title="Target Students Preview"
              >
                Found <strong>{promotionPreviewCount}</strong> student{promotionPreviewCount === 1 ? '' : 's'} matching the filter.
                {promotionPreviewCount > 0 ? (
                  promoteAction === 'increment_semester' ? (
                    <span> They will be moved from Year {promoteFilters.year} Sem {promoteFilters.semester} to Sem {Number(promoteFilters.semester) + 1}.</span>
                  ) : promoteAction === 'increment_year' ? (
                    <span> They will be moved to Year {Number(promoteFilters.year) + 1} Sem {Number(promoteFilters.semester) + 1}.</span>
                  ) : (
                    <span> They will be moved to Year {promoteCustomYear} Sem {promoteCustomSemester}.</span>
                  )
                ) : (
                  <span> Please check the filters. No students match this query.</span>
                )}
              </Notice>
            ) : null}

            {confirmOpen && promotionPreviewCount > 0 ? (
              <Notice tone="warning" title="Execute Bulk Promotion?">
                <p>This action is irreversible. All {promotionPreviewCount} students will be updated simultaneously in the database.</p>
                <div className="enrollment-actions" style={{ marginTop: '12px' }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setConfirmOpen(false)}
                    disabled={promoting}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={handleBulkPromote}
                    disabled={promoting}
                  >
                    {promoting ? 'Promoting...' : 'Yes, promote students'}
                  </button>
                </div>
              </Notice>
            ) : (
              <div className="enrollment-actions">
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={promoting || promotionPreviewCount === null || promotionPreviewCount === 0 || confirmOpen}
                >
                  Promote Students
                </button>
              </div>
            )}
          </form>
        </Panel>
      ) : null}
    </div>
  );
}
