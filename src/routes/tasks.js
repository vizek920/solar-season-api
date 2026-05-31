const router = require('express').Router();
const pool = require('../db');
const { authClan, authAdmin } = require('../middleware/auth');
const { audit } = require('../utils/audit');

// ===== ME ROUTES (قبل /:id) =====

router.get('/me/submissions', authClan, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ts.*, t.title as task_title, t.xp_reward, t.difficulty
       FROM task_submissions ts
       JOIN tasks t ON ts.task_id = t.id
       WHERE ts.clan_id = $1
       ORDER BY ts.submitted_at DESC`,
      [req.clan.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// الحصول على كل المهام النشطة
router.get('/', async (req, res) => {
  const { season_id, card_category } = req.query;
  try {
    let query = `
      SELECT t.*, a.username as created_by_name,
             COUNT(ts.id) as submission_count
      FROM tasks t
      LEFT JOIN admins a ON t.created_by = a.id
      LEFT JOIN task_submissions ts ON t.id = ts.task_id
      WHERE t.is_active = true
    `;
    const params = [];
    if (season_id) { params.push(season_id); query += ` AND t.season_id = $${params.length}`; }
    if (card_category) { params.push(card_category); query += ` AND (t.card_category = $${params.length} OR t.card_category = 'all')`; }
    query += ' GROUP BY t.id, a.username ORDER BY t.created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// تفاصيل مهمة
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*, a.username as created_by_name FROM tasks t
       LEFT JOIN admins a ON t.created_by = a.id WHERE t.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Task not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// إنشاء مهمة (أدمن)
router.post('/', authAdmin, async (req, res) => {
  const { season_id, title, description, difficulty, xp_reward, reward_type, reward_amount, card_category, task_type, deadline } = req.body;
  if (!season_id || !title) return res.status(400).json({ error: 'season_id and title required' });
  try {
    const finalRewardType = reward_type || 'xp';
    const finalRewardAmount = reward_amount || xp_reward || 0;
    const result = await pool.query(
      `INSERT INTO tasks (season_id, title, description, difficulty, xp_reward, reward_type, reward_amount, card_category, task_type, deadline, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [season_id, title, description, difficulty || 1, finalRewardAmount, finalRewardType, finalRewardAmount, card_category || 'all', task_type || 'text', deadline || null, req.admin.id]
    );
    const clansQuery = card_category && card_category !== 'all'
      ? 'SELECT id FROM clans WHERE card_type = $1 AND is_active = true'
      : 'SELECT id FROM clans WHERE is_active = true';
    const clansParams = card_category && card_category !== 'all' ? [card_category] : [];
    const clans = await pool.query(clansQuery, clansParams);
    for (const clan of clans.rows) {
      await pool.query(
        `INSERT INTO notifications (clan_id, title, message, type) VALUES ($1, $2, $3, 'info')`,
        [clan.id, '🎯 مهمة جديدة!', `تم إضافة مهمة جديدة: ${title}`]
      );
    }
    await audit('task_created', req.admin.username, 'task', result.rows[0].id, { title, xp_reward }, req.ip);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// تعديل مهمة (أدمن)
router.patch('/:id', authAdmin, async (req, res) => {
  const { title, description, difficulty, xp_reward, deadline, is_frozen, is_active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE tasks SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        difficulty = COALESCE($3, difficulty),
        xp_reward = COALESCE($4, xp_reward),
        deadline = COALESCE($5, deadline),
        is_frozen = COALESCE($6, is_frozen),
        is_active = COALESCE($7, is_active)
       WHERE id = $8 RETURNING *`,
      [title, description, difficulty, xp_reward, deadline, is_frozen, is_active, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Task not found' });
    await audit('task_updated', req.admin.username, 'task', req.params.id, req.body, req.ip);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// تجميد مهمة
router.patch('/:id/freeze', authAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE tasks SET is_frozen = NOT is_frozen WHERE id = $1 RETURNING is_frozen, title',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Task not found' });
    await audit('task_freeze_toggled', req.admin.username, 'task', req.params.id, { is_frozen: result.rows[0].is_frozen }, req.ip);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// تقديم إجابة (كلان)
router.post('/:id/submit', authClan, async (req, res) => {
  const { content, image_url } = req.body;
  try {
    const taskResult = await pool.query(
      'SELECT * FROM tasks WHERE id = $1 AND is_active = true AND is_frozen = false',
      [req.params.id]
    );
    const task = taskResult.rows[0];
    if (!task) return res.status(404).json({ error: 'Task not found or frozen' });
    if (task.deadline && new Date(task.deadline) < new Date())
      return res.status(400).json({ error: 'Task deadline has passed' });

    const result = await pool.query(
      `INSERT INTO task_submissions (task_id, clan_id, content, image_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (task_id, clan_id) DO UPDATE SET content = $3, image_url = $4, status = 'pending', submitted_at = NOW()
       RETURNING *`,
      [req.params.id, req.clan.id, content || null, image_url || null]
    );
    await pool.query(
      `INSERT INTO notifications (is_global, title, message, type) VALUES (true, '📨 تقديم جديد', $1, 'info')`,
      [`الكلان ${req.clan.name} قدّم إجابة على: ${task.title}`]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// تقديمات مهمة (أدمن)
router.get('/:id/submissions', authAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ts.*, c.name as clan_name, c.card_type
       FROM task_submissions ts JOIN clans c ON ts.clan_id = c.id
       WHERE ts.task_id = $1 ORDER BY ts.submitted_at DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// مراجعة تقديم (أدمن)
router.post('/submissions/:submissionId/review', authAdmin, async (req, res) => {
  const { is_approved, note } = req.body;
  if (is_approved === undefined) return res.status(400).json({ error: 'is_approved required' });
  try {
    await pool.query('BEGIN');
    const subResult = await pool.query(
      `SELECT ts.*, t.xp_reward, t.title, c.name as clan_name
       FROM task_submissions ts JOIN tasks t ON ts.task_id = t.id JOIN clans c ON ts.clan_id = c.id
       WHERE ts.id = $1`,
      [req.params.submissionId]
    );
    const sub = subResult.rows[0];
    if (!sub) { await pool.query('ROLLBACK'); return res.status(404).json({ error: 'Submission not found' }); }

    const newStatus = is_approved ? 'approved' : 'rejected';
    await pool.query('UPDATE task_submissions SET status = $1 WHERE id = $2', [newStatus, sub.id]);
    await pool.query(
      'INSERT INTO task_reviews (submission_id, reviewer_id, is_approved, note) VALUES ($1, $2, $3, $4)',
      [sub.id, req.admin.id, is_approved, note || null]
    );

    if (is_approved) {
      await pool.query('UPDATE clans SET xp = xp + $1 WHERE id = $2', [sub.xp_reward, sub.clan_id]);
      await pool.query(
        'INSERT INTO xp_log (clan_id, amount, reason, changed_by, task_id) VALUES ($1, $2, $3, $4, $5)',
        [sub.clan_id, sub.xp_reward, `Task completed: ${sub.title}`, req.admin.username, sub.task_id]
      );
    }

    await pool.query(
      `INSERT INTO notifications (clan_id, title, message, type) VALUES ($1, $2, $3, $4)`,
      [sub.clan_id,
       is_approved ? '✅ تم قبول إجابتك!' : '❌ تم رفض إجابتك',
       is_approved ? `تهانينا! إجابتك على "${sub.title}" قُبلت وحصلت على ${sub.xp_reward} XP` : `للأسف إجابتك على "${sub.title}" رُفضت. ${note || ''}`,
       is_approved ? 'success' : 'danger']
    );

    await audit('submission_reviewed', req.admin.username, 'submission', sub.id, { is_approved, clan: sub.clan_name }, req.ip);
    await pool.query('COMMIT');
    res.json({ status: newStatus, xp_awarded: is_approved ? sub.xp_reward : 0 });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
