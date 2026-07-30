import { useMemo, useState } from 'react';

import { authApi, getApiErrorMessage } from '../api';
import { Notice, PageHeader, Panel, PasswordField } from '../components/Ui';
import { roleLabel } from '../utils';

const EMPTY_FORM = {
  current_password: '',
  new_password: '',
  confirm_password: '',
};

export function ChangePasswordPage({ token, user, notify }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const passwordMismatch = useMemo(() => (
    Boolean(form.confirm_password) && form.new_password !== form.confirm_password
  ), [form.confirm_password, form.new_password]);

  const sameAsCurrent = useMemo(() => (
    Boolean(form.current_password) && Boolean(form.new_password) && form.current_password === form.new_password
  ), [form.current_password, form.new_password]);

  const isValid = (
    Boolean(form.current_password)
    && form.new_password.length >= 6
    && form.confirm_password.length >= 6
    && !passwordMismatch
    && !sameAsCurrent
  );

  async function handleSubmit(event) {
    event.preventDefault();
    if (!isValid) {
      setError('Enter your current password, choose a new password with at least 6 characters, and make sure both new password fields match.');
      return;
    }

    setSaving(true);
    setError('');

    try {
      const response = await authApi.changePassword(token, {
        current_password: form.current_password,
        new_password: form.new_password,
      });
      setForm(EMPTY_FORM);
      notify('success', 'Password updated', response.message || 'Your password has been changed successfully.');
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, 'Unable to change your password right now.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="Change Password"
        subtitle={`Update the sign-in password for your ${roleLabel(user?.role).toLowerCase()} account.`}
      />

      <Notice tone="info" title="Security">
        Use your current password to confirm your identity first. Your new password must be at least 6 characters long and should be something you do not reuse elsewhere.
      </Notice>

      {error ? <Notice tone="danger" title="Password Update Error">{error}</Notice> : null}
      {sameAsCurrent ? (
        <Notice tone="warning" title="Choose a Different Password">
          Your new password must be different from the current password.
        </Notice>
      ) : null}
      {passwordMismatch ? (
        <Notice tone="warning" title="Passwords Do Not Match">
          The new password and confirmation password must match exactly.
        </Notice>
      ) : null}

      <Panel title="Update Password" subtitle="This changes the password used for staff-side sign-in.">
        <form className="form-grid form-grid-compact" onSubmit={handleSubmit}>
          <label className="field">
            <span>Current Password</span>
            <PasswordField
              className="input"
              value={form.current_password}
              onChange={(event) => setForm((current) => ({ ...current, current_password: event.target.value }))}
              placeholder="Enter your current password"
              autoComplete="current-password"
              required
            />
          </label>
          <label className="field">
            <span>New Password</span>
            <PasswordField
              className="input"
              value={form.new_password}
              onChange={(event) => setForm((current) => ({ ...current, new_password: event.target.value }))}
              placeholder="Enter a new password"
              autoComplete="new-password"
              minLength={6}
              required
            />
          </label>
          <label className="field">
            <span>Confirm New Password</span>
            <PasswordField
              className="input"
              value={form.confirm_password}
              onChange={(event) => setForm((current) => ({ ...current, confirm_password: event.target.value }))}
              placeholder="Re-enter the new password"
              autoComplete="new-password"
              minLength={6}
              required
            />
          </label>

          <div className="enrollment-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setForm(EMPTY_FORM);
                setError('');
              }}
              disabled={saving}
            >
              Clear
            </button>
            <button type="submit" className="btn-primary" disabled={!isValid || saving}>
              {saving ? 'Updating Password...' : 'Change Password'}
            </button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
