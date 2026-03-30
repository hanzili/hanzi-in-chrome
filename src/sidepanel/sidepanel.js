/**
 * Side Panel - Chat interface for Hanzi Browse
 */

// Provider configurations
const PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1/messages',
    models: [
      { id: 'claude-opus-4-5-20251101', name: 'Opus 4.5' },
      { id: 'claude-opus-4-20250514', name: 'Opus 4' },
      { id: 'claude-sonnet-4-20250514', name: 'Sonnet 4' },
      { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' },
    ],
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'gpt-5-mini', name: 'GPT-5 Mini' },
      { id: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'o3', name: 'o3' },
      { id: 'o4-mini', name: 'o4-mini' },
    ],
  },
  google: {
    name: 'Google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    models: [
      { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (Preview)' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    ],
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    models: [
      { id: 'qwen/qwen3-vl-235b-a22b-thinking', name: 'Qwen3 VL 235B (Reasoning)' },
      { id: 'moonshotai/kimi-k2.5', name: 'Kimi K2.5 (Reasoning)' },
      { id: 'mistralai/mistral-large-2512', name: 'Mistral Large 3' },
    ],
  },
};

// Elements
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const modelSelector = document.getElementById('model-selector');
const modelSelectorBtn = document.getElementById('model-selector-btn');
const modelDropdown = document.getElementById('model-dropdown');
const modelList = document.getElementById('model-list');
const currentModelNameEl = document.getElementById('current-model-name');
const newChatBtn = document.getElementById('new-chat-btn');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsSave = document.getElementById('settings-save');
const settingsClose = document.getElementById('settings-close');
const planModal = document.getElementById('plan-modal');
const planDomains = document.getElementById('plan-domains');
const planSteps = document.getElementById('plan-steps');
const planApprove = document.getElementById('plan-approve');
const planCancel = document.getElementById('plan-cancel');
const askToggle = document.getElementById('ask-toggle');
const stopBtn = document.getElementById('stop-btn');
const inputContainer = document.getElementById('input-container');
const imagePreview = document.getElementById('image-preview');

// State
let isRunning = false;
let askBeforeActing = true;
let currentToolIndicator = null;
let currentStreamingMessage = null;
let completedSteps = []; // Array of { tool, input, result, description }
let pendingStep = null; // Current executing step
let stepsSection = null;
let attachedImages = []; // Array of base64 data URLs

// Session state - managed by UI
let sessionTabGroupId = null; // Tab group for current session

// Config state
let providerKeys = {}; // { anthropic: 'sk-...', openai: 'sk-...', ... }
let customModels = []; // [{ name, baseUrl, modelId, apiKey }, ...]
let availableModels = []; // Combined list of { name, provider, modelId, baseUrl, apiKey }
let currentModelIndex = 0;
let selectedProvider = null;

// Domain skills state
let userSkills = []; // [{ domain: 'example.com', skill: '...' }, ...]
let builtInSkills = []; // Loaded from service worker
let editingSkillIndex = -1; // -1 = adding new, >= 0 = editing existing

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // Load saved config
  await loadConfig();

  // Auto-resize textarea
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
  });

  // Handle Enter to send
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Send button
  sendBtn.addEventListener('click', sendMessage);

  // Model selector
  modelSelectorBtn.addEventListener('click', toggleModelDropdown);
  document.addEventListener('click', (e) => {
    if (!modelSelector.contains(e.target)) {
      closeModelDropdown();
    }
  });

  // New chat
  newChatBtn.addEventListener('click', clearChat);

  // Settings
  settingsBtn.addEventListener('click', openSettings);
  settingsClose.addEventListener('click', closeSettings);
  settingsSave.addEventListener('click', saveSettings);

  // Settings tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // Provider cards
  document.querySelectorAll('.provider-card').forEach(card => {
    card.addEventListener('click', () => selectProvider(card.dataset.provider));
  });

  // Add custom model
  document.getElementById('add-custom-btn').addEventListener('click', addCustomModel);

  // Domain skills UI
  document.getElementById('add-skill-btn').addEventListener('click', addOrUpdateSkill);
  document.getElementById('add-skill-toggle').addEventListener('click', () => showSkillForm(true));
  document.getElementById('skill-form-close').addEventListener('click', hideSkillForm);
  document.getElementById('skill-form-cancel').addEventListener('click', hideSkillForm);

  // CLI import/logout (Claude Code Plan)
  document.getElementById('import-cli-btn').addEventListener('click', handleImportCLI);
  document.getElementById('cli-logout-btn').addEventListener('click', handleCLILogout);

  // Codex import/logout (Codex Plan)
  document.getElementById('import-codex-btn').addEventListener('click', handleImportCodex);
  document.getElementById('codex-logout-btn').addEventListener('click', handleCodexLogout);

  // Ask before acting toggle
  askToggle.addEventListener('click', () => {
    askBeforeActing = !askBeforeActing;
    askToggle.classList.toggle('active', askBeforeActing);
  });

  // Plan approval
  planApprove.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'PLAN_APPROVAL_RESPONSE', payload: { approved: true } }).catch(() => {});
    planModal.classList.add('hidden');
  });
  planCancel.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'PLAN_APPROVAL_RESPONSE', payload: { approved: false } }).catch(() => {});
    planModal.classList.add('hidden');
  });

  // Stop button
  stopBtn.addEventListener('click', stopTask);

  // Image drag & drop
  inputContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    inputContainer.classList.add('drag-over');
  });

  inputContainer.addEventListener('dragleave', (e) => {
    e.preventDefault();
    inputContainer.classList.remove('drag-over');
  });

  inputContainer.addEventListener('drop', (e) => {
    e.preventDefault();
    inputContainer.classList.remove('drag-over');
    handleImageDrop(e.dataTransfer);
  });

  // Paste image
  inputEl.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (items) {
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) readImageFile(file);
          break;
        }
      }
    }
  });
});

