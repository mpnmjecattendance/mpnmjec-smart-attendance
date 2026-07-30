import { useState } from 'react';
import { AlertCircle, Inbox, LoaderCircle, Activity, Users, CheckCircle, Clock, ArrowUpRight, Eye, EyeOff } from 'lucide-react';

import { classNames, formatPercent, statusLabel, statusTone } from '../utils';

export function PageHeader({ title, subtitle, action }) {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {action ? <div className="page-header-action">{action}</div> : null}
    </div>
  );
}

export function Panel({ title, subtitle, action, children, className }) {
  return (
    <section className={classNames('panel', className)}>
      {(title || subtitle || action) && (
        <div className="panel-header">
          <div>
            {title ? <h2 className="panel-title">{title}</h2> : null}
            {subtitle ? <p className="panel-subtitle">{subtitle}</p> : null}
          </div>
          {action ? <div>{action}</div> : null}
        </div>
      )}
      {children}
    </section>
  );
}

export function StatGrid({ children }) {
  return <div className="stats-grid">{children}</div>;
}

export function StatCard({ label, value, helper, tone = 'neutral' }) {
  let Icon = Activity;
  if (/student/i.test(label)) Icon = Users;
  else if (/account|staff/i.test(label)) Icon = Users;
  else if (/present|attendance/i.test(label)) Icon = CheckCircle;
  else if (/average/i.test(label)) Icon = Clock;

  return (
    <div className={classNames('stat-card', `stat-card-${tone}`)}>
      <div className="stat-card-header">
        <span className="stat-label">{label}</span>
        <div className={classNames('stat-icon', `stat-icon-${tone}`)}><Icon size={18} /></div>
      </div>
      <strong className="stat-value">{value}</strong>
      <div className="stat-helper-block">
        <div className="stat-sparkline"><ArrowUpRight size={14} /></div>
        {helper ? <span className="stat-helper">{helper}</span> : <span className="stat-helper">Live status</span>}
      </div>
    </div>
  );
}

export function Notice({ tone = 'neutral', title, children }) {
  return (
    <div className={classNames('notice', `notice-${tone}`)}>
      <AlertCircle size={18} />
      <div>
        {title ? <strong>{title}</strong> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({ title, message }) {
  return (
    <div className="empty-state">
      <Inbox size={28} />
      <h3>{title}</h3>
      <p>{message}</p>
    </div>
  );
}

export function LoadingState({ label = 'Loading...' }) {
  return (
    <div className="loading-state">
      <LoaderCircle className="spin" size={24} />
      <span>{label}</span>
    </div>
  );
}

export function PasswordField({
  value,
  onChange,
  placeholder,
  required = false,
  minLength,
  className = 'input-field',
  autoComplete = 'current-password',
  ...props
}) {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="password-input-wrap">
      <input
        {...props}
        className={className}
        type={showPassword ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        required={required}
        minLength={minLength}
        autoComplete={autoComplete}
      />
      <button
        type="button"
        className="show-pass-btn"
        onClick={() => setShowPassword((current) => !current)}
        aria-label={showPassword ? 'Hide password' : 'Show password'}
        aria-pressed={showPassword}
      >
        {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </div>
  );
}

export function StatusBadge({ status }) {
  return <span className={classNames('badge', `badge-${statusTone(status)}`)}>{statusLabel(status)}</span>;
}

export function ProgressBar({ value, tone = 'success' }) {
  const safeValue = Math.max(0, Math.min(100, Number(value ?? 0)));
  return (
    <div className="progress-track">
      <div className={classNames('progress-fill', `progress-fill-${tone}`)} style={{ width: `${safeValue}%` }} />
    </div>
  );
}

export function ComparisonBars({ items, emptyMessage = 'No analytics available yet.' }) {
  if (!items?.length) {
    return <EmptyState title="No comparison data" message={emptyMessage} />;
  }

  return (
    <div className="comparison-list">
      {items.map((item) => (
        <div className="comparison-row" key={item.label}>
          <div className="comparison-meta">
            <strong>{item.label}</strong>
            <span>{item.meta || formatPercent(item.value)}</span>
          </div>
          <div className="comparison-bar">
            <div className="comparison-bar-fill" style={{ width: `${Math.max(0, Math.min(100, Number(item.value || 0)))}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function TrendChart({ points }) {
  if (!points?.length) {
    return <EmptyState title="No trend data" message="Attendance trend will appear once sessions are recorded." />;
  }

  return (
    <div className="trend-grid">
      {points.map((point) => (
        <div className="trend-point" key={point.label}>
          <div className="trend-bar-shell">
            <div className="trend-bar" style={{ height: `${Math.max(10, Number(point.value || 0))}%` }} />
          </div>
          <strong>{formatPercent(point.value)}</strong>
          <span>{point.label}</span>
        </div>
      ))}
    </div>
  );
}

export function Table({
  columns,
  rows,
  emptyTitle,
  emptyMessage,
  rowKey,
  className,
  tableClassName,
}) {
  if (!rows?.length) {
    return <EmptyState title={emptyTitle} message={emptyMessage} />;
  }

  return (
    <div className={classNames('table-shell', className)}>
      <table className={classNames('data-table', tableClassName)}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={classNames(column.className, column.headerClassName)}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={rowKey ? rowKey(row) : index}>
              {columns.map((column) => (
                <td key={column.key} className={classNames(column.className, column.cellClassName)}>
                  {column.render ? column.render(row) : row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPageChange, isLoading = false }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pagination">
      <button
        type="button"
        className="btn-secondary"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1 || isLoading}
      >
        Previous
      </button>
      {isLoading ? (
        <span className="pagination-loading">
          <LoaderCircle className="spin" size={16} />
          Loading...
        </span>
      ) : (
        <span>
          Page {page} of {totalPages}
        </span>
      )}
      <button
        type="button"
        className="btn-secondary"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages || isLoading}
      >
        Next
      </button>
    </div>
  );
}

export function ToastStack({ toasts }) {
  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <div key={toast.id} className={classNames('toast', `toast-${toast.tone}`)}>
          <strong>{toast.title}</strong>
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  );
}
