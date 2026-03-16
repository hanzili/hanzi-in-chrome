import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { PROVIDERS, CODEX_MODELS } from '../sidepanel-preact/config/providers';
import agentDemoVideo from '../../cli-use-case.webm';
import sidepanelDemoVideo from '../../sidepanel-use-case.mp4';

const STEPS = {
  WELCOME: 'welcome',
  SETUP: 'setup',
  CONNECT: 'connect',
  DONE: 'done',
};

const SIDEPANEL_MODEL_PREFERENCES = [
  { provider: 'anthropic', authMethod: 'oauth', modelId: 'claude-sonnet-4-20250514' },
  { provider: 'anthropic', authMethod: 'api_key', modelId: 'claude-sonnet-4-20250514' },
  { provider: 'codex', authMethod: 'codex_oauth', modelId: 'gpt-5.1-codex-max' },
  { provider: 'openai', authMethod: 'api_key', modelId: 'gpt-4o' },
  { provider: 'google', authMethod: 'api_key', modelId: 'gemini-2.5-flash' },
  { provider: 'openrouter', authMethod: 'api_key', modelId: 'qwen/qwen3-vl-235b-a22b-thinking' },
];

const AGENT_MODEL_PREFERENCES = [
  { provider: 'anthropic', authMethod: 'oauth', modelId: 'claude-haiku-4-5-20251001' },
  { provider: 'anthropic', authMethod: 'api_key', modelId: 'claude-haiku-4-5-20251001' },
  { provider: 'codex', authMethod: 'codex_oauth', modelId: 'gpt-5.1-codex-mini' },
  { provider: 'openai', authMethod: 'api_key', modelId: 'gpt-5-mini' },
  { provider: 'google', authMethod: 'api_key', modelId: 'gemini-2.5-flash' },
  { provider: 'openrouter', authMethod: 'api_key', modelId: 'moonshotai/kimi-k2.5' },
];

function buildAvailableModels(providerKeys = {}, customModels = [], oauth = {}, codex = {}) {
  const models = [];
  const hasOAuth = oauth?.isOAuthEnabled && oauth?.isAuthenticated;
  const hasCodexOAuth = codex?.isAuthenticated;

  if (hasCodexOAuth) {
    for (const model of CODEX_MODELS) {
      models.push({
        name: `${model.name} (codex plan)`,
        provider: 'codex',
        modelId: model.id,
        baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
        apiKey: null,
        authMethod: 'codex_oauth',
      });
    }
  }

  for (const [providerId, provider] of Object.entries(PROVIDERS)) {
    const hasApiKey = providerKeys[providerId];

    if (providerId === 'anthropic') {
      if (hasOAuth) {
        for (const model of provider.models) {
          models.push({
            name: `${model.name} (claude code)`,
            provider: providerId,
            modelId: model.id,
            baseUrl: provider.baseUrl,
            apiKey: null,
            authMethod: 'oauth',
          });
        }
      }

      if (hasApiKey) {
        for (const model of provider.models) {
          models.push({
            name: `${model.name} (api)`,
            provider: providerId,
            modelId: model.id,
            baseUrl: provider.baseUrl,
            apiKey: hasApiKey,
            authMethod: 'api_key',
          });
        }
      }
    } else if (hasApiKey) {
      for (const model of provider.models) {
        models.push({
          name: `${model.name} (api)`,
          provider: providerId,
          modelId: model.id,
          baseUrl: provider.baseUrl,
          apiKey: hasApiKey,
          authMethod: 'api_key',
        });
      }
    }
  }

  for (const customModel of customModels) {
    models.push({
      name: customModel.name,
      provider: 'openai',
      modelId: customModel.modelId,
      baseUrl: customModel.baseUrl,
      apiKey: customModel.apiKey,
      authMethod: 'api_key',
    });
  }

  return models;
}

