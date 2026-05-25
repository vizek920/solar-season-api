const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { audit } = require('../utils/audit');

// تسجيل دخول الكلان
router.post('/clan/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  try {
    const result = await pool.query(
      'SELECT * FROM clans WHERE email = $1 AND is_active = true',
      [email.toLowerCase()]
    );
    const clan = result.rows[0];
    if (!clan) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, clan.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: clan.id, name: clan.name, type: 'clan', card_type: clan.card_type },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    await audit('clan_login', clan.name, 'clan', clan.id, null, req.ip);

    res.json({
      token,
      clan: {
        id: clan.id,
        name: clan.name,
        email: clan.email,
        card_type: clan.card_type,
        xp: clan.xp,
        immunity_count: clan.immunity_count,
        is_eliminated: clan.is_eliminated,
        logo_url: clan.logo_url
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// تسجيل دخول الأدمن
router.post('/admin/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  try {
    const result = await pool.query(
      'SELECT * FROM admins WHERE email = $1 AND is_active = true',
      [email.toLowerCase()]
    );
    const admin = result.rows[0];
    if (!admin) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: admin.id, username: admin.username, type: 'admin', role: admin.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    await audit('admin_login', admin.username, 'admin', admin.id, null, req.ip);

    res.json({
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        email: admin.email,
        role: admin.role
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
