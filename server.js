require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL ||
  'https://script.google.com/macros/s/AKfycbz_-V_REex012_GpwYc5Elrp135AVuyONudgkccPKNJ2fypx5nXINsYHQOOkuNP8r9n/exec';

const RC_CLIENT_ID = process.env.RC_CLIENT_ID || '4wQyQGPz0HYcwQ1JGnPy45';
const RC_CLIENT_SECRET = process.env.RC_CLIENT_SECRET || 'bUghqhsGdjHeQpAuEDuToLdsDGSiaFFA8bdv9X3h4GOu';
const RC_SERVER = 'https://platform.ringcentral.com';

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const agents = new Map();              // extensionId -> ws
const pendingForms = new Map();
const processedSessions = new Set();   // "sessionId:extId" combos already triggered
const sessionTimers = new Map();       // sessionId -> { startTime, answeredBy: Set }
const pendingPopups = new Map();       // extensionId -> [callData, ...] (queue for reconnect)
const processedUuids = new Set();      // deduplicate across multiple subscriptions

// Extension ID to agent name lookup
const AGENT_NAMES = {
  '63747196007': 'Amy Green',
  '62824418006': 'Anabell Rosario',
  '63866477007': 'Becca Lewis',
  '62842636006': 'Bennett Johnson',
  '63794397007': 'Catherine Asem',
  '63747245007': 'Chelsea Hickey',
  '62831034006': 'Christina Spanos',
  '63747246007': 'Claudia Corzo',
  '63747234007': 'Cynthia Prange',
  '63747233007': 'Danshanara Turlington',
  '63747222007': 'Davida Mccray',
  '62842639006': 'Deniz Sotelo Rodriguez',
  '63870421007': 'Dennis Thompson',
  '62842473006': 'Elie Orgel',
  '62842635006': 'Geraldine Mcginnis',
  '63747197007': 'Humberto Hernandez',
  '62837438006': 'Ivoria Harris',
  '63857220007': 'Jami Knowland',
  '63877665007': 'Jamie Paolini',
  '63747205007': 'Jay Cantor',
  '62843219006': 'Jenn Begley',
  '63747244007': 'Jennifer Screen',
  '63866476007': 'Jessica Butler',
  '62842642006': 'Jocelyn Rodriguez',
  '63747195007': 'Kelly Emmell',
  '63747227007': 'Kim Enger',
  '62842640006': 'Korayma Rojas',
  '62842546006': 'Kylee Howell',
  '63747210007': 'Kyra Berrios',
  '62842643006': 'Larica Curry',
  '63747240007': 'Latasha Spruill',
  '63908826007': 'Latoya Smith',
  '63747239007': 'Latoya Waples',
  '63870423007': 'Lisa Rodriguez',
  '62842637006': 'Magali Lopez',
  '63747215007': 'Marco Hernandez',
  '63747204007': 'Megan Cooper',
  '63747203007': 'Melissa Wiley',
  '63747238007': 'Michael Trzeciakiewicz',
  '63747209007': 'Naomi Middleton',
  '62842638006': 'Nestor Lopez',
  '63851655007': 'Nicole Worseck-Dixon',
  '63747208007': 'Nya Stanley',
  '63747202007': 'Okechukwu Obua',
  '63747232007': 'Patricia Ayers',
  '62831037006': 'Rache Fitzgerald',
  '63747220007': 'Ricky Thomas',
  '63747221007': 'Robert Isakoff',
  '63747223007': 'Robert Miller',
  '63747231007': 'Ron Romanelli',
  '62842641006': 'Sally Rodriguez Sotelo',
  '62837202006': 'Shannon Brady',
  '63747237007': 'Shelby Stevens',
  '63747225007': 'Sixto Rey Troche',
  '62844939006': 'Stephanie Falkner',
  '63747243007': 'Susanna Larvie',
  '62791907006': 'Sylvia Simon',
  '63804918007': 'Syreeta Monte',
  '63747201007': 'Uche Obua',
  '63747207007': 'Victoria Distler',
};

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

      // Deliver any queued popups from while agent was disconnected
      const queued = pendingPopups.get(agentExtId);
      if (queued && queued.length > 0) {
        console.log(`[QUEUE] Delivering ${queued.length} queued popup(s) to ext ${agentExtId}`);
        queued.forEach(callData => {
          ws.send(JSON.stringify({ type: 'call_ended', callData }));
        });
        pendingPopups.delete(agentExtId);
      }
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
  // Handle subscription validation
  const validationToken = req.headers['validation-token'];
  if (validationToken) {
    res.set('Validation-Token', validationToken);
    return res.status(200).send();
  }
  res.status(200).send();

  const uuid = req.body?.uuid;
  const eventFilter = req.body?.event || '';
  const event = req.body?.body;
  if (!event) return;

  // ── DEDUP: Skip duplicate events from multiple subscriptions ──
  if (uuid) {
    if (processedUuids.has(uuid)) return;
    processedUuids.add(uuid);
    setTimeout(() => processedUuids.delete(uuid), 120000);
  }

  // ── FILTER: Only process extension-level events ──
  // Account-level events (/account/xxx/telephony/sessions) have no extension
  // in the URL and produce unreliable party data
  if (!eventFilter.includes('/extension/')) return;

  // Extract extension ID from the event filter URL
  const extMatch = eventFilter.match(/\/extension\/(\d+)\//);
  const eventExtId = extMatch ? extMatch[1] : null;

  // ── FILTER: Only process events for known agents ──
  if (!eventExtId || !AGENT_NAMES[eventExtId]) return;

  const sessionId = event?.sessionId;
  const parties = event?.parties || [];
  if (!parties.length || !sessionId) return;

  const party = parties[0];
  const statusCode = party?.status?.code;
  const direction = party?.direction;

  // ── TRACK: Record when an agent answers ──
  if (statusCode === 'Answered') {
    if (!sessionTimers.has(sessionId)) {
      sessionTimers.set(sessionId, { startTime: Date.now(), answeredBy: new Set() });
    }
    sessionTimers.get(sessionId).answeredBy.add(eventExtId);
    console.log(`[CALL] Session ${sessionId} - ${AGENT_NAMES[eventExtId]} answered (${direction})`);
    return;
  }

  // ── IGNORE: Setup, Proceeding, Voicemail events ──
  if (statusCode !== 'Disconnected') return;

  // ── FILTER: Skip ring-no-answer and missed calls ──
  const reason = party?.status?.reason;
  if (reason === 'AgentDropped' || party?.missedCall) return;

  // ── FILTER: Only trigger popup if this agent actually answered the call ──
  const timer = sessionTimers.get(sessionId);
  if (!timer || !timer.answeredBy.has(eventExtId)) return;

  // ── DEDUP: One popup per session per agent ──
  const sessionExtKey = `${sessionId}:${eventExtId}`;
  if (processedSessions.has(sessionExtKey)) return;
  processedSessions.add(sessionExtKey);
  setTimeout(() => processedSessions.delete(sessionExtKey), 120000);

  // ── Calculate duration ──
  const callDuration = Math.round((Date.now() - timer.startTime) / 1000);

  // Skip calls shorter than 3 seconds
  if (callDuration < 3) {
    console.log(`[CALL] Session ${sessionId} - ${AGENT_NAMES[eventExtId]} ${callDuration}s, too short, skipping`);
    return;
  }

  // ── Build call data ──
  let otherPhone, otherName;
  if (direction === 'Inbound') {
    otherPhone = party?.from?.phoneNumber || 'Unknown';
    otherName = party?.from?.name || 'Unknown Caller';
    // Clean forwarded names like "Wellness and Recovery Helpline - WIRELESS CALLER"
    if (otherName.includes(' - ')) {
      otherName = otherName.split(' - ').pop().trim();
    }
  } else {
    otherPhone = party?.to?.phoneNumber || 'Unknown';
    otherName = party?.to?.name || 'Unknown Caller';
  }

  const agentName = AGENT_NAMES[eventExtId];

  const callData = {
    formId: uuidv4(),
    agentId: eventExtId,
    agentName: agentName,
    rcAgentName: agentName,
    callerPhone: otherPhone,
    callerName: otherName,
    direction: direction || 'Unknown',
    duration: callDuration,
    startTime: event?.eventTime || new Date().toISOString(),
    sessionId: sessionId,
  };

  console.log(`[CALL] Popup: ${agentName} | ${direction} | ${otherPhone} ${otherName} | ${callDuration}s`);

  // Clean up timer if no other agents are pending on this session
  timer.answeredBy.delete(eventExtId);
  if (timer.answeredBy.size === 0) sessionTimers.delete(sessionId);

  // ── Deliver or queue popup ──
  const agentWs = agents.get(eventExtId);
  if (agentWs && agentWs.readyState === WebSocket.OPEN) {
    agentWs.send(JSON.stringify({ type: 'call_ended', callData }));
  } else {
    console.log(`[QUEUE] Agent ext ${eventExtId} offline, queuing popup (5 min expiry)`);
    if (!pendingPopups.has(eventExtId)) pendingPopups.set(eventExtId, []);
    pendingPopups.get(eventExtId).push(callData);
    setTimeout(() => {
      const q = pendingPopups.get(eventExtId);
      if (q) {
        const idx = q.indexOf(callData);
        if (idx !== -1) q.splice(idx, 1);
        if (q.length === 0) pendingPopups.delete(eventExtId);
      }
    }, 300000);
  }
});