// Listen for messages from service worker
chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'TASK_UPDATE': handleTaskUpdate(message.update); break;
    case 'TASK_COMPLETE': handleTaskComplete(message.result); break;
    case 'TASK_ERROR': handleTaskError(message.error); break;
    case 'PLAN_APPROVAL_REQUIRED': showPlanApproval(message.plan); break;
    case 'SESSION_GROUP_UPDATE':
      // Service worker informs us of tab group changes
      sessionTabGroupId = message.tabGroupId;
      break;
  }
});

// ============================================
// CONFIG
// ============================================

async function loadConfig() {
  const config = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
  providerKeys = config.providerKeys || {};
  customModels = config.customModels || [];
  currentModelIndex = config.currentModelIndex || 0;
  userSkills = config.userSkills || [];
  builtInSkills = config.builtInSkills || [];

  await updateCLIStatus();
  await buildAvailableModels();
  updateModelDisplay();
  renderModelList();
  await updateProviderStatuses();
  renderCustomModelsList();
  renderSkillsList();
}

async function buildAvailableModels() {
  availableModels = [];

  // Check if Claude OAuth is enabled
  const oauthStatus = await chrome.runtime.sendMessage({ type: 'GET_OAUTH_STATUS' });
  const hasOAuth = oauthStatus && oauthStatus.isOAuthEnabled && oauthStatus.isAuthenticated;

  // Check if Codex OAuth is enabled
  const codexStatus = await chrome.runtime.sendMessage({ type: 'GET_CODEX_STATUS' });
  const hasCodexOAuth = codexStatus && codexStatus.isAuthenticated;

  // Add Codex Plan models if connected (ChatGPT Pro plan via Codex CLI)
  if (hasCodexOAuth) {
    const codexModels = [
      { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max' },
      { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
      { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
      { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
      { id: 'gpt-5-codex', name: 'GPT-5 Codex' },
    ];
    for (const model of codexModels) {
      availableModels.push({
        name: `${model.name} (Codex Plan)`,
        provider: 'codex',
        modelId: model.id,
        baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
        apiKey: null,
        authMethod: 'codex_oauth',
      });
    }
  }

  // Add models from configured providers
  for (const [providerId, provider] of Object.entries(PROVIDERS)) {
    const hasApiKey = providerKeys[providerId];

    // Special handling for Anthropic: show separate entries for OAuth and API key
    if (providerId === 'anthropic') {
      // Add OAuth models (Claude Code Plan) if connected
      if (hasOAuth) {
        for (const model of provider.models) {
          availableModels.push({
            name: `${model.name} (Claude Code)`,
            provider: providerId,
            modelId: model.id,
            baseUrl: provider.baseUrl,
            apiKey: null,
            authMethod: 'oauth',
          });
        }
      }

      // Add API key models if configured
      if (hasApiKey) {
        for (const model of provider.models) {
          availableModels.push({
            name: `${model.name} (API)`,
            provider: providerId,
            modelId: model.id,
            baseUrl: provider.baseUrl,
            apiKey: providerKeys[providerId],
            authMethod: 'apikey',
          });
        }
      }
    } else if (providerId === 'openai') {
      // OpenAI: label as API to distinguish from Codex Plan
      if (hasApiKey) {
        for (const model of provider.models) {
          availableModels.push({
            name: `${model.name} (API)`,
            provider: providerId,
            modelId: model.id,
            baseUrl: provider.baseUrl,
            apiKey: providerKeys[providerId],
          });
        }
      }
    } else {
      // Other providers (Google, OpenRouter): just check for API key
      if (hasApiKey) {
        for (const model of provider.models) {
          availableModels.push({
            name: model.name,
            provider: providerId,
            modelId: model.id,
            baseUrl: provider.baseUrl,
            apiKey: providerKeys[providerId],
          });
        }
      }
    }
  }

  // Add custom models
  for (const custom of customModels) {
    availableModels.push({
      name: custom.name,
      provider: 'custom',
      modelId: custom.modelId,
      baseUrl: custom.baseUrl,
      apiKey: custom.apiKey,
    });
  }

  // Ensure index is valid
  if (currentModelIndex >= availableModels.length) {
    currentModelIndex = 0;
  }
}

async function saveConfig() {
  const currentModel = availableModels[currentModelIndex];
  await chrome.runtime.sendMessage({
    type: 'SAVE_CONFIG',
    payload: {
      providerKeys,
      customModels,
      currentModelIndex,
      userSkills,
      // Also set the active model config for the service worker
      ...(currentModel ? {
        model: currentModel.modelId,
        apiBaseUrl: currentModel.baseUrl,
        apiKey: currentModel.apiKey,
        authMethod: currentModel.authMethod || null,
      } : {}),
    },
  });
}

// ============================================
// MODEL SELECTOR
// ============================================

function toggleModelDropdown() {
  if (modelDropdown.classList.contains('hidden')) {
    modelDropdown.classList.remove('hidden');
    modelSelector.classList.add('open');
  } else {
    closeModelDropdown();
  }
}

function closeModelDropdown() {
  modelDropdown.classList.add('hidden');
  modelSelector.classList.remove('open');
}

function updateModelDisplay() {
  if (availableModels.length === 0) {
    currentModelNameEl.textContent = 'No models';
    return;
  }
  currentModelNameEl.textContent = availableModels[currentModelIndex]?.name || 'Select model';
}

function renderModelList() {
  if (availableModels.length === 0) {
    modelList.innerHTML = `
      <div style="padding: 12px 14px; color: var(--text-muted); font-size: 13px;">
        No models configured.<br>Open Settings to add.
      </div>
    `;
    return;
  }

  modelList.innerHTML = availableModels.map((model, i) => `
    <div class="model-item ${i === currentModelIndex ? 'active' : ''}" data-index="${i}">
      <svg class="check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      <span>${model.name}</span>
    </div>
  `).join('');

  modelList.querySelectorAll('.model-item').forEach(item => {
    item.addEventListener('click', () => {
      currentModelIndex = parseInt(item.dataset.index);
      updateModelDisplay();
      renderModelList();
      closeModelDropdown();
      saveConfig();
    });
  });
}

// ============================================
// SETTINGS
// ============================================

async function openSettings() {
  settingsModal.classList.remove('hidden');
  selectedProvider = null;
  document.getElementById('provider-config').style.display = 'none';
  document.querySelectorAll('.provider-card').forEach(c => c.classList.remove('active'));
  renderCustomModelsList();
  renderSkillsList();
  hideSkillForm(); // Hide and reset skill form when opening
  await updateCLIStatus(); // Check OAuth login status
}

function closeSettings() {
  settingsModal.classList.add('hidden');
}

function selectProvider(providerId) {
  selectedProvider = providerId;
  document.querySelectorAll('.provider-card').forEach(c => {
    c.classList.toggle('active', c.dataset.provider === providerId);
  });

  const configEl = document.getElementById('provider-config');
  const apiKeyInput = document.getElementById('provider-api-key');
  apiKeyInput.value = providerKeys[providerId] || '';
  configEl.style.display = 'block';
  apiKeyInput.focus();
}

async function updateProviderStatuses() {
  // Check OAuth status
  const oauthStatus = await chrome.runtime.sendMessage({ type: 'GET_OAUTH_STATUS' });
  const hasOAuth = oauthStatus && oauthStatus.isOAuthEnabled && oauthStatus.isAuthenticated;

  for (const providerId of Object.keys(PROVIDERS)) {
    const statusEl = document.getElementById(`${providerId}-status`);

    // For Anthropic, show OAuth status
    if (providerId === 'anthropic' && hasOAuth) {
      statusEl.textContent = 'OAuth Active';
      statusEl.classList.add('configured');
    } else if (providerKeys[providerId]) {
      statusEl.textContent = 'Configured';
      statusEl.classList.add('configured');
    } else {
      statusEl.textContent = 'Not configured';
      statusEl.classList.remove('configured');
    }
  }
}

async function saveSettings() {
  // Save provider key if one is selected
  if (selectedProvider) {
    const apiKey = document.getElementById('provider-api-key').value.trim();
    if (apiKey) {
      providerKeys[selectedProvider] = apiKey;
    } else {
      delete providerKeys[selectedProvider];
    }
  }

  await buildAvailableModels();
  updateModelDisplay();
  renderModelList();
  await updateProviderStatuses();
  await saveConfig();
  closeSettings();
}

// CLI import handlers
async function handleImportCLI() {
  const btn = document.getElementById('import-cli-btn');
  const statusEl = document.getElementById('cli-status');

  btn.disabled = true;
  document.getElementById('import-cli-btn-text').textContent = 'Connecting...';

  try {
    const response = await chrome.runtime.sendMessage({ type: 'IMPORT_CLI_CREDENTIALS' });

    if (response.success) {
      // Update UI
      btn.style.display = 'none';
      document.getElementById('cli-logout-btn').style.display = 'block';
      document.getElementById('cli-status-badge').style.display = 'inline';

      await buildAvailableModels();
      updateModelDisplay();
      renderModelList();
    } else {
      throw new Error(response.error || 'Import failed');
    }
  } catch (error) {
    statusEl.textContent = error.message;
    statusEl.style.display = 'block';
    statusEl.style.color = '#ff6b6b';
    btn.disabled = false;
    document.getElementById('import-cli-btn-text').textContent = 'Connect';
  }
}

async function handleCLILogout() {
  try {
    await chrome.runtime.sendMessage({ type: 'OAUTH_LOGOUT' });

    document.getElementById('import-cli-btn').style.display = 'block';
    document.getElementById('import-cli-btn').disabled = false;
    document.getElementById('import-cli-btn-text').textContent = 'Connect';
    document.getElementById('cli-logout-btn').style.display = 'none';
    document.getElementById('cli-status-badge').style.display = 'none';
    document.getElementById('cli-status').style.display = 'none';

    await buildAvailableModels();
    updateModelDisplay();
    renderModelList();
    await updateProviderStatuses();
  } catch (error) {
    const statusEl = document.getElementById('cli-status');
    statusEl.textContent = error.message;
    statusEl.style.color = '#ff6b6b';
  }
}

async function updateCLIStatus() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_OAUTH_STATUS' });

  if (response && response.isAuthenticated) {
    document.getElementById('import-cli-btn').style.display = 'none';
    document.getElementById('cli-logout-btn').style.display = 'block';
    document.getElementById('cli-status-badge').style.display = 'inline';
    document.getElementById('cli-status').style.display = 'none';
  } else {
    document.getElementById('import-cli-btn').style.display = 'block';
    document.getElementById('cli-logout-btn').style.display = 'none';
    document.getElementById('cli-status-badge').style.display = 'none';
    document.getElementById('cli-status').style.display = 'none';
  }

  // Update Codex status too
  await updateCodexStatus();
}

// Codex import handlers
async function handleImportCodex() {
  const btn = document.getElementById('import-codex-btn');
  const statusEl = document.getElementById('codex-status');

  btn.disabled = true;
  document.getElementById('import-codex-btn-text').textContent = 'Connecting...';

  try {
    const response = await chrome.runtime.sendMessage({ type: 'IMPORT_CODEX_CREDENTIALS' });

    if (!response) {
      throw new Error('No response from service worker');
    }

    if (response.success) {
      // Update UI
      btn.style.display = 'none';
      document.getElementById('codex-logout-btn').style.display = 'block';
      document.getElementById('codex-status-badge').style.display = 'inline';
      statusEl.style.display = 'none';

      await buildAvailableModels();
      updateModelDisplay();
      renderModelList();
    } else {
      throw new Error(response.error || 'Import failed');
    }
  } catch (error) {
    statusEl.textContent = error.message;
    statusEl.style.display = 'block';
    statusEl.style.color = '#ff6b6b';
    btn.disabled = false;
    document.getElementById('import-codex-btn-text').textContent = 'Connect';
  }
}

async function handleCodexLogout() {
  try {
    await chrome.runtime.sendMessage({ type: 'CODEX_LOGOUT' });

    document.getElementById('import-codex-btn').style.display = 'block';
    document.getElementById('import-codex-btn').disabled = false;
    document.getElementById('import-codex-btn-text').textContent = 'Connect';
    document.getElementById('codex-logout-btn').style.display = 'none';
    document.getElementById('codex-status-badge').style.display = 'none';
    document.getElementById('codex-status').style.display = 'none';

    await buildAvailableModels();
    updateModelDisplay();
    renderModelList();
  } catch (error) {
    const statusEl = document.getElementById('codex-status');
    statusEl.textContent = error.message;
    statusEl.style.color = '#ff6b6b';
  }
}

async function updateCodexStatus() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_CODEX_STATUS' });

  if (response && response.isAuthenticated) {
    document.getElementById('import-codex-btn').style.display = 'none';
    document.getElementById('codex-logout-btn').style.display = 'block';
    document.getElementById('codex-status-badge').style.display = 'inline';
    document.getElementById('codex-status').style.display = 'none';
  } else {
    document.getElementById('import-codex-btn').style.display = 'block';
    document.getElementById('codex-logout-btn').style.display = 'none';
    document.getElementById('codex-status-badge').style.display = 'none';
    document.getElementById('codex-status').style.display = 'none';
  }
}

async function addCustomModel() {
  const name = document.getElementById('custom-display-name').value.trim();
  const baseUrl = document.getElementById('custom-base-url').value.trim();
  const modelId = document.getElementById('custom-model-id').value.trim();
  const apiKey = document.getElementById('custom-api-key').value.trim();

  if (!name || !baseUrl || !modelId) {
    alert('Please fill in Display Name, Base URL, and Model ID');
    return;
  }

  customModels.push({ name, baseUrl, modelId, apiKey });

  // Clear form
  document.getElementById('custom-display-name').value = '';
  document.getElementById('custom-base-url').value = '';
  document.getElementById('custom-model-id').value = '';
  document.getElementById('custom-api-key').value = '';

  await buildAvailableModels();
  updateModelDisplay();
  renderModelList();
  renderCustomModelsList();
  await saveConfig();

  // Switch to the new model
  currentModelIndex = availableModels.length - 1;
  updateModelDisplay();
  renderModelList();
  await saveConfig();
}

function renderCustomModelsList() {
  const listEl = document.getElementById('custom-models-list');
  if (!listEl) return;

  if (customModels.length === 0) {
    listEl.innerHTML = '<div style="color: var(--text-muted); font-size: 13px; margin-bottom: 12px;">No custom models added yet.</div>';
    return;
  }

  listEl.innerHTML = customModels.map((model, i) => `
    <div class="custom-model-item" data-index="${i}">
      <div class="model-info">
        <div class="model-name">${model.name}</div>
        <div class="model-url">${model.baseUrl}</div>
      </div>
      <button class="delete-btn" data-index="${i}" title="Delete">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
        </svg>
      </button>
    </div>
  `).join('');

  // Attach delete handlers
  listEl.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const index = parseInt(btn.dataset.index);
      const modelName = customModels[index].name;
      if (confirm(`Delete "${modelName}"?`)) {
        customModels.splice(index, 1);
        await buildAvailableModels();
        updateModelDisplay();
        renderModelList();
        renderCustomModelsList();
        await saveConfig();
      }
    });
  });
}

