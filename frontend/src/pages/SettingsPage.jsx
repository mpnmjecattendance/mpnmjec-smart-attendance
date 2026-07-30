import { useEffect, useState } from 'react';

import { getApiErrorMessage, settingsApi } from '../api';
import { EmptyState, LoadingState, Notice, PageHeader, Panel } from '../components/Ui';

const emptyRule = {
  start_date: '',
  end_date: '',
  audience: 'both',
  day_type: 'holiday',
  reason: '',
};

const emptySettings = {
  holidays: [],
  calendar_rules: [],
  student_attendance: {
    morning_time_start: '08:30:00',
    morning_time_end: '12:30:00',
    afternoon_time_start: '13:30:00',
    afternoon_time_end: '16:30:00',
  },
  staff_attendance: {
    morning_time_start: '08:30:00',
    morning_time_end: '12:30:00',
    evening_time_start: '13:30:00',
    evening_time_end: '16:30:00',
  },
};

function toTimeInput(value) {
  return String(value || '').slice(0, 5);
}

function normalizeSettings(settings) {
  return {
    ...emptySettings,
    ...(settings || {}),
    student_attendance: {
      ...emptySettings.student_attendance,
      ...(settings?.student_attendance || {}),
    },
    staff_attendance: {
      ...emptySettings.staff_attendance,
      ...(settings?.staff_attendance || {}),
    },
    calendar_rules: (settings?.calendar_rules || []).map((rule) => ({
      ...emptyRule,
      ...rule,
      reason: rule.reason || '',
    })),
  };
}

function validateStudentTimingWindows(studentAttendance) {
  const morningStart = toTimeInput(studentAttendance.morning_time_start);
  const morningEnd = toTimeInput(studentAttendance.morning_time_end);
  const afternoonStart = toTimeInput(studentAttendance.afternoon_time_start);
  const afternoonEnd = toTimeInput(studentAttendance.afternoon_time_end);

  if (morningStart >= morningEnd) {
    return 'Student morning start must be earlier than morning end.';
  }
  if (afternoonStart >= afternoonEnd) {
    return 'Student afternoon start must be earlier than afternoon end.';
  }
  if (morningEnd >= afternoonStart) {
    return 'Student morning end must be earlier than afternoon start.';
  }
  return '';
}

function validateStaffTimingWindows(staffAttendance) {
  const morningStart = toTimeInput(staffAttendance.morning_time_start);
  const morningEnd = toTimeInput(staffAttendance.morning_time_end);
  const eveningStart = toTimeInput(staffAttendance.evening_time_start);
  const eveningEnd = toTimeInput(staffAttendance.evening_time_end);

  if (morningStart >= morningEnd) {
    return 'Staff morning start must be earlier than morning end.';
  }
  if (eveningStart >= eveningEnd) {
    return 'Staff evening start must be earlier than evening end.';
  }
  if (morningEnd >= eveningStart) {
    return 'Staff morning end must be earlier than evening start.';
  }
  return '';
}

function validateTimingWindows(settings) {
  return validateStudentTimingWindows(settings.student_attendance) || validateStaffTimingWindows(settings.staff_attendance);
}

function validateCalendarRules(rules) {
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (!rule.start_date || !rule.end_date) {
      return `Calendar rule ${index + 1} needs both From Date and To Date.`;
    }
    if (rule.start_date > rule.end_date) {
      return `Calendar rule ${index + 1} has a From Date after the To Date.`;
    }
  }
  return '';
}

function audienceLabel(audience) {
  return {
    students: 'Students Only',
    staff: 'Staff Only',
    both: 'Students and Staff',
  }[audience] || audience;
}

function dayTypeLabel(dayType) {
  return {
    holiday: 'Holiday',
    working: 'Working Day',
    attendance_not_conducted: 'Attendance Not Conducted',
  }[dayType] || dayType;
}