function buildConnectedSources(config = {}, oauth = {}, codex = {}) {
  const sources = new Set();

  if (oauth?.isOAuthEnabled && oauth?.isAuthenticated) {
    sources.add('claude');
  }

  if (codex?.isAuthenticated) {
    sources.add('codex');
  }

  for (const providerId of Object.keys(config.providerKeys || {})) {
    if (config.providerKeys?.[providerId]) {
      sources.add(`api_${providerId}`);
    }
  }

  for (const customModel of config.customModels || []) {
    sources.add(`custom_${customModel.name}`);
  }

  return sources;
}

function serializeModelConfig(model) {
  if (!model) return null;

  return {
    name: model.name,
    provider: model.provider,
    model: model.modelId,
    apiBaseUrl: model.baseUrl,
    apiKey: model.apiKey,
    authMethod: model.authMethod,
  };
}

function findModelIndex(models, selection) {
  if (!selection?.model || !selection?.apiBaseUrl) {
    return -1;
  }

  return models.findIndex(model =>
    model.provider === selection.provider &&
    model.modelId === selection.model &&
    model.baseUrl === selection.apiBaseUrl &&
    model.authMethod === selection.authMethod
  );
}

function findPreferredModelIndex(models, preferences) {
  for (const preference of preferences) {
    const index = models.findIndex(model =>
      model.provider === preference.provider &&
      model.authMethod === preference.authMethod &&
      model.modelId === preference.modelId
    );
    if (index >= 0) {
      return index;
    }
  }

  return models.length > 0 ? 0 : -1;
}

function getInitialSurfaceIndexes(models, config, preservedSideConfig = null, preservedAgentConfig = null) {
  const currentSideConfig = {
    provider: config.provider,
    model: config.model,
    apiBaseUrl: config.apiBaseUrl,
    authMethod: config.authMethod,
  };

  const sideIndex =
    findModelIndex(models, preservedSideConfig) >= 0 ? findModelIndex(models, preservedSideConfig)
      : findModelIndex(models, currentSideConfig) >= 0 ? findModelIndex(models, currentSideConfig)
        : findPreferredModelIndex(models, SIDEPANEL_MODEL_PREFERENCES);

  const agentIndex =
    findModelIndex(models, preservedAgentConfig) >= 0 ? findModelIndex(models, preservedAgentConfig)
      : findModelIndex(models, config.agentDefaultConfig) >= 0 ? findModelIndex(models, config.agentDefaultConfig)
        : findPreferredModelIndex(models, AGENT_MODEL_PREFERENCES);

  return {
    sideIndex,
    agentIndex,
  };
}

