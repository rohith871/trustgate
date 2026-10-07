const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'trustgate_jwt_secret_key_2026';

function authenticateToken(req, res, next) {
  let token = null;

  if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required. Please log in.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'INVALID_TOKEN', message: 'Session expired or invalid. Please log in again.' });
  }
}

function requireRole(allowedRole) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== allowedRole) {
      return res.status(403).json({ error: 'FORBIDDEN', message: `Access denied. Requires ${allowedRole} role.` });
    }
    next();
  };
}

module.exports = {
  JWT_SECRET,
  authenticateToken,
  requireRole
};
