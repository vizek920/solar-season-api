const router = require('express').Router();
const pool = require('../db');
const { authBot } = require('../middleware/auth');

// الحصول على الليدربورد (للبوت)
router.get('/leaderboard', authBot, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT name, card_type, xp, immunity_count, is_eliminated,
             RANK() OVER (ORDER BY xp DESC) as rank
      FROM clans WHERE is_active = true ORDER BY xp DESC LIMIT 20
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// الحصول على معلومات كلان بـ Discord ID
router.get('/clan/:discordId', authBot, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, card_type, xp, immunity_count, is_eliminated,
              RANK() OVER (ORDER BY xp DESC) as rank
       FROM clans WHERE discord_id = $1 AND is_active = true`,
      [req.params.discordId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Clan not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// الحصول على المهام النشطة (للبوت)
router.get('/tasks', authBot, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.id, t.title, t.description, t.xp_reward, t.difficulty,
             t.card_category, t.deadline, t.task_type
      FROM tasks t
      JOIN seasons s ON t.season_id = s.id
      WHERE t.is_active = true AND t.is_frozen = false AND s.is_active = true
      AND (t.deadline IS NULL OR t.deadline > NOW())
      ORDER BY t.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// إرسال تقديم عبر البوت
router.post('/submit', authBot, async (req, res) => {
  const { task_id, clan_discord_id, clan_id, content, image_url } = req.body;
  if (!task_id || (!clan_discord_id && !clan_id)) return res.status(400).json({ error: 'Missing fields' });

  try {
    let clan;
    if (clan_id) {
      const r = await pool.query('SELECT id, name FROM clans WHERE id = $1 AND is_active = true', [clan_id]);
      clan = r.rows[0];
    } else {
      const r = await pool.query('SELECT id, name FROM clans WHERE discord_id = $1 AND is_active = true', [clan_discord_id]);
      clan = r.rows[0];
    }
    if (!clan) return res.status(404).json({ error: 'Clan not found — تأكد من إضافة Role ID الكلان في الموقع' });

    const taskResult = await pool.query(
      'SELECT * FROM tasks WHERE id = $1 AND is_active = true AND is_frozen = false',
      [task_id]
    );
    if (!taskResult.rows[0]) return res.status(404).json({ error: 'Task not found or frozen' });

    const result = await pool.query(
      `INSERT INTO task_submissions (task_id, clan_id, content, image_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (task_id, clan_id) DO UPDATE SET content = $3, image_url = $4, status = 'pending', submitted_at = NOW()
       RETURNING *`,
      [task_id, clan.id, content || null, image_url || null]
    );

    res.json({ success: true, submission_id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// مراجعة تقديم من البوت
router.post('/review', authBot, async (req, res) => {
  const { submission_id, is_approved, note, reviewer_tag } = req.body;
  if (!submission_id || is_approved === undefined) return res.status(400).json({ error: 'Missing fields' });

  try {
    await pool.query('BEGIN');

    const subResult = await pool.query(
      `SELECT ts.*, t.xp_reward, t.title, c.name as clan_name
       FROM task_submissions ts 
       JOIN tasks t ON ts.task_id = t.id 
       JOIN clans c ON ts.clan_id = c.id
       WHERE ts.id = $1`,
      [submission_id]
    );
    const sub = subResult.rows[0];
    if (!sub) { await pool.query('ROLLBACK'); return res.status(404).json({ error: 'Submission not found' }); }

    const newStatus = is_approved ? 'approved' : 'rejected';
    await pool.query('UPDATE task_submissions SET status = $1 WHERE id = $2', [newStatus, submission_id]);

    await pool.query(
      'INSERT INTO task_reviews (submission_id, reviewer_discord_id, is_approved, note) VALUES ($1, $2, $3, $4)',
      [submission_id, reviewer_tag || 'Discord Bot', is_approved, note || null]
    );

    if (is_approved) {
      await pool.query('UPDATE clans SET xp = xp + $1 WHERE id = $2', [sub.xp_reward, sub.clan_id]);
      await pool.query(
        'INSERT INTO xp_log (clan_id, amount, reason, changed_by, task_id) VALUES ($1, $2, $3, $4, $5)',
        [sub.clan_id, sub.xp_reward, `Task: ${sub.title}`, reviewer_tag || 'Discord', sub.task_id]
      );
    }

    await pool.query(
      `INSERT INTO notifications (clan_id, title, message, type) VALUES ($1, $2, $3, $4)`,
      [sub.clan_id,
       is_approved ? '✅ تم قبول إجابتك!' : '❌ تم رفض إجابتك',
       is_approved ? `تهانينا! إجابتك على "${sub.title}" قُبلت وحصلت على ${sub.xp_reward} XP` : `للأسف إجابتك على "${sub.title}" رُفضت. ${note || ''}`,
       is_approved ? 'success' : 'danger']
    );

    await pool.query('COMMIT');
    res.json({ success: true, xp_awarded: is_approved ? sub.xp_reward : 0, clan: sub.clan_name });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// السيزون النشط (للبوت)
router.get('/season', authBot, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM seasons WHERE is_active = true LIMIT 1');
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
