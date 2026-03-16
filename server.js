require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL ||
  'https://script.google.com/macros/s/AKfycbzZ9hbLj2ecF9PJgzBpfh3UBTxzGL-WZSawktSdtFeICofuPvLZumeGFGEavH-mQ8SH/exec';

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const agents = new Map();
const pendingForms = new Map();
const callStartTimes = new Map(); // sessionId -> start timestamp

// ── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let agentId = null;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'register') {
      agentId = msg.agentId;
      agents.set(agentId, ws);
      console.log(`Agent registered: ${agentId}`);
      ws.send(JSON.stringify({ type: 'registered', agentId }));
    }
  });
  ws.on('close', () => {
    if (agentId) agents.delete(agentId);
  });
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

  // Log full payload for debugging
  console.log('RC event body:', JSON.stringify(event, null, 2));

  // Track call start time
  const sessionId = event?.sessionId;
  const partyStatuses = (event?.parties || []).map(p => p.status?.code);
  const hasAnswered = partyStatuses.some(s => s === 'Answered');
  if (hasAnswered && sessionId && !callStartTimes.has(sessionId)) {
    callStartTimes.set(sessionId, Date.now());
  }

  // Accept both presence events (telephonyStatus=NoCall) and telephony session events (party status=Disconnected)
  const topStatus = event?.telephonyStatus;
  const isCallEnd = topStatus === 'NoCall' || partyStatuses.some(s => s === 'Disconnected');
  if (!isCallEnd) return;
  // Skip pure presence events that have no parties
  if (!event?.parties?.length) return;

  const parties = event?.parties || [];

  // Agent party always has from.extensionId
  const agentParty = parties.find(p => p.from?.extensionId) || parties[0];
  const direction = agentParty?.direction === 'Outbound' ? 'Outbound' : 'Inbound';

  let otherPhone, otherName;
  if (direction === 'Outbound') {
    // Agent called out: other party is in agentParty.to
    otherPhone = agentParty?.to?.phoneNumber || 'Unknown';
    otherName = agentParty?.to?.name || 'Unknown Caller';
  } else {
    // Someone called in: other party is in agentParty.from or a separate party
    const inboundParty = parties.find(p => !p.from?.extensionId) || parties[1];
    otherPhone = inboundParty?.from?.phoneNumber || agentParty?.from?.phoneNumber || 'Unknown';
    otherName = inboundParty?.from?.name || 'Unknown Caller';
  }

  const callData = {
    formId: uuidv4(),
    agentId: String(agentParty?.from?.extensionId || 'unknown'),
    agentName: agentParty?.from?.name || 'Agent',
    callerPhone: otherPhone,
    callerName: otherName,
    direction,
    duration: sessionId && callStartTimes.has(sessionId) ? Math.round((Date.now() - callStartTimes.get(sessionId)) / 1000) : 0,
    startTime: event?.eventTime || new Date().toISOString(),
    sessionId: event?.sessionId || uuidv4(),
  };

  pendingForms.set(callData.formId, callData);
  if (sessionId) callStartTimes.delete(sessionId);

  const agentWs = agents.get(callData.agentId);
  if (agentWs && agentWs.readyState === WebSocket.OPEN) {
    agentWs.send(JSON.stringify({ type: 'call_ended', callData }));
  } else {
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
    // Google Apps Script requires following redirects manually
    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain', // Apps Script works better with text/plain
      },
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

// ── Test popup ───────────────────────────────────────────────────────────────
app.post('/api/test-popup', (req, res) => {
  const callData = {
    formId: uuidv4(),
    agentId: req.body.agentId || 'test-agent',
    agentName: req.body.agentName || 'Test Agent',
    callerPhone: '+13025550123',
    callerName: 'John Smith',
    direction: 'Inbound',
    duration: 187,
    startTime: new Date().toISOString(),
    sessionId: uuidv4(),
  };
  pendingForms.set(callData.formId, callData);
  if (sessionId) callStartTimes.delete(sessionId);
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
  console.log(`Apps Script URL: ${APPS_SCRIPT_URL}`);
});