// ============================================
// DOMAIN SKILLS
// ============================================

function renderSkillsList() {
  const listEl = document.getElementById('skills-list');
  if (!listEl) return;

  // Combine built-in and user skills for display
  const allSkills = [];

  // Add built-in skills first (with flag)
  for (const skill of builtInSkills) {
    allSkills.push({ ...skill, isBuiltIn: true });
  }

  // Add user skills (may override built-in)
  for (const skill of userSkills) {
    // Check if this overrides a built-in skill
    const builtInIndex = allSkills.findIndex(s => s.domain === skill.domain && s.isBuiltIn);
    if (builtInIndex >= 0) {
      // Replace built-in with user version
      allSkills[builtInIndex] = { ...skill, isBuiltIn: false, overridesBuiltIn: true };
    } else {
      allSkills.push({ ...skill, isBuiltIn: false });
    }
  }

  if (allSkills.length === 0) {
    listEl.innerHTML = '<div class="empty-skills">No domain skills yet.<br>Click + to add one.</div>';
    return;
  }

  listEl.innerHTML = allSkills.map((skill) => {
    const preview = skill.skill.substring(0, 80).replace(/\n/g, ' ') + (skill.skill.length > 80 ? '...' : '');
    const icon = skill.isBuiltIn ? '📦' : '✏️';
    const userIndex = userSkills.findIndex(s => s.domain === skill.domain);

    return `
      <div class="skill-item" data-domain="${skill.domain}" data-is-builtin="${skill.isBuiltIn}" data-user-index="${userIndex}">
        <span class="skill-icon">${icon}</span>
        <div class="skill-info">
          <div class="skill-domain">
            ${skill.domain}
            ${skill.isBuiltIn ? '<span class="builtin-badge">Built-in</span>' : ''}
            ${skill.overridesBuiltIn ? '<span class="builtin-badge">Custom</span>' : ''}
          </div>
          <div class="skill-preview">${preview}</div>
        </div>
        <div class="skill-actions">
          <button class="edit-btn" title="Edit">Edit</button>
          ${!skill.isBuiltIn ? `<button class="delete-btn" title="Delete">×</button>` : ''}
        </div>
      </div>
    `;
  }).join('');

  // Attach event handlers - click anywhere on item to edit
  listEl.querySelectorAll('.skill-item').forEach(item => {
    const editBtn = item.querySelector('.edit-btn');
    const deleteBtn = item.querySelector('.delete-btn');

    const handleEdit = (e) => {
      e.stopPropagation();
      const domain = item.dataset.domain;
      const isBuiltIn = item.dataset.isBuiltin === 'true';
      const userIndex = parseInt(item.dataset.userIndex);

      if (isBuiltIn) {
        // Edit built-in: pre-fill with built-in content, will create user override
        const builtIn = builtInSkills.find(s => s.domain === domain);
        if (builtIn) {
          editingSkillIndex = -1; // New skill (override)
          document.getElementById('skill-domain').value = builtIn.domain;
          document.getElementById('skill-content').value = builtIn.skill;
          document.getElementById('skill-form-title').textContent = 'Customize Built-in Skill';
          document.getElementById('add-skill-btn').textContent = 'Save Override';
          showSkillForm();
        }
      } else {
        // Edit user skill
        editingSkillIndex = userIndex;
        const skill = userSkills[userIndex];
        document.getElementById('skill-domain').value = skill.domain;
        document.getElementById('skill-content').value = skill.skill;
        document.getElementById('skill-form-title').textContent = 'Edit Skill';
        document.getElementById('add-skill-btn').textContent = 'Save Changes';
        showSkillForm();
      }
    };

    editBtn.addEventListener('click', handleEdit);

    if (deleteBtn) {
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const userIndex = parseInt(item.dataset.userIndex);
        if (confirm(`Delete skill for "${userSkills[userIndex].domain}"?`)) {
          userSkills.splice(userIndex, 1);
          renderSkillsList();
          await saveConfig();
        }
      });
    }
  });
}