export function SettingsPage({ token, notify }) {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let ignore = false;

    async function loadSettings() {
      setLoading(true);
      setError('');
      try {
        const response = await settingsApi.get(token);
        if (!ignore) {
          setSettings(normalizeSettings(response));
        }
      } catch (requestError) {
        if (!ignore) {
          setSettings(null);
          setError(getApiErrorMessage(requestError, 'Unable to load settings.'));
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }

    loadSettings();
    return () => {
      ignore = true;
    };
  }, [token]);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!settings) {
      return;
    }

    const timingValidationError = validateTimingWindows(settings);
    if (timingValidationError) {
      setError(timingValidationError);
      return;
    }

    const ruleValidationError = validateCalendarRules(settings.calendar_rules || []);
    if (ruleValidationError) {
      setError(ruleValidationError);
      return;
    }

    setSaving(true);
    setError('');

    try {
      const payload = {
        holidays: [],
        calendar_rules: (settings.calendar_rules || []).map((rule) => ({
          start_date: rule.start_date,
          end_date: rule.end_date,
          audience: rule.audience,
          day_type: rule.day_type,
          reason: String(rule.reason || '').trim() || null,
        })),
        student_attendance: {
          morning_time_start: `${toTimeInput(settings.student_attendance.morning_time_start)}:00`,
          morning_time_end: `${toTimeInput(settings.student_attendance.morning_time_end)}:00`,
          afternoon_time_start: `${toTimeInput(settings.student_attendance.afternoon_time_start)}:00`,
          afternoon_time_end: `${toTimeInput(settings.student_attendance.afternoon_time_end)}:00`,
        },
        staff_attendance: {
          morning_time_start: `${toTimeInput(settings.staff_attendance.morning_time_start)}:00`,
          morning_time_end: `${toTimeInput(settings.staff_attendance.morning_time_end)}:00`,
          evening_time_start: `${toTimeInput(settings.staff_attendance.evening_time_start)}:00`,
          evening_time_end: `${toTimeInput(settings.staff_attendance.evening_time_end)}:00`,
        },
      };
      const response = await settingsApi.update(token, payload);
      setSettings(normalizeSettings(response));
      notify('success', 'Settings saved', 'Student timings, staff timings, and academic calendar rules were updated.');
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, 'Unable to save settings.'));
    } finally {
      setSaving(false);
    }
  }

  function updateTimingBlock(blockName, field, value) {
    setSettings((current) => ({
      ...current,
      [blockName]: {
        ...(current?.[blockName] || {}),
        [field]: value,
      },
    }));
  }

  function updateCalendarRule(index, field, value) {
    setSettings((current) => ({
      ...current,
      calendar_rules: (current?.calendar_rules || []).map((rule, ruleIndex) => (
        ruleIndex === index ? { ...rule, [field]: value } : rule
      )),
    }));
  }

  function addCalendarRule(dayType = 'holiday') {
    setSettings((current) => ({
      ...(current || emptySettings),
      calendar_rules: [
        ...(current?.calendar_rules || []),
        { ...emptyRule, day_type: dayType },
      ],
    }));
  }

  function removeCalendarRule(index) {
    setSettings((current) => ({
      ...current,
      calendar_rules: (current?.calendar_rules || []).filter((_, ruleIndex) => ruleIndex !== index),
    }));
  }

  if (loading) {
    return <LoadingState label="Loading attendance settings..." />;
  }

  if (!settings) {
    return <EmptyState title="Settings unavailable" message={error || 'Unable to load attendance settings.'} />;
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="System Settings"
        subtitle="Configure separate student and staff attendance timings, then manage shared academic calendar rules for both audiences."
      />

      {error ? <Notice tone="danger" title="Settings Error">{error}</Notice> : null}

      <Notice tone="info" title="Separate Attendance Windows">
        Student attendance continues to use morning and afternoon sessions. Staff attendance now uses a separate morning and evening timing window, while the calendar rules below remain shared across students, staff, or both.
      </Notice>

      <form className="page-stack" onSubmit={handleSubmit}>
        <Panel
          title="Student Attendance Timing"
          subtitle="These timings control student attendance windows, student dashboards, and student-side attendance operations."
        >
          <div className="details-grid details-grid-compact">
            <label className="field">
              <span>Morning Start</span>
              <input
                className="input"
                type="time"
                value={toTimeInput(settings.student_attendance.morning_time_start)}
                onChange={(event) => updateTimingBlock('student_attendance', 'morning_time_start', event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Morning End</span>
              <input
                className="input"
                type="time"
                value={toTimeInput(settings.student_attendance.morning_time_end)}
                onChange={(event) => updateTimingBlock('student_attendance', 'morning_time_end', event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Afternoon Start</span>
              <input
                className="input"
                type="time"
                value={toTimeInput(settings.student_attendance.afternoon_time_start)}
                onChange={(event) => updateTimingBlock('student_attendance', 'afternoon_time_start', event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Afternoon End</span>
              <input
                className="input"
                type="time"
                value={toTimeInput(settings.student_attendance.afternoon_time_end)}
                onChange={(event) => updateTimingBlock('student_attendance', 'afternoon_time_end', event.target.value)}
                required
              />
            </label>
          </div>
        </Panel>

        <Panel
          title="Staff Attendance Timing"
          subtitle="These timings control staff-side attendance windows, staff review screens, and staff session handling."
        >
          <div className="details-grid details-grid-compact">
            <label className="field">
              <span>Morning Start</span>
              <input
                className="input"
                type="time"
                value={toTimeInput(settings.staff_attendance.morning_time_start)}
                onChange={(event) => updateTimingBlock('staff_attendance', 'morning_time_start', event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Morning End</span>
              <input
                className="input"
                type="time"
                value={toTimeInput(settings.staff_attendance.morning_time_end)}
                onChange={(event) => updateTimingBlock('staff_attendance', 'morning_time_end', event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Evening Start</span>
              <input
                className="input"
                type="time"
                value={toTimeInput(settings.staff_attendance.evening_time_start)}
                onChange={(event) => updateTimingBlock('staff_attendance', 'evening_time_start', event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Evening End</span>
              <input
                className="input"
                type="time"
                value={toTimeInput(settings.staff_attendance.evening_time_end)}
                onChange={(event) => updateTimingBlock('staff_attendance', 'evening_time_end', event.target.value)}
                required
              />
            </label>
          </div>
        </Panel>

        <Panel
          title="Academic Calendar Rules"
          subtitle="These shared rules still decide whether a date is working, holiday, or attendance-not-conducted for students, staff, or both."
        >
          <div className="field">
            <span>Calendar Rules</span>
            <div className="calendar-rule-list">
              {(settings.calendar_rules || []).map((rule, index) => (
                <div key={`${rule.start_date || 'rule'}-${rule.end_date || index}-${index}`} className="calendar-rule-card">
                  <div className="details-grid details-grid-compact">
                    <label className="field">
                      <span>From Date</span>
                      <input
                        className="input"
                        type="date"
                        value={rule.start_date}
                        onChange={(event) => updateCalendarRule(index, 'start_date', event.target.value)}
                        required
                      />
                    </label>
                    <label className="field">
                      <span>To Date</span>
                      <input
                        className="input"
                        type="date"
                        value={rule.end_date}
                        min={rule.start_date || undefined}
                        onChange={(event) => updateCalendarRule(index, 'end_date', event.target.value)}
                        required
                      />
                    </label>
                    <label className="field">
                      <span>Audience</span>
                      <select
                        className="input"
                        value={rule.audience}
                        onChange={(event) => updateCalendarRule(index, 'audience', event.target.value)}
                      >
                        <option value="both">{audienceLabel('both')}</option>
                        <option value="students">{audienceLabel('students')}</option>
                        <option value="staff">{audienceLabel('staff')}</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>Day Type</span>
                      <select
                        className="input"
                        value={rule.day_type}
                        onChange={(event) => updateCalendarRule(index, 'day_type', event.target.value)}
                      >
                        <option value="holiday">{dayTypeLabel('holiday')}</option>
                        <option value="working">{dayTypeLabel('working')}</option>
                        <option value="attendance_not_conducted">{dayTypeLabel('attendance_not_conducted')}</option>
                      </select>
                    </label>
                    <label className="field field-span-2">
                      <span>Reason</span>
                      <input
                        className="input"
                        value={rule.reason}
                        onChange={(event) => updateCalendarRule(index, 'reason', event.target.value)}
                        placeholder="e.g. Semester Holidays, Staff Training, Kiosk Not Activated"
                      />
                    </label>
                  </div>
                  <div className="calendar-rule-actions">
                    <span>{audienceLabel(rule.audience)} - {dayTypeLabel(rule.day_type)}</span>
                    <button type="button" className="btn-secondary" onClick={() => removeCalendarRule(index)}>
                      Remove Rule
                    </button>
                  </div>
                </div>
              ))}

              {!settings.calendar_rules.length ? (
                <Notice tone="warning" title="No calendar rules added">
                  Add a rule below for semester holidays, student-only holidays, staff-only working days, or attendance-not-conducted days.
                </Notice>
              ) : null}

              <div className="chip-group">
                <button type="button" className="btn-secondary" onClick={() => addCalendarRule('holiday')}>
                  Add Holiday Rule
                </button>
                <button type="button" className="btn-secondary" onClick={() => addCalendarRule('working')}>
                  Add Working Day Rule
                </button>
                <button type="button" className="btn-secondary" onClick={() => addCalendarRule('attendance_not_conducted')}>
                  Add Not Conducted Rule
                </button>
              </div>
            </div>
          </div>
        </Panel>

        <div className="enrollment-actions">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Saving Settings...' : 'Save Settings'}
          </button>
        </div>
      </form>
    </div>
  );
}
