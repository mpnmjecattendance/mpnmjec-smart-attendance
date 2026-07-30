import { CalendarRange, KeyRound, LayoutDashboard, LogOut, Pencil, Settings, Users, Menu, X, User } from 'lucide-react';
import { useState } from 'react';
import { NavLink } from 'react-router-dom';

import { classNames, roleLabel } from '../utils';

const NAV_ITEMS = {
  admin: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/dashboard/attendance', label: 'Institute Attendance', icon: CalendarRange },
    { to: '/dashboard/data-exports', label: 'Data Exports', icon: Users },
    { to: '/dashboard/users', label: 'Enrollment & Identity', icon: Users },
    { to: '/dashboard/edit', label: 'Edit Records', icon: Pencil },
    { to: '/dashboard/change-password', label: 'Change Password', icon: KeyRound },
    { to: '/dashboard/settings', label: 'Settings', icon: Settings },
  ],
  hod: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/dashboard/my-attendance', label: 'My Attendance', icon: User },
    { to: '/dashboard/change-password', label: 'Change Password', icon: KeyRound },
    { to: '/dashboard/attendance', label: 'Department Attendance', icon: CalendarRange },
  ],
  advisor: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/dashboard/my-attendance', label: 'My Attendance', icon: User },
    { to: '/dashboard/users', label: 'Enrollment & Identity', icon: Users },
    { to: '/dashboard/edit', label: 'Edit Records', icon: Pencil },
    { to: '/dashboard/change-password', label: 'Change Password', icon: KeyRound },
    { to: '/dashboard/attendance', label: 'Attendance Management', icon: CalendarRange },
  ],
  staff: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/dashboard/my-attendance', label: 'My Attendance', icon: User },
    { to: '/dashboard/change-password', label: 'Change Password', icon: KeyRound },
    { to: '/dashboard/attendance', label: 'Attendance Management', icon: CalendarRange },
    { to: '/dashboard/student-export', label: 'Student Data Export', icon: Users },
  ],
  principal: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/dashboard/my-attendance', label: 'My Attendance', icon: User },
    { to: '/dashboard/change-password', label: 'Change Password', icon: KeyRound },
    { to: '/dashboard/attendance', label: 'Institute Insights', icon: CalendarRange },
  ],
  student: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/dashboard/attendance', label: 'Attendance', icon: CalendarRange },
  ],
};

export function AppShell({ user, onLogout, children }) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const role = String(user?.role || '').toLowerCase();
  const navItems = role === 'staff'
    ? NAV_ITEMS.staff.filter((item) => item.to !== '/dashboard/attendance' && item.to !== '/dashboard/student-export')
    : NAV_ITEMS[role] || NAV_ITEMS.student;
  const resolvedNavItems = role === 'staff' && user?.is_class_advisor
    ? NAV_ITEMS.staff
    : role === 'staff'
      ? navItems
      : NAV_ITEMS[role] || NAV_ITEMS.student;

  const closeMenu = () => setIsMobileMenuOpen(false);

  return (
    <div className="app-shell">
      {isMobileMenuOpen && <div className="sidebar-overlay" onClick={closeMenu} />}
      
      <aside className={classNames('sidebar', isMobileMenuOpen && 'sidebar-open')}>
        <div className="brand-block">
          <img src="/image-r2.png" alt="MPNMJEC Logo" style={{ width: '40px', height: '40px', background: 'white', borderRadius: '50%', padding: '4px' }} />
          <div>
            <h1>MPNMJEC</h1>
            <p>Smart Attendance System</p>
          </div>
          <button className="mobile-close-btn" onClick={closeMenu}>
            <X size={20} />
          </button>
        </div>

        <nav className="sidebar-nav">
          {resolvedNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/dashboard'}
              onClick={closeMenu}
              className={({ isActive }) => classNames('sidebar-link', isActive && 'active')}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <button type="button" className="sidebar-link sidebar-link-logout" onClick={onLogout}>
          <LogOut size={18} />
          <span>Logout</span>
        </button>
      </aside>

      <div className="shell-main">
        <header className="topbar">
          <div className="topbar-left-cluster">
            <button className="mobile-menu-btn" onClick={() => setIsMobileMenuOpen(true)}>
              <Menu size={24} />
            </button>
            <div className="topbar-brand-title">
              <strong>MPNMJEC Smart Attendance System</strong>
              <p>{roleLabel(role)}</p>
            </div>
          </div>
          <div className="topbar-user">
            <div className="topbar-user-info">
              <strong>{user.name}</strong>
              <p>{user.identifier}</p>
            </div>
            <div className="user-avatar" style={{ borderRadius: '50%' }}><User size={20} /></div>
          </div>
        </header>

        <main className="page-shell">{children}</main>
      </div>
    </div>
  );
}
