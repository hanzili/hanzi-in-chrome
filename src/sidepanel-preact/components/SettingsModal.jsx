import { useState, useEffect } from 'preact/hooks';
import { PROVIDERS } from '../config/providers';

export function SettingsModal({ config, onClose }) {
  const [activeTab, setActiveTab] = useState('providers');
  const [selectedProvider, setSelectedProvider] = useState(null);
  const [localKeys, setLocalKeys] = useState({ ...config.providerKeys });
  const [agentDefaultIndex, setAgentDefaultIndex] = useState(config.currentAgentDefaultIndex);
  const [newCustomModel, setNewCustomModel] = useState({ name: '', baseUrl: '', modelId: '', apiKey: '' });
  const [skillForm, setSkillForm] = useState({ domain: '', skill: '', isOpen: false, editIndex: -1 });
  const [managedStatus, setManagedStatus] = useState(null);

  useEffect(() => {
    setAgentDefaultIndex(config.currentAgentDefaultIndex);
  }, [config.currentAgentDefaultIndex]);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_MANAGED_STATUS' }, (res) => {
      if (res) setManagedStatus(res);
    });
  }, []);

  const handleSave = async () => {
    // Update provider keys
    for (const [provider, key] of Object.entries(localKeys)) {
      if (key !== config.providerKeys[provider]) {
        config.setProviderKey(provider, key);
      }
    }
    await config.saveConfig();
    if (agentDefaultIndex !== config.currentAgentDefaultIndex && agentDefaultIndex >= 0) {
      await config.selectAgentDefault(agentDefaultIndex);
    }
    onClose();
  };

  const handleAddCustomModel = () => {
    if (!newCustomModel.name || !newCustomModel.baseUrl || !newCustomModel.modelId) {
      alert('Please fill in name, base URL, and model ID');
      return;
    }
    config.addCustomModel({ ...newCustomModel });
    setNewCustomModel({ name: '', baseUrl: '', modelId: '', apiKey: '' });
  };

  const handleAddSkill = () => {
    if (!skillForm.domain || !skillForm.skill) {
      alert('Please fill in both domain and tips/guidance');
      return;
    }
    config.addUserSkill({ domain: skillForm.domain.toLowerCase(), skill: skillForm.skill });
    setSkillForm({ domain: '', skill: '', isOpen: false, editIndex: -1 });
  };

  const handleEditSkill = (index) => {
    const skill = config.userSkills[index];
    setSkillForm({ domain: skill.domain, skill: skill.skill, isOpen: true, editIndex: index });
  };

  return (
    <div class="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal settings-modal">
        <div class="modal-header">
          <span>Settings</span>
          <button class="close-btn" onClick={onClose}>&times;</button>
        </div>

        <div class="tabs">
          <button
            class={`tab ${activeTab === 'providers' ? 'active' : ''}`}
            onClick={() => setActiveTab('providers')}
          >
            Providers
          </button>
          <button
            class={`tab ${activeTab === 'custom' ? 'active' : ''}`}
            onClick={() => setActiveTab('custom')}
          >
            Custom Models
          </button>
          <button
            class={`tab ${activeTab === 'skills' ? 'active' : ''}`}
            onClick={() => setActiveTab('skills')}
          >
            Domain Skills
          </button>
          <button
            class={`tab ${activeTab === 'managed' ? 'active' : ''}`}
            onClick={() => setActiveTab('managed')}
          >
            Managed
            {managedStatus && (
              <span style={{
                width: 6, height: 6, borderRadius: '50%', display: 'inline-block', marginLeft: 4,
                background: managedStatus.isManaged ? '#2f4a3d' : '#ccc',
              }} />
            )}
          </button>
          <button
            class={`tab ${activeTab === 'license' ? 'active' : ''}`}
            onClick={() => setActiveTab('license')}
          >
            License
          </button>
        </div>

        <div class="modal-body">
          {activeTab === 'managed' && (
            <ManagedTab />
          )}

          {activeTab === 'providers' && (
            <ProvidersTab
              localKeys={localKeys}
              setLocalKeys={setLocalKeys}
              selectedProvider={selectedProvider}
              setSelectedProvider={setSelectedProvider}
              agentDefaultIndex={agentDefaultIndex}
              setAgentDefaultIndex={setAgentDefaultIndex}
              config={config}
            />
          )}

          {activeTab === 'custom' && (
            <CustomModelsTab
              customModels={config.customModels}
              newModel={newCustomModel}
              setNewModel={setNewCustomModel}
              onAdd={handleAddCustomModel}
              onRemove={config.removeCustomModel}
            />
          )}

          {activeTab === 'skills' && (
            <SkillsTab
              userSkills={config.userSkills}
              builtInSkills={config.builtInSkills}
              skillForm={skillForm}
              setSkillForm={setSkillForm}
              onAdd={handleAddSkill}
              onEdit={handleEditSkill}
              onRemove={config.removeUserSkill}
            />
          )}

          {activeTab === 'license' && (
            <LicenseTab />
          )}
        </div>

        <div class="modal-footer">
          <button class="btn btn-secondary" onClick={onClose}>Close</button>
          <button class="btn btn-primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}

function ProvidersTab({
  localKeys,
  setLocalKeys,
  selectedProvider,
  setSelectedProvider,
  agentDefaultIndex,
  setAgentDefaultIndex,
  config
}) {
  return (
    <div class="tab-content">
      {/* Import Claude credentials */}
      <div class="provider-section">
        <h4>Import Claude credentials</h4>
        <p class="provider-desc">Import from <code>claude login</code> to use your Claude Pro/Max subscription. <a href="https://github.com/hanzili/hanzi-in-chrome#claude-code-plan-setup" target="_blank">Setup guide</a></p>
        {config.oauthStatus.isAuthenticated ? (
          <div class="connected-status">
            <span class="status-badge connected">Connected</span>
            <button class="btn btn-secondary btn-sm" onClick={config.logoutCLI}>Disconnect</button>
          </div>
        ) : (
          <button class="btn btn-primary" onClick={config.importCLI}>Import from claude login</button>
        )}
      </div>

      {/* Import Codex credentials */}
      <div class="provider-section">
        <h4>Import Codex credentials</h4>
        <p class="provider-desc">Import from <code>codex login</code> to use your ChatGPT Pro/Plus subscription. <a href="https://github.com/hanzili/hanzi-in-chrome#codex-plan-setup" target="_blank">Setup guide</a></p>
        {config.codexStatus.isAuthenticated ? (
          <div class="connected-status">
            <span class="status-badge connected">Connected</span>
            <button class="btn btn-secondary btn-sm" onClick={config.logoutCodex}>Disconnect</button>
          </div>
        ) : (
          <button class="btn btn-primary" onClick={config.importCodex}>Import from codex login</button>
        )}
      </div>

      <hr />

      {/* API Keys */}
      <h4>API Keys (Pay-per-use)</h4>
      <div class="provider-cards">
        {Object.entries(PROVIDERS).map(([id, provider]) => (
          <div
            key={id}
            class={`provider-card ${selectedProvider === id ? 'selected' : ''} ${localKeys[id] ? 'configured' : ''}`}
            onClick={() => setSelectedProvider(selectedProvider === id ? null : id)}
          >
            <div class="provider-name">{provider.name}</div>
            {localKeys[id] && <span class="check-badge">✓</span>}
          </div>
        ))}
      </div>

      {selectedProvider && (
        <div class="api-key-input">
          <label>{PROVIDERS[selectedProvider].name} {selectedProvider === 'vertex' ? 'Service Account JSON' : 'API Key'}</label>
          {selectedProvider === 'vertex' ? (
            <textarea
              value={localKeys[selectedProvider] || ''}
              onInput={(e) => setLocalKeys({ ...localKeys, [selectedProvider]: e.target.value })}
              placeholder="Paste the entire service account JSON file contents here..."
              rows={4}
              style={{ fontFamily: 'monospace', fontSize: '0.8em' }}
            />
          ) : (
            <input
              type="password"
              value={localKeys[selectedProvider] || ''}
              onInput={(e) => setLocalKeys({ ...localKeys, [selectedProvider]: e.target.value })}
              placeholder="Enter API key..."
            />
          )}
        </div>
      )}

      <hr />

      <div class="provider-section">
        <h4>browser automation default</h4>
        <p class="provider-desc">
          used by <code>hanzi-browser</code> and mcp browser tasks.
          the sidepanel model is still selected from the header.
        </p>
        <div class="api-key-input">
          <label>default model for cli / mcp</label>
          <select
            value={agentDefaultIndex >= 0 ? String(agentDefaultIndex) : ''}
            onChange={(e) => setAgentDefaultIndex(Number(e.target.value))}
            disabled={config.availableModels.length === 0}
          >
            {config.availableModels.length === 0 ? (
              <option value="">connect a model source first</option>
            ) : (
              config.availableModels.map((model, index) => (
                <option key={`${model.provider}-${model.modelId}-${index}`} value={String(index)}>
                  {model.name}
                </option>
              ))
            )}
          </select>
        </div>
      </div>

      <hr />

      {/* MCP Server Integration */}
      <div class="provider-section">
        <h4>MCP Server</h4>
        <p class="provider-desc">
          Control this browser from Claude Code or any MCP client.{' '}
          <a href="https://github.com/hanzili/hanzi-in-chrome#setup" target="_blank">Setup guide</a>
        </p>
        <code class="install-cmd">npm install -g hanzi-in-chrome</code>
      </div>
    </div>
  );
}

function CustomModelsTab({ customModels, newModel, setNewModel, onAdd, onRemove }) {
  return (
    <div class="tab-content">
      <p class="tab-desc">Add custom OpenAI-compatible endpoints</p>

      <div class="custom-model-form">
        <input
          type="text"
          placeholder="Display Name"
          value={newModel.name}
          onInput={(e) => setNewModel({ ...newModel, name: e.target.value })}
        />
        <input
          type="text"
          placeholder="Base URL (e.g., https://api.example.com/v1/chat/completions)"
          value={newModel.baseUrl}
          onInput={(e) => setNewModel({ ...newModel, baseUrl: e.target.value })}
        />
        <input
          type="text"
          placeholder="Model ID"
          value={newModel.modelId}
          onInput={(e) => setNewModel({ ...newModel, modelId: e.target.value })}
        />
        <input
          type="password"
          placeholder="API Key (optional)"
          value={newModel.apiKey}
          onInput={(e) => setNewModel({ ...newModel, apiKey: e.target.value })}
        />
        <button class="btn btn-primary" onClick={onAdd}>Add Model</button>
      </div>

      {customModels.length > 0 && (
        <div class="custom-models-list">
          <h4>Custom Models</h4>
          {customModels.map((model, i) => (
            <div key={i} class="custom-model-item">
              <div class="model-info">
                <span class="model-name">{model.name}</span>
                <span class="model-url">{model.baseUrl}</span>
              </div>
              <button class="btn btn-danger btn-sm" onClick={() => onRemove(i)}>Remove</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LicenseTab() {
  const [status, setStatus] = useState(null);
  const [keyInput, setKeyInput] = useState('');
  const [activating, setActivating] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_LICENSE_STATUS' }, (res) => {
      if (res) setStatus(res);
    });
  }, []);

  const handleActivate = () => {
    if (!keyInput.trim()) return;
    setActivating(true);
    setMessage('');
    chrome.runtime.sendMessage({ type: 'ACTIVATE_LICENSE', payload: { key: keyInput.trim() } }, (res) => {
      setActivating(false);
      setMessage(res.message);
      if (res.success) {
        setKeyInput('');
        chrome.runtime.sendMessage({ type: 'GET_LICENSE_STATUS' }, (s) => { if (s) setStatus(s); });
      }
    });
  };

  const handleDeactivate = () => {
    chrome.runtime.sendMessage({ type: 'DEACTIVATE_LICENSE' }, () => {
      chrome.runtime.sendMessage({ type: 'GET_LICENSE_STATUS' }, (s) => { if (s) setStatus(s); });
      setMessage('License deactivated.');
    });
  };

  if (!status) return <div class="tab-content"><p>Loading...</p></div>;

  return (
    <div class="tab-content">
      <div class="provider-section">
        <h4>Current Plan</h4>
        <p class="provider-desc" style={{ fontSize: '1.1em', fontWeight: 500 }}>
          {status.isPro
            ? <><span class="status-badge connected">Pro</span> Unlimited tasks</>
            : <><span class="status-badge">{status.tasksUsed}/{status.taskLimit} tasks used</span> Free tier</>
          }
        </p>
      </div>

      {!status.isPro && (
        <div class="provider-section">
          <h4>Upgrade to Pro</h4>
          <p class="provider-desc">Unlimited tasks for a one-time payment of $29.</p>
          <a
            href="https://hanziinchrome.lemonsqueezy.com/checkout/buy/5f9be29a-b862-43bf-a440-b4a3cdc9b28e"
            target="_blank"
            class="btn btn-primary"
            style={{ display: 'inline-block', textDecoration: 'none', marginBottom: '12px' }}
          >
            Buy Pro — $29
          </a>
        </div>
      )}

      <div class="provider-section">
        <h4>{status.isPro ? 'License Key' : 'Activate License'}</h4>
        {status.isPro ? (
          <div class="connected-status">
            <code style={{ fontSize: '0.85em' }}>{status.key?.slice(0, 8)}...{status.key?.slice(-4)}</code>
            <button class="btn btn-secondary btn-sm" onClick={handleDeactivate}>Deactivate</button>
          </div>
        ) : (
          <div class="api-key-input">
            <input
              type="text"
              value={keyInput}
              onInput={(e) => setKeyInput(e.target.value)}
              placeholder="Paste license key..."
              onKeyDown={(e) => e.key === 'Enter' && handleActivate()}
            />
            <button class="btn btn-primary" onClick={handleActivate} disabled={activating}>
              {activating ? 'Activating...' : 'Activate'}
            </button>
          </div>
        )}
        {message && <p class="provider-desc" style={{ marginTop: '8px' }}>{message}</p>}
      </div>

      {!status.isPro && (
        <div class="provider-section">
          <p class="provider-desc" style={{ opacity: 0.7, fontSize: '0.85em' }}>
            Tip: MCP/CLI users can also set the <code>HANZI_IN_CHROME_LICENSE_KEY</code> environment variable.
          </p>
        </div>
      )}
    </div>
  );
}

function SkillsTab({ userSkills, builtInSkills, skillForm, setSkillForm, onAdd, onEdit, onRemove }) {
  return (
    <div class="tab-content">
      <p class="tab-desc">Add domain-specific tips to help the AI navigate websites</p>

      <button
        class="btn btn-secondary"
        onClick={() => setSkillForm({ ...skillForm, isOpen: true, editIndex: -1, domain: '', skill: '' })}
      >
        + Add Skill
      </button>

      {skillForm.isOpen && (
        <div class="skill-form">
          <input
            type="text"
            placeholder="Domain (e.g., github.com)"
            value={skillForm.domain}
            onInput={(e) => setSkillForm({ ...skillForm, domain: e.target.value })}
          />
          <textarea
            placeholder="Tips and guidance for this domain..."
            value={skillForm.skill}
            onInput={(e) => setSkillForm({ ...skillForm, skill: e.target.value })}
            rows={4}
          />
          <div class="skill-form-actions">
            <button class="btn btn-secondary" onClick={() => setSkillForm({ ...skillForm, isOpen: false })}>
              Cancel
            </button>
            <button class="btn btn-primary" onClick={onAdd}>
              {skillForm.editIndex >= 0 ? 'Update' : 'Add'}
            </button>
          </div>
        </div>
      )}

      <div class="skills-list">
        {userSkills.length > 0 && (
          <>
            <h4>Your Skills</h4>
            {userSkills.map((skill, i) => (
              <div key={i} class="skill-item">
                <div class="skill-domain">{skill.domain}</div>
                <div class="skill-preview">{skill.skill.substring(0, 100)}...</div>
                <div class="skill-actions">
                  <button class="btn btn-sm" onClick={() => onEdit(i)}>Edit</button>
                  <button class="btn btn-sm btn-danger" onClick={() => onRemove(i)}>Delete</button>
                </div>
              </div>
            ))}
          </>
        )}

        {builtInSkills.length > 0 && (
          <>
            <h4>Built-in Skills</h4>
            {builtInSkills.map((skill, i) => (
              <div key={i} class="skill-item builtin">
                <div class="skill-domain">{skill.domain}</div>
                <div class="skill-preview">{skill.skill.substring(0, 100)}...</div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

const DEFAULT_API_URL = 'https://api.hanzilla.co';

function ManagedTab() {
  const [status, setStatus] = useState(null);
  const [pairingToken, setPairingToken] = useState('');
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [message, setMessage] = useState('');
  const [pairing, setPairing] = useState(false);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_MANAGED_STATUS' }, (res) => {
      if (res) setStatus(res);
    });
  }, []);

  const handlePair = () => {
    if (!pairingToken.trim()) return;
    setPairing(true);
    setMessage('');
    chrome.runtime.sendMessage({
      type: 'MANAGED_PAIR',
      payload: { pairing_token: pairingToken.trim(), api_url: apiUrl.trim() || DEFAULT_API_URL },
    }, (res) => {
      setPairing(false);
      if (res?.success) {
        setMessage('');
        setPairingToken('');
        setStatus({ isManaged: true, browserSessionId: res.browserSessionId });
      } else {
        const err = res?.error || 'Unknown error';
        let msg;
        if (err.includes('expired')) {
          msg = 'Token expired. Generate a new one from the developer console.';
        } else if (err.includes('consumed') || err.includes('already')) {
          msg = 'Token already used. Each token can only be used once.';
        } else if (err.includes('Invalid')) {
          msg = 'Invalid token. Make sure you copied the full token starting with hic_pair_';
        } else {
          msg = `Connection failed: ${err}`;
        }
        setMessage(msg);
      }
    });
  };

  const handleDisconnect = () => {
    chrome.runtime.sendMessage({ type: 'MANAGED_DISCONNECT' }, () => {
      setStatus({ isManaged: false, browserSessionId: null });
      setMessage('Disconnected.');
    });
  };

  return (
    <div class="tab-content">
      <div class="provider-section">
        <h4>Pair this browser</h4>
        <p class="provider-desc">
          Paste a pairing token to connect this browser to a Hanzi workspace. Once paired, your workspace can run tasks in this browser remotely.
        </p>
      </div>

      {status?.isManaged ? (
        <div class="provider-section">
          <div class="connected-status">
            <span class="status-badge connected">Paired</span>
            <code style={{ fontSize: '0.8em', marginLeft: '8px' }}>{status.browserSessionId?.slice(0, 8)}...</code>
            <button class="btn btn-secondary btn-sm" onClick={handleDisconnect} style={{ marginLeft: '8px' }}>Disconnect</button>
          </div>
          <p class="provider-desc" style={{ marginTop: '8px', fontSize: '0.85em' }}>
            This browser is connected and ready to receive tasks.
          </p>
        </div>
      ) : (
        <>
          <div class="provider-section">
            <div class="api-key-input">
              <label>Pairing token</label>
              <input
                type="text"
                value={pairingToken}
                onInput={(e) => setPairingToken(e.target.value)}
                placeholder="hic_pair_..."
                onKeyDown={(e) => e.key === 'Enter' && handlePair()}
                autoFocus
              />
              <button class="btn btn-primary" onClick={handlePair} disabled={pairing || !pairingToken.trim()}>
                {pairing ? 'Connecting...' : 'Connect'}
              </button>
            </div>
          </div>

          <div class="provider-section">
            <button
              class="btn btn-sm"
              style={{ fontSize: '0.8em', opacity: 0.7, background: 'none', border: 'none', padding: '4px 0', cursor: 'pointer', textDecoration: 'underline' }}
              onClick={() => setShowAdvanced(!showAdvanced)}
            >
              {showAdvanced ? 'Hide advanced options' : 'Advanced: custom backend URL'}
            </button>
            {showAdvanced && (
              <div class="api-key-input" style={{ marginTop: '8px' }}>
                <label>Backend URL</label>
                <input
                  type="text"
                  value={apiUrl}
                  onInput={(e) => setApiUrl(e.target.value)}
                  placeholder={DEFAULT_API_URL}
                />
                <p class="provider-desc" style={{ fontSize: '0.75em', marginTop: '4px' }}>
                  Only change this if you are running a local or custom Hanzi deployment.
                </p>
              </div>
            )}
          </div>
        </>
      )}

      {message && (
        <div class="provider-section">
          <p class="provider-desc" style={{ marginTop: '4px', color: message.startsWith('Failed') ? '#c62828' : undefined }}>{message}</p>
        </div>
      )}

      <div class="provider-section">
        <p class="provider-desc" style={{ opacity: 0.6, fontSize: '0.8em' }}>
          Get a pairing token from the app that is integrating Hanzi, or create one with <code>POST /v1/browser-sessions/pair</code>.
        </p>
      </div>
    </div>
  );
}
