const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const https = require('https');
const pool = require('../db');

// التحقق من Cloudflare Turnstile
const verifyCaptcha = async (token, ip) => {
  return new Promise((resolve) => {
    if (!token) { resolve(false); return; }
    const body = JSON.stringify({
      secret: process.env.TURNSTILE_SECRET,
      response: token,
      remoteip: ip
    });
    const options = {
      hostname: 'challenges.cloudflare.com',
      port: 443, path: '/turnstile/v0/siteverify',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data).success === true); }
        catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.write(body); req.end();
  });
};

const captchaMiddleware = async (req, res, next) => {
  // تخطي في بيئة التطوير
  if (process.env.NODE_ENV === 'development') return next();

  const token = req.body?.captcha_token;
  const ip = req.ip;

  const valid = await verifyCaptcha(token, ip);
  if (!valid) {
    return res.status(403).json({ error: 'captcha_failed', message: 'فشل التحقق الأمني. حاول مرة أخرى.' });
  }
  next();
};

// Rate Limiter لتسجيل الدخول — 5 محاولات كل 15 دقيقة
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const retryAfter = Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000 / 60);
    res.status(429).json({
      error: `تم تجاوز عدد المحاولات المسموح بها. حاول مرة أخرى بعد ${retryAfter} دقيقة.`,
      retry_after_minutes: retryAfter
    });
  }
});

// Rate Limiter للـ API العام — 60 طلب في الدقيقة
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' },
});

// Rate Limiter للبوت — أكثر تساهلاً
const botLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Bot rate limit exceeded.' },
});

// Security Headers
const securityHeaders = helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
});

// ===== تتبع محاولات الدخول الفاشلة — مخزّن في قاعدة البيانات =====
// (يصمد بعد إعادة تشغيل السيرفر أو نشر تحديث جديد، عكس التخزين في الذاكرة)
const WINDOW_MS = 15 * 60 * 1000; // نافذة 15 دقيقة
const MAX_ATTEMPTS = 5;           // الحد الأقصى للمحاولات الفاشلة

const trackLoginAttempt = async (ip, success) => {
  try {
    if (success) {
      // عند نجاح الدخول: نمسح سجل المحاولات لهذا الجهاز
      await pool.query('DELETE FROM login_attempts WHERE ip = $1', [ip]);
      return;
    }

    // عند الفشل: نزيد العداد (أو نبدأ من جديد إذا انتهت النافذة الزمنية)
    // العملية ذرية (atomic) في استعلام واحد لتفادي أي تعارض
    await pool.query(
      `INSERT INTO login_attempts (ip, attempts, first_attempt)
       VALUES ($1, 1, now())
       ON CONFLICT (ip) DO UPDATE SET
         attempts = CASE
           WHEN now() - login_attempts.first_attempt > interval '15 minutes' THEN 1
           ELSE login_attempts.attempts + 1
         END,
         first_attempt = CASE
           WHEN now() - login_attempts.first_attempt > interval '15 minutes' THEN now()
           ELSE login_attempts.first_attempt
         END`,
      [ip]
    );
  } catch (err) {
    // لا نوقف تسجيل الدخول بسبب خطأ في التتبع — فقط نسجّل الخطأ
    console.error('trackLoginAttempt error:', err.message);
  }
};

const checkBlocked = async (req, res, next) => {
  const ip = req.ip; // دقيق بفضل trust proxy
  try {
    const result = await pool.query(
      'SELECT attempts, first_attempt FROM login_attempts WHERE ip = $1',
      [ip]
    );
    const record = result.rows[0];

    if (record && record.attempts >= MAX_ATTEMPTS) {
      const elapsed = Date.now() - new Date(record.first_attempt).getTime();
      if (elapsed < WINDOW_MS) {
        const timeLeft = Math.ceil((WINDOW_MS - elapsed) / 1000 / 60);
        return res.status(429).json({
          error: `تم حظر هذا الجهاز مؤقتاً. حاول بعد ${timeLeft} دقيقة.`,
          retry_after_minutes: timeLeft,
          blocked: true
        });
      } else {
        // انتهت مدة الحظر: نمسح السجل ونسمح بالمحاولة
        await pool.query('DELETE FROM login_attempts WHERE ip = $1', [ip]);
      }
    }
  } catch (err) {
    // عند خطأ في القاعدة نسمح بالمرور (fail-open) حتى لا نمنع الدخول الشرعي
    console.error('checkBlocked error:', err.message);
  }
  next();
};

module.exports = { loginLimiter, apiLimiter, botLimiter, securityHeaders, trackLoginAttempt, checkBlocked, captchaMiddleware };
