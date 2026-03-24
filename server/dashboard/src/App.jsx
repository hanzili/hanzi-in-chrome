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
  return (
    <button class="btn-copy" onClick={copy}>
      {copied ? '✓ Copied!' : label}
    </button>
  );
}

// ─── App ─────────────────────────────────────────────

export function App() {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState(null);
  const [keys, setKeys] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [usage, setUsage] = useState(null);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState(null);
  const [error, setError] = useState(null);

  // Extension detection
  const [extensionReady, setExtensionReady] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [paired, setPaired] = useState(false);

  const loadProfile = useCallback(async () => {
    const r = await api('GET', '/v1/me');
    if (r?.data) setProfile(r.data);
  }, []);
  const loadKeys = useCallback(async () => {
    const r = await api('GET', '/v1/api-keys');
    if (r) setKeys(r.data?.api_keys || []);
  }, []);
  const loadSessions = useCallback(async () => {
    const r = await api('GET', '/v1/browser-sessions');
    if (r) setSessions(r.data?.sessions || []);
  }, []);
  const loadUsage = useCallback(async () => {
    const r = await api('GET', '/v1/usage');
    if (r) setUsage(r.data);
  }, []);

  useEffect(() => {
    Promise.all([loadProfile(), loadKeys(), loadSessions(), loadUsage()]).then(() => setLoading(false));
    const interval = setInterval(loadSessions, 5000);
    return () => clearInterval(interval);
  }, []);

  // Extension detection via content script bridge
  useEffect(() => {
    const handler = (event) => {
      if (event.data?.type === 'HANZI_EXTENSION_READY') setExtensionReady(true);
      if (event.data?.type === 'HANZI_PAIR_RESULT') {
        setPairing(false);
        if (event.data.success) { setPaired(true); loadSessions(); }
        else setError('Pairing failed: ' + (event.data.error || 'unknown'));
      }
    };
    window.addEventListener('message', handler);
    window.postMessage({ type: 'HANZI_PING' }, '*');
    return () => window.removeEventListener('message', handler);
  }, []);

  const hasKeys = keys.length > 0;
  const connectedSession = sessions.find(s => s.status === 'connected');
  const hasConnected = !!connectedSession || paired;

  if (loading) return <LoadingSkeleton />;

  const firstName = profile?.user?.name?.split(' ')[0] || 'there';
  const workspaceName = profile?.workspace?.name || 'Your workspace';

  return (
    <div class="page">
      <div class="header">
        <div>
          <h1>Hi, {firstName}</h1>
          <div class="subtitle">{workspaceName}</div>
        </div>
        <button class="signout" onClick={signOut}>Sign out</button>
      </div>

      {/* Setup */}
      <div class="section-label">Get started</div>
      <p class="section-desc">Set up your API key and connect a browser to test with. <a href="https://browse.hanzilla.co/docs.html#build-with-hanzi">Read how it works →</a></p>

      <StepKey
        keys={keys}
        newKeyName={newKeyName}
        setNewKeyName={setNewKeyName}
        createdKey={createdKey}
        setCreatedKey={setCreatedKey}
        onRefresh={loadKeys}
        setError={setError}
      />

      {hasKeys && (
        <StepPair
          extensionReady={extensionReady}
          pairing={pairing}
          paired={paired}
          setPairing={setPairing}
          setPaired={setPaired}
          setError={setError}
          onPairSuccess={loadSessions}
        />
      )}

      {hasKeys && hasConnected && (
        <StepTask
          apiKey={createdKey || keys[0]?.key_prefix}
          sessionId={connectedSession?.id}
          onTaskComplete={loadUsage}
        />
      )}

      {/* Workspace (monitoring) */}
      {sessions.length > 0 && (
        <>
          <div class="section-label" style={{ marginTop: 32 }}>Your workspace</div>
          <SessionsCard sessions={sessions} onRefresh={loadSessions} />
          <UsageCard usage={usage} />
        </>
      )}

      {error && <div class="error-toast">{error}</div>}
    </div>
  );
}

// ─── Step: API Key ───────────────────────────────────