// ── Submit to Google Sheets ──────────────────────────────────────────────────
app.post('/api/submit', async (req, res) => {
  const {
    formId, outcome, notes, followUpDate,
    agentName, rcAgentName, callerPhone, callerName,
    direction, duration, startTime, sessionId,
    clientType, service, submissionId
  } = req.body;

  const sid = submissionId || 'NO-ID';
  console.log(`[SUBMIT ${sid}] Received from ${agentName} | ${clientType} | ${service} | ${outcome}`);

  if (!outcome) {
    console.log(`[SUBMIT ${sid}] REJECTED: missing outcome`);
    return res.status(400).json({ error: 'Outcome is required' });
  }

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
    rcAgentName: rcAgentName || '',
    submissionId: sid,
  };

  try {
    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });

    const text = await response.text();
    console.log(`[SUBMIT ${sid}] Apps Script status: ${response.status} | body: ${text}`);

    let result;
    try { result = JSON.parse(text); } catch { result = {}; }

    if (result.success) {
      console.log(`[SUBMIT ${sid}] SUCCESS`);
      pendingForms.delete(formId);
      res.json({ success: true, submissionId: sid });
    } else {
      console.error(`[SUBMIT ${sid}] APPS SCRIPT ERROR: ${result.error || text}`);
      res.status(500).json({ error: result.error || 'Apps Script reported failure', submissionId: sid });
    }
  } catch (err) {
    console.error(`[SUBMIT ${sid}] NETWORK ERROR: ${err.message}`);
    res.status(500).json({ error: 'Failed to save to Google Sheets: ' + err.message, submissionId: sid });
  }
});

// ── Test popup ───────────────────────────────────────────────────────────────
app.post('/api/test-popup', (req, res) => {
  const targetExt = req.body.extensionId || 'test';
  const callData = {
    formId: uuidv4(),
    agentId: targetExt,
    agentName: req.body.agentName || 'Test Agent',
    callerPhone: '+13025550123',
    callerName: 'John Smith',
    direction: 'Inbound',
    duration: 187,
    startTime: new Date().toISOString(),
    sessionId: uuidv4(),
  };
  const agentWs = agents.get(targetExt);
  if (agentWs && agentWs.readyState === WebSocket.OPEN) {
    agentWs.send(JSON.stringify({ type: 'call_ended', callData }));
    res.json({ success: true, callData, routed: true });
  } else {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN)
        client.send(JSON.stringify({ type: 'call_ended', callData }));
    });
    res.json({ success: true, callData, routed: false, broadcast: true });
  }
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
