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
  const { task_id, clan_discord_id, content, image_url } = req.body;
  if (!task_id || !clan_discord_id) return res.status(400).json({ error: 'Missing fields' });

  try {
    const clanResult = await pool.query('SELECT id, name FROM clans WHERE discord_id = $1', [clan_discord_id]);
    if (!clanResult.rows[0]) return res.status(404).json({ error: 'Clan not found' });
    const clan = clanResult.rows[0];

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