function StepKey({ keys, newKeyName, setNewKeyName, createdKey, setCreatedKey, onRefresh, setError }) {
  const createKey = async () => {
    if (!newKeyName.trim()) return;
    setError(null);
    const r = await api('POST', '/v1/api-keys', { name: newKeyName.trim() });
    if (!r) return;
    if (r.status === 201) { setCreatedKey(r.data.key); setNewKeyName(''); await onRefresh(); }
    else setError(r.data?.error || 'Failed to create key');
  };
  const deleteKey = async (id) => {
    if (!confirm('Delete this API key?')) return;
    await api('DELETE', `/v1/api-keys/${id}`);
    setCreatedKey(null);
    await onRefresh();
  };

  return (
    <div class="card">
      <div class="step-header-row">
        <span class={`step-badge ${keys.length > 0 ? 'done' : 'active'}`}>{keys.length > 0 ? '✓' : '1'}</span>
        <div>
          <h3>API Key</h3>
          <p class="step-explain">This authenticates your backend when calling the Hanzi API.</p>
        </div>
      </div>

      {keys.map(k => (
        <div class="key-row" key={k.id}>
          <span><strong>{k.name}</strong> <code class="key-prefix">{k.key_prefix}</code></span>
          <button class="btn-danger" onClick={() => deleteKey(k.id)}>Delete</button>
        </div>
      ))}

      {createdKey && (
        <div class="key-created">
          <div class="mono-with-copy">
            <div class="mono">{createdKey}</div>
            <CopyButton text={createdKey} label="Copy key" />
          </div>
          <div class="warning">Save this key — it won't be shown again.</div>
        </div>
      )}

      <div class="inline-form" style={{ marginTop: 8 }}>
        <input value={newKeyName} onInput={e => setNewKeyName(e.target.value)}
          placeholder="Key name (e.g. dev, production)" maxLength={100}
          onKeyDown={e => e.key === 'Enter' && createKey()} />
        <button class="btn-primary" onClick={createKey} disabled={!newKeyName.trim()}>
          {keys.length === 0 ? 'Create key' : 'Add key'}
        </button>
      </div>
    </div>
  );
}

// ─── Step: Pair Browser ──────────────────────────────

