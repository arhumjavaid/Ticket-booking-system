import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function NavBar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <nav className="navbar">
      <Link to="/" className="brand" aria-label="BookMe home">
        <span className="brand-mark" aria-hidden="true">
          ★
        </span>
        <span>
          Book<span className="accent">Me</span>
        </span>
      </Link>
      <div className="navbar-links">
        <NavLink to="/" end>
          Events
        </NavLink>
        {user && user.role !== 'ADMIN' && <NavLink to="/bookings">My Tickets</NavLink>}
        {user?.role === 'ADMIN' && (
          <NavLink to="/admin" end>
            Admin
          </NavLink>
        )}
        {user?.role === 'ADMIN' && <NavLink to="/admin/analytics">Analytics</NavLink>}
      </div>
      <div className="navbar-user">
        {user ? (
          <>
            <span className="avatar" aria-hidden="true">
              {user.name.charAt(0).toUpperCase()}
            </span>
            <span className="user-name">{user.name}</span>
            <button
              className="btn-ghost btn-sm"
              onClick={async () => {
                await logout();
                navigate('/login');
              }}
            >
              Log out
            </button>
          </>
        ) : (
          <>
            <Link to="/login" className="nav-plain">
              Log in
            </Link>
            <Link to="/register" className="btn btn-sm">
              Sign up
            </Link>
          </>
        )}
      </div>
    </nav>
  );
}
