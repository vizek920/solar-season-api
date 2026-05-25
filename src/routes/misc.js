const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { authClan, authAdmin, authSuperAdmin } = require('../middleware/auth');
const { audit } = require('../utils/audit');

// ===== NOTIFICATIONS =====
const notifRouter = require('express').Router();

notifRouter.get('/', authClan, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM notifications
       WHERE (clan_id = $1 OR is_global = true) AND clan_id IS NOT NULL OR is_global = true
       ORDER BY created_at DESC LIMIT 30`,
      [req.clan.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

notifRouter.get('/unread-count', authClan, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) FROM notifications WHERE (clan_id = $1 OR is_global = true) AND is_read = false`,
      [req.clan.id]
    );
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

notifRouter.patch('/:id/read', authClan, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET is_read = true WHERE id = $1 AND clan_id = $2', [req.params.id, req.clan.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

notifRouter.patch('/read-all', authClan, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET is_read = true WHERE clan_id = $1', [req.clan.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// إرسال إشعار عام (أدمن)
notifRouter.post('/broadcast', authAdmin, async (req, res) => {
  const { title, message, type } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  try {
    await pool.query(
      `INSERT INTO notifications (is_global, title, message, type) VALUES (true, $1, $2, $3)`,
      [title || 'إشعار', message, type || 'info']
    );
    await audit('broadcast_sent', req.admin.username, null, null, { title, message }, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== SEASONS =====
const seasonRouter = require('express').Router();

seasonRouter.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM seasons ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

seasonRouter.get('/active', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM seasons WHERE is_active = true LIMIT 1');
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

seasonRouter.post('/', authAdmin, async (req, res) => {
  const { name, description, start_at, end_at } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const result = await pool.query(
      'INSERT INTO seasons (name, description, start_at, end_at) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, description, start_at, end_at]
    );
    await audit('season_created', req.admin.username, 'season', result.rows[0].id, { name }, req.ip);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

seasonRouter.patch('/:id/activate', authAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE seasons SET is_active = false');
    await pool.query('UPDATE seasons SET is_active = true WHERE id = $1', [req.params.id]);
    await audit('season_activated', req.admin.username, 'season', req.params.id, null, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== ADMIN MANAGEMENT =====
const adminRouter = require('express').Router();

// إنشاء أدمن جديد (superadmin فقط)
adminRouter.post('/', authSuperAdmin, async (req, res) => {
  const { username, email, password, role, discord_id } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO admins (username, email, password_hash, role, discord_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, username, email, role',
      [username, email.toLowerCase(), hash, role || 'moderator', discord_id || null]
    );
    await audit('admin_created', req.admin.username, 'admin', result.rows[0].id, { username, role }, req.ip);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username or email exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

// قائمة الأدمنز
adminRouter.get('/', authSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, email, role, discord_id, is_active, created_at FROM admins ORDER BY created_at');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Audit log (superadmin)
adminRouter.get('/audit-log', authSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// إحصائيات عامة
adminRouter.get('/stats', authAdmin, async (req, res) => {
  try {
    const [clans, tasks, submissions, pending] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM clans WHERE is_active = true'),
      pool.query('SELECT COUNT(*) FROM tasks WHERE is_active = true'),
      pool.query('SELECT COUNT(*) FROM task_submissions'),
      pool.query("SELECT COUNT(*) FROM task_submissions WHERE status = 'pending'")
    ]);
    res.json({
      total_clans: parseInt(clans.rows[0].count),
      total_tasks: parseInt(tasks.rows[0].count),
      total_submissions: parseInt(submissions.rows[0].count),
      pending_reviews: parseInt(pending.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = { notifRouter, seasonRouter, adminRouter };
