const pool = require('../db');

const audit = async (action, performedBy, targetType = null, targetId = null, details = null, ip = null) => {
  try {
    await pool.query(
      `INSERT INTO audit_log (action, performed_by, target_type, target_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [action, performedBy, targetType, targetId, details ? JSON.stringify(details) : null, ip]
    );
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
};

module.exports = { audit };