function showSkillForm(isNew = false) {
  if (isNew) {
    editingSkillIndex = -1;
    document.getElementById('skill-domain').value = '';
    document.getElementById('skill-content').value = '';
    document.getElementById('skill-form-title').textContent = 'Add New Skill';
    document.getElementById('add-skill-btn').textContent = 'Save Skill';
  }
  document.getElementById('skill-form').classList.remove('hidden');
}

function hideSkillForm() {
  document.getElementById('skill-form').classList.add('hidden');
  cancelSkillEdit();
}

async function addOrUpdateSkill() {
  const domain = document.getElementById('skill-domain').value.trim().toLowerCase();
  const skill = document.getElementById('skill-content').value.trim();

  if (!domain || !skill) {
    alert('Please fill in both domain and tips/guidance');
    return;
  }

  if (editingSkillIndex >= 0) {
    // Update existing
    userSkills[editingSkillIndex] = { domain, skill };
  } else {
    // Check for duplicate user skill
    const existingIndex = userSkills.findIndex(s => s.domain === domain);
    if (existingIndex >= 0) {
      userSkills[existingIndex] = { domain, skill };
    } else {
      userSkills.push({ domain, skill });
    }
  }

  hideSkillForm();
  renderSkillsList();
  await saveConfig();
}

function cancelSkillEdit() {
  editingSkillIndex = -1;
  document.getElementById('skill-domain').value = '';
  document.getElementById('skill-content').value = '';
  document.getElementById('skill-form-title').textContent = 'Add New Skill';
  document.getElementById('add-skill-btn').textContent = 'Save Skill';
}

