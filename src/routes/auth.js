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
        id: clan.id, name: clan.name, email: clan.email,
        card_type: clan.card_type, xp: clan.xp,
        immunity_count: clan.immunity_count,
        is_eliminated: clan.is_eliminated, logo_url: clan.logo_url
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
      admin: { id: admin.id, username: admin.username, email: admin.email, role: admin.role }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// تغيير كلمة سر الكلان (أدمن فقط)
router.patch('/clan/:id/password', async (req, res) => {
  const { password } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'admin') return res.status(403).json({ error: 'Admin only' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'كلمة السر قصيرة جداً (6 أحرف على الأقل)' });
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'UPDATE clans SET password_hash = $1 WHERE id = $2 RETURNING name',
      [hash, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Clan not found' });
    await audit('clan_password_changed', decoded.username, 'clan', req.params.id, null, req.ip);
    res.json({ success: true, clan: result.rows[0].name });
  } catch (err) {
    if (err.name === 'JsonWebTokenError') return res.status(401).json({ error: 'Invalid token' });
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
