require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const pool = require('./db');
const { loginLimiter, apiLimiter, botLimiter, securityHeaders } = require('./middleware/security');

const authRoutes = require('./routes/auth');
const clanRoutes = require('./routes/clans');
const taskRoutes = require('./routes/tasks');
const botRoutes = require('./routes/bot');
const { notifRouter, seasonRouter, adminRouter } = require('./routes/misc');

const app = express();
const PORT = process.env.PORT || 3000;
const API_URL = process.env.API_URL || 'https://solar-season-api.onrender.com';

// ===== Security Headers =====
app.use(securityHeaders);

// ===== إخفاء معلومات السيرفر =====
app.disable('x-powered-by');

// ===== CORS =====
app.use(cors({
  origin: function(origin, callback) {
    const allowed = [
      'http://localhost:5173',
      'https://solar-season-frontend.vercel.app',
      process.env.FRONTEND_URL
    ];
    if (!origin || allowed.includes(origin) || (origin && origin.endsWith('.vercel.app'))) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// ===== Body Parsing مع حد للحجم =====
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// ===== Rate Limiting =====
app.use('/api/auth', loginLimiter); // صارم جداً على تسجيل الدخول
app.use('/api/bot', botLimiter);    // أكثر تساهلاً للبوت
app.use('/api', apiLimiter);        // عام للباقي

// ===== Routes =====
app.use('/api/auth', authRoutes);
app.use('/api/clans', clanRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/notifications', notifRouter);
app.use('/api/seasons', seasonRouter);
app.use('/api/admin', adminRouter);
app.use('/api/bot', botRoutes);

// ===== Health Check =====
app.get('/ping', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/', (req, res) => res.json({ name: 'Solar Season API', version: '1.0.0' }));

// ===== CRON JOBS =====
cron.schedule('* * * * *', async () => {
  try {
    const result = await pool.query(
      `UPDATE tasks SET is_frozen = true WHERE deadline < NOW() AND is_frozen = false AND is_active = true RETURNING id`
    );
    if (result.rows.length > 0) console.log(`⏰ Frozen ${result.rows.length} expired tasks`);
  } catch (err) { console.error('Cron freeze error:', err.message); }
});

cron.schedule('*/10 * * * *', async () => {
  try {
    const https = require('https');
    const url = new URL(`${API_URL}/ping`);
    https.get(url.href, () => {}).on('error', () => {});
  } catch { }
});

cron.schedule('0 3 * * *', async () => {
  try {
    const season = await pool.query('SELECT id FROM seasons WHERE is_active = true LIMIT 1');
    if (!season.rows[0]) return;
    const clans = await pool.query('SELECT id, name, card_type, xp, immunity_count, is_eliminated FROM clans WHERE is_active = true ORDER BY xp DESC');
    await pool.query('INSERT INTO daily_snapshots (season_id, data) VALUES ($1, $2)', [season.rows[0].id, JSON.stringify({ clans: clans.rows, date: new Date().toISOString() })]);
    console.log('✅ Daily snapshot saved');
  } catch (err) { console.error('Snapshot error:', err.message); }
});

// ===== Error Handler =====
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => console.log(`🚀 Solar Season API running on port ${PORT}`));
