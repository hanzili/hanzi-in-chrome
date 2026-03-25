import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from './api';

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

  const loadProfile = useCallback(async () => { const r = await api('GET', '/v1/me'); if (r?.data) setProfile(r.data); }, []);
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

  const firstName = profile?.user?.name?.split(' ')[0] || 'there';
  const workspaceName = profile?.workspace?.name || 'Your workspace';
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
      </div>

      {tab === 'start' && (
        <GettingStartedTab
          keys={keys} loadKeys={loadKeys} setError={setError}
          extensionReady={extensionReady} pairing={pairing} paired={paired}
          setPairing={setPairing} setPaired={setPaired}
          hasKeys={hasKeys} hasConnected={hasConnected}
          connectedSession={connectedSession} sessions={sessions}
          loadSessions={loadSessions} loadUsage={loadUsage}
        />
      )}

      {tab === 'sessions' && (
        <SessionsTab sessions={sessions} onRefresh={loadSessions} usage={usage} />
      )}

      {tab === 'settings' && (
        <SettingsTab keys={keys} loadKeys={loadKeys} setError={setError} profile={profile} credits={credits} loadCredits={loadCredits} />
      )}

      {error && <div class="error-toast" onClick={() => setError(null)}>{error}</div>}
    </div>
  );
}

// ─── Getting Started Tab ─────────────────────────────

