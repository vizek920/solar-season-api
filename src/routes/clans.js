const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { authClan, authAdmin, authSuperAdmin } = require('../middleware/auth');
const { audit } = require('../utils/audit');

// الحصول على الليدربورد العام
router.get('/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, card_type, xp, immunity_count, is_eliminated, logo_url,
             RANK() OVER (ORDER BY xp DESC) as rank
      FROM clans WHERE is_active = true ORDER BY xp DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== ME ROUTES (يجب أن تكون قبل /:id) =====

router.get('/me', authClan, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, card_type, discord_id, logo_url, xp,
              immunity_count, is_eliminated, created_at,
              RANK() OVER (ORDER BY xp DESC) as rank
       FROM clans WHERE id = $1`,
      [req.clan.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/me/xp-log', authClan, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT x.*, t.title as task_title FROM xp_log x
       LEFT JOIN tasks t ON x.task_id = t.id
       WHERE x.clan_id = $1 ORDER BY x.created_at DESC LIMIT 50`,
      [req.clan.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/me/immunity-log', authClan, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM immunity_log WHERE clan_id = $1 ORDER BY created_at DESC',
      [req.clan.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// الحصول على ملف كلان معين (عام) - بعد /me
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, card_type, xp, immunity_count, is_eliminated, logo_url, created_at,
              RANK() OVER (ORDER BY xp DESC) as rank
       FROM clans WHERE id = $1 AND is_active = true`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Clan not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id/members', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT discord_id, username, role, joined_at FROM clan_members WHERE clan_id = $1 ORDER BY joined_at',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id/xp-log', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT x.*, t.title as task_title FROM xp_log x
       LEFT JOIN tasks t ON x.task_id = t.id
       WHERE x.clan_id = $1 ORDER BY x.created_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== ADMIN ROUTES =====

router.post('/', authAdmin, async (req, res) => {
  const { name, email, password, card_type, discord_id } = req.body;
  if (!name || !email || !password || !card_type)
    return res.status(400).json({ error: 'Missing required fields' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO clans (name, email, password_hash, card_type, discord_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, card_type`,
      [name, email.toLowerCase(), hash, card_type, discord_id || null]
    );
    await audit('clan_created', req.admin.username, 'clan', result.rows[0].id, { name, card_type }, req.ip);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Clan name or email already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/:id/xp', authAdmin, async (req, res) => {
  const { amount, reason } = req.body;
  if (amount === undefined) return res.status(400).json({ error: 'Amount required' });
  try {
    await pool.query('BEGIN');
    const result = await pool.query(
      'UPDATE clans SET xp = GREATEST(0, xp + $1) WHERE id = $2 RETURNING xp, name',
      [amount, req.params.id]
    );
    if (!result.rows[0]) { await pool.query('ROLLBACK'); return res.status(404).json({ error: 'Clan not found' }); }
    await pool.query(
      'INSERT INTO xp_log (clan_id, amount, reason, changed_by) VALUES ($1, $2, $3, $4)',
      [req.params.id, amount, reason || 'Manual adjustment', req.admin.username]
    );
    await audit('xp_changed', req.admin.username, 'clan', req.params.id, { amount, reason }, req.ip);
    await pool.query('COMMIT');
    res.json({ new_xp: result.rows[0].xp, clan: result.rows[0].name });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/:id/immunity', authAdmin, async (req, res) => {
  const { action, amount = 1, reason } = req.body;
  if (!action) return res.status(400).json({ error: 'Action required' });
  try {
    let delta = action === 'gained' ? amount : -amount;
    const result = await pool.query(
      'UPDATE clans SET immunity_count = GREATEST(0, immunity_count + $1) WHERE id = $2 RETURNING immunity_count, name',
      [delta, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Clan not found' });
    await pool.query(
      'INSERT INTO immunity_log (clan_id, action, amount, reason, used_by) VALUES ($1, $2, $3, $4, $5)',
      [req.params.id, action, amount, reason || null, req.admin.username]
    );
    await audit('immunity_changed', req.admin.username, 'clan', req.params.id, { action, amount }, req.ip);
    res.json({ immunity_count: result.rows[0].immunity_count });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/:id/eliminate', authAdmin, async (req, res) => {
  const { is_eliminated } = req.body;
  try {
    await pool.query('UPDATE clans SET is_eliminated = $1 WHERE id = $2', [is_eliminated, req.params.id]);
    await audit('clan_elimination_changed', req.admin.username, 'clan', req.params.id, { is_eliminated }, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/:id', authAdmin, async (req, res) => {
  const { name, discord_id, logo_url } = req.body;
  try {
    const result = await pool.query(
      `UPDATE clans SET
        name = COALESCE($1, name),
        discord_id = COALESCE($2, discord_id),
        logo_url = COALESCE($3, logo_url)
       WHERE id = $4 RETURNING id, name`,
      [name, discord_id, logo_url, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id', authSuperAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE clans SET is_active = false WHERE id = $1', [req.params.id]);
    await audit('clan_deactivated', req.admin.username, 'clan', req.params.id, null, req.ip);
    res.json({ message: 'Clan deactivated' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
 
