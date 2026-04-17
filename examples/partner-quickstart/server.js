/**
 * Hanzi Browse Partner Quickstart — Medical AI Assistant Demo
 *
 * Shows how a medical app can use Hanzi Browse to read patient data from
 * any EHR (Electronic Health Record) system through the browser.
 *
 * The doctor opens their EHR in one tab and this app in another.
 * This app uses Hanzi Browse to read the patient chart from the EHR tab.
 *
 * Setup:
 *   1. Get an API key from https://api.hanzilla.co/dashboard
 *   2. HANZI_API_KEY=hic_live_... npm start
 *   3. Open http://localhost:3000
 */

import express from "express";

const app = express();
app.use(express.json());

const API_KEY = process.env.HANZI_API_KEY;
const BASE_URL = process.env.HANZI_API_URL || "https://api.hanzilla.co";

if (!API_KEY) {
  console.error("Set HANZI_API_KEY environment variable.");
  process.exit(1);
}

async function hanzi(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// --- Routes ---

app.post("/api/pair", async (req, res) => {
  try {
    const data = await hanzi("POST", "/v1/browser-sessions/pair", {
      label: req.body.doctor_name || "Doctor",
      external_user_id: req.body.doctor_id || `doc-${Date.now()}`,
    });
    res.json({
      pairing_token: data.pairing_token,
      pairing_url: `${BASE_URL}/pair/${data.pairing_token}`,
      expires_in_seconds: data.expires_in_seconds,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sessions", async (req, res) => {
  try {
    const data = await hanzi("GET", "/v1/browser-sessions");
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/task", async (req, res) => {
  try {
    const { browser_session_id, task } = req.body;
    if (!browser_session_id || !task) {
      return res.status(400).json({ error: "browser_session_id and task required" });
    }
    const created = await hanzi("POST", "/v1/tasks", { browser_session_id, task });
    const deadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const status = await hanzi("GET", `/v1/tasks/${created.id}`);
      if (status.status !== "running") return res.json(status);
    }
    res.json({ id: created.id, status: "timeout" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Frontend ---

app.get("/", (req, res) => { res.type("html").send(HTML); });

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MediAssist — AI Medical Assistant</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f0f4f8; color: #1a2332; min-height: 100vh; }
    .topbar { background: #1a2332; color: white; padding: 12px 24px; display: flex; align-items: center; gap: 12px; }
    .topbar h1 { font-size: 18px; font-weight: 700; }
    .topbar .badge { font-size: 11px; background: #38bdf8; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
    .container { max-width: 680px; margin: 0 auto; padding: 24px 20px; }
    .card { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
    .card h2 { font-size: 16px; font-weight: 700; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
    .card p { font-size: 14px; color: #64748b; line-height: 1.6; margin-bottom: 12px; }
    button { padding: 10px 20px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; }
    .btn-primary { background: #1a2332; color: white; }
    .btn-primary:hover { background: #2d3a4a; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-secondary { background: white; border: 1px solid #e2e8f0; color: #1a2332; }
    .status { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; padding: 4px 10px; border-radius: 999px; }
    .status-connected { background: #dcfce7; color: #166534; }
    .status-disconnected { background: #fef2f2; color: #991b1b; }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; }
    .status-dot.on { background: #22c55e; }
    .status-dot.off { background: #ef4444; }
    .chat { display: flex; flex-direction: column; gap: 12px; }
    .message { padding: 12px 16px; border-radius: 12px; font-size: 14px; line-height: 1.6; max-width: 90%; }
    .message.user { background: #1a2332; color: white; align-self: flex-end; border-bottom-right-radius: 4px; }
    .message.ai { background: #f1f5f9; color: #1a2332; align-self: flex-start; border-bottom-left-radius: 4px; }
    .message.ai .label { font-size: 11px; font-weight: 700; color: #38bdf8; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
    .input-row { display: flex; gap: 8px; margin-top: 12px; }
    .input-row input { flex: 1; padding: 10px 14px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 14px; font-family: inherit; }
    .input-row input:focus { outline: none; border-color: #38bdf8; }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #e2e8f0; border-top-color: #38bdf8; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .link { color: #38bdf8; text-decoration: none; font-weight: 600; }
    .link:hover { text-decoration: underline; }
    .setup-hint { font-size: 13px; color: #94a3b8; margin-top: 8px; }
    .examples { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .example { padding: 6px 12px; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 999px; font-size: 12px; cursor: pointer; color: #475569; }
    .example:hover { background: #e2e8f0; }
  </style>
</head>
<body>
  <div class="topbar">
    <h1>MediAssist</h1>
    <span class="badge">AI Medical Assistant</span>
    <span style="margin-left:auto; font-size:12px; opacity:0.6;">Powered by Hanzi Browse</span>
  </div>

  <div class="container">
    <!-- Setup -->
    <div class="card" id="setup-card">
      <h2>
        <span id="setup-icon">⚡</span>
        Connect your browser
      </h2>
      <p>Connect your Chrome browser to MediAssist. The AI will be able to open your EHR, read patient charts, and answer your questions.</p>
      <div id="setup-content">
        <button class="btn-primary" id="pair-btn" onclick="startPairing()">Connect browser</button>
      </div>
      <div id="setup-status" style="margin-top:8px;"></div>
    </div>

    <!-- Chat -->
    <div class="card" id="chat-card" style="display:none;">
      <h2>🩺 Patient Assistant</h2>
      <p>Ask a question. The AI will open the EHR, find the patient, and read their chart to answer you.</p>

      <div class="examples" id="examples">
        <span class="example" onclick="askQuestion(this.textContent)">Summarize this patient's chart</span>
        <span class="example" onclick="askQuestion(this.textContent)">What medications are they on and are there any drug interactions?</span>
        <span class="example" onclick="askQuestion(this.textContent)">Prepare a pre-visit summary for my next appointment</span>
        <span class="example" onclick="askQuestion(this.textContent)">Are this patient's vitals concerning?</span>
        <span class="example" onclick="askQuestion(this.textContent)">What insurance does this patient have?</span>
      </div>

      <div class="chat" id="chat"></div>

      <div class="input-row">
        <input id="question" placeholder="Ask about a patient..." onkeydown="if(event.key==='Enter')askQuestion()" />
        <button class="btn-primary" id="ask-btn" onclick="askQuestion()">Ask</button>
      </div>
    </div>
  </div>

  <script>
    let connectedSessionId = null;

    async function startPairing() {
      const btn = document.getElementById('pair-btn');
      const status = document.getElementById('setup-status');
      btn.disabled = true;
      btn.textContent = 'Generating link...';

      try {
        const res = await fetch('/api/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ doctor_name: 'Dr. Demo' }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        status.innerHTML =
          '<p style="margin-top:8px;"><a href="' + data.pairing_url + '" target="_blank" class="link">Click here to connect your browser →</a></p>' +
          '<p class="setup-hint">Opens a new tab. Your browser will auto-connect in seconds.</p>';
        btn.textContent = 'Link generated';

        // Poll for connection
        pollSessions();
      } catch (err) {
        status.innerHTML = '<p style="color:#ef4444;">' + err.message + '</p>';
        btn.disabled = false;
        btn.textContent = 'Connect browser';
      }
    }

    async function pollSessions() {
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 3000));
        try {
          const res = await fetch('/api/sessions');
          const data = await res.json();
          const connected = (data.sessions || []).find(s => s.status === 'connected');
          if (connected) {
            connectedSessionId = connected.id;
            document.getElementById('setup-icon').textContent = '✓';
            document.getElementById('setup-content').innerHTML =
              '<span class="status status-connected"><span class="status-dot on"></span> Browser connected</span>';
            document.getElementById('setup-status').innerHTML = '';
            document.getElementById('chat-card').style.display = '';
            return;
          }
        } catch {}
      }
    }

    async function askQuestion(text) {
      const input = document.getElementById('question');
      const question = text || input.value.trim();
      if (!question || !connectedSessionId) return;
      input.value = '';

      const chat = document.getElementById('chat');
      document.getElementById('examples').style.display = 'none';

      // Show user message
      chat.innerHTML += '<div class="message user">' + escHtml(question) + '</div>';

      // Show loading
      const loadingId = 'loading-' + Date.now();
      chat.innerHTML += '<div class="message ai" id="' + loadingId + '"><div class="label">MediAssist AI</div><span class="spinner"></span> Opening EHR, logging in, reading chart...</div>';
      chat.scrollTop = chat.scrollHeight;

      // Build the task with domain knowledge about OpenEMR's iframe-heavy layout.
      // IMPORTANT: OpenEMR uses nested iframes — clicking menus is unreliable.
      // Use direct URLs instead to navigate reliably.
      const task = 'Go to https://demo.openemr.io/openemr/index.php and log in with username "physician" and password "physician". ' +
        'IMPORTANT: OpenEMR uses iframes — do NOT click menus to navigate. Use direct URLs instead. ' +
        'After logging in, navigate directly to https://demo.openemr.io/openemr/interface/main/finder/dynamic_finder.php to see the patient list. ' +
        'Click the first patient to open their chart. If that URL does not work, try https://demo.openemr.io/openemr/interface/patient_file/summary/demographics.php?set_pid=1 to go directly to patient #1. ' +
        'Read all visible patient information including demographics, diagnoses, medications, and notes. ' +
        'Then answer this question from the doctor: "' + question + '". ' +
        'Give a clear, concise medical answer based only on what you can see in the chart.';

      try {
        const res = await fetch('/api/task', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ browser_session_id: connectedSessionId, task }),
        });
        const data = await res.json();
        const el = document.getElementById(loadingId);
        if (data.status === 'complete' && data.answer) {
          el.innerHTML = '<div class="label">MediAssist AI</div>' + escHtml(data.answer);
        } else if (data.error && data.error.includes('429')) {
          el.innerHTML = '<div class="label">MediAssist AI</div>The AI service is temporarily busy. Please wait a moment and try again.';
        } else {
          el.innerHTML = '<div class="label">MediAssist AI</div>Sorry, I couldn\\'t read the chart. Make sure your EHR is open in the connected browser and try again.';
        }
      } catch (err) {
        const el = document.getElementById(loadingId);
        if (el) el.innerHTML = '<div class="label">MediAssist AI</div>Error: ' + escHtml(err.message);
      }
      chat.scrollTop = chat.scrollHeight;
    }

    function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    // Check if already connected
    fetch('/api/sessions').then(r => r.json()).then(data => {
      const connected = (data.sessions || []).find(s => s.status === 'connected');
      if (connected) {
        connectedSessionId = connected.id;
        document.getElementById('setup-icon').textContent = '✓';
        document.getElementById('setup-content').innerHTML =
          '<span class="status status-connected"><span class="status-dot on"></span> Browser connected</span>';
        document.getElementById('chat-card').style.display = '';
      }
    }).catch(() => {});
  </script>
</body>
</html>`;

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MediAssist demo running at http://localhost:${PORT}`);
  console.log(`Using Hanzi Browse API at ${BASE_URL}`);
});