export function OnboardingApp() {
  const [step, setStep] = useState(STEPS.WELCOME);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [connectedSources, setConnectedSources] = useState(new Set());
  const [availableModels, setAvailableModels] = useState([]);
  const [sidepanelDefaultIndex, setSidepanelDefaultIndex] = useState(-1);
  const [agentDefaultIndex, setAgentDefaultIndex] = useState(-1);
  const [selectedApiProvider, setSelectedApiProvider] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [customModel, setCustomModel] = useState({ name: '', baseUrl: '', modelId: '', apiKey: '' });
  const availableModelsRef = useRef([]);
  const sidepanelDefaultIndexRef = useRef(-1);
  const agentDefaultIndexRef = useRef(-1);

  useEffect(() => {
    availableModelsRef.current = availableModels;
  }, [availableModels]);

  useEffect(() => {
    sidepanelDefaultIndexRef.current = sidepanelDefaultIndex;
  }, [sidepanelDefaultIndex]);

  useEffect(() => {
    agentDefaultIndexRef.current = agentDefaultIndex;
  }, [agentDefaultIndex]);

  const refreshSetupState = useCallback(async () => {
    const preservedSideConfig = serializeModelConfig(availableModelsRef.current[sidepanelDefaultIndexRef.current]);
    const preservedAgentConfig = serializeModelConfig(availableModelsRef.current[agentDefaultIndexRef.current]);

    const [config, oauth, codex] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_CONFIG' }),
      chrome.runtime.sendMessage({ type: 'GET_OAUTH_STATUS' }),
      chrome.runtime.sendMessage({ type: 'GET_CODEX_STATUS' }),
    ]);

    const models = buildAvailableModels(
      config?.providerKeys || {},
      config?.customModels || [],
      oauth,
      codex
    );

    setConnectedSources(buildConnectedSources(config, oauth, codex));
    setAvailableModels(models);

    const { sideIndex, agentIndex } = getInitialSurfaceIndexes(
      models,
      config || {},
      preservedSideConfig,
      preservedAgentConfig
    );

    setSidepanelDefaultIndex(sideIndex);
    setAgentDefaultIndex(agentIndex);
  }, []);

  useEffect(() => {
    void refreshSetupState();
  }, [refreshSetupState]);

  const continueFromWelcome = () => {
    setStep(STEPS.SETUP);
  };

  const handleImportClaude = async () => {
    setConnecting(true);
    setConnectError('');
    try {
      const result = await chrome.runtime.sendMessage({ type: 'IMPORT_CLI_CREDENTIALS' });
      if (result.success) {
        await refreshSetupState();
      } else {
        setConnectError(result.error || 'failed to import claude credentials. make sure you have run `claude login` first.');
      }
    } catch {
      setConnectError('failed to connect. is claude code installed?');
    }
    setConnecting(false);
  };

  const handleImportCodex = async () => {
    setConnecting(true);
    setConnectError('');
    try {
      const result = await chrome.runtime.sendMessage({ type: 'IMPORT_CODEX_CREDENTIALS' });
      if (result.success) {
        await refreshSetupState();
      } else {
        setConnectError(result.error || 'failed to import codex credentials. make sure you have run `codex login` first.');
      }
    } catch {
      setConnectError('failed to connect. is codex cli installed?');
    }
    setConnecting(false);
  };

  const handleSaveApiKey = async () => {
    if (!selectedApiProvider || !apiKey.trim()) return;

    setConnecting(true);
    setConnectError('');
    try {
      const currentConfig = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
      await chrome.runtime.sendMessage({
        type: 'SAVE_CONFIG',
        payload: {
          providerKeys: {
            ...(currentConfig?.providerKeys || {}),
            [selectedApiProvider]: apiKey.trim(),
          },
        },
      });
      setApiKey('');
      setSelectedApiProvider(null);
      await refreshSetupState();
    } catch {
      setConnectError('failed to save api key.');
    }
    setConnecting(false);
  };

  const handleSaveCustomModel = async () => {
    if (!customModel.name || !customModel.baseUrl || !customModel.modelId) return;

    setConnecting(true);
    setConnectError('');
    try {
      const currentConfig = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
      await chrome.runtime.sendMessage({
        type: 'SAVE_CONFIG',
        payload: {
          customModels: [
            ...(currentConfig?.customModels || []),
            { ...customModel },
          ],
        },
      });
      setCustomModel({ name: '', baseUrl: '', modelId: '', apiKey: '' });
      await refreshSetupState();
    } catch {
      setConnectError('failed to save custom model.');
    }
    setConnecting(false);
  };

  const finishOnboarding = async () => {
    if (availableModels.length > 0) {
      const sidepanelModel = availableModels[sidepanelDefaultIndex];
      const agentModel = availableModels[agentDefaultIndex];

      await chrome.runtime.sendMessage({
        type: 'SAVE_CONFIG',
        payload: {
          ...(sidepanelModel ? {
            currentModelIndex: sidepanelDefaultIndex,
            model: sidepanelModel.modelId,
            apiBaseUrl: sidepanelModel.baseUrl,
            apiKey: sidepanelModel.apiKey,
            authMethod: sidepanelModel.authMethod,
            provider: sidepanelModel.provider,
          } : {}),
          agentDefaultConfig: serializeModelConfig(agentModel),
        },
      });
    }

    await chrome.storage.local.set({
      onboarding_completed: true,
      onboarding_completed_at: Date.now(),
      onboarding_primary_mode: 'both',
      onboarding_version: 1,
    });

    setStep(STEPS.DONE);
  };

  if (step === STEPS.WELCOME) {
    return <WelcomeStep onContinue={continueFromWelcome} />;
  }

  if (step === STEPS.SETUP) {
    return (
      <SetupStep
        onContinue={() => setStep(STEPS.CONNECT)}
        onBack={() => setStep(STEPS.WELCOME)}
      />
    );
  }

  if (step === STEPS.CONNECT) {
    return (
      <ConnectStep
        connecting={connecting}
        connectError={connectError}
        connectedSources={connectedSources}
        availableModels={availableModels}
        sidepanelDefaultIndex={sidepanelDefaultIndex}
        agentDefaultIndex={agentDefaultIndex}
        selectedApiProvider={selectedApiProvider}
        apiKey={apiKey}
        customModel={customModel}
        onImportClaude={handleImportClaude}
        onImportCodex={handleImportCodex}
        onSelectApiProvider={setSelectedApiProvider}
        onApiKeyChange={setApiKey}
        onSaveApiKey={handleSaveApiKey}
        onCustomModelChange={setCustomModel}
        onSaveCustomModel={handleSaveCustomModel}
        onSidepanelDefaultChange={setSidepanelDefaultIndex}
        onAgentDefaultChange={setAgentDefaultIndex}
        onFinish={finishOnboarding}
        onBack={() => {
          setStep(STEPS.SETUP);
          setConnectError('');
        }}
      />
    );
  }

  if (step === STEPS.DONE) {
    return <DoneStep />;
  }
}

