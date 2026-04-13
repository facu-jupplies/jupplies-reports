const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cookieSession = require('cookie-session');
const { getDb, initDb } = require('./src/db');

const app = express();
const PORT = 3000;

// ─── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Sesión con cookie firmada (segura, httpOnly, no accesible desde JS del browser)
app.use(cookieSession({
  name: 'jupplies_session',
  keys: [crypto.randomBytes(32).toString('hex')],
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días
  httpOnly: true,
  sameSite: 'lax',
  // secure: true se activa abajo si viene por HTTPS (Cloudflare Tunnel)
}));

// Detectar HTTPS detrás de proxy (Cloudflare Tunnel, ngrok)
app.set('trust proxy', 1);
app.use((req, res, next) => {
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    req.sessionOptions.secure = true;
  }
  next();
});

// ─── Login page ───────────────────────────────────────────────────────────────

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Login — Jupplies Reports</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', system-ui, sans-serif; background: #eeeef0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .login-card { background: #fff; border-radius: 16px; box-shadow: 0 8px 30px rgba(0,0,0,.1); padding: 40px; width: 360px; text-align: center; }
  .logo { font-size: 28px; font-weight: 800; color: #1a1a2e; margin-bottom: 4px; }
  .logo-arrow { color: #ff6f4c; }
  .logo-sub { font-size: 12px; color: #5a5a78; margin-bottom: 24px; }
  .form-group { text-align: left; margin-bottom: 16px; }
  .form-group label { display: block; font-size: 12px; font-weight: 600; color: #5a5a78; margin-bottom: 4px; }
  .form-group input { width: 100%; padding: 10px 14px; border: 1.5px solid #e2e2e8; border-radius: 8px; font-size: 14px; font-family: inherit; }
  .form-group input:focus { outline: none; border-color: #ff6f4c; }
  .btn { width: 100%; padding: 12px; background: #ff6f4c; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: 700; cursor: pointer; font-family: inherit; }
  .btn:hover { background: #e85535; }
  .error { color: #c0392b; font-size: 13px; margin-bottom: 12px; display: none; }
</style>
</head>
<body>
<div class="login-card">
  <div class="logo"><span class="logo-arrow">&#9668;</span>UPPLIES</div>
  <div class="logo-sub">Reports</div>
  <div class="error" id="error-msg">Usuario o contrase&ntilde;a incorrectos</div>
  <form method="POST" action="/login" id="login-form">
    <div class="form-group">
      <label>Usuario</label>
      <input type="text" name="user" autocomplete="username" required autofocus>
    </div>
    <div class="form-group">
      <label>Contrase&ntilde;a</label>
      <input type="password" name="pass" autocomplete="current-password" required>
    </div>
    <button type="submit" class="btn">Entrar</button>
  </form>
</div>
<script>
  if (location.search.includes('error=1')) {
    document.getElementById('error-msg').style.display = 'block';
  }
</script>
</body>
</html>`;

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/');
  res.type('html').send(LOGIN_HTML);
});

app.post('/login', (req, res) => {
  const { user, pass } = req.body;
  try {
    const db = getDb();
    const dbUser = db.prepare("SELECT value FROM app_settings WHERE key = 'app_user'").pluck().get();
    const dbPass = db.prepare("SELECT value FROM app_settings WHERE key = 'app_password'").pluck().get();

    if (user === dbUser && pass === dbPass) {
      req.session.authenticated = true;
      req.session.user = user;
      return res.redirect('/');
    }
  } catch (_) {}

  res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

// ─── Auth middleware — protege TODO excepto login ─────────────────────────────

function requireAuth(req, res, next) {
  // Permitir /login sin auth
  if (req.path === '/login') return next();

  if (!req.session || !req.session.authenticated) {
    // Para llamadas API, devolver 401 JSON
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'No autenticado. Recargá la página para loguearte.' });
    }
    // Para páginas, redirigir al login
    return res.redirect('/login');
  }
  next();
}

app.use(requireAuth);

// Archivos estáticos (ahora protegidos por la sesión)
app.use(express.static(path.join(__dirname, 'public')));

// ─── Rutas API ────────────────────────────────────────────────────────────────

app.use('/api/skus',     require('./src/routes/skus'));
app.use('/api/import',   require('./src/routes/import'));
app.use('/api/reports',  require('./src/routes/reports'));
app.use('/api/cod',      require('./src/routes/cod'));
app.use('/api/settings', require('./src/routes/settings'));
app.use('/api/tts',      require('./src/routes/tts'));

// TTS saved dates (for the days strip)
app.get('/api/tts/dates', (req, res) => {
  try {
    const { getDb } = require('./src/db');
    const db = getDb();
    const dates = db.prepare('SELECT date FROM tts_history ORDER BY date ASC').all().map(r => r.date);
    res.json(dates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Simla endpoints
app.get('/api/simla/stock', async (req, res) => {
  try {
    const { getSimlaStockMap } = require('./src/services/simlaService');
    res.json(await getSimlaStockMap());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/simla/sync', async (req, res) => {
  try {
    const { syncSimlaCosts, invalidateCache } = require('./src/services/simlaService');
    invalidateCache();
    const updated = await syncSimlaCosts();
    res.json({ ok: true, updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Manejo global de errores
app.use((err, req, res, next) => {
  console.error('Error en ruta:', err.message);
  res.status(500).json({ error: err.message });
});

// ─── Arrancar ─────────────────────────────────────────────────────────────────

async function start() {
  try {
    await initDb();
    console.log('  ✓ Base de datos lista');

    app.listen(PORT, () => {
      console.log('');
      console.log('  ╔══════════════════════════════════════╗');
      console.log('  ║   Jupplies Reports — servidor activo ║');
      console.log('  ╠══════════════════════════════════════╣');
      console.log(`  ║   http://localhost:${PORT}              ║`);
      console.log('  ╚══════════════════════════════════════╝');
      console.log('');
      console.log('  Mantené esta ventana abierta mientras usás la app.');
      console.log('  Para cerrar el servidor: Ctrl+C');
      console.log('');
    });
  } catch (err) {
    console.error('Error arrancando el servidor:', err);
    process.exit(1);
  }
}

start();