function GettingStartedTab({ keys, loadKeys, setError, extensionReady, pairing, paired, setPairing, setPaired, hasKeys, hasConnected, connectedSession, sessions, loadSessions, loadUsage }) {
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState(null);
  const [taskInput, setTaskInput] = useState('Go to example.com and tell me the page title');
  const [taskStatus, setTaskStatus] = useState(null);
  const [taskAnswer, setTaskAnswer] = useState('');
  const [taskSteps, setTaskSteps] = useState(0);

  // Determine which phase we're in
  const testComplete = taskStatus === 'complete';

  const createKey = async () => {
    if (!newKeyName.trim()) return;
    const r = await api('POST', '/v1/api-keys', { name: newKeyName.trim() });
    if (r?.status === 201) { setCreatedKey(r.data.key); setNewKeyName(''); await loadKeys(); }
    else setError(r?.data?.error || 'Failed');
  };

  const pairBrowser = async () => {
    setPairing(true);
    const r = await api('POST', '/v1/browser-sessions/pair', { label: 'Developer testing' });
    if (!r || r.status !== 201) { setPairing(false); setError(r?.data?.error || 'Failed'); return; }
    window.postMessage({ type: 'HANZI_PAIR', token: r.data.pairing_token, apiUrl: location.origin }, '*');
    setTimeout(() => setPairing(p => { if (p) { setError('Extension did not respond.'); return false; } return p; }), 5000);
  };

  const runTask = async () => {
    const sid = connectedSession?.id || sessions.find(s => s.status === 'connected')?.id;
    if (!taskInput.trim() || !sid) return;
    setTaskStatus('running'); setTaskAnswer(''); setTaskSteps(0);
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

  return (
    <div>
      {/* Phase 1: Test it yourself */}
      <div class="section-label">Test it yourself</div>
      <p class="section-desc">Try the full flow with your own browser.</p>

      {/* Step 1: API Key */}
      <div class="card">
        <div class="step-row">
          <span class={`step-badge ${hasKeys ? 'done' : 'active'}`}>{hasKeys ? '✓' : '1'}</span>
          <div class="step-content">
            <h3>API Key</h3>
            <p class="step-explain">Authenticates your backend when calling the Hanzi API.</p>
            {keys.map(k => (
              <div class="key-row" key={k.id}>
                <span><strong>{k.name}</strong> <code class="key-prefix">{k.key_prefix}</code></span>
              </div>
            ))}
            {createdKey && (
              <div class="key-created">
                <div class="mono-with-copy"><div class="mono">{createdKey}</div><CopyButton text={createdKey} label="Copy key" /></div>
                <div class="warning">Save this key — it won't be shown again.</div>
              </div>
            )}
            {!hasKeys && (
              <div class="inline-form">
                <input value={newKeyName} onInput={e => setNewKeyName(e.target.value)} placeholder="Key name (e.g. dev)" maxLength={100} onKeyDown={e => e.key === 'Enter' && createKey()} />
                <button class="btn-primary" onClick={createKey} disabled={!newKeyName.trim()}>Create key</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Step 2: Connect browser */}
      {hasKeys && (
        <div class="card">
          <div class="step-row">
            <span class={`step-badge ${hasConnected ? 'done' : 'active'}`}>{hasConnected ? '✓' : '2'}</span>
            <div class="step-content">
              <h3>{hasConnected ? 'Browser connected' : 'Connect your browser'}</h3>
              <p class="step-explain">{hasConnected ? 'Your Chrome is paired for testing.' : 'Pair your own Chrome to test tasks in it.'}</p>
              {!hasConnected && extensionReady && (
                <button class="btn-primary" onClick={pairBrowser} disabled={pairing}>{pairing ? 'Connecting...' : 'Connect this browser'}</button>
              )}
              {!hasConnected && !extensionReady && (
                <p class="step-explain"><a href="https://chromewebstore.google.com/detail/hanzi-in-chrome/iklpkemlmbhemkiojndpbhoakgikpmcd" target="_blank">Install the Hanzi extension</a>, then reload this page.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Step 3: Run task */}
      {hasKeys && hasConnected && (
        <div class="card">
          <div class="step-row">
            <span class={`step-badge ${testComplete ? 'done' : 'active'}`}>{testComplete ? '✓' : '3'}</span>
            <div class="step-content">
              <h3>Run a test task</h3>
              <p class="step-explain">Tell Hanzi what to do in your connected browser.</p>
              {!taskStatus ? (
                <div class="inline-form">
                  <input value={taskInput} onInput={e => setTaskInput(e.target.value)} placeholder="What should Hanzi do?" onKeyDown={e => e.key === 'Enter' && runTask()} />
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

      {/* Phase 2: Ship to users — only show after first test task */}
      {testComplete && <ShipToUsers />}
    </div>
  );
}

// ─── Ship to Users ───────────────────────────────────

function ShipToUsers() {
  const [link, setLink] = useState(null);
  const [generating, setGenerating] = useState(false);

  const generateLink = async () => {
    setGenerating(true);
    const r = await api('POST', '/v1/browser-sessions/pair', { label: 'User pairing link' });
    setGenerating(false);
    if (r?.status === 201) setLink(`${location.origin}/pair/${r.data.pairing_token}`);
  };

  return (
    <>
      <div class="section-label" style={{ marginTop: 28 }}>Ship it to your users</div>
      <p class="section-desc">Your user clicks a link. Their browser pairs automatically.</p>

      <div class="card">
        <h3>Generate a pairing link</h3>
        <p class="step-explain">Each user gets their own link. They click it → extension auto-pairs → done.</p>
        {!link ? (
          <button class="btn-primary" onClick={generateLink} disabled={generating} style={{ marginTop: 8 }}>
            {generating ? 'Generating...' : 'Try it — generate a link'}
          </button>
        ) : (
          <div style={{ marginTop: 8 }}>
            <div class="mono-with-copy"><div class="mono" style={{ fontSize: 12 }}>{link}</div><CopyButton text={link} label="Copy link" /></div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <a href={link} target="_blank" rel="noreferrer" class="btn-primary" style={{ display: 'inline-block', textDecoration: 'none', color: 'white', padding: '6px 14px', borderRadius: 8, fontSize: 13 }}>Open it</a>
              <button class="btn-secondary" onClick={() => setLink(null)} style={{ fontSize: 12 }}>New link</button>
            </div>
            <p class="step-explain" style={{ marginTop: 8 }}>Expires in 5 minutes. In production, your backend generates one per user via <code>POST /v1/browser-sessions/pair</code>.</p>
          </div>
        )}
      </div>

      {/* What the user sees */}
      <div class="card" style={{ background: '#f5f1e8' }}>
        <h3>What your user sees</h3>
        <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 20, background: 'white', textAlign: 'center', margin: '8px 0' }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Connect your browser</div>
          <div style={{ padding: '10px 16px', background: '#e8f0ec', color: '#2f4a3d', borderRadius: 8, display: 'inline-block', fontWeight: 500, fontSize: 14 }}>✓ Browser connected!</div>
          <div style={{ fontSize: 13, color: '#6d6256', marginTop: 8 }}>You can close this tab.</div>
        </div>
        <p class="step-explain">If the extension isn't installed, they see an "Install" button linking to the Chrome Web Store.</p>
      </div>
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

      <div class="card">
        <h3>Workspace</h3>
        <p class="step-explain">{profile?.workspace?.name || 'Your workspace'}</p>
      </div>

      <div class="card">
        <h3>Resources</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <a href="/docs.html#build-with-hanzi">API Documentation</a>
          <a href="https://github.com/hanzili/llm-in-chrome/tree/main/examples/partner-quickstart" target="_blank">Sample App (GitHub)</a>
          <a href="https://github.com/hanzili/llm-in-chrome/tree/main/sdk" target="_blank">SDK Source</a>
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
    } else {
      setError(r?.data?.error || 'Billing not available yet');
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
  await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' });
  window.location.href = 'https://browse.hanzilla.co';
}
