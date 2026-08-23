// Usage: router.get('/admin/users', authJwt, rbac('ADMIN'), handler)
function rbac(...allowedRoles) {
  return function (req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient role for this action' });
    }
    next();
  };
}

module.exports = rbac;
