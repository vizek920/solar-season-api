const router = require('express').Router();
const pool = require('../db');
const { authBot } = require('../middleware/auth');

// الليدربورد
router.get('/leaderboard', authBot, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, card_type, xp, immunity_count, is_eliminated, logo_url, discord_id, hearts,
             RANK() OVER (ORDER BY xp DESC) as rank
      FROM clans WHERE is_active = true ORDER BY xp DESC LIMIT 20
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// كلان بـ Role ID
router.get('/clan/:discordId', authBot, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, card_type, xp, immunity_count, is_eliminated, discord_id, hearts,
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

// المهام النشطة
router.get('/tasks', authBot, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.id, t.title, t.description, t.xp_reward, t.difficulty,
             t.card_category, t.deadline, t.created_at, t.task_type, t.reward_type, t.reward_amount
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

// السيزون النشط
router.get('/season', authBot, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM seasons WHERE is_active = true LIMIT 1');
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== قبول مهمة =====
router.post('/accept', authBot, async (req, res) => {
  const { task_id, clan_id } = req.body;
  if (!task_id || !clan_id) return res.status(400).json({ error: 'Missing fields' });

  try {
    // التحقق من المهمة
    const task = await pool.query(
      'SELECT * FROM tasks WHERE id = $1 AND is_active = true AND is_frozen = false',
      [task_id]
    );
    if (!task.rows[0]) return res.status(404).json({ error: 'Task not found or frozen' });
    if (task.rows[0].deadline && new Date(task.rows[0].deadline) < new Date()) {
      return res.status(400).json({ error: 'Task deadline has passed' });
    }

    // التحقق من عدم القبول مسبقاً
    const existing = await pool.query(
      'SELECT id FROM task_acceptances WHERE task_id = $1 AND clan_id = $2',
      [task_id, clan_id]
    );
    if (existing.rows[0]) {
      return res.status(400).json({ error: 'already_accepted', message: 'لقد قبلت هذه المهمة مسبقاً' });
    }

    // التحقق من عدم التقديم مسبقاً
    const submitted = await pool.query(
      "SELECT id, status FROM task_submissions WHERE task_id = $1 AND clan_id = $2",
      [task_id, clan_id]
    );
    if (submitted.rows[0]) {
      return res.status(400).json({ error: 'already_submitted', message: 'لقد قدمت هذه المهمة بالفعل' });
    }

    // تسجيل القبول
    await pool.query(
      'INSERT INTO task_acceptances (task_id, clan_id) VALUES ($1, $2)',
      [task_id, clan_id]
    );

    // إشعار للكلان
    await pool.query(
      `INSERT INTO notifications (clan_id, title, message, type) VALUES ($1, '✅ قبلت المهمة', $2, 'info')`,
      [clan_id, `قبلت مهمة "${task.rows[0].title}" — لديك حتى ${task.rows[0].deadline ? new Date(task.rows[0].deadline).toLocaleString('ar') : 'وقت غير محدد'} للتسليم`]
    );

    res.json({ success: true, task: task.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== إرسال تقديم =====
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
    if (!clan) return res.status(404).json({ error: 'Clan not found' });

    // التحقق من قبول المهمة أولاً
    const accepted = await pool.query(
      'SELECT id FROM task_acceptances WHERE task_id = $1 AND clan_id = $2',
      [task_id, clan.id]
    );
    if (!accepted.rows[0]) {
      return res.status(400).json({ 
        error: 'not_accepted', 
        message: 'يجب قبول المهمة أولاً قبل التقديم! اضغط زر "قبول المهمة"' 
      });
    }

    // التحقق من عدم التقديم مسبقاً بشكل نهائي
    const existing = await pool.query(
      "SELECT id, status FROM task_submissions WHERE task_id = $1 AND clan_id = $2",
      [task_id, clan.id]
    );
    if (existing.rows[0]) {
      const status = existing.rows[0].status;
      if (status === 'approved') {
        return res.status(400).json({ error: 'already_approved', message: 'تم قبول هذه المهمة مسبقاً ✅' });
      }
      if (status === 'pending') {
        return res.status(400).json({ error: 'already_submitted', message: 'تقديمك قيد المراجعة ⏳' });
      }
      if (status === 'rejected') {
        return res.status(400).json({ error: 'rejected_final', message: 'تم رفض تقديمك ❌ — لا يمكن إعادة التقديم' });
      }
    }

    const taskResult = await pool.query(
      'SELECT * FROM tasks WHERE id = $1 AND is_active = true AND is_frozen = false',
      [task_id]
    );
    if (!taskResult.rows[0]) return res.status(404).json({ error: 'Task not found or frozen' });
    if (taskResult.rows[0].deadline && new Date(taskResult.rows[0].deadline) < new Date()) {
      return res.status(400).json({ error: 'expired', message: 'انتهى وقت المهمة' });
    }

    const result = await pool.query(
      `INSERT INTO task_submissions (task_id, clan_id, content, image_url)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [task_id, clan.id, content || null, image_url || null]
    );

    res.json({ success: true, submission_id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== مراجعة تقديم =====
router.post('/review', authBot, async (req, res) => {
  const { submission_id, is_approved, note, reviewer_tag } = req.body;
  if (!submission_id || is_approved === undefined) return res.status(400).json({ error: 'Missing fields' });

  try {
    await pool.query('BEGIN');

    const subResult = await pool.query(
      `SELECT ts.*, t.xp_reward, t.title, t.reward_type, t.reward_amount,
              c.name as clan_name, c.id as clan_id, c.discord_id as clan_discord_id
       FROM task_submissions ts
       JOIN tasks t ON ts.task_id = t.id
       JOIN clans c ON ts.clan_id = c.id
       WHERE ts.id = $1`,
      [submission_id]
    );
    const sub = subResult.rows[0];
    if (!sub) { await pool.query('ROLLBACK'); return res.status(404).json({ error: 'Submission not found' }); }

    if (sub.status !== 'pending') {
      await pool.query('ROLLBACK');
      return res.status(400).json({ error: 'Already reviewed' });
    }

    const newStatus = is_approved ? 'approved' : 'rejected';
    await pool.query('UPDATE task_submissions SET status = $1 WHERE id = $2', [newStatus, submission_id]);
    await pool.query(
      'INSERT INTO task_reviews (submission_id, reviewer_discord_id, is_approved, note) VALUES ($1, $2, $3, $4)',
      [submission_id, reviewer_tag || 'Discord', is_approved, note || null]
    );

    let rewardInfo = {};

    if (is_approved) {
      const rewardType = sub.reward_type || 'xp';
      const rewardAmount = sub.reward_amount || sub.xp_reward || 0;

      if (rewardType === 'xp') {
        await pool.query('UPDATE clans SET xp = xp + $1 WHERE id = $2', [rewardAmount, sub.clan_id]);
        await pool.query(
          'INSERT INTO xp_log (clan_id, amount, reason, changed_by, task_id) VALUES ($1, $2, $3, $4, $5)',
          [sub.clan_id, rewardAmount, `Task: ${sub.title}`, reviewer_tag || 'Discord', sub.task_id]
        );
        rewardInfo = { type: 'xp', amount: rewardAmount };
      } else if (rewardType === 'immunity') {
        await pool.query('UPDATE clans SET immunity_count = immunity_count + $1 WHERE id = $2', [rewardAmount, sub.clan_id]);
        await pool.query('INSERT INTO immunity_log (clan_id, action, amount, reason, used_by) VALUES ($1, $2, $3, $4, $5)',
          [sub.clan_id, 'gained', rewardAmount, `Task: ${sub.title}`, reviewer_tag || 'Discord']);
        rewardInfo = { type: 'immunity', amount: rewardAmount };
      } else if (rewardType === 'hearts') {
        await pool.query('UPDATE clans SET hearts = hearts + $1 WHERE id = $2', [rewardAmount, sub.clan_id]);
        rewardInfo = { type: 'hearts', amount: rewardAmount };
      } else if (rewardType === 'joker') {
        const season = await pool.query('SELECT id FROM seasons WHERE is_active = true LIMIT 1');
        if (season.rows[0]) {
          const existingJoker = await pool.query(
            'SELECT id FROM joker_cards WHERE clan_id = $1 AND season_id = $2',
            [sub.clan_id, season.rows[0].id]
          );
          if (!existingJoker.rows[0]) {
            await pool.query('INSERT INTO joker_cards (clan_id, season_id, effect) VALUES ($1, $2, $3)',
              [sub.clan_id, season.rows[0].id, 'random']);
          }
        }
        rewardInfo = { type: 'joker' };
      }

      await pool.query(
        `INSERT INTO notifications (clan_id, title, message, type) VALUES ($1, '✅ تم قبول إجابتك!', $2, 'success')`,
        [sub.clan_id, `تهانينا! إجابتك على "${sub.title}" قُبلت!`]
      );
    } else {
      await pool.query(
        `INSERT INTO notifications (clan_id, title, message, type) VALUES ($1, '❌ تم رفض إجابتك', $2, 'danger')`,
        [sub.clan_id, `إجابتك على "${sub.title}" رُفضت. ${note || ''} — لا يمكن إعادة التقديم`]
      );
    }

    await pool.query('COMMIT');
    res.json({
      success: true, status: newStatus,
      reward: rewardInfo,
      clan_name: sub.clan_name,
      clan_discord_id: sub.clan_discord_id,
      task_title: sub.title
    });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// خصم قلب
router.post('/deduct-heart', authBot, async (req, res) => {
  const { clan_id, reason } = req.body;
  try {
    const result = await pool.query(
      'UPDATE clans SET hearts = GREATEST(0, hearts - 1) WHERE id = $1 RETURNING hearts, name, discord_id',
      [clan_id]
    );
    const clan = result.rows[0];
    if (!clan) return res.status(404).json({ error: 'Clan not found' });

    if (clan.hearts === 0) {
      await pool.query('UPDATE clans SET is_eliminated = true WHERE id = $1', [clan_id]);
      await pool.query(
        `INSERT INTO notifications (clan_id, title, message, type) VALUES ($1, '⚠️ تم إقصاؤك!', $2, 'danger')`,
        [clan_id, `نفدت قلوبك! ${reason || ''}`]
      );
    } else {
      await pool.query(
        `INSERT INTO notifications (clan_id, title, message, type) VALUES ($1, '💔 خسرت قلباً!', $2, 'warning')`,
        [clan_id, `${reason || ''} — تبقى ${clan.hearts} قلب`]
      );
    }

    res.json({ hearts: clan.hearts, eliminated: clan.hearts === 0, clan_discord_id: clan.discord_id, clan_name: clan.name });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// استخدام الجوكر
router.post('/use-joker', authBot, async (req, res) => {
  const { clan_id } = req.body;
  try {
    const season = await pool.query('SELECT id FROM seasons WHERE is_active = true LIMIT 1');
    if (!season.rows[0]) return res.status(400).json({ error: 'No active season' });

    const joker = await pool.query(
      'SELECT * FROM joker_cards WHERE clan_id = $1 AND season_id = $2 AND is_revealed = false',
      [clan_id, season.rows[0].id]
    );
    if (!joker.rows[0]) return res.status(400).json({ error: 'No joker available' });

    const effects = ['immunity', 'hearts', 'xp_boost', 'elimination_escape'];
    const effect = effects[Math.floor(Math.random() * effects.length)];

    await pool.query(
      'UPDATE joker_cards SET is_revealed = true, effect = $1, revealed_at = NOW() WHERE id = $2',
      [effect, joker.rows[0].id]
    );

    let effectResult = {};
    if (effect === 'immunity') {
      await pool.query('UPDATE clans SET immunity_count = immunity_count + 1 WHERE id = $1', [clan_id]);
      effectResult = { effect: 'immunity', description: '🛡 حصلت على حصانة!' };
    } else if (effect === 'hearts') {
      await pool.query('UPDATE clans SET hearts = hearts + 2 WHERE id = $1', [clan_id]);
      effectResult = { effect: 'hearts', description: '❤️ حصلت على قلبين!' };
    } else if (effect === 'xp_boost') {
      await pool.query('UPDATE clans SET xp = xp + 500 WHERE id = $1', [clan_id]);
      await pool.query('INSERT INTO xp_log (clan_id, amount, reason, changed_by) VALUES ($1, 500, $2, $3)',
        [clan_id, 'Joker Card', 'Bot']);
      effectResult = { effect: 'xp_boost', description: '⚡ حصلت على 500 XP!' };
    } else if (effect === 'elimination_escape') {
      await pool.query('UPDATE clans SET is_eliminated = false, hearts = 1 WHERE id = $1', [clan_id]);
      effectResult = { effect: 'elimination_escape', description: '🔄 عدت للمنافسة!' };
    }

    await pool.query(
      `INSERT INTO notifications (clan_id, title, message, type) VALUES ($1, '🃏 تم كشف الجوكر!', $2, 'success')`,
      [clan_id, `تأثير الجوكر: ${effectResult.description}`]
    );

    res.json({ success: true, ...effectResult });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// منح جوكر
router.post('/grant-joker', authBot, async (req, res) => {
  const { clan_id } = req.body;
  try {
    const season = await pool.query('SELECT id FROM seasons WHERE is_active = true LIMIT 1');
    if (!season.rows[0]) return res.status(400).json({ error: 'No active season' });
    await pool.query(
      `INSERT INTO joker_cards (clan_id, season_id, effect) VALUES ($1, $2, 'random') ON CONFLICT DO NOTHING`,
      [clan_id, season.rows[0].id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// إنشاء تحدي
router.post('/challenge', authBot, async (req, res) => {
  const { challenger_clan_id, target_name, xp_bet, challenger_discord_id } = req.body;
  try {
    const target = await pool.query(
      "SELECT id, name, discord_id FROM clans WHERE LOWER(name) = LOWER($1) AND is_active = true",
      [target_name]
    );
    if (!target.rows[0]) return res.status(404).json({ error: 'الكلان غير موجود' });
    if (target.rows[0].id === challenger_clan_id) return res.status(400).json({ error: 'لا يمكنك تحدي نفسك' });

    const challenger = await pool.query('SELECT name FROM clans WHERE id = $1', [challenger_clan_id]);
    const result = await pool.query(
      `INSERT INTO challenges (challenger_clan_id, challenged_clan_id, xp_bet, challenger_discord_id, challenged_discord_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [challenger_clan_id, target.rows[0].id, xp_bet, challenger_discord_id, target.rows[0].discord_id]
    );

    res.json({
      success: true, challenge_id: result.rows[0].id,
      target_discord_id: target.rows[0].discord_id,
      challenger: challenger.rows[0].name,
      challenged: target.rows[0].name, xp_bet
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// قبول تحدي
router.post('/challenge/accept', authBot, async (req, res) => {
  const { challenge_id } = req.body;
  try {
    const result = await pool.query(
      `UPDATE challenges SET status = 'accepted' WHERE id = $1 AND status = 'pending' RETURNING *`,
      [challenge_id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Challenge not found' });
    const ch = result.rows[0];
    const [c1, c2] = await Promise.all([
      pool.query('SELECT name FROM clans WHERE id = $1', [ch.challenger_clan_id]),
      pool.query('SELECT name FROM clans WHERE id = $1', [ch.challenged_clan_id])
    ]);
    res.json({ success: true, challenger: c1.rows[0].name, challenged: c2.rows[0].name, xp_bet: ch.xp_bet });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// إنهاء تحدي
router.post('/challenge/complete', authBot, async (req, res) => {
  const { challenge_id, winner_clan_id } = req.body;
  try {
    await pool.query('BEGIN');
    const ch = await pool.query('SELECT * FROM challenges WHERE id = $1', [challenge_id]);
    if (!ch.rows[0]) { await pool.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    const loserId = ch.rows[0].challenger_clan_id === winner_clan_id ? ch.rows[0].challenged_clan_id : ch.rows[0].challenger_clan_id;
    await pool.query('UPDATE clans SET xp = xp + $1 WHERE id = $2', [ch.rows[0].xp_bet, winner_clan_id]);
    await pool.query('UPDATE clans SET xp = GREATEST(0, xp - $1) WHERE id = $2', [ch.rows[0].xp_bet, loserId]);
    await pool.query(`UPDATE challenges SET status = 'completed', winner_clan_id = $1, completed_at = NOW() WHERE id = $2`, [winner_clan_id, challenge_id]);
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: 'Server error' });
  }
});

// Big Screen
router.get('/bigscreen', async (req, res) => {
  try {
    const [clans, season, tasks] = await Promise.all([
      pool.query(`SELECT id, name, card_type, xp, immunity_count, is_eliminated, hearts, RANK() OVER (ORDER BY xp DESC) as rank FROM clans WHERE is_active = true ORDER BY xp DESC LIMIT 20`),
      pool.query('SELECT * FROM seasons WHERE is_active = true LIMIT 1'),
      pool.query(`SELECT id, title, card_category, xp_reward, reward_type, difficulty, deadline FROM tasks WHERE is_active = true AND is_frozen = false AND (deadline IS NULL OR deadline > NOW()) ORDER BY created_at DESC LIMIT 5`)
    ]);
    res.json({ clans: clans.rows, season: season.rows[0] || null, tasks: tasks.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// خصم عقوبة موحّد: نقاط (xp) / قلوب (hearts) / دروع (shields=immunity_count)
router.post('/penalty', authBot, async (req, res) => {
  const { clan_id, type, amount, reason } = req.body;
  const amt = Math.max(1, parseInt(amount, 10) || 1);
  // العمود مُختار من قائمة ثابتة فقط (آمن ضد الحقن)
  const column = type === 'xp' ? 'xp' : type === 'hearts' ? 'hearts' : type === 'shields' ? 'immunity_count' : null;
  if (!clan_id || !column) return res.status(400).json({ error: 'invalid_request' });

  try {
    const result = await pool.query(
      `UPDATE clans SET ${column} = GREATEST(0, ${column} - $2) WHERE id = $1
       RETURNING name, discord_id, xp, hearts, immunity_count`,
      [clan_id, amt]
    );
    const clan = result.rows[0];
    if (!clan) return res.status(404).json({ error: 'Clan not found' });

    let eliminated = false;
    if (type === 'hearts' && clan.hearts === 0) {
      eliminated = true;
      await pool.query('UPDATE clans SET is_eliminated = true WHERE id = $1', [clan_id]);
    }

    const typeLabel = type === 'xp' ? `${amt} XP` : type === 'hearts' ? `${amt} قلب` : `${amt} درع`;
    const title = eliminated ? '⚠️ تم إقصاؤك!' : '⚖️ عقوبة';
    const message = eliminated
      ? `نفدت قلوبك! ${reason || ''}`.trim()
      : `تم خصم ${typeLabel}. ${reason || ''}`.trim();
    await pool.query(
      `INSERT INTO notifications (clan_id, title, message, type) VALUES ($1, $2, $3, $4)`,
      [clan_id, title, message, eliminated ? 'danger' : 'warning']
    );

    res.json({
      clan_name: clan.name,
      clan_discord_id: clan.discord_id,
      eliminated,
      type,
      amount: amt,
      xp: clan.xp,
      hearts: clan.hearts,
      immunity_count: clan.immunity_count
    });
  } catch (err) {
    console.error('Penalty endpoint error:', err.message);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

module.exports = router;
