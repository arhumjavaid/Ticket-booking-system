import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function NavBar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <nav className="navbar">
      <div className="navbar-brand">
        <Link to="/">Ticketing</Link>
      </div>
      <div className="navbar-links">
        <Link to="/">Events</Link>
        {user && <Link to="/bookings">My Bookings</Link>}
        {user?.role === 'ADMIN' && <Link to="/admin">Admin</Link>}
        {user?.role === 'ADMIN' && <Link to="/admin/analytics">Analytics</Link>}
      </div>
      <div className="navbar-user">
        {user ? (
          <>
            <span>{user.name}</span>
            <button
              onClick={async () => {
                await logout();
                navigate('/login');
              }}
            >
              Logout
            </button>
          </>
        ) : (
          <>
            <Link to="/login">Login</Link>
            <Link to="/register">Register</Link>
          </>
        )}
      </div>
    </nav>
  );
}
