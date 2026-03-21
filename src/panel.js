const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const LOG_PATH = path.join(__dirname, '..', 'atendimentos.log');
const app = express();

// Estado compartilhado com o bot
const botState = {
  status: 'disconnected',
  paused: false,
  qrCode: null,
  startedAt: null,
  sessions: {},
  testHistory: {},
  sock: null,
  stats: { today: 0, tests: 0, totalMessages: 0 },
};

const rateLimitMap = new Map();

// CORS para permitir o frontend no Vercel
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-auth-token'],
  credentials: true,
}));

app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

// Auth middleware
function authMiddleware(req, res, next) {
  if (req.path === '/api/login') return next();
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Token necessário' });
  try {
    const cfg = readConfig();
    const expected = crypto.createHash('sha256')
      .update(cfg.panel.username + ':' + cfg.panel.password)
      .digest('hex');
    if (token !== expected) return res.status(401).json({ error: 'Token inválido' });
    next();
  } catch {
    res.status(500).json({ error: 'Erro de autenticação' });
  }
}

// Health check (sem auth, para Render/uptime monitors)
app.get('/health', (req, res) => {
  res.json({ ok: true, status: botState.status, uptime: botState.startedAt ? Date.now() - botState.startedAt : 0 });
});

// Login
app.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body;
    const cfg = readConfig();
    if (username === cfg.panel.username && password === cfg.panel.password) {
      const token = crypto.createHash('sha256')
        .update(cfg.panel.username + ':' + cfg.panel.password)
        .digest('hex');
      res.json({ success: true, token });
    } else {
      res.status(401).json({ error: 'Credenciais inválidas' });
    }
  } catch {
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

app.use('/api', (req, res, next) => {
  if (req.path === '/login') return next();
  authMiddleware(req, res, next);
});

// Config
app.get('/api/config', (req, res) => {
  try { res.json(readConfig()); }
  catch { res.status(500).json({ error: 'Erro ao ler configuração' }); }
});

app.post('/api/config', (req, res) => {
  try {
    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object') {
      return res.status(400).json({ error: 'Config inválida' });
    }
    writeConfig(newConfig);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Erro ao salvar' }); }
});

// Bot Status
app.get('/api/status', (req, res) => {
  const activeSessions = Object.entries(botState.sessions)
    .filter(([, s]) => s.step !== 0)
    .map(([jid, s]) => ({
      number: jid.replace('@s.whatsapp.net', ''),
      step: s.step,
      name: s.name || '-',
    }));

  res.json({
    status: botState.status,
    paused: botState.paused,
    qrCode: botState.qrCode,
    uptime: botState.startedAt ? Date.now() - botState.startedAt : 0,
    activeSessions,
    totalSessions: Object.keys(botState.sessions).length,
    stats: botState.stats,
  });
});

// Pause / Resume
app.post('/api/pause', (req, res) => {
  botState.paused = !botState.paused;
  console.log(botState.paused ? '⏸️  Bot PAUSADO via painel' : '▶️  Bot RETOMADO via painel');
  res.json({ success: true, paused: botState.paused });
});

// QR Code
app.get('/api/qrcode', (req, res) => {
  res.json({ qrCode: botState.qrCode, status: botState.status });
});

// Sessions
app.get('/api/sessions', (req, res) => {
  const list = Object.entries(botState.sessions).map(([jid, s]) => ({
    number: jid.replace('@s.whatsapp.net', ''),
    jid,
    step: s.step,
    name: s.name || '-',
    system: s.system || '-',
  }));
  res.json({ sessions: list });
});

// Test History
app.get('/api/test-history', (req, res) => {
  const list = Object.entries(botState.testHistory).map(([jid, ts]) => ({
    number: jid.replace('@s.whatsapp.net', ''),
    date: new Date(ts).toLocaleString('pt-BR'),
    timestamp: ts,
  }));
  list.sort((a, b) => b.timestamp - a.timestamp);
  res.json({ history: list });
});

app.delete('/api/test-history/:number', (req, res) => {
  const jid = req.params.number + '@s.whatsapp.net';
  if (botState.testHistory[jid]) {
    delete botState.testHistory[jid];
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Número não encontrado' });
  }
});

app.delete('/api/test-history', (req, res) => {
  for (const key of Object.keys(botState.testHistory)) {
    delete botState.testHistory[key];
  }
  res.json({ success: true });
});

// Whitelist / Blacklist
app.post('/api/whitelist', (req, res) => {
  try {
    const cfg = readConfig();
    const { number } = req.body;
    if (!number) return res.status(400).json({ error: 'Número necessário' });
    if (!cfg.whitelist) cfg.whitelist = [];
    if (!cfg.whitelist.includes(number)) cfg.whitelist.push(number);
    writeConfig(cfg);
    res.json({ success: true, whitelist: cfg.whitelist });
  } catch { res.status(500).json({ error: 'Erro' }); }
});

app.delete('/api/whitelist/:number', (req, res) => {
  try {
    const cfg = readConfig();
    cfg.whitelist = (cfg.whitelist || []).filter(n => n !== req.params.number);
    writeConfig(cfg);
    res.json({ success: true, whitelist: cfg.whitelist });
  } catch { res.status(500).json({ error: 'Erro' }); }
});

app.post('/api/blacklist', (req, res) => {
  try {
    const cfg = readConfig();
    const { number } = req.body;
    if (!number) return res.status(400).json({ error: 'Número necessário' });
    if (!cfg.blacklist) cfg.blacklist = [];
    if (!cfg.blacklist.includes(number)) cfg.blacklist.push(number);
    writeConfig(cfg);
    res.json({ success: true, blacklist: cfg.blacklist });
  } catch { res.status(500).json({ error: 'Erro' }); }
});

app.delete('/api/blacklist/:number', (req, res) => {
  try {
    const cfg = readConfig();
    cfg.blacklist = (cfg.blacklist || []).filter(n => n !== req.params.number);
    writeConfig(cfg);
    res.json({ success: true, blacklist: cfg.blacklist });
  } catch { res.status(500).json({ error: 'Erro' }); }
});

// Logs
app.get('/api/logs', (req, res) => {
  try {
    if (!fs.existsSync(LOG_PATH)) return res.json({ logs: [] });
    const content = fs.readFileSync(LOG_PATH, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const last200 = lines.slice(-200).reverse();
    res.json({ logs: last200 });
  } catch { res.status(500).json({ error: 'Erro ao ler logs' }); }
});

app.get('/api/logs/export', (req, res) => {
  try {
    if (!fs.existsSync(LOG_PATH)) return res.status(404).send('Nenhum log');
    const content = fs.readFileSync(LOG_PATH, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    let csv = 'Data/Hora,Numero,Tipo,Detalhes\n';
    for (const line of lines) {
      const match = line.match(/^\[(.+?)\]\s+(.+?)\s+\|\s+(.+?)\s+\|\s+(.+)$/);
      if (match) {
        const [, date, number, type, details] = match;
        csv += `"${date}","${number}","${type}","${details.replace(/"/g, '""')}"\n`;
      }
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=atendimentos.csv');
    res.send('\uFEFF' + csv);
  } catch { res.status(500).json({ error: 'Erro ao exportar' }); }
});

// Stats / Dashboard
app.get('/api/stats', (req, res) => {
  try {
    if (!fs.existsSync(LOG_PATH)) {
      return res.json({ today: 0, total: 0, byType: {}, byDay: [] });
    }
    const content = fs.readFileSync(LOG_PATH, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const todayStr = new Date().toLocaleDateString('pt-BR');
    let todayCount = 0;
    const byType = {};
    const byDay = {};

    for (const line of lines) {
      const match = line.match(/^\[(.+?)\]\s+.+?\s+\|\s+(.+?)\s+\|/);
      if (match) {
        const [, dateStr, type] = match;
        byType[type] = (byType[type] || 0) + 1;
        const dayPart = dateStr.split(',')[0] || dateStr.split(' ')[0];
        byDay[dayPart] = (byDay[dayPart] || 0) + 1;
        if (dateStr.includes(todayStr)) todayCount++;
      }
    }
    const dayEntries = Object.entries(byDay).slice(-30).map(([day, count]) => ({ day, count }));
    res.json({ today: todayCount, total: lines.length, byType, byDay: dayEntries });
  } catch { res.status(500).json({ error: 'Erro ao gerar stats' }); }
});

// Send message (massa)
app.post('/api/send-message', async (req, res) => {
  try {
    const { numbers, message } = req.body;
    if (!message) return res.status(400).json({ error: 'Mensagem necessária' });
    if (!botState.sock) return res.status(400).json({ error: 'Bot não conectado' });

    let targets = numbers;
    if (!targets || targets.length === 0) {
      const jids = new Set([
        ...Object.keys(botState.testHistory),
        ...Object.keys(botState.sessions),
      ]);
      targets = [...jids].map(j => j.replace('@s.whatsapp.net', ''));
    }

    let sent = 0, failed = 0;
    for (const num of targets) {
      try {
        const jid = num.includes('@') ? num : num + '@s.whatsapp.net';
        await botState.sock.sendMessage(jid, { text: message });
        sent++;
        await new Promise(r => setTimeout(r, 1500));
      } catch { failed++; }
    }
    res.json({ success: true, sent, failed });
  } catch { res.status(500).json({ error: 'Erro ao enviar' }); }
});

// Rate limit helper
function checkRateLimit(jid) {
  const cfg = readConfig();
  if (!cfg.rateLimit?.enabled) return true;
  const now = Date.now();
  const maxPerMin = cfg.rateLimit.maxPerMinute || 30;
  if (!rateLimitMap.has(jid)) rateLimitMap.set(jid, []);
  const timestamps = rateLimitMap.get(jid).filter(t => now - t < 60000);
  rateLimitMap.set(jid, timestamps);
  if (timestamps.length >= maxPerMin) return false;
  timestamps.push(now);
  return true;
}

// Business hours helper
function isWithinBusinessHours() {
  const cfg = readConfig();
  const bh = cfg.businessHours;
  if (!bh?.enabled) return true;
  const now = new Date();
  const day = now.getDay();
  if (!(bh.days || []).includes(day)) return false;
  const [startH, startM] = (bh.start || '08:00').split(':').map(Number);
  const [endH, endM] = (bh.end || '22:00').split(':').map(Number);
  const cur = now.getHours() * 60 + now.getMinutes();
  return cur >= startH * 60 + startM && cur <= endH * 60 + endM;
}

function startPanel() {
  const config = readConfig();
  const port = process.env.PORT || config.panel?.port || 3010;
  app.listen(port, () => {
    console.log(`\n🖥️  Painel rodando em: http://localhost:${port}\n`);
  });
}

module.exports = { startPanel, readConfig, writeConfig, botState, checkRateLimit, isWithinBusinessHours };
