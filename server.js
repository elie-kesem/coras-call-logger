require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const SUGGESTIONS_FILE = path.join(__dirname, 'suggestions.json');
function loadSuggestions() {
  try { return JSON.parse(fs.readFileSync(SUGGESTIONS_FILE, 'utf8')); } catch { return []; }
}
function saveSuggestions(list) {
  fs.writeFileSync(SUGGESTIONS_FILE, JSON.stringify(list, null, 2));
}

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL ||
  'https://script.google.com/macros/s/AKfycbzZ9hbLj2ecF9PJgzBpfh3UBTxzGL-WZSawktSdtFeICofuPvLZumeGFGEavH-mQ8SH/exec';

const RC_CLIENT_ID = process.env.RC_CLIENT_ID || '4wQyQGPz0HYcwQ1JGnPy45';
const RC_CLIENT_SECRET = process.env.RC_CLIENT_SECRET || 'bUghqhsGdjHeQpAuEDuToLdsDGSiaFFA8bdv9X3h4GOu';
const RC_SERVER = 'https://platform.ringcentral.com';

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// ── Basic Auth for admin pages ────────────────────────────────────────────────
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'coras2024';

function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const [user, pass] = decoded.split(':');
    if (user === ADMIN_USER && pass === ADMIN_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="CORAS Admin"');
  res.status(401).send('Unauthorized');
}

app.get('/dashboard.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/suggestions.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'suggestions.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

const agents = new Map();        // extensionId -> ws
const pendingForms = new Map();
const callStartTimes = new Map(); // sessionId -> start timestamp
const processedSessions = new Set(); // sessionIds already triggered popup

// ── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let agentExtId = null;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'register') {
      agentExtId = String(msg.extensionId);
      agents.set(agentExtId, ws);
      console.log(`Agent registered: ${msg.agentName} (ext ${agentExtId})`);
      ws.send(JSON.stringify({ type: 'registered', extensionId: agentExtId }));
    }
  });
  ws.on('close', () => {
    if (agentExtId) agents.delete(agentExtId);
  });
});

// ── OAuth: exchange code for token ───────────────────────────────────────────
app.post('/api/rc-auth', async (req, res) => {
  const { code, redirectUri } = req.body;
  if (!code) return res.status(400).json({ error: 'Missing code' });

  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });

    const response = await fetch(`${RC_SERVER}/restapi/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${RC_CLIENT_ID}:${RC_CLIENT_SECRET}`).toString('base64'),
      },
      body: params.toString(),
    });

    const token = await response.json();
    if (!token.access_token) {
      console.error('Token error:', token);
      return res.status(400).json({ error: 'Failed to get token', detail: token });
    }

    // Fetch user info to get extension ID and name
    const meRes = await fetch(`${RC_SERVER}/restapi/v1.0/account/~/extension/~`, {
      headers: { 'Authorization': `Bearer ${token.access_token}` }
    });
    const me = await meRes.json();

    res.json({
      extensionId: String(me.id),
      agentName: me.name || `${me.contact?.firstName} ${me.contact?.lastName}`.trim(),
      accessToken: token.access_token,
    });
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── RingCentral Webhook ──────────────────────────────────────────────────────
app.post('/webhook/ringcentral', async (req, res) => {
  const validationToken = req.headers['validation-token'];
  if (validationToken) {
    res.set('Validation-Token', validationToken);
    return res.status(200).send();
  }
  res.status(200).send();

  const event = req.body?.body;
  if (!event) return;

  // Track call start time
  const sessionId = event?.sessionId;
  const partyStatuses = (event?.parties || []).map(p => p.status?.code);
  const hasAnswered = partyStatuses.some(s => s === 'Answered');
  const hasProceeding = partyStatuses.some(s => s === 'Proceeding');
  
  console.log(`Session ${sessionId} - statuses: ${JSON.stringify(partyStatuses)}, hasAnswered: ${hasAnswered}`);
  
  // Start timer on Answered OR Proceeding (for outbound calls that connect)
  if ((hasAnswered || hasProceeding) && sessionId && !callStartTimes.has(sessionId)) {
    callStartTimes.set(sessionId, Date.now());
    console.log(`Started timer for session ${sessionId}`);
  }

  // Accept telephony session disconnects and presence NoCall events
  // Only process telephony session events with Disconnected party status
  const isCallEnd = partyStatuses.some(s => s === 'Disconnected');
  if (!isCallEnd) return;
  if (!event?.parties?.length) return;
  // Skip if already processed this session
  if (sessionId && processedSessions.has(sessionId)) return;

  const parties = event?.parties || [];

  // Get extensionId from party data or top-level event
  const agentParty = parties.find(p => p.from?.extensionId) || parties[0];
  const topExtId = event?.extensionId ? String(event.extensionId) : null;
  const extId = String(agentParty?.from?.extensionId || topExtId || 'unknown');

  // Use activeCalls for direction — most reliable source
  const activeCall = event?.activeCalls?.[0];
  const direction = activeCall?.direction === 'Outbound' ? 'Outbound' :
    (agentParty?.direction === 'Outbound' ? 'Outbound' : 'Inbound');

  let otherPhone, otherName;
  if (direction === 'Outbound') {
    // Agent dialed out — other party is the "to" number
    otherPhone = activeCall?.to || agentParty?.to?.phoneNumber || 'Unknown';
    otherName = agentParty?.to?.name || 'Unknown Caller';
  } else {
    // Inbound — other party is the "from" number
    otherPhone = activeCall?.from || agentParty?.from?.phoneNumber || 'Unknown';
    // For inbound, agent's own number is in from if it's their extension
    // Find the non-agent party
    const inboundParty = parties.find(p => !p.from?.extensionId) || parties[1];
    if (inboundParty) {
      otherPhone = inboundParty.from?.phoneNumber || otherPhone;
      otherName = inboundParty.from?.name || 'Unknown Caller';
    } else {
      otherName = 'Unknown Caller';
    }
  }

  const callData = {
    formId: uuidv4(),
    agentId: extId,
    agentName: agentParty?.from?.name || 'Agent',
    callerPhone: otherPhone,
    callerName: otherName,
    direction,
    duration: sessionId && callStartTimes.has(sessionId)
      ? Math.round((Date.now() - callStartTimes.get(sessionId)) / 1000) : 0,
    startTime: event?.eventTime || new Date().toISOString(),
    sessionId: event?.sessionId || uuidv4(),
  };

  pendingForms.set(callData.formId, callData);
  if (sessionId) {
    callStartTimes.delete(sessionId);
    processedSessions.add(sessionId);
    setTimeout(() => processedSessions.delete(sessionId), 60000);
  }

  // Route to specific agent by extension ID
  const agentWs = agents.get(extId);
  if (agentWs && agentWs.readyState === WebSocket.OPEN) {
    console.log(`Routing popup to agent ext ${extId}`);
    agentWs.send(JSON.stringify({ type: 'call_ended', callData }));
  } else {
    console.log(`Agent ext ${extId} not connected, broadcasting to all`);
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN)
        client.send(JSON.stringify({ type: 'call_ended', callData }));
    });
  }
});

