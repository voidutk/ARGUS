const { unauthorized, forbidden } = require('../lib/errors');

/**
 * Role gate. Usage: `router.get('/admin/users', rbac('ADMIN', 'SUPERVISOR'), handler)`.
 *
 * Deliberately explicit rather than hierarchical. A ranking ("ADMIN outranks
 * SUPERVISOR outranks INVESTIGATOR") reads as tidier right up to the first role
 * that is not a superset of the one below it — an ANALYST needs analytics an
 * INVESTIGATOR does not, and needs none of their case-management rights. Listing
 * the roles that may call each route keeps the answer to "who can do this?"
 * readable at the route table.
 */
function rbac(...allowedRoles) {
  return function requireRole(req, res, next) {
    if (!req.user) return next(unauthorized());
    if (!allowedRoles.includes(req.user.role)) {
      return next(forbidden(
        `This action requires the ${allowedRoles.join(' or ')} role; you are ${req.user.role}`
      ));
    }
    next();
  };
}

module.exports = rbac;
