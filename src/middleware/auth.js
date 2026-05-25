const jwt = require('jsonwebtoken');

// التحقق من توكن الكلان
const authClan = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'clan') return res.status(403).json({ error: 'Access denied' });
    req.clan = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// التحقق من توكن الأدمن
const authAdmin = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'admin') return res.status(403).json({ error: 'Access denied' });
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// التحقق من أي مستخدم (كلان أو أدمن)
const authAny = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// التحقق من صلاحية Superadmin
const authSuperAdmin = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'admin' || decoded.role !== 'superadmin') {
      return res.status(403).json({ error: 'Superadmin access required' });
    }
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// التحقق من بوت Discord
const authBot = (req, res, next) => {
  const secret = req.headers['x-bot-secret'];
  if (!secret || secret !== process.env.DISCORD_BOT_SECRET) {
    return res.status(403).json({ error: 'Bot access denied' });
  }
  next();
};

module.exports = { authClan, authAdmin, authAny, authSuperAdmin, authBot };