function ToolbarHint() {
  return (
    <div class="toolbar-hint">
      {/* Fake Chrome toolbar strip */}
      <svg viewBox="0 0 480 100" fill="none" xmlns="http://www.w3.org/2000/svg" class="toolbar-hint-svg">
        {/* Toolbar background */}
        <rect width="480" height="48" rx="12" fill="#e8eaed" />
        {/* Bookmark star */}
        <path d="M36 24l2.3 4.7 5.2.8-3.8 3.7.9 5.2L36 35.8l-4.6 2.6.9-5.2-3.8-3.7 5.2-.8z" fill="none" stroke="#9aa0a6" stroke-width="1.5" />
        {/* Separator */}
        <rect x="56" y="12" width="1" height="24" rx="0.5" fill="#dadce0" />
        {/* Generic extension icons */}
        <circle cx="84" cy="24" r="12" fill="#c4c7cc" />
        <circle cx="116" cy="24" r="12" fill="#c4c7cc" />
        <circle cx="148" cy="24" r="12" fill="#c4c7cc" />

        {/* Hanzi icon — highlighted */}
        <g>
          {/* Pulse ring */}
          <circle cx="188" cy="24" r="17" fill="none" stroke="#5D9A9A" stroke-width="2" opacity="0.3">
            <animate attributeName="r" values="17;22;17" dur="2s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.3;0;0.3" dur="2s" repeatCount="indefinite" />
          </circle>
          {/* Highlight ring */}
          <circle cx="188" cy="24" r="16" fill="none" stroke="#5D9A9A" stroke-width="2" />
          {/* Actual hanzi icon */}
          <image href="data:image/png;base64,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" x="175" y="11" width="26" height="26" />
        </g>

        {/* More generic icons */}
        <circle cx="224" cy="24" r="12" fill="#c4c7cc" />
        {/* Separator */}
        <rect x="248" y="12" width="1" height="24" rx="0.5" fill="#dadce0" />
        {/* Profile circle */}
        <circle cx="272" cy="24" r="14" fill="#c4c7cc" />
        {/* Three-dot menu */}
        <circle cx="300" cy="17" r="2" fill="#9aa0a6" />
        <circle cx="300" cy="24" r="2" fill="#9aa0a6" />
        <circle cx="300" cy="31" r="2" fill="#9aa0a6" />

        {/* Arrow pointing up to the hanzi icon */}
        <path d="M188 56 L188 50" stroke="#5D9A9A" stroke-width="2.5" stroke-linecap="round" />
        <path d="M183 53 L188 47 L193 53" stroke="#5D9A9A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none" />

        {/* Label bubble */}
        <rect x="108" y="60" width="160" height="32" rx="8" fill="#5D9A9A" />
        <text x="188" y="81" text-anchor="middle" fill="white" font-size="13" font-weight="600" font-family="-apple-system, BlinkMacSystemFont, sans-serif">click this icon</text>
      </svg>
    </div>
  );
}

