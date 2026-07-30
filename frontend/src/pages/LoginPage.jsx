import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { authApi, getApiErrorMessage } from '../api';
import { PasswordField } from '../components/Ui';

export function LoginPage({
  onLogin,
  initialTab = 'student',
  allowedTabs = ['student', 'staff'],
  title = 'Sign In',
  subtitle,
  externalError = '',
}) {
  const availableTabs = useMemo(() => {
    const normalized = (allowedTabs || []).map((tabName) => String(tabName || '').toLowerCase()).filter(Boolean);
    return normalized.length ? normalized : ['student', 'staff'];
  }, [allowedTabs]);
  const resolvedInitialTab = availableTabs.includes(initialTab) ? initialTab : availableTabs[0];

  const [tab, setTab] = useState(resolvedInitialTab);
  const [identifier, setIdentifier] = useState('');
  const [studentDob, setStudentDob] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!availableTabs.includes(tab)) {
      setTab(resolvedInitialTab);
    }
  }, [availableTabs, resolvedInitialTab, tab]);

  const isStudentLogin = tab === 'student';
  const identifierLabel = isStudentLogin ? 'Register Number' : 'Staff Email';
  const placeholder = isStudentLogin ? 'e.g. 911520104040' : 'staff@institution.edu';
  const headerSubtitle = subtitle || (
    isStudentLogin
      ? 'Enter your register number and date of birth to access the student portal'
      : 'Use your staff email and password to access the system'
  );
  const displayedError = error || externalError;

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    try {
      const session = isStudentLogin
        ? await authApi.studentAccess(identifier, studentDob)
        : await authApi.login(identifier, password);
      onLogin({
        token: session.access_token,
        user: session.user,
      });
    } catch (requestError) {
      setError(
        getApiErrorMessage(
          requestError,
          isStudentLogin
            ? 'Unable to access the student portal. Please verify the register number and date of birth.'
            : 'Unable to sign in. Please verify your email and password.'
        )
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-split-layout">
      <div className="product-watermark">6ixminds Labs</div>

      {/* Left Branding Section */}
      <section className="login-brand-side">
        <div className="brand-content">
          <div className="brand-logo-large">
            <img src="/image-r2.png" alt="MPNMJEC Logo" style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 'inherit' }} />
          </div>
          <h1>MPNMJEC Smart Attendance System</h1>
          <p>Smart, reliable attendance system for academic institutions</p>
        </div>
      </section>

      {/* Right Form Section */}
      <section className="login-form-side">
        <div className="login-card">
          <div className="login-header">
            <h2>{title}</h2>
            <p>{headerSubtitle}</p>
          </div>

          {availableTabs.length > 1 ? (
            <div className="login-tabs">
              {availableTabs.includes('student') ? (
                <button
                  type="button"
                  className={`login-tab ${tab === 'student' ? 'active' : ''}`}
                  onClick={() => {
                    setTab('student');
                    setPassword('');
                    setStudentDob('');
                    setError('');
                  }}
                >
                  Student Login
                </button>
              ) : null}
              {availableTabs.includes('staff') ? (
                <button
                  type="button"
                  className={`login-tab ${tab === 'staff' ? 'active' : ''}`}
                  onClick={() => {
                    setTab('staff');
                    setError('');
                  }}
                >
                  Staff Login
                </button>
              ) : null}
            </div>
          ) : null}

          <form className="login-form" onSubmit={handleSubmit}>
            {displayedError && <div className="notice notice-danger">{displayedError}</div>}

            <label className="field-group">
              <span>{identifierLabel}</span>
              <input
                className="input-field"
                type={isStudentLogin ? 'text' : 'email'}
                placeholder={placeholder}
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
              />
            </label>

            {isStudentLogin ? (
              <label className="field-group">
                <span>Date of Birth</span>
                <input
                  className="input-field"
                  type="date"
                  value={studentDob}
                  onChange={(e) => setStudentDob(e.target.value)}
                  required
                />
              </label>
            ) : (
              <label className="field-group">
                <div className="password-header">
                  <span>Password</span>
                </div>
                <PasswordField
                  className="input-field"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
            )}

            <button type="submit" className="login-submit-btn" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="spin" size={18} />
                  <span>{isStudentLogin ? 'Opening Portal...' : 'Signing In...'}</span>
                </>
              ) : (
                isStudentLogin ? 'Enter Student Portal' : 'Sign In'
              )}
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