// ============================================
// MESSAGES
// ============================================

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || isRunning) return;

  if (availableModels.length === 0) {
    alert('Please configure a model in Settings first');
    return;
  }

  // Hide empty state (get fresh reference in case it was recreated)
  const emptyState = document.getElementById('empty-state');
  if (emptyState) emptyState.style.display = 'none';
  completedSteps = [];
  stepsSection = null;

  // Capture images before clearing
  const imagesToSend = [...attachedImages];

  addUserMessage(text, imagesToSend);
  inputEl.value = '';
  inputEl.style.height = 'auto';
  clearAttachedImages();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    addErrorMessage('No active tab found');
    return;
  }

  isRunning = true;
  sendBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');

  try {
    await chrome.runtime.sendMessage({
      type: 'START_TASK',
      payload: {
        tabId: tab.id,
        task: text,
        askBeforeActing,
        images: imagesToSend,
        tabGroupId: sessionTabGroupId, // Send current tab group ID (or null)
      },
    });
  } catch (error) {
    addErrorMessage(`Error: ${error.message}`);
    resetRunningState();
  }
}

function stopTask() {
  chrome.runtime.sendMessage({ type: 'STOP_TASK' }).catch(() => {});
  // Message will be shown by handleTaskComplete when service worker responds
  resetRunningState();
}

