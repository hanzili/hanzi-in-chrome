import { useState, useEffect, useCallback } from 'preact/hooks';
import posthog from 'posthog-js';
import { api, redirectToSignIn } from './api';

// ─── Utility ─────────────────────────────────────────

function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return <button class="btn-copy" onClick={copy}>{copied ? '✓ Copied!' : label}</button>;
}

function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ─── App ─────────────────────────────────────────────

export function App() {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState(null);
  const [keys, setKeys] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [usage, setUsage] = useState(null);
  const [credits, setCredits] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('start');

  // Extension detection
  const [extensionReady, setExtensionReady] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [paired, setPaired] = useState(false);

  const [needsAuth, setNeedsAuth] = useState(false);
  const loadProfile = useCallback(async () => {
    const r = await api('GET', '/v1/me');
    if (r?.unauthorized) { setNeedsAuth(true); return; }
    if (r?.data) {
      setProfile(r.data);
      if (r.data.user?.email) {
        posthog.identify(r.data.user.id || r.data.user.email, {
          email: r.data.user.email,
          name: r.data.user.name,
        });
        posthog.capture('dashboard_sign_in');
      }
    }
  }, []);
  const loadKeys = useCallback(async () => { const r = await api('GET', '/v1/api-keys'); if (r) setKeys(r.data?.api_keys || []); }, []);
  const loadSessions = useCallback(async () => { const r = await api('GET', '/v1/browser-sessions'); if (r) setSessions(r.data?.sessions || []); }, []);
  const loadUsage = useCallback(async () => { const r = await api('GET', '/v1/usage'); if (r) setUsage(r.data); }, []);
  const loadCredits = useCallback(async () => { const r = await api('GET', '/v1/billing/credits'); if (r) setCredits(r.data); }, []);

  useEffect(() => {
    Promise.all([loadProfile(), loadKeys(), loadSessions(), loadUsage(), loadCredits()]).then(() => setLoading(false));
    const interval = setInterval(loadSessions, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if (e.data?.type === 'HANZI_EXTENSION_READY') setExtensionReady(true);
      if (e.data?.type === 'HANZI_PAIR_RESULT') {
        setPairing(false);
        if (e.data.success) { setPaired(true); loadSessions(); }
        else setError('Pairing failed: ' + (e.data.error || 'unknown'));
      }
    };
    window.addEventListener('message', handler);
    window.postMessage({ type: 'HANZI_PING' }, '*');
    return () => window.removeEventListener('message', handler);
  }, []);

  if (loading) return <LoadingSkeleton />;

  if (needsAuth) {
    redirectToSignIn();
    return <LoadingSkeleton />;
  }

  const firstName = profile?.user?.name?.split(' ')[0] || 'there';
  const workspaceName = profile?.user?.name ? `${profile.user.name}'s workspace` : 'Your workspace';
  const hasKeys = keys.length > 0;
  const connectedSession = sessions.find(s => s.status === 'connected');
  const hasConnected = !!connectedSession || paired;

  return (
    <div class="page">
      <div class="header">
        <div>
          <h1>{workspaceName}</h1>
          <div class="subtitle">Hi, {firstName}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {credits && (
            <div style={{ textAlign: 'right', fontSize: 13, color: 'var(--muted)' }}>
              <div><strong style={{ color: 'var(--ink)', fontSize: 16 }}>{(credits.free_remaining || 0) + (credits.credit_balance || 0)}</strong> tasks left</div>
              <div>{credits.free_remaining || 0} free + {credits.credit_balance || 0} credits</div>
            </div>
          )}
          <button class="signout" onClick={signOut}>Sign out</button>
        </div>
      </div>

      <div class="tabs">
        <button class={`tab ${tab === 'start' ? 'active' : ''}`} onClick={() => setTab('start')}>Getting Started</button>
        <button class={`tab ${tab === 'sessions' ? 'active' : ''}`} onClick={() => setTab('sessions')}>Sessions{sessions.length > 0 && <span class="tab-count">{sessions.filter(s => s.status === 'connected').length}</span>}</button>
        <button class={`tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>Settings</button>
        {/* Automations tab hidden until ready — infrastructure is built but UI needs work */}
      </div>

      {tab === 'start' && (
        <GettingStartedTab
          keys={keys} loadKeys={loadKeys} setError={setError}
          extensionReady={extensionReady} pairing={pairing} paired={paired}
          setPairing={setPairing} setPaired={setPaired}
          hasKeys={hasKeys} hasConnected={hasConnected}
          connectedSession={connectedSession} sessions={sessions}
          loadSessions={loadSessions} loadUsage={loadUsage}
          setTab={setTab}
        />
      )}

      {tab === 'sessions' && (
        <SessionsTab sessions={sessions} onRefresh={loadSessions} usage={usage} />
      )}

      {tab === 'settings' && (
        <SettingsTab keys={keys} loadKeys={loadKeys} setError={setError} profile={profile} credits={credits} loadCredits={loadCredits} />
      )}

      {/* Automations is feature-flagged off — infrastructure exists but UI isn't production-ready. */}
      {/* To re-enable during local testing: set localStorage.hanziEnableAutomations = '1' and refresh. */}
      {tab === 'automations' && typeof localStorage !== 'undefined' && localStorage.getItem('hanziEnableAutomations') === '1' && (
        <AutomationsTab sessions={sessions} workspaceId={profile?.workspace?.id} setError={setError} />
      )}

      {error && <div class="error-toast" onClick={() => setError(null)}>{error}</div>}
    </div>
  );
}

// ─── Getting Started Tab ─────────────────────────────

function GettingStartedTab({ keys, loadKeys, setError, extensionReady, pairing, paired, setPairing, setPaired, hasKeys, hasConnected, connectedSession, sessions, loadSessions, loadUsage, setTab }) {
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState(null);
  const [taskInput, setTaskInput] = useState('Go to example.com and tell me the page title');
  const [taskStatus, setTaskStatus] = useState(null);
  const [taskAnswer, setTaskAnswer] = useState('');
  const [taskSteps, setTaskSteps] = useState(0);

  const testComplete = taskStatus === 'complete';

  const createKey = async () => {
    if (!newKeyName.trim()) return;
    const r = await api('POST', '/v1/api-keys', { name: newKeyName.trim() });
    if (r?.status === 201) { setCreatedKey(r.data.key); setNewKeyName(''); await loadKeys(); }
    else setError(r?.data?.error || 'Failed');
  };

  const pairBrowser = async () => {
    setPairing(true);
    posthog.capture('connect_browser_clicked');
    const r = await api('POST', '/v1/browser-sessions/pair', { label: 'Developer testing' });
    if (!r || r.status !== 201) { setPairing(false); setError(r?.data?.error || 'Failed'); return; }
    window.postMessage({ type: 'HANZI_PAIR', token: r.data.pairing_token, apiUrl: location.origin }, '*');
    setTimeout(() => setPairing(p => { if (p) { setError('Extension did not respond.'); return false; } return p; }), 5000);
  };

  const runTask = async () => {
    const sid = connectedSession?.id || sessions.find(s => s.status === 'connected')?.id;
    if (!taskInput.trim()) return;
    if (!sid) { setTaskStatus('error'); setTaskAnswer('No connected browser session found. Try refreshing the page.'); return; }
    setTaskStatus('running'); setTaskAnswer(''); setTaskSteps(0);
    posthog.capture('test_task_run');
    const r = await api('POST', '/v1/tasks', { task: taskInput.trim(), browser_session_id: sid });
    if (!r || r.status !== 201) { setTaskStatus('error'); setTaskAnswer(r?.data?.error || 'Failed'); return; }
    const taskId = r.data.id;
    const deadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const s = await api('GET', `/v1/tasks/${taskId}`);
      if (!s) break;
      setTaskSteps(s.data?.steps || 0);
      if (s.data?.status !== 'running') {
        setTaskStatus(s.data?.status || 'error');
        setTaskAnswer(s.data?.answer || 'No answer.');
        loadUsage();
        return;
      }
    }
    setTaskStatus('error'); setTaskAnswer('Timed out after 3 minutes.');
  };

  const INTEGRATION_PROMPT = `Add browser automation to this project using the Hanzi Browse API. Read the codebase first, then ask me:

1. What browser task should Hanzi Browse automate? (e.g. "read patient chart", "fill out a form", "extract data from a web portal")
2. Where in the UI should the browser pairing flow go? (e.g. settings page, onboarding, a dedicated page)
3. Where should task results appear? (e.g. inline in the app, a chat interface, a dashboard)

Then build the integration using this API reference:

## Hanzi Browse API (base URL: https://api.hanzilla.co)

Auth: \`Authorization: Bearer ${createdKey || keys[0]?.key_prefix || 'hic_live_...'}\` header on all requests.

### Core flow
1. Create pairing token → show user a link → they connect their browser
2. Run tasks against their connected browser → poll for results
3. Show the answer in your app

### Endpoints

POST /v1/browser-sessions/pair
  Body: {"label": "User Name", "external_user_id": "your_user_id"}
  Returns: {"pairing_token": "hic_pair_...", "expires_in_seconds": 300}
  → Build link: https://api.hanzilla.co/pair/{pairing_token}

GET /v1/browser-sessions
  Returns: {"sessions": [{"id": "...", "status": "connected", "label": "..."}]}

POST /v1/tasks
  Body: {"task": "description", "browser_session_id": "...", "url": "optional", "context": "optional"}
  Returns: {"id": "task_id", "status": "running"}
  → Poll GET /v1/tasks/:id every 2s until status != "running". Typical: 10-60s.

GET /v1/tasks/:id
  Returns: {"status": "running|complete|error", "answer": "...", "steps": 4}

POST /v1/tasks/:id/cancel

GET /v1/tasks/:id/steps
  Returns: {"steps": [{"step": 1, "status": "tool_use", "toolName": "navigate", ...}]}

### Key details
- 20 free tasks/month, then $0.05/completed task. Errors are free.
- User needs the Hanzi Browse Chrome extension: https://chromewebstore.google.com/detail/iklpkemlmbhemkiojndpbhoakgikpmcd
- Sample app: https://github.com/hanzili/hanzi-browse/tree/main/examples/partner-quickstart

Read the codebase to understand the stack and project structure, then ask me the 3 questions above. After I answer, build the full integration.`;

  return (
    <div>
      {/* Step 1: API Key (always visible) */}
      {!hasKeys && (
        <div class="card">
          <h3>Create your API key</h3>
          <p class="step-explain">You need this to call the Hanzi Browse API from your backend.</p>
          <div class="inline-form">
            <input value={newKeyName} onInput={e => setNewKeyName(e.target.value)} placeholder="Key name (e.g. dev)" maxLength={100} onKeyDown={e => e.key === 'Enter' && createKey()} />
            <button class="btn-primary" onClick={createKey} disabled={!newKeyName.trim()}>Create key</button>
          </div>
        </div>
      )}
      {createdKey && (
        <div class="card">
          <h3>Your API key</h3>
          <div class="key-created">
            <div class="mono-with-copy"><div class="mono">{createdKey}</div><CopyButton text={createdKey} label="Copy key" /></div>
            <div class="warning">Save this key — it won't be shown again.</div>
          </div>
          <p class="step-explain" style={{ marginTop: 12 }}>Verify it works:</p>
          <div class="mono-with-copy" style={{ marginTop: 4 }}>
            <div class="mono" style={{ fontSize: 11 }}>{`curl ${location.origin}/v1/billing/credits -H "Authorization: Bearer ${createdKey}"`}</div>
            <CopyButton text={`curl ${location.origin}/v1/billing/credits -H "Authorization: Bearer ${createdKey}"`} label="Copy" />
          </div>
        </div>
      )}

      {/* Build the integration */}
      {hasKeys && (
        <div class="card" style={{ background: '#f5f1e8' }}>
          <h3>Build the integration</h3>
          <p class="step-explain">Copy this prompt into Claude Code, Cursor, or any AI coding agent. It has the full API reference and will ask you 3 questions before building.</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button class="btn-primary" onClick={() => { navigator.clipboard.writeText(INTEGRATION_PROMPT); }}
              style={{ fontSize: 13 }}
              ref={el => { if (el) el.onclick = () => { navigator.clipboard.writeText(INTEGRATION_PROMPT); posthog.capture('integration_prompt_copied'); el.textContent = 'Copied!'; setTimeout(() => el.textContent = 'Copy integration prompt', 1500); }; }}>
              Copy integration prompt
            </button>
            <a href="/docs.html#build-with-hanzi" class="btn-secondary" style={{ textDecoration: 'none', padding: '6px 14px', borderRadius: 8, fontSize: 13 }}>Read the docs</a>
          </div>
        </div>
      )}

      {/* Pair a browser */}
      {hasKeys && (
        <PairAndTest
          sessions={sessions} loadSessions={loadSessions}
          extensionReady={extensionReady} pairing={pairing} paired={paired}
          pairBrowser={pairBrowser} hasConnected={hasConnected}
          connectedSession={connectedSession}
          taskInput={taskInput} setTaskInput={setTaskInput}
          taskStatus={taskStatus} taskSteps={taskSteps} taskAnswer={taskAnswer}
          testComplete={testComplete} runTask={runTask}
          setTaskStatus={setTaskStatus} setTaskAnswer={setTaskAnswer}
          setTab={setTab}
        />
      )}
    </div>
  );
}

// ─── Pair & Test ────────────────────────────────────

function PairAndTest({ sessions, loadSessions, extensionReady, pairing, paired, pairBrowser, hasConnected, connectedSession, taskInput, setTaskInput, taskStatus, taskSteps, taskAnswer, testComplete, runTask, setTaskStatus, setTaskAnswer, setTab }) {
  const [link, setLink] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [linkGeneratedAt, setLinkGeneratedAt] = useState(null);
  const [sessionCountAtGen, setSessionCountAtGen] = useState(null);
  const [linkPaired, setLinkPaired] = useState(false);
  const [countdown, setCountdown] = useState(null);

  const generateLink = async () => {
    setGenerating(true);
    setLinkPaired(false);
    const r = await api('POST', '/v1/browser-sessions/pair', { label: 'User pairing link' });
    setGenerating(false);
    if (r?.status === 201) {
      setLink(`${location.origin}/pair/${r.data.pairing_token}`);
      setLinkGeneratedAt(Date.now());
      setSessionCountAtGen(sessions.length);
      setCountdown(300);
      posthog.capture('pairing_link_generated');
    }
  };

  // Countdown timer
  useEffect(() => {
    if (countdown === null || countdown <= 0) return;
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  // Detect new session appearing after link was generated
  useEffect(() => {
    if (linkGeneratedAt && sessionCountAtGen !== null && sessions.length > sessionCountAtGen && !linkPaired) {
      setLinkPaired(true);
    }
  }, [sessions, linkGeneratedAt, sessionCountAtGen, linkPaired]);

  const expired = countdown !== null && countdown <= 0 && !linkPaired;
  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  return (
    <>
      <div class="section-label" style={{ marginTop: 28 }}>Try it out</div>
      <p class="section-desc">Pair a browser, then run a task to see it work.</p>

      {/* Step 1: Pair a browser */}
      <div class="card">
        <div class="step-row">
          <span class={`step-badge ${hasConnected || linkPaired ? 'done' : 'active'}`}>{hasConnected || linkPaired ? '✓' : '1'}</span>
          <div class="step-content">
            <h3>{hasConnected || linkPaired ? 'Browser paired' : 'Pair a browser'}</h3>

            {hasConnected || linkPaired ? (
              <p class="step-explain">
                {linkPaired ? 'A user paired via your link.' : 'Your Chrome is connected for testing.'}
                {' '}<button class="btn-secondary" onClick={() => setTab('sessions')} style={{ fontSize: 11, padding: '2px 8px' }}>View sessions</button>
              </p>
            ) : !link ? (
              <div>
                <p class="step-explain">Generate a pairing link to share, or connect this browser directly.</p>
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button class="btn-primary" onClick={generateLink} disabled={generating}>
                    {generating ? 'Generating...' : 'Generate a link'}
                  </button>
                  {extensionReady && (
                    <button class="btn-secondary" onClick={pairBrowser} disabled={pairing}>
                      {pairing ? 'Connecting...' : 'Connect this browser'}
                    </button>
                  )}
                </div>
                {!extensionReady && (
                  <p class="step-explain" style={{ marginTop: 8 }}>To connect this browser directly, <a href="https://chromewebstore.google.com/detail/hanzi-browse/iklpkemlmbhemkiojndpbhoakgikpmcd" target="_blank">install the extension</a> first.</p>
                )}
                <p class="step-explain" style={{ marginTop: 8, fontSize: 12, color: '#999' }}>In production, your backend calls <code>POST /v1/browser-sessions/pair</code> to generate links programmatically.</p>
              </div>
            ) : (
              /* Link generated — show status tracker */
              <div>
                <div class="pairing-tracker">
                  <div class="pairing-step done">
                    <div class="pairing-dot done" />
                    <span>Generated</span>
                  </div>
                  <div class="pairing-line" />
                  <div class={`pairing-step ${linkPaired ? 'done' : 'waiting'}`}>
                    <div class={`pairing-dot ${linkPaired ? 'done' : 'waiting'}`} />
                    <span>{linkPaired ? 'Paired' : 'Waiting for click...'}</span>
                  </div>
                </div>

                <div class="mono-with-copy" style={{ marginTop: 12 }}>
                  <div class="mono" style={{ fontSize: 12 }}>{link}</div>
                  <CopyButton text={link} label="Copy link" />
                </div>

                <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                  <a href={link} target="_blank" rel="noreferrer" class="btn-primary" style={{ display: 'inline-block', textDecoration: 'none', color: 'white', padding: '6px 14px', borderRadius: 8, fontSize: 13 }}>Open it</a>
                  <button class="btn-secondary" onClick={() => { setLink(null); setLinkGeneratedAt(null); setSessionCountAtGen(null); setCountdown(null); setLinkPaired(false); }} style={{ fontSize: 12 }}>New link</button>
                  {!expired && countdown > 0 && (
                    <span style={{ fontSize: 12, color: countdown < 60 ? 'var(--red)' : 'var(--muted)' }}>Expires in {fmtTime(countdown)}</span>
                  )}
                  {expired && (
                    <span style={{ fontSize: 12, color: 'var(--red)', fontWeight: 600 }}>Expired</span>
                  )}
                </div>

                <p class="step-explain" style={{ marginTop: 8 }}>
                  User needs the <a href="https://chromewebstore.google.com/detail/hanzi-browse/iklpkemlmbhemkiojndpbhoakgikpmcd" target="_blank">Hanzi Browse extension</a> installed.
                  {extensionReady && !linkPaired && (
                    <>{' '}Or <button style={{ background: 'none', border: 'none', color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer', padding: 0, font: 'inherit', fontSize: 'inherit' }} onClick={pairBrowser} disabled={pairing}>{pairing ? 'connecting...' : 'connect this browser'}</button> instead.</>
                  )}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Step 2: Run a test task */}
      {(hasConnected || linkPaired) && (
        <div class="card">
          <div class="step-row">
            <span class={`step-badge ${testComplete ? 'done' : 'active'}`}>{testComplete ? '✓' : '2'}</span>
            <div class="step-content">
              <h3>Run a test task</h3>
              <p class="step-explain">Tell Hanzi Browse what to do in the paired browser.</p>
              {!taskStatus ? (
                <div class="inline-form">
                  <input value={taskInput} onInput={e => setTaskInput(e.target.value)} placeholder="What should Hanzi Browse do?" onKeyDown={e => e.key === 'Enter' && runTask()} />
                  <button class="btn-primary" onClick={runTask} disabled={!taskInput.trim()}>Run</button>
                </div>
              ) : taskStatus === 'running' ? (
                <div class="task-running"><div class="task-spinner" /><span>Running... ({taskSteps} step{taskSteps !== 1 ? 's' : ''})</span></div>
              ) : (
                <div class="task-result">
                  <div class={`task-status-label ${taskStatus}`}>{taskStatus === 'complete' ? '✓ Complete' : '✗ ' + taskStatus}{taskSteps > 0 && ` · ${taskSteps} steps`}</div>
                  <div class="task-answer">{taskAnswer}</div>
                  <button class="btn-secondary" onClick={() => { setTaskStatus(null); setTaskAnswer(''); }} style={{ marginTop: 8 }}>Run another</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Sessions Tab ────────────────────────────────────

function SessionsTab({ sessions, onRefresh, usage }) {
  const connected = sessions.filter(s => s.status === 'connected');
  const disconnected = sessions.filter(s => s.status === 'disconnected');

  const removeSession = async (id) => {
    await api('DELETE', `/v1/browser-sessions/${id}`);
    onRefresh();
  };
  const removeAllDisconnected = async () => {
    for (const s of disconnected) await api('DELETE', `/v1/browser-sessions/${s.id}`);
    onRefresh();
  };

  const fmt = n => n > 999999 ? (n / 1e6).toFixed(1) + 'M' : n > 999 ? (n / 1e3).toFixed(1) + 'K' : String(n || 0);

  return (
    <div>
      {/* Summary */}
      <div class="summary-bar">
        <span class="summary-stat"><strong>{connected.length}</strong> connected</span>
        <span class="summary-stat"><strong>{disconnected.length}</strong> disconnected</span>
        <span class="summary-stat"><strong>{usage?.taskCount || 0}</strong> tasks run</span>
      </div>

      {/* Connected */}
      {connected.length > 0 && (
        <div class="card">
          <h3 style={{ color: 'var(--green)' }}>Connected</h3>
          {connected.map(s => <SessionRow key={s.id} session={s} />)}
        </div>
      )}

      {/* Disconnected */}
      {disconnected.length > 0 && (
        <div class="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ color: 'var(--muted)' }}>Disconnected</h3>
            <button class="btn-secondary" onClick={removeAllDisconnected} style={{ fontSize: 11, padding: '3px 10px' }}>Remove all</button>
          </div>
          {disconnected.map(s => <SessionRow key={s.id} session={s} onRemove={() => removeSession(s.id)} />)}
          <p class="step-explain" style={{ marginTop: 6 }}>Sessions reconnect automatically when the browser reopens.</p>
        </div>
      )}

      {sessions.length === 0 && (
        <div class="card"><p class="step-explain">No sessions yet. Go to Getting Started to pair a browser.</p></div>
      )}

      {/* Recent task runs */}
      <RecentTasksCard />

      {/* Usage */}
      <div class="card">
        <h3>Usage</h3>
        <div class="usage-grid">
          <div class="usage-stat"><div class="num">{usage?.taskCount || 0}</div><div class="label">Tasks</div></div>
          <div class="usage-stat"><div class="num">{fmt(usage?.totalApiCalls)}</div><div class="label">API calls</div></div>
          <div class="usage-stat"><div class="num">{fmt((usage?.totalInputTokens || 0) + (usage?.totalOutputTokens || 0))}</div><div class="label">Tokens</div></div>
        </div>
      </div>

      <button class="btn-secondary" onClick={onRefresh} style={{ marginTop: 8, fontSize: 12 }}>Refresh</button>
    </div>
  );
}

function RecentTasksCard() {
  const [tasks, setTasks] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      const r = await api('GET', '/v1/tasks');
      if (r?.status === 200 && Array.isArray(r.data?.tasks)) {
        setTasks(r.data.tasks);
      } else if (r?.status === 200 && Array.isArray(r.data)) {
        setTasks(r.data);
      } else {
        setError(r?.data?.error || 'Could not load recent tasks');
        setTasks([]);
      }
    })();
  }, []);

  if (tasks === null) {
    return <div class="card"><h3>Recent tasks</h3><p class="step-explain">Loading…</p></div>;
  }
  if (tasks.length === 0) {
    return <div class="card"><h3>Recent tasks</h3><p class="step-explain">{error || 'No tasks run yet. Try one from Getting Started.'}</p></div>;
  }

  const badge = (status) => {
    const color = status === 'complete' ? 'var(--green)' : status === 'error' ? 'var(--red, #9a2e2e)' : status === 'cancelled' ? 'var(--muted)' : '#1d6fa5';
    return <span style={{ fontSize: 11, color, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: 'rgba(0,0,0,0.03)' }}>{status}</span>;
  };

  return (
    <div class="card">
      <h3>Recent tasks</h3>
      <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
        {tasks.slice(0, 20).map(t => {
          const id = t.id;
          const status = t.status;
          const task = t.task || t.prompt || '(no task text)';
          const created = t.created_at || t.createdAt;
          const duration = t.completed_at && created ? Math.round((t.completed_at - created) / 1000) + 's' : null;
          const expanded = expandedId === id;
          return (
            <div key={id} style={{ borderBottom: '1px solid var(--line, #e5ddd0)', padding: '8px 0', cursor: 'pointer' }} onClick={() => setExpandedId(expanded ? null : id)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task}</span>
                {badge(status)}
                {duration && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{duration}</span>}
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>{timeAgo(created)}</span>
              </div>
              {expanded && (
                <div style={{ marginTop: 8, padding: 10, background: 'rgba(0,0,0,0.02)', borderRadius: 6, fontSize: 12 }}>
                  {t.answer ? <div><strong>Answer:</strong> {t.answer}</div> : <div class="step-explain">No answer recorded.</div>}
                  {t.error && <div style={{ marginTop: 6, color: 'var(--red, #9a2e2e)' }}><strong>Error:</strong> {t.error}</div>}
                  <div style={{ marginTop: 6, color: 'var(--muted)', fontSize: 11 }}>
                    Task ID: <code>{id}</code> · Session: <code>{(t.browser_session_id || t.browserSessionId || '').slice(0, 8)}…</code>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SessionRow({ session: s, onRemove }) {
  const label = s.label || s.external_user_id || 'Unnamed';
  return (
    <div class="session-row">
      <span class="session-info">
        <span class={`status-dot ${s.status}`} />
        <span class="session-label">{label}</span>
        {s.external_user_id && s.label && <span class="session-meta">{s.external_user_id}</span>}
      </span>
      <span class="session-id-group">
        <span class="session-time">{timeAgo(s.last_heartbeat)}</span>
        <code>{s.id.slice(0, 8)}...</code>
        {onRemove && <button class="btn-danger" onClick={onRemove} style={{ padding: '2px 8px', fontSize: 11 }}>Remove</button>}
      </span>
    </div>
  );
}

// ─── Settings Tab ────────────────────────────────────

function SettingsTab({ keys, loadKeys, setError, profile, credits, loadCredits }) {
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState(null);

  const createKey = async () => {
    if (!newKeyName.trim()) return;
    const r = await api('POST', '/v1/api-keys', { name: newKeyName.trim() });
    if (r?.status === 201) { setCreatedKey(r.data.key); setNewKeyName(''); await loadKeys(); }
    else setError(r?.data?.error || 'Failed');
  };
  const deleteKey = async (id) => {
    if (!confirm('Delete this API key?')) return;
    await api('DELETE', `/v1/api-keys/${id}`);
    setCreatedKey(null);
    await loadKeys();
  };

  return (
    <div>
      <div class="card">
        <h3>API Keys</h3>
        {keys.map(k => (
          <div class="key-row" key={k.id}>
            <span><strong>{k.name}</strong> <code class="key-prefix">{k.key_prefix}</code>{k.last_used_at && <span class="session-meta"> · used {timeAgo(k.last_used_at)}</span>}</span>
            <button class="btn-danger" onClick={() => deleteKey(k.id)}>Delete</button>
          </div>
        ))}
        {createdKey && (
          <div class="key-created">
            <div class="mono-with-copy"><div class="mono">{createdKey}</div><CopyButton text={createdKey} label="Copy key" /></div>
            <div class="warning">Save this key — it won't be shown again.</div>
          </div>
        )}
        <div class="inline-form" style={{ marginTop: 8 }}>
          <input value={newKeyName} onInput={e => setNewKeyName(e.target.value)} placeholder="Key name" maxLength={100} onKeyDown={e => e.key === 'Enter' && createKey()} />
          <button class="btn-primary" onClick={createKey} disabled={!newKeyName.trim()}>Create key</button>
        </div>
      </div>

      <div class="card">
        <h3>Credits & Usage</h3>
        {credits ? (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, margin: '8px 0 12px' }}>
              <div style={{ padding: 12, background: '#f5f1e8', borderRadius: 8, textAlign: 'center' }}>
                <div style={{ fontSize: 28, fontWeight: 700 }}>{credits.free_remaining || 0}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>free tasks left</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>of {credits.free_tasks_per_month}/month</div>
              </div>
              <div style={{ padding: 12, background: '#f5f1e8', borderRadius: 8, textAlign: 'center' }}>
                <div style={{ fontSize: 28, fontWeight: 700 }}>{credits.credit_balance || 0}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>purchased credits</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>$0.05/task</div>
              </div>
            </div>
            <p class="step-explain">You only pay for completed tasks. Errors and timeouts are free.</p>
            <BuyCreditsButtons loadCredits={loadCredits} setError={setError} />
          </div>
        ) : (
          <p class="step-explain">Loading...</p>
        )}
      </div>

      <div class="card" style={{ background: '#f5f1e8' }}>
        <h3>Building a product with Hanzi Browse?</h3>
        <p class="step-explain">Need volume pricing, custom SLAs, or dedicated support? We offer wholesale rates starting at $0.02/task for partners.</p>
        <a href="mailto:hanzili0217@gmail.com?subject=Partner%20pricing&body=Hi%20Hanzi%20team%2C%0A%0AI%27m%20building%20a%20product%20that%20uses%20browser%20automation.%0A%0AExpected%20volume%3A%20%0AUse%20case%3A%20%0A" class="btn-primary" style={{ display: 'inline-block', textDecoration: 'none', color: 'white', padding: '8px 16px', borderRadius: 8, fontSize: 13, marginTop: 8 }}>Contact us for partner pricing</a>
      </div>

      <div class="card">
        <h3>Resources</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <a href="/docs.html#build-with-hanzi">API Documentation</a>
          <a href="https://github.com/hanzili/hanzi-browse/tree/main/examples/partner-quickstart" target="_blank">Sample App (GitHub)</a>
          <a href="https://github.com/hanzili/hanzi-browse/tree/main/sdk" target="_blank">SDK Source</a>
          <a href="https://discord.gg/hahgu5hcA5" target="_blank">Discord Community</a>
        </div>
      </div>
    </div>
  );
}

// ─── Buy Credits ─────────────────────────────────────

function BuyCreditsButtons({ loadCredits, setError }) {
  const [buying, setBuying] = useState(false);

  const buy = async (credits) => {
    setBuying(true);
    const r = await api('POST', '/v1/billing/checkout', {
      credits,
      success_url: location.origin + '/dashboard?checkout=success',
      cancel_url: location.origin + '/dashboard',
    });
    setBuying(false);
    if (r?.data?.url) {
      window.location.href = r.data.url;
    } else if (r?.data?.error === 'billing_unconfigured' || r?.status === 501) {
      setError('Paid credits aren’t enabled on this workspace yet. You can keep using the 20 free tasks/month — email hanzili0217@gmail.com to add credits.');
    } else {
      setError(r?.data?.error || 'Checkout failed — please try again or contact support.');
    }
  };

  // Check for checkout success redirect
  useEffect(() => {
    if (location.search.includes('checkout=success')) {
      loadCredits();
      history.replaceState(null, '', '/dashboard');
    }
  }, []);

  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
      <button class="btn-primary" onClick={() => buy(100)} disabled={buying} style={{ fontSize: 13 }}>
        100 credits — $5
      </button>
      <button class="btn-secondary" onClick={() => buy(500)} disabled={buying} style={{ fontSize: 13 }}>
        500 — $20
      </button>
      <button class="btn-secondary" onClick={() => buy(1500)} disabled={buying} style={{ fontSize: 13 }}>
        1500 — $50
      </button>
    </div>
  );
}

// ─── Automations ─────────────────────────────────────

function AutomationsTab({ sessions, workspaceId, setError }) {
  const [automations, setAutomations] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [engagements, setEngagements] = useState([]);
  const [view, setView] = useState('drafts'); // 'drafts' | 'setup' | 'history'
  const [creating, setCreating] = useState(false);
  const [posting, setPosting] = useState({});

  // Setup form
  const [productName, setProductName] = useState('');
  const [productUrl, setProductUrl] = useState('');
  const [productDesc, setProductDesc] = useState('');
  const [keywords, setKeywords] = useState('');
  const [schedule, setSchedule] = useState('0 9 * * 1,3,5');
  const [sessionId, setSessionId] = useState('');

  const loadAutomations = useCallback(async () => {
    const r = await api('GET', '/v1/automations');
    if (r?.data) setAutomations(Array.isArray(r.data) ? r.data : []);
  }, []);

  const loadDrafts = useCallback(async () => {
    const r = await api('GET', '/v1/automations/drafts?status=pending');
    if (r?.data) setDrafts(Array.isArray(r.data) ? r.data : []);
  }, []);

  const loadEngagements = useCallback(async () => {
    const r = await api('GET', '/v1/automations/engagements?limit=20');
    if (r?.data) setEngagements(Array.isArray(r.data) ? r.data : []);
  }, []);

  useEffect(() => {
    loadAutomations();
    loadDrafts();
    loadEngagements();
  }, []);

  const connectedSessions = sessions.filter(s => s.status === 'connected');

  async function createAutomation(e) {
    e.preventDefault();
    setCreating(true);
    try {
      const r = await api('POST', '/v1/automations', {
        browser_session_id: sessionId,
        config: {
          product_name: productName,
          product_url: productUrl,
          product_description: productDesc,
          keywords: keywords.split(',').map(k => k.trim()).filter(Boolean),
          schedule_cron: schedule,
          max_drafts: 8,
          reply_mix: { a: 40, b: 40, c: 20 },
        },
      });
      if (r?.data?.id) {
        await loadAutomations();
        setView('drafts');
      } else {
        setError(r?.data?.error || 'Failed to create automation');
      }
    } finally {
      setCreating(false);
    }
  }

  async function approveDraft(id) {
    await api('PATCH', `/v1/automations/drafts/${id}`, { status: 'approved' });
    await loadDrafts();
  }

  async function skipDraft(id) {
    await api('PATCH', `/v1/automations/drafts/${id}`, { status: 'skipped' });
    await loadDrafts();
  }

  async function postDraft(id) {
    setPosting(p => ({ ...p, [id]: true }));
    try {
      await api('POST', `/v1/automations/drafts/${id}/post`);
      // Poll for completion
      setTimeout(async () => {
        await loadDrafts();
        await loadEngagements();
        setPosting(p => ({ ...p, [id]: false }));
      }, 5000);
    } catch {
      setPosting(p => ({ ...p, [id]: false }));
    }
  }

  async function toggleAutomation(auto) {
    const newStatus = auto.status === 'active' ? 'paused' : 'active';
    await api('PATCH', `/v1/automations/${auto.id}`, { status: newStatus });
    await loadAutomations();
  }

  // No automations yet — show setup
  if (automations.length === 0 || view === 'setup') {
    return (
      <div class="card">
        <h2>Set up X Marketing Automation</h2>
        <p style={{ color: 'var(--muted)', marginBottom: 16, fontSize: 14 }}>
          Automatically find relevant X conversations and draft replies. You review and approve before anything gets posted.
        </p>
        <form onSubmit={createAutomation}>
          <div class="form-group">
            <label>Product name</label>
            <input value={productName} onInput={e => setProductName(e.target.value)} placeholder="Hanzi Browse" required />
          </div>
          <div class="form-group">
            <label>Product URL</label>
            <input value={productUrl} onInput={e => setProductUrl(e.target.value)} placeholder="https://browse.hanzilla.co" />
          </div>
          <div class="form-group">
            <label>Description</label>
            <input value={productDesc} onInput={e => setProductDesc(e.target.value)} placeholder="Browser automation for AI agents" />
          </div>
          <div class="form-group">
            <label>Keywords (comma-separated)</label>
            <input value={keywords} onInput={e => setKeywords(e.target.value)} placeholder="browser automation, MCP server, AI agent browser" required />
          </div>
          <div class="form-group">
            <label>Schedule</label>
            <select value={schedule} onChange={e => setSchedule(e.target.value)}>
              <option value="0 9 * * 1,3,5">3x per week (Mon, Wed, Fri 9am)</option>
              <option value="0 9 * * *">Daily (9am)</option>
              <option value="0 9,17 * * *">2x per day (9am, 5pm)</option>
            </select>
          </div>
          <div class="form-group">
            <label>Browser session</label>
            {connectedSessions.length === 0 ? (
              <p style={{ color: 'var(--accent)', fontSize: 13 }}>No browser connected. Pair one first in the Sessions tab.</p>
            ) : (
              <select value={sessionId} onChange={e => setSessionId(e.target.value)} required>
                <option value="">Select a session...</option>
                {connectedSessions.map(s => (
                  <option key={s.id} value={s.id}>{s.label || s.id.slice(0, 8)} — connected</option>
                ))}
              </select>
            )}
          </div>
          <button class="btn-primary" type="submit" disabled={creating || connectedSessions.length === 0}>
            {creating ? 'Creating...' : 'Create Automation'}
          </button>
        </form>
      </div>
    );
  }

  // Main view with sub-tabs
  const auto = automations[0]; // MVP: one automation per workspace
  const pendingCount = drafts.length;

  return (
    <div>
      {/* Status card */}
      <div class="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <strong>{auto.config?.product_name || 'X Marketing'}</strong>
            <span style={{ marginLeft: 8, padding: '2px 8px', borderRadius: 4, fontSize: 12, background: auto.status === 'active' ? '#eef5f0' : auto.status === 'error' ? '#fef0ef' : '#f5f3ef', color: auto.status === 'active' ? '#2f4a3d' : auto.status === 'error' ? '#9a2e2e' : '#6d6256' }}>
              {auto.status}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button class="btn-secondary" onClick={() => toggleAutomation(auto)} style={{ fontSize: 12 }}>
              {auto.status === 'active' ? 'Pause' : 'Resume'}
            </button>
            <button class="btn-secondary" onClick={() => setView('setup')} style={{ fontSize: 12 }}>
              Edit
            </button>
          </div>
        </div>
        {auto.errorMessage && <p style={{ color: '#9a2e2e', fontSize: 13, marginTop: 8 }}>{auto.errorMessage}</p>}
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
          Last run: {auto.lastRunAt ? timeAgo(auto.lastRunAt) : 'never'} · Next: {auto.nextRunAt ? new Date(auto.nextRunAt).toLocaleString() : 'not scheduled'}
        </div>
      </div>

      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button class={`tab ${view === 'drafts' ? 'active' : ''}`} onClick={() => { setView('drafts'); loadDrafts(); }}>
          Drafts {pendingCount > 0 && <span class="tab-count">{pendingCount}</span>}
        </button>
        <button class={`tab ${view === 'history' ? 'active' : ''}`} onClick={() => { setView('history'); loadEngagements(); }}>
          History
        </button>
      </div>

      {/* Drafts */}
      {view === 'drafts' && (
        <div>
          {drafts.length === 0 ? (
            <div class="card" style={{ textAlign: 'center', color: 'var(--muted)' }}>
              <p>No pending drafts. The next scout will run {auto.nextRunAt ? new Date(auto.nextRunAt).toLocaleString() : 'when scheduled'}.</p>
            </div>
          ) : (
            drafts.map(d => (
              <div key={d.id} class="card" style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                  <div>
                    <strong style={{ fontSize: 14 }}>{d.tweetAuthorName || 'Unknown'}</strong>
                    <span style={{ color: 'var(--muted)', marginLeft: 6, fontSize: 13 }}>{d.tweetAuthorHandle}</span>
                    {d.tweetAuthorFollowers && <span style={{ color: 'var(--muted)', marginLeft: 6, fontSize: 12 }}>({d.tweetAuthorFollowers.toLocaleString()} followers)</span>}
                  </div>
                  <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: d.replyType === 'A' ? '#eef5f0' : d.replyType === 'C' ? '#fef5ee' : '#f0eef5', color: d.replyType === 'A' ? '#2f4a3d' : d.replyType === 'C' ? '#8a5a2e' : '#4a3d6b' }}>
                    Type {d.replyType || '?'}
                  </span>
                </div>
                {/* Original tweet */}
                <div style={{ background: '#f7f3ea', padding: '10px 12px', borderRadius: 8, fontSize: 13, marginBottom: 10, color: 'var(--ink)' }}>
                  {d.tweetText || 'Tweet not available'}
                </div>
                {/* Draft reply */}
                <div style={{ background: '#f0f7f2', padding: '10px 12px', borderRadius: 8, fontSize: 13, marginBottom: 10, color: '#1f1711', borderLeft: '3px solid #2f4a3d' }}>
                  {d.replyText}
                </div>
                {d.replyReasoning && <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>{d.replyReasoning}</div>}
                <div style={{ display: 'flex', gap: 8 }}>
                  {d.status === 'pending' && (
                    <>
                      <button class="btn-primary" onClick={() => approveDraft(d.id)} style={{ fontSize: 12 }}>Approve</button>
                      <button class="btn-secondary" onClick={() => skipDraft(d.id)} style={{ fontSize: 12 }}>Skip</button>
                    </>
                  )}
                  {d.status === 'approved' && (
                    <button class="btn-primary" onClick={() => postDraft(d.id)} disabled={posting[d.id]} style={{ fontSize: 12 }}>
                      {posting[d.id] ? 'Posting...' : 'Post'}
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* History */}
      {view === 'history' && (
        <div class="card">
          {engagements.length === 0 ? (
            <p style={{ color: 'var(--muted)', textAlign: 'center' }}>No engagements yet.</p>
          ) : (
            <table style={{ width: '100%', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
                  <th>Handle</th>
                  <th>Type</th>
                  <th>Reply</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {engagements.map(e => (
                  <tr key={e.id}>
                    <td><a href={e.tweetUrl} target="_blank" rel="noopener">{e.authorHandle}</a></td>
                    <td>{e.replyType || '-'}</td>
                    <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.replySummary || '-'}</td>
                    <td>{timeAgo(e.postedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Loading ─────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div class="page">
      <div class="skeleton skeleton-header" />
      <div class="skeleton skeleton-subtitle" />
      <div class="skeleton skeleton-card" />
      <div class="skeleton skeleton-card" />
    </div>
  );
}

async function signOut() {
  posthog.reset();
  await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' });
  window.location.href = 'https://browse.hanzilla.co';
}
