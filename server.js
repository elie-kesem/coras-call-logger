require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// Google Apps Script Web App URL - no Google Cloud needed
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL ||
  'https://script.google.com/macros/s/AKfycbzZ9hbLj2ecF9PJgzBpfh3UBTxzGL-WZSawktSdtFeICofuPvLZumeGFGEavH-mQ8SH/exec';

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Track connected agents: agentId -> ws
const agents = new Map();
// Pending forms: formId -> callData
const pendingForms = new Map();

// ── WebSocket: agent connections ─────────────────────────────────────────────
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
    if (agentId) {
      agents.delete(agentId);
      console.log(`Agent disconnected: ${agentId}`);
    }
  });
});

// ── RingCentral Webhook ──────────────────────────────────────────────────────
app.post('/webhook/ringcentral', async (req, res) => {
  // RingCentral sends a validation token on first setup
  const validationToken = req.headers['validation-token'];
  if (validationToken) {
    res.set('Validation-Token', validationToken);
    return res.status(200).send();
  }

  res.status(200).send(); // always ACK quickly

  const body = req.body;
  const event = body?.body;
  if (!event) return;

  // Only act on calls that have ended
  const status = event?.telephonyStatus || event?.status;
  if (status !== 'NoCall' && status !== 'Disconnected') return;

  const parties = event?.parties || [];
  const agent = parties.find(p => p.direction === 'Outbound' || p.role === 'Initiator') || parties[0];
  const caller = parties.find(p => p.direction === 'Inbound') || parties[1];

  const callData = {
    formId: uuidv4(),
    agentId: String(agent?.extensionId || agent?.accountId || 'unknown'),
    agentName: agent?.from?.name || agent?.to?.name || 'Agent',
    callerPhone: caller?.from?.phoneNumber || event?.from?.phoneNumber || 'Unknown',
    callerName: caller?.from?.name || 'Unknown Caller',
    direction: event?.direction || 'Inbound',
    duration: event?.duration || 0,
    startTime: event?.startTime || new Date().toISOString(),
    sessionId: event?.sessionId || uuidv4(),
  };

  pendingForms.set(callData.formId, callData);

  // Push popup to the matching agent's browser
  const agentWs = agents.get(callData.agentId);
  if (agentWs && agentWs.readyState === WebSocket.OPEN) {
    agentWs.send(JSON.stringify({ type: 'call_ended', callData }));
  } else {
    // Broadcast to all connected agents as fallback
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'call_ended', callData }));
      }
    });
  }
});

// ── Submit form → Google Sheets via Apps Script ───────────────────────────────
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });

    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch { result = { success: true }; }

    if (result.success === false) {
      throw new Error(result.error || 'Apps Script returned error');
    }

    pendingForms.delete(formId);
    res.json({ success: true });
  } catch (err) {
    console.error('Sheet error:', err.message);
    res.status(500).json({ error: 'Failed to save to Google Sheets', detail: err.message });
  }
});

// ── Manual test popup ────────────────────────────────────────────────────────
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
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'call_ended', callData }));
    }
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

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`CORAS Call Logger running on port ${PORT}`);
  console.log(`Apps Script URL: ${APPS_SCRIPT_URL}`);
});