function resetRunningState() {
  isRunning = false;
  sendBtn.classList.remove('hidden');
  stopBtn.classList.add('hidden');
}

// ============================================
// IMAGE HANDLING
// ============================================

function handleImageDrop(dataTransfer) {
  const files = dataTransfer.files;
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      readImageFile(file);
    }
  }
}

function readImageFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    attachedImages.push(e.target.result);
    renderImagePreviews();
  };
  reader.readAsDataURL(file);
}

function removeAttachedImage(index) {
  attachedImages.splice(index, 1);
  renderImagePreviews();
}

function clearAttachedImages() {
  attachedImages = [];
  renderImagePreviews();
}

function renderImagePreviews() {
  if (attachedImages.length === 0) {
    imagePreview.classList.add('hidden');
    imagePreview.innerHTML = '';
    return;
  }

  imagePreview.classList.remove('hidden');
  imagePreview.innerHTML = attachedImages.map((img, i) => `
    <div class="image-preview-item" data-index="${i}">
      <img src="${img}" alt="Preview ${i + 1}">
      <button class="remove-image-btn" data-index="${i}">&times;</button>
    </div>
  `).join('');

  // Attach remove handlers
  imagePreview.querySelectorAll('.remove-image-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeAttachedImage(parseInt(btn.dataset.index));
    });
  });
}

function addUserMessage(text, images = []) {
  const el = document.createElement('div');
  el.className = 'message user';

  if (images.length > 0) {
    const imagesContainer = document.createElement('div');
    imagesContainer.style.display = 'flex';
    imagesContainer.style.flexWrap = 'wrap';
    imagesContainer.style.gap = '8px';
    imagesContainer.style.marginBottom = '8px';

    for (const imgSrc of images) {
      const img = document.createElement('img');
      img.src = imgSrc;
      img.style.maxWidth = '150px';
      img.style.maxHeight = '100px';
      img.style.borderRadius = '8px';
      img.style.objectFit = 'cover';
      imagesContainer.appendChild(img);
    }
    el.appendChild(imagesContainer);
  }

  if (text) {
    const textEl = document.createElement('span');
    textEl.textContent = text;
    el.appendChild(textEl);
  }

  messagesEl.appendChild(el);
  scrollToBottom();
}