function StepPair({ extensionReady, pairing, paired, setPairing, setPaired, setError, onPairSuccess }) {
  const pairThisBrowser = async () => {
    setError(null);
    setPairing(true);
    const r = await api('POST', '/v1/browser-sessions/pair', { label: 'Developer testing' });
    if (!r || r.status !== 201) { setPairing(false); setError(r?.data?.error || 'Failed'); return; }
    window.postMessage({ type: 'HANZI_PAIR', token: r.data.pairing_token, apiUrl: window.location.origin }, '*');
    setTimeout(() => setPairing(p => { if (p) { setError('Extension did not respond. Try reloading the extension.'); return false; } return p; }), 5000);
  };

  if (paired) {
    return (
      <div class="card">
        <div class="step-header-row">
          <span class="step-badge done">✓</span>
          <div>
            <h3>Browser connected</h3>
            <p class="step-explain">Your Chrome is connected as a test user. Hanzi can now run tasks in it.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div class="card">
      <div class="step-header-row">
        <span class="step-badge active">2</span>
        <div>
          <h3>Connect your browser</h3>
          <p class="step-explain">Pair your own Chrome so you can test running tasks in it. In production, each of your users pairs their own browser.</p>
        </div>
      </div>

      {extensionReady ? (
        <div style={{ textAlign: 'center', padding: '8px 0' }}>
          <button class="btn-primary btn-lg" onClick={pairThisBrowser} disabled={pairing}>
            {pairing ? 'Connecting...' : 'Connect this browser'}
          </button>
          <div class="field-hint" style={{ marginTop: 6 }}>Extension detected — one click to connect.</div>
        </div>
      ) : (
        <div class="pair-context">
          <strong>Hanzi extension not detected.</strong>{' '}
          <a href="https://chromewebstore.google.com/detail/hanzi-in-chrome/iklpkemlmbhemkiojndpbhoakgikpmcd" target="_blank" rel="noreferrer">Install it</a>, then reload this page.
        </div>
      )}
    </div>
  );
}

// ─── Step: Run Task ──────────────────────────────────

function StepTask({ apiKey, sessionId, onTaskComplete }) {
  const [taskInput, setTaskInput] = useState('Go to Hacker News and tell me the top 3 stories');
  const [taskStatus, setTaskStatus] = useState(null); // null | 'running' | 'complete' | 'error'
  const [taskAnswer, setTaskAnswer] = useState('');
  const [taskSteps, setTaskSteps] = useState(0);

  const runTask = async () => {
    if (!taskInput.trim() || !sessionId) return;
    setTaskStatus('running');
    setTaskAnswer('');
    setTaskSteps(0);

    const r = await api('POST', '/v1/tasks', {
      task: taskInput.trim(),
      browser_session_id: sessionId,
    });
    if (!r || r.status !== 201) {
      setTaskStatus('error');
      setTaskAnswer(r?.data?.error || 'Failed to create task. Is your browser session connected?');
      return;
    }

    const taskId = r.data.id;

    // Poll until complete
    const deadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const status = await api('GET', `/v1/tasks/${taskId}`);
      if (!status) break;
      setTaskSteps(status.data?.steps || 0);
      if (status.data?.status !== 'running') {
        setTaskStatus(status.data?.status || 'error');
        setTaskAnswer(status.data?.answer || 'No answer returned.');
        if (onTaskComplete) onTaskComplete();
        return;
      }
    }
    setTaskStatus('error');
    setTaskAnswer('Task timed out after 3 minutes.');
  };

  return (
    <div class="card">
      <div class="step-header-row">
        <span class={`step-badge ${taskStatus === 'complete' ? 'done' : 'active'}`}>
          {taskStatus === 'complete' ? '✓' : '3'}
        </span>
        <div>
          <h3>Run a test task</h3>
          <p class="step-explain">Tell Hanzi what to do in your connected browser.</p>
        </div>
      </div>

      {!taskStatus ? (
        <>
          <div class="inline-form">
            <input value={taskInput} onInput={e => setTaskInput(e.target.value)}
              placeholder="What should Hanzi do in the browser?"
              onKeyDown={e => e.key === 'Enter' && runTask()} />
            <button class="btn-primary" onClick={runTask} disabled={!taskInput.trim()}>Run</button>
          </div>
        </>
      ) : taskStatus === 'running' ? (
        <div class="task-running">
          <div class="task-spinner" />
          <span>Running... ({taskSteps} step{taskSteps !== 1 ? 's' : ''})</span>
        </div>
      ) : (
        <div class="task-result">
          <div class={`task-status ${taskStatus}`}>
            {taskStatus === 'complete' ? '✓ Complete' : '✗ ' + taskStatus}
            {taskSteps > 0 && ` · ${taskSteps} steps`}
          </div>
          <div class="task-answer">{taskAnswer}</div>
          <button class="btn-secondary" onClick={() => { setTaskStatus(null); setTaskAnswer(''); }} style={{ marginTop: 8 }}>
            Run another task
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Build Guide ─────────────────────────────────────

// ─── Sessions Card ───────────────────────────────────

function SessionsCard({ sessions, onRefresh }) {
  const connected = sessions.filter(s => s.status === 'connected').length;

  const removeSession = async (id) => {
    await api('DELETE', `/v1/browser-sessions/${id}`);
    onRefresh();
  };

  const removeAllDisconnected = async () => {
    const disconnected = sessions.filter(s => s.status === 'disconnected');
    for (const s of disconnected) {
      await api('DELETE', `/v1/browser-sessions/${s.id}`);
    }
    onRefresh();
  };

  return (
    <div class="card">
      <h2>
        Sessions
        <span class="card-badge">{connected > 0 ? `${connected} connected` : `${sessions.length} paired`}</span>
      </h2>
      {sessions.map(s => {
        const meta = [s.label, s.external_user_id].filter(Boolean).join(' · ');
        return (
          <div class="session-row" key={s.id}>
            <span class="session-info">
              <span class={`status-dot ${s.status}`} />
              <span>{s.status}</span>
              {meta && <span class="session-meta">({meta})</span>}
            </span>
            <span class="session-id-group">
              <code>{s.id.slice(0, 8)}...</code>
              {s.status === 'disconnected' && (
                <button class="btn-danger" onClick={() => removeSession(s.id)} style={{ padding: '2px 8px', fontSize: 11 }}>Remove</button>
              )}
            </span>
          </div>
        );
      })}
      {sessions.some(s => s.status === 'disconnected') && (
        <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button class="btn-secondary" onClick={removeAllDisconnected} style={{ fontSize: 12 }}>Remove all disconnected</button>
          <button class="btn-secondary" onClick={onRefresh} style={{ fontSize: 12 }}>Refresh</button>
        </div>
      )}
      {!sessions.some(s => s.status === 'disconnected') && (
        <button class="btn-secondary" onClick={onRefresh} style={{ marginTop: 8, fontSize: 12 }}>Refresh</button>
      )}
    </div>
  );
}

// ─── Usage Card ──────────────────────────────────────

function UsageCard({ usage }) {
  const fmt = n => n > 999999 ? (n / 1e6).toFixed(1) + 'M' : n > 999 ? (n / 1e3).toFixed(1) + 'K' : String(n || 0);
  return (
    <div class="card">
      <h2>Usage</h2>
      <div class="usage-grid">
        <div class="usage-stat"><div class="num">{usage?.taskCount || 0}</div><div class="label">Tasks</div></div>
        <div class="usage-stat"><div class="num">{fmt(usage?.totalApiCalls)}</div><div class="label">API calls</div></div>
        <div class="usage-stat"><div class="num">{fmt((usage?.totalInputTokens || 0) + (usage?.totalOutputTokens || 0))}</div><div class="label">Tokens</div></div>
      </div>
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
