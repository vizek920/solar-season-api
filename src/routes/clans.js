const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { authClan, authAdmin, authSuperAdmin } = require('../middleware/auth');
const { audit } = require('../utils/audit');

// ===== الليدربورد العام =====
router.get('/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, card_type, xp, immunity_count, is_eliminated, logo_url, discord_id, hearts,
             RANK() OVER (ORDER BY xp DESC) as rank
      FROM clans WHERE is_active = true ORDER BY xp DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== ME ROUTES (قبل /:id) =====

router.get('/me', authClan, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, card_type, discord_id, logo_url, xp, hearts,
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

// ===== CLAN BY ID =====

router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, card_type, xp, immunity_count, is_eliminated, logo_url, hearts, created_at,
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

// جوكر الكلان (عام)
router.get('/:id/joker', async (req, res) => {
  try {
    const season = await pool.query('SELECT id FROM seasons WHERE is_active = true LIMIT 1');
    if (!season.rows[0]) return res.status(404).json({ error: 'No active season' });
    const result = await pool.query(
      'SELECT * FROM joker_cards WHERE clan_id = $1 AND season_id = $2',
      [req.params.id, season.rows[0].id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'No joker' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== ADMIN ROUTES =====

// إنشاء كلان
router.post('/', authAdmin, async (req, res) => {
  const { name, email, password, card_type, discord_id } = req.body;
  if (!name || !email || !password || !card_type)
    return res.status(400).json({ error: 'Missing required fields' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO clans (name, email, password_hash, card_type, discord_id, hearts)
       VALUES ($1, $2, $3, $4, $5, 1) RETURNING id, name, email, card_type`,
      [name, email.toLowerCase(), hash, card_type, discord_id || null]
    );
    await audit('clan_created', req.admin.username, 'clan', result.rows[0].id, { name, card_type }, req.ip);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Clan name or email already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

// تعديل كلان
router.patch('/:id', authAdmin, async (req, res) => {
  const { name, discord_id, logo_url, card_type } = req.body;
  try {
    const result = await pool.query(
      `UPDATE clans SET
        name = COALESCE(NULLIF($1, ''), name),
        discord_id = CASE WHEN $2::text IS NOT NULL THEN NULLIF($2, '') ELSE discord_id END,
        logo_url = COALESCE(NULLIF($3, ''), logo_url),
        card_type = COALESCE(NULLIF($4, ''), card_type)
       WHERE id = $5 RETURNING id, name, card_type, discord_id`,
      [name || null, discord_id !== undefined ? discord_id : null, logo_url || null, card_type || null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Clan not found' });
    await audit('clan_updated', req.admin.username, 'clan', req.params.id, { name, discord_id, card_type }, req.ip);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// تعديل XP
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

// تعديل الحصانة
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

// تعديل القلوب
router.patch('/:id/hearts', authAdmin, async (req, res) => {
  const { amount, reason } = req.body;
  if (amount === undefined) return res.status(400).json({ error: 'Amount required' });
  try {
    const result = await pool.query(
      'UPDATE clans SET hearts = GREATEST(0, hearts + $1) WHERE id = $2 RETURNING hearts, name, discord_id',
      [amount, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Clan not found' });

    if (result.rows[0].hearts === 0 && amount < 0) {
      await pool.query('UPDATE clans SET is_eliminated = true WHERE id = $1', [req.params.id]);
      await pool.query(
        `INSERT INTO notifications (clan_id, title, message, type) VALUES ($1, '⚠️ تم إقصاؤك!', $2, 'danger')`,
        [req.params.id, `نفدت قلوبك! تم إقصاء كلانك. ${reason || ''}`]
      );
    } else if (amount < 0) {
      await pool.query(
        `INSERT INTO notifications (clan_id, title, message, type) VALUES ($1, '💔 خسرت قلباً!', $2, 'warning')`,
        [req.params.id, `تم خصم قلب. ${reason || ''} — تبقى ${result.rows[0].hearts} قلب`]
      );
    } else {
      await pool.query(
        `INSERT INTO notifications (clan_id, title, message, type) VALUES ($1, '❤️ حصلت على قلب!', $2, 'success')`,
        [req.params.id, `تم إضافة ${amount} قلب لكلانك!`]
      );
    }

    await audit('hearts_changed', req.admin.username, 'clan', req.params.id, { amount, reason }, req.ip);
    res.json({ hearts: result.rows[0].hearts, eliminated: result.rows[0].hearts === 0 && amount < 0 });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// إقصاء / إعادة كلان
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

// منح جوكر
router.post('/:id/joker', authAdmin, async (req, res) => {
  try {
    const season = await pool.query('SELECT id FROM seasons WHERE is_active = true LIMIT 1');
    if (!season.rows[0]) return res.status(400).json({ error: 'No active season' });

    const existing = await pool.query(
      'SELECT id FROM joker_cards WHERE clan_id = $1 AND season_id = $2',
      [req.params.id, season.rows[0].id]
    );
    if (existing.rows[0]) return res.status(400).json({ error: 'الكلان لديه جوكر بالفعل' });

    await pool.query(
      'INSERT INTO joker_cards (clan_id, season_id, effect) VALUES ($1, $2, $3)',
      [req.params.id, season.rows[0].id, 'random']
    );
    await pool.query(
      `INSERT INTO notifications (clan_id, title, message, type) VALUES ($1, '🃏 حصلت على الجوكر!', $2, 'success')`,
      [req.params.id, 'تم منحك بطاقة الجوكر السرية! استخدمها بأمر /جوكر في Discord']
    );
    await audit('joker_granted', req.admin.username, 'clan', req.params.id, null, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// حذف كلان
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
