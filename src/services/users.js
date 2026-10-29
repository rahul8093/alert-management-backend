// Users come from the existing tables m_user, m_user_role, m_role (read only).
const { srcQuery, S } = require('../db');
const config = require('../config');

async function rolesFor(userId, fallbackRoleId) {
  const rows = await srcQuery(
    `SELECT ur.role_id, r.role_name
       FROM ${S('m_user_role')} ur
       LEFT JOIN ${S('m_role')} r ON r.role_id = ur.role_id
      WHERE ur.user_id = ? AND (ur.status IS NULL OR ur.status = 'A')`,
    [userId],
  );
  if (!rows.length && fallbackRoleId) {
    const r = await srcQuery(`SELECT role_id, role_name FROM ${S('m_role')} WHERE role_id = ?`, [fallbackRoleId]);
    return r.length ? r : [{ role_id: fallbackRoleId, role_name: null }];
  }
  return rows;
}

function toPublicUser(u, roles) {
  const roleIds = roles.map((r) => Number(r.role_id));
  return {
    userId: u.user_id,
    name: (u.user_name || u.user_id || '').trim(),
    email: u.email_id || null,
    mobile: u.mobile_no || null,
    companyId: u.company_id || null,
    roles: roles.map((r) => ({ id: Number(r.role_id), name: r.role_name })),
    isAdmin: roleIds.some((id) => config.adminRoleIds.includes(id)),
  };
}

/** Login lookup by user id or email. Returns the raw row (with password) or null. */
async function findForLogin(username) {
  const rows = await srcQuery(
    `SELECT user_id, user_name, company_id, password, email_id, mobile_no, role_id, status
       FROM ${S('m_user')}
      WHERE user_id = ? OR (email_id IS NOT NULL AND email_id <> '' AND email_id = ?)
      LIMIT 2`,
    [username, username],
  );
  // Prefer the exact user_id match if an email matched another user too
  return rows.find((r) => r.user_id.toLowerCase() === String(username).toLowerCase()) || rows[0] || null;
}

async function getActiveUser(userId) {
  const rows = await srcQuery(
    `SELECT user_id, user_name, company_id, email_id, mobile_no, role_id, status
       FROM ${S('m_user')} WHERE user_id = ? LIMIT 1`,
    [userId],
  );
  const u = rows[0];
  if (!u || u.status !== 'A') return null;
  return toPublicUser(u, await rolesFor(u.user_id, u.role_id));
}

module.exports = { findForLogin, getActiveUser, rolesFor, toPublicUser };