// ── Submit → Google Sheets via Apps Script ───────────────────────────────────
app.post('/api/submit', async (req, res) => {
  const {
    formId, outcome, notes, followUpDate,
    agentName, callerPhone, callerName,
    direction, duration, startTime, sessionId,
    clientType, service
  } = req.body;

  if (!outcome) return res.status(400).json({ error: 'Outcome is required' });

  const payload = {
    timestamp: new Date().toISOString(),
    sessionId: sessionId || '',
    agentName: agentName || '',
    callerPhone: callerPhone || '',
    callerName: callerName || '',
    direction: direction || '',
    duration: formatDuration(duration),
    startTime: startTime || '',
    clientType: clientType || '',
    service: service || '',
    outcome,
    notes: notes || '',
    followUpDate: followUpDate || '',
  };

  try {
    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });

    console.log('Apps Script response status:', response.status);
    const text = await response.text();
    console.log('Apps Script response body:', text);

    pendingForms.delete(formId);
    res.json({ success: true });
  } catch (err) {
    console.error('Sheet error:', err.message);
    res.status(500).json({ error: 'Failed to save to Google Sheets', detail: err.message });
  }
});

// ── Report: fetch rows from Google Sheets via Apps Script ────────────────────
app.get('/api/report', requireAuth, async (req, res) => {
  try {
    const url = new URL(APPS_SCRIPT_URL);
    // Forward any query params (startDate, endDate, agent) to the script
    if (req.query.startDate) url.searchParams.set('startDate', req.query.startDate);
    if (req.query.endDate)   url.searchParams.set('endDate',   req.query.endDate);
    if (req.query.agent)     url.searchParams.set('agent',     req.query.agent);
    url.searchParams.set('action', 'read');

    const response = await fetch(url.toString(), { redirect: 'follow' });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { rows: [] }; }
    res.json(data);
  } catch (err) {
    console.error('Report fetch error:', err.message);
    res.status(500).json({ error: err.message, rows: [] });
  }
});

// ── Suggestions ──────────────────────────────────────────────────────────────
app.post('/api/suggest', (req, res) => {
  const { agentName, direction, clientType, step, context, suggestion } = req.body;
  if (!suggestion?.trim()) return res.status(400).json({ error: 'Suggestion text required' });
  const list = loadSuggestions();
  list.push({
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    agentName: agentName || 'Unknown',
    direction: direction || 'Unknown',
    clientType: clientType || null,
    step: step || null,
    context: context || null,
    suggestion: suggestion.trim(),
  });
  saveSuggestions(list);
  console.log(`Suggestion from ${agentName}: [${step}] "${suggestion.trim()}"`);
  res.json({ success: true });
});

app.get('/api/suggestions', requireAuth, (req, res) => {
  res.json(loadSuggestions());
});

// ── Test popup ───────────────────────────────────────────────────────────────
app.post('/api/test-popup', (req, res) => {
  const callData = {
    formId: uuidv4(),
    agentId: req.body.extensionId || 'test',
    agentName: req.body.agentName || 'Test Agent',
    callerPhone: '+13025550123',
    callerName: 'John Smith',
    direction: 'Inbound',
    duration: 187,
    startTime: new Date().toISOString(),
    sessionId: uuidv4(),
  };
  pendingForms.set(callData.formId, callData);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN)
      client.send(JSON.stringify({ type: 'call_ended', callData }));
  });
  res.json({ success: true, callData });
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`CORAS Call Logger running on port ${PORT}`);
});
