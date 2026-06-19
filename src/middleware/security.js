const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const https = require('https');

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

// تتبع محاولات الدخول الفاشلة
const loginAttempts = new Map();

const trackLoginAttempt = (ip, success) => {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  if (!loginAttempts.has(ip)) {
    loginAttempts.set(ip, { attempts: 0, firstAttempt: now });
  }
  const record = loginAttempts.get(ip);
  if (now - record.firstAttempt > windowMs) {
    loginAttempts.set(ip, { attempts: 0, firstAttempt: now });
    return;
  }
  if (success) { loginAttempts.delete(ip); return; }
  record.attempts++;
};

const checkBlocked = (req, res, next) => {
  const ip = req.ip; // الآن دقيق بفضل trust proxy
  const record = loginAttempts.get(ip);
  if (record && record.attempts >= 5) {
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const timeLeft = Math.ceil((record.firstAttempt + windowMs - now) / 1000 / 60);
    if (timeLeft > 0) {
      return res.status(429).json({
        error: `تم حظر هذا الجهاز مؤقتاً. حاول بعد ${timeLeft} دقيقة.`,
        retry_after_minutes: timeLeft,
        blocked: true
      });
    } else {
      loginAttempts.delete(ip);
    }
  }
  next();
};

// تنظيف تلقائي كل ساعة
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of loginAttempts.entries()) {
    if (now - record.firstAttempt > 15 * 60 * 1000) loginAttempts.delete(key);
  }
}, 60 * 60 * 1000);

module.exports = { loginLimiter, apiLimiter, botLimiter, securityHeaders, trackLoginAttempt, checkBlocked, captchaMiddleware };