function addAssistantMessage(text) {
  const el = document.createElement('div');
  el.className = 'message assistant';
  el.innerHTML = `<div class="bullet"></div><div class="content">${formatMarkdown(text)}</div>`;
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function addErrorMessage(text) {
  const el = document.createElement('div');
  el.className = 'message error';
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function addSystemMessage(text) {
  const el = document.createElement('div');
  el.className = 'message system';
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

// eslint-disable-next-line sonarjs/cognitive-complexity
function formatMarkdown(text) {
  const lines = text.split('\n');
  let result = [];
  let inList = false;
  let listType = null;

  for (const line of lines) {
    const ulMatch = line.match(/^[-*]\s+(.+)$/);
    const olMatch = line.match(/^(\d+)\.\s+(.+)$/);

    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        if (inList) result.push(listType === 'ol' ? '</ol>' : '</ul>');
        result.push('<ul>');
        inList = true;
        listType = 'ul';
      }
      result.push(`<li>${formatInline(ulMatch[1])}</li>`);
    } else if (olMatch) {
      if (!inList || listType !== 'ol') {
        if (inList) result.push(listType === 'ol' ? '</ol>' : '</ul>');
        result.push('<ol>');
        inList = true;
        listType = 'ol';
      }
      result.push(`<li>${formatInline(olMatch[2])}</li>`);
    } else {
      if (inList) {
        result.push(listType === 'ol' ? '</ol>' : '</ul>');
        inList = false;
        listType = null;
      }
      if (line.trim() === '') {
        result.push('<br>');
      } else {
        result.push(`<p>${formatInline(line)}</p>`);
      }
    }
  }
  if (inList) result.push(listType === 'ol' ? '</ol>' : '</ul>');
  return result.join('');
}

function formatInline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

// ============================================
// TASK UPDATES
// ============================================

function handleTaskUpdate(update) {
  if (update.status === 'thinking') {
    showThinkingIndicator();
    if (currentStreamingMessage) {
      currentStreamingMessage.classList.remove('streaming');
      currentStreamingMessage = null;
    }
  } else if (update.status === 'streaming' && update.text) {
    hideToolIndicator();
    if (!currentStreamingMessage) {
      currentStreamingMessage = addAssistantMessage(update.text);
      currentStreamingMessage.classList.add('streaming');
    } else {
      currentStreamingMessage.querySelector('.content').innerHTML = formatMarkdown(update.text);
    }
    scrollToBottom();
  } else if (update.status === 'executing') {
    if (currentStreamingMessage) {
      currentStreamingMessage.classList.remove('streaming');
      currentStreamingMessage = null;
    }
    // Store pending step with input for rich display
    pendingStep = { tool: update.tool, input: update.input };
    const actionDesc = getActionDescription(update.tool, update.input);
    showToolIndicator(actionDesc, update.tool);
  } else if (update.status === 'executed') {
    hideToolIndicator();
    // Complete the step with result (use update.input as fallback if pendingStep is null)
    addCompletedStep(update.tool, pendingStep?.input || update.input, update.result);
    pendingStep = null;
  } else if (update.status === 'message' && update.text) {
    hideToolIndicator();
    if (currentStreamingMessage) {
      currentStreamingMessage.querySelector('.content').innerHTML = formatMarkdown(update.text);
      currentStreamingMessage.classList.remove('streaming');
      currentStreamingMessage = null;
    } else {
      addAssistantMessage(update.text);
    }
  }
}

function handleTaskComplete(result) {
  hideToolIndicator();
  if (currentStreamingMessage) {
    currentStreamingMessage.classList.remove('streaming');
    currentStreamingMessage = null;
  }
  resetRunningState();
  if (result.message && !result.success) {
    addSystemMessage(result.message);
  }
}

function handleTaskError(error) {
  hideToolIndicator();
  if (currentStreamingMessage) {
    currentStreamingMessage.classList.remove('streaming');
    currentStreamingMessage = null;
  }
  resetRunningState();
  addErrorMessage(`Error: ${error}`);
}

function showToolIndicator(label, toolName = null) {
  hideToolIndicator();
  const el = document.createElement('div');
  el.className = 'tool-indicator';

  // Use tool-specific icon or generic spinner
  const icon = toolName ? getToolIcon(toolName) :
    '<svg class="sparkle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';

  el.innerHTML = `
    <div class="indicator-icon">${icon}</div>
    <span>${label}</span>
  `;
  messagesEl.appendChild(el);
  currentToolIndicator = el;
  scrollToBottom();
}

function hideToolIndicator() {
  if (currentToolIndicator) {
    currentToolIndicator.remove();
    currentToolIndicator = null;
  }
}

function showThinkingIndicator() {
  hideToolIndicator();
  const el = document.createElement('div');
  el.className = 'tool-indicator';
  el.innerHTML = `
    <div class="indicator-icon">
      <svg class="sparkle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <path d="M12 6v6l4 2"/>
      </svg>
    </div>
    <span>Thinking<span class="thinking-dots"><span></span><span></span><span></span></span></span>
  `;
  messagesEl.appendChild(el);
  currentToolIndicator = el;
  scrollToBottom();
}

// Tool metadata: labels and icons
const TOOL_META = {
  read_page: {
    label: 'Reading page',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
  },
  find: {
    label: 'Finding elements',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>'
  },
  form_input: {
    label: 'Filling form',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'
  },
  computer: {
    label: 'Interacting',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>'
  },
  navigate: {
    label: 'Navigating',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>'
  },
  get_page_text: {
    label: 'Extracting text',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>'
  },
  update_plan: {
    label: 'Planning',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>'
  },
  tabs_create: {
    label: 'Creating tab',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>'
  },
  tabs_context: {
    label: 'Getting tabs',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'
  },
  javascript_tool: {
    label: 'Running script',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>'
  },
  upload_image: {
    label: 'Uploading image',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>'
  },
};

function getToolLabel(toolName) {
  return TOOL_META[toolName]?.label || toolName.replace(/_/g, ' ');
}

function getToolIcon(toolName) {
  return TOOL_META[toolName]?.icon || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';
}

/**
 * Generate human-readable action description from tool input
 */
function getActionDescription(toolName, input) {
  if (!input) return getToolLabel(toolName);

  switch (toolName) {
    case 'computer': {
      const action = input.action;
      if (action === 'click' || action === 'left_click') {
        if (input.ref) return `Clicking element ref_${input.ref}`;
        if (input.coordinate) return `Clicking at (${input.coordinate[0]}, ${input.coordinate[1]})`;
        return 'Clicking';
      }
      if (action === 'type') {
        const text = input.text?.substring(0, 30) || '';
        return `Typing "${text}${input.text?.length > 30 ? '...' : ''}"`;
      }
      if (action === 'key') return `Pressing ${input.key}`;
      if (action === 'scroll') return `Scrolling ${input.direction || 'down'}`;
      if (action === 'screenshot') return 'Taking screenshot';
      if (action === 'drag') return 'Dragging element';
      return `${action || 'Interacting'}`;
    }
    case 'form_input': {
      const value = input.value?.substring(0, 25) || '';
      if (input.ref) return `Filling ref_${input.ref} with "${value}${input.value?.length > 25 ? '...' : ''}"`;
      return `Filling form field`;
    }
    case 'navigate': {
      try {
        const url = new URL(input.url);
        return `Navigating to ${url.hostname}`;
      } catch {
        return `Navigating to ${input.url?.substring(0, 30) || 'URL'}`;
      }
    }
    case 'find': {
      const query = input.query?.substring(0, 30) || '';
      return `Finding "${query}${input.query?.length > 30 ? '...' : ''}"`;
    }
    case 'read_page':
      return input.filter === 'interactive' ? 'Reading interactive elements' : 'Reading full page';
    case 'get_page_text':
      return 'Extracting page text';
    case 'tabs_create':
      return `Opening new tab`;
    case 'tabs_context':
      return 'Getting tab info';
    case 'javascript_tool':
      return 'Running JavaScript';
    case 'update_plan':
      return 'Updating plan';
    default:
      return getToolLabel(toolName);
  }
}

/**
 * Format step result for display
 */
function formatStepResult(result) {
  if (!result || result === 'done') return null;
  if (typeof result !== 'string') return null;
  // Truncate long results
  if (result.length > 100) return result.substring(0, 100) + '...';
  return result;
}

function addCompletedStep(toolName, input = null, result = null) {
  const description = getActionDescription(toolName, input);
  const step = { tool: toolName, input, result, description };
  completedSteps.push(step);

  // Incremental update: just append the new step
  appendStepElement(step);
  updateStepCount();
}

function createStepsSection() {
  stepsSection = document.createElement('div');
  stepsSection.className = 'steps-section';
  stepsSection.innerHTML = `
    <div class="steps-toggle">
      <div class="toggle-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
      </div>
      <span class="toggle-text">0 steps completed</span>
      <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
    </div>
    <div class="steps-list"></div>
  `;

  // Toggle expand/collapse
  // IMPORTANT: Capture local references to avoid closure bug when multiple steps sections exist
  const thisSection = stepsSection;
  thisSection.querySelector('.steps-toggle').addEventListener('click', () => {
    const toggle = thisSection.querySelector('.steps-toggle');
    const list = thisSection.querySelector('.steps-list');
    toggle.classList.toggle('expanded');
    list.classList.toggle('visible');
  });

  messagesEl.appendChild(stepsSection);
}

function appendStepElement(step) {
  // Create steps section if it doesn't exist
  if (!stepsSection) {
    createStepsSection();
  }

  const list = stepsSection.querySelector('.steps-list');
  const stepEl = createStepElement(step);
  list.appendChild(stepEl);

  // Only auto-scroll if user is already near bottom
  if (isScrolledToBottom()) {
    scrollToBottom();
  }
}

function createStepElement(step) {
  const div = document.createElement('div');
  div.className = 'step-item';

  const resultText = formatStepResult(step.result);
  div.innerHTML = `
    <div class="step-icon success">${getToolIcon(step.tool)}</div>
    <div class="step-content">
      <div class="step-label">${escapeHtml(step.description)}</div>
      ${resultText ? `<div class="step-result">${escapeHtml(resultText)}</div>` : ''}
    </div>
    <div class="step-status">✓</div>
  `;

  return div;
}

function updateStepCount() {
  if (!stepsSection) return;

  const toggle = stepsSection.querySelector('.toggle-text');
  const count = completedSteps.length;
  toggle.textContent = `${count} step${count !== 1 ? 's' : ''} completed`;
}

function isScrolledToBottom() {
  const threshold = 50; // px from bottom
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showPlanApproval(plan) {
  planDomains.innerHTML = plan.domains.map(d => `<span style="padding:4px 10px;background:var(--bg-tertiary);border-radius:12px;font-size:12px;">${d}</span>`).join('');
  planSteps.innerHTML = plan.approach.map(s => `<li style="margin:6px 0;">${s}</li>`).join('');
  planModal.classList.remove('hidden');
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function clearChat() {
  messagesEl.innerHTML = '';
  const emptyState = document.createElement('div');
  emptyState.className = 'empty-state';
  emptyState.id = 'empty-state';
  emptyState.innerHTML = `<h2>What can I help with?</h2><p>I can browse the web, fill forms, click buttons, and automate tasks in your browser.</p>`;
  messagesEl.appendChild(emptyState);
  completedSteps = [];
  pendingStep = null;
  stepsSection = null;
  currentStreamingMessage = null;
  currentToolIndicator = null;
  isRunning = false;
  sendBtn.disabled = false;
  sessionTabGroupId = null; // Reset tab group on new chat
  chrome.runtime.sendMessage({ type: 'CLEAR_CONVERSATION' }).catch(() => {});
}