function WelcomeStep({ onContinue }) {
  return (
    <div class="onboarding-page">
      <div class="onboarding-container">
        <div class="onboarding-header">
          <div class="logo-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
          </div>
          <h1>hanzi lets ai use your real chrome</h1>
          <p class="subtitle">
            use it yourself in the sidepanel, or connect it to claude code / codex / mcp
            so your ai agent can drive your logged-in browser.
          </p>
        </div>

        <div class="mode-cards">
          <div class="mode-card">
            <div class="mode-preview">
              <video
                src={sidepanelDemoVideo}
                autoPlay
                muted
                loop
                playsInline
                preload="metadata"
              />
            </div>
            <h2>use it myself</h2>
            <p>open the sidepanel, describe what you want, and let hanzi browse for you directly inside chrome.</p>
            <div class="mode-setup">sidepanel use</div>
          </div>

          <div class="mode-card">
            <div class="mode-preview">
              <video
                src={agentDemoVideo}
                autoPlay
                muted
                loop
                playsInline
                preload="metadata"
              />
            </div>
            <h2>use it from my ai agent</h2>
            <p>connect claude code, codex cli, or any mcp client and let your agent drive the same logged-in browser.</p>
            <div class="mode-setup">cli and mcp use</div>
          </div>
        </div>

        <div class="onboarding-footer">
          <button class="btn btn-primary btn-lg" onClick={onContinue}>
            continue setup
          </button>
        </div>
      </div>
    </div>
  );
}

