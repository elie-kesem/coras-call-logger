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

const agents = new Map();        // extensionId -> ws
const pendingForms = new Map();
const callStartTimes = new Map(); // sessionId -> start timestamp
const processedSessions = new Set(); // sessionIds already triggered popup

// Extension ID to agent name lookup (fallback for webhook data)
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

  // DEBUG: Log raw webhook payload (first 2000 chars)
  console.log('WEBHOOK RAW:', JSON.stringify(req.body).substring(0, 2000));

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

  // Look up agent name from RC webhook data
  // For outbound: agent is the "from" party
  // For inbound: agent is the "to" party (they received the call)
  // Also check activeCalls for the agent's name
  let rcAgentName = 'Unknown';
  if (direction === 'Outbound') {
    rcAgentName = agentParty?.from?.name || activeCall?.fromName || 'Unknown';
  } else {
    // Inbound: agent answered, so their name is in the "to" side
    const agentAsTo = parties.find(p => p.to?.extensionId);
    rcAgentName = agentAsTo?.to?.name || agentParty?.to?.name || activeCall?.toName || 'Unknown';
  }
  // Fallback: look up from AGENTS list by extension ID
  if (rcAgentName === 'Unknown' || rcAgentName === 'Unknown Caller') {
    rcAgentName = AGENT_NAMES[extId] || 'Unknown';
  }

  const callData = {
    formId: uuidv4(),
    agentId: extId,
    agentName: rcAgentName,
    rcAgentName,
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

  // Route to specific agent by extension ID — never broadcast
  if (extId === 'unknown') {
    console.log(`Session ${sessionId} - no extension ID found, skipping popup`);
    return;
  }
  const agentWs = agents.get(extId);
  if (agentWs && agentWs.readyState === WebSocket.OPEN) {
    console.log(`Routing popup to agent ext ${extId}`);
    agentWs.send(JSON.stringify({ type: 'call_ended', callData }));
  } else {
    console.log(`Agent ext ${extId} not connected, popup dropped`);
  }
});

// ── Submit → Google Sheets via Apps Script ───────────────────────────────────
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
