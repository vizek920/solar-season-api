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
       WHERE clan_id = $1 OR is_global = true
       ORDER BY created_at DESC LIMIT 50`,
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
      `SELECT COUNT(*) FROM notifications 
       WHERE (clan_id = $1 OR is_global = true) AND is_read = false`,
      [req.clan.id]
    );
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

notifRouter.patch('/read-all', authClan, async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET is_read = true WHERE clan_id = $1 OR is_global = true',
      [req.clan.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

notifRouter.patch('/:id/read', authClan, async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET is_read = true WHERE id = $1',
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

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
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const result = await pool.query(
      'INSERT INTO seasons (name, description) VALUES ($1, $2) RETURNING *',
      [name, description || null]
    );
    await audit('season_created', req.admin.username, 'season', result.rows[0].id, { name }, req.ip);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

seasonRouter.patch('/:id', authAdmin, async (req, res) => {
  const { name, description } = req.body;
  try {
    const result = await pool.query(
      `UPDATE seasons SET
        name = COALESCE($1, name),
        description = COALESCE($2, description)
       WHERE id = $3 RETURNING *`,
      [name, description, req.params.id]
    );
    res.json(result.rows[0]);
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

seasonRouter.patch('/:id/deactivate', authAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE seasons SET is_active = false WHERE id = $1', [req.params.id]);
    await audit('season_deactivated', req.admin.username, 'season', req.params.id, null, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// إعادة ضبط XP كل الكلانات (للانتقال لسيزون جديد)
seasonRouter.post('/:id/reset-xp', authSuperAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE clans SET xp = 0, immunity_count = 0, is_eliminated = false');
    await audit('season_xp_reset', req.admin.username, 'season', req.params.id, null, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== ADMIN MANAGEMENT =====
const adminRouter = require('express').Router();

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

adminRouter.get('/', authSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, role, discord_id, is_active, created_at FROM admins ORDER BY created_at'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

adminRouter.get('/audit-log', authSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

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

// Big Screen data
adminRouter.get('/bigscreen', async (req, res) => {
  try {
    const [clans, season, tasks] = await Promise.all([
      pool.query(`
        SELECT id, name, card_type, xp, immunity_count, is_eliminated, logo_url,
               RANK() OVER (ORDER BY xp DESC) as rank
        FROM clans WHERE is_active = true ORDER BY xp DESC LIMIT 20
      `),
      pool.query('SELECT * FROM seasons WHERE is_active = true LIMIT 1'),
      pool.query(`
        SELECT id, title, card_category, xp_reward, difficulty, deadline, is_frozen
        FROM tasks WHERE is_active = true AND is_frozen = false
        AND (deadline IS NULL OR deadline > NOW())
        ORDER BY created_at DESC LIMIT 5
      `)
    ]);
    res.json({
      clans: clans.rows,
      season: season.rows[0] || null,
      tasks: tasks.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = { notifRouter, seasonRouter, adminRouter };