function SetupStep({ onContinue, onBack }) {
  const [copied, setCopied] = useState(false);

  return (
    <div class="onboarding-page">
      <div class="onboarding-container">
        <button class="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          back
        </button>

        <div class="onboarding-header">
          <h1>configure your agents</h1>
          <p class="subtitle">
            run this in your terminal. it detects claude code, cursor, windsurf, and claude desktop — configures each one automatically.
          </p>
        </div>

        <div class="connect-sections">
          <div class="connect-section">
            <div class="command-block" style={{ margin: '12px 0' }}>
              <code>npx hanzi-in-chrome setup</code>
              <button
                class="copy-btn"
                onClick={() => {
                  navigator.clipboard.writeText('npx hanzi-in-chrome setup');
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? 'copied!' : 'copy'}
              </button>
            </div>
            <p class="connect-hint">
              skip this step if you only want to use hanzi from the chrome sidepanel.
            </p>
          </div>
        </div>

        <div class="onboarding-footer">
          <button class="btn btn-primary btn-lg" onClick={onContinue}>
            next
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectStep({
  connecting,
  connectError,
  connectedSources,
  availableModels,
  sidepanelDefaultIndex,
  agentDefaultIndex,
  selectedApiProvider,
  apiKey,
  customModel,
  onImportClaude,
  onImportCodex,
  onSelectApiProvider,
  onApiKeyChange,
  onSaveApiKey,
  onCustomModelChange,
  onSaveCustomModel,
  onSidepanelDefaultChange,
  onAgentDefaultChange,
  onFinish,
  onBack,
}) {
  const [showApiKeys, setShowApiKeys] = useState(false);
  const hasAnySources = connectedSources.size > 0;
  const hasClaude = connectedSources.has('claude');
  const hasCodex = connectedSources.has('codex');
  const hasApiKey = (id) => connectedSources.has(`api_${id}`);

  return (
    <div class="onboarding-page">
      <div class="onboarding-container">
        <button class="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          back
        </button>

        <div class="onboarding-header">
          <h1>connect a model source</h1>
          <p class="subtitle">
            hanzi needs credentials to run browser tasks. pick whichever you already have.
          </p>
        </div>

        {hasAnySources && (
          <div class="success-banner">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            connected {connectedSources.size} source{connectedSources.size === 1 ? '' : 's'}. you can keep going, or just review the defaults and continue.
          </div>
        )}

        {connectError && (
          <div class="error-banner">{connectError}</div>
        )}

        <div class="connect-sections">
          <div class="connect-section">

            <div class="quick-connect-grid">
              <button
                class={`quick-connect-card ${hasClaude ? 'connected' : ''}`}
                onClick={onImportClaude}
                disabled={connecting || hasClaude}
              >
                <div class="quick-connect-head">
                  <span class="quick-connect-title">use claude</span>
                  {hasClaude && <span class="check-mark">connected</span>}
                </div>
                <span class="quick-connect-desc">import from `claude login` and use your claude subscription</span>
              </button>

              <button
                class={`quick-connect-card ${hasCodex ? 'connected' : ''}`}
                onClick={onImportCodex}
                disabled={connecting || hasCodex}
              >
                <div class="quick-connect-head">
                  <span class="quick-connect-title">use codex</span>
                  {hasCodex && <span class="check-mark">connected</span>}
                </div>
                <span class="quick-connect-desc">import from `codex login` and use your chatgpt subscription</span>
              </button>

              <button
                class={`quick-connect-card ${showApiKeys ? 'selected' : ''}`}
                onClick={() => setShowApiKeys(!showApiKeys)}
                disabled={connecting}
              >
                <div class="quick-connect-head">
                  <span class="quick-connect-title">use an api key</span>
                  <span class="quick-connect-pill">{showApiKeys ? 'open' : 'choose provider'}</span>
                </div>
                <span class="quick-connect-desc">connect anthropic, openai, google, or openrouter directly</span>
              </button>
            </div>


            {showApiKeys && (
              <div class="nested-panel">
                <div class="api-provider-grid">
                  {Object.entries(PROVIDERS).map(([id, provider]) => (
                    <button
                      key={id}
                      class={`api-provider-btn ${selectedApiProvider === id ? 'selected' : ''} ${hasApiKey(id) ? 'connected' : ''}`}
                      onClick={() => onSelectApiProvider(selectedApiProvider === id ? null : id)}
                    >
                      {provider.name}
                      {hasApiKey(id) && <span class="check-mark">saved</span>}
                    </button>
                  ))}
                </div>

                {selectedApiProvider && (
                  <div class="api-key-entry">
                    <input
                      type="password"
                      placeholder={`${PROVIDERS[selectedApiProvider].name.toLowerCase()} api key`}
                      value={apiKey}
                      onInput={(e) => onApiKeyChange(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && onSaveApiKey()}
                    />
                    <button
                      class="btn btn-primary"
                      onClick={onSaveApiKey}
                      disabled={!apiKey.trim() || connecting}
                    >
                      {connecting ? 'saving...' : 'save'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div class="connect-section">
            <details class="advanced-section">
              <summary>more ways to connect (ollama, lm studio, etc.)</summary>
              <p class="connect-hint" style={{ marginBottom: '12px' }}>
                add any openai-compatible endpoint. works with ollama (<code>http://localhost:11434/v1</code>), lm studio, vllm, or any hosted provider.
              </p>
              <div class="custom-model-form">
                <input
                  type="text"
                  placeholder="display name"
                  value={customModel.name}
                  onInput={(e) => onCustomModelChange({ ...customModel, name: e.target.value })}
                />
                <input
                  type="text"
                  placeholder="base url (e.g. http://localhost:11434/v1)"
                  value={customModel.baseUrl}
                  onInput={(e) => onCustomModelChange({ ...customModel, baseUrl: e.target.value })}
                />
                <input
                  type="text"
                  placeholder="model id"
                  value={customModel.modelId}
                  onInput={(e) => onCustomModelChange({ ...customModel, modelId: e.target.value })}
                />
                <input
                  type="password"
                  placeholder="api key (optional)"
                  value={customModel.apiKey}
                  onInput={(e) => onCustomModelChange({ ...customModel, apiKey: e.target.value })}
                />
                <button
                  class="btn btn-primary"
                  onClick={onSaveCustomModel}
                  disabled={!customModel.name || !customModel.baseUrl || !customModel.modelId || connecting}
                >
                  {connecting ? 'saving...' : 'add model'}
                </button>
              </div>
            </details>
          </div>

          {hasAnySources && availableModels.length > 0 && (
            <div class="connect-section">
              <div class="section-kicker">defaults</div>
              <h3>pick your models</h3>
              <div class="defaults-grid">
                <label class="default-select-card primary">
                  <span class="default-label">sidepanel model</span>
                  <select
                    value={String(sidepanelDefaultIndex)}
                    onChange={(e) => onSidepanelDefaultChange(Number(e.target.value))}
                  >
                    {availableModels.map((model, index) => (
                      <option key={`primary-${model.provider}-${model.modelId}-${index}`} value={String(index)}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                  <span class="default-help">sidepanel</span>
                </label>

                <label class="default-select-card secondary">
                  <span class="default-label">automation model</span>
                  <select
                    value={String(agentDefaultIndex)}
                    onChange={(e) => onAgentDefaultChange(Number(e.target.value))}
                  >
                    {availableModels.map((model, index) => (
                      <option key={`secondary-${model.provider}-${model.modelId}-${index}`} value={String(index)}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                  <span class="default-help">browser automation</span>
                </label>
              </div>
            </div>
          )}
        </div>

        <div class="onboarding-footer">
          {hasAnySources ? (
            <button class="btn btn-primary btn-lg" onClick={onFinish}>
              finish setup
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </button>
          ) : (
            <button class="btn btn-secondary skip-btn" onClick={onFinish}>
              skip for now
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function DoneStep() {
  const [copied, setCopied] = useState(null);

  const copyToClipboard = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div class="onboarding-page">
      <div class="onboarding-container">
        <div class="onboarding-header">
          <div class="success-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </div>
          <h1>you're all set</h1>
          <p class="subtitle">you can now use hanzi directly in chrome or connect it to your ai agent. both are ready.</p>
        </div>

        <div class="done-sections">
          <div class="done-section">
            <h3>use it from your agent</h3>
            <p class="section-intro">restart your agent and ask it to do something in the browser. the mcp tools are ready.</p>
          </div>

          <div class="done-section">
            <h3>use it yourself in chrome</h3>
            <p class="section-intro">click the hanzi icon in your chrome toolbar, then try one of these:</p>
            <ToolbarHint />
            <div class="example-tasks">
              <div class="example-task">"summarize my open jira tickets"</div>
              <div class="example-task">"go to linkedin and draft a post about today's release"</div>
              <div class="example-task">"compare prices for flights to tokyo next week"</div>
            </div>
          </div>
        </div>

        <div class="onboarding-footer">
          <button class="btn btn-primary btn-lg" onClick={() => window.close()}>
            close setup
          </button>
        </div>

      </div>
    </div>
  );
}
