import { d, A, y, q, u, P as PROVIDERS, C as CODEX_MODELS, G } from "./providers.js";
const agentDemoVideo = "" + new URL("cli-use-case.webm", import.meta.url).href;
const sidepanelDemoVideo = "" + new URL("sidepanel-use-case.mp4", import.meta.url).href;
const STEPS = {
  WELCOME: "welcome",
  SETUP: "setup",
  CONNECT: "connect",
  DONE: "done"
};
const SIDEPANEL_MODEL_PREFERENCES = [
  { provider: "anthropic", authMethod: "oauth", modelId: "claude-sonnet-4-20250514" },
  { provider: "anthropic", authMethod: "api_key", modelId: "claude-sonnet-4-20250514" },
  { provider: "codex", authMethod: "codex_oauth", modelId: "gpt-5.1-codex-max" },
  { provider: "openai", authMethod: "api_key", modelId: "gpt-4o" },
  { provider: "google", authMethod: "api_key", modelId: "gemini-2.5-flash" },
  { provider: "openrouter", authMethod: "api_key", modelId: "qwen/qwen3-vl-235b-a22b-thinking" }
];
const AGENT_MODEL_PREFERENCES = [
  { provider: "anthropic", authMethod: "oauth", modelId: "claude-haiku-4-5-20251001" },
  { provider: "anthropic", authMethod: "api_key", modelId: "claude-haiku-4-5-20251001" },
  { provider: "codex", authMethod: "codex_oauth", modelId: "gpt-5.1-codex-mini" },
  { provider: "openai", authMethod: "api_key", modelId: "gpt-5-mini" },
  { provider: "google", authMethod: "api_key", modelId: "gemini-2.5-flash" },
  { provider: "openrouter", authMethod: "api_key", modelId: "moonshotai/kimi-k2.5" }
];
function buildAvailableModels(providerKeys = {}, customModels = [], oauth = {}, codex = {}) {
  const models = [];
  const hasOAuth = (oauth == null ? void 0 : oauth.isOAuthEnabled) && (oauth == null ? void 0 : oauth.isAuthenticated);
  const hasCodexOAuth = codex == null ? void 0 : codex.isAuthenticated;
  if (hasCodexOAuth) {
    for (const model of CODEX_MODELS) {
      models.push({
        name: `${model.name} (codex plan)`,
        provider: "codex",
        modelId: model.id,
        baseUrl: "https://chatgpt.com/backend-api/codex/responses",
        apiKey: null,
        authMethod: "codex_oauth"
      });
    }
  }
  for (const [providerId, provider] of Object.entries(PROVIDERS)) {
    const hasApiKey = providerKeys[providerId];
    if (providerId === "anthropic") {
      if (hasOAuth) {
        for (const model of provider.models) {
          models.push({
            name: `${model.name} (claude code)`,
            provider: providerId,
            modelId: model.id,
            baseUrl: provider.baseUrl,
            apiKey: null,
            authMethod: "oauth"
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
            authMethod: "api_key"
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
          authMethod: "api_key"
        });
      }
    }
  }
  for (const customModel of customModels) {
    models.push({
      name: customModel.name,
      provider: "openai",
      modelId: customModel.modelId,
      baseUrl: customModel.baseUrl,
      apiKey: customModel.apiKey,
      authMethod: "api_key"
    });
  }
  return models;
}
function buildConnectedSources(config = {}, oauth = {}, codex = {}) {
  var _a;
  const sources = /* @__PURE__ */ new Set();
  if ((oauth == null ? void 0 : oauth.isOAuthEnabled) && (oauth == null ? void 0 : oauth.isAuthenticated)) {
    sources.add("claude");
  }
  if (codex == null ? void 0 : codex.isAuthenticated) {
    sources.add("codex");
  }
  for (const providerId of Object.keys(config.providerKeys || {})) {
    if ((_a = config.providerKeys) == null ? void 0 : _a[providerId]) {
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
    authMethod: model.authMethod
  };
}
function findModelIndex(models, selection) {
  if (!(selection == null ? void 0 : selection.model) || !(selection == null ? void 0 : selection.apiBaseUrl)) {
    return -1;
  }
  return models.findIndex(
    (model) => model.provider === selection.provider && model.modelId === selection.model && model.baseUrl === selection.apiBaseUrl && model.authMethod === selection.authMethod
  );
}
function findPreferredModelIndex(models, preferences) {
  for (const preference of preferences) {
    const index = models.findIndex(
      (model) => model.provider === preference.provider && model.authMethod === preference.authMethod && model.modelId === preference.modelId
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
    authMethod: config.authMethod
  };
  const sideIndex = findModelIndex(models, preservedSideConfig) >= 0 ? findModelIndex(models, preservedSideConfig) : findModelIndex(models, currentSideConfig) >= 0 ? findModelIndex(models, currentSideConfig) : findPreferredModelIndex(models, SIDEPANEL_MODEL_PREFERENCES);
  const agentIndex = findModelIndex(models, preservedAgentConfig) >= 0 ? findModelIndex(models, preservedAgentConfig) : findModelIndex(models, config.agentDefaultConfig) >= 0 ? findModelIndex(models, config.agentDefaultConfig) : findPreferredModelIndex(models, AGENT_MODEL_PREFERENCES);
  return {
    sideIndex,
    agentIndex
  };
}
function OnboardingApp() {
  const [step, setStep] = d(STEPS.WELCOME);
  const [connecting, setConnecting] = d(false);
  const [connectError, setConnectError] = d("");
  const [connectedSources, setConnectedSources] = d(/* @__PURE__ */ new Set());
  const [availableModels, setAvailableModels] = d([]);
  const [sidepanelDefaultIndex, setSidepanelDefaultIndex] = d(-1);
  const [agentDefaultIndex, setAgentDefaultIndex] = d(-1);
  const [selectedApiProvider, setSelectedApiProvider] = d(null);
  const [apiKey, setApiKey] = d("");
  const [customModel, setCustomModel] = d({ name: "", baseUrl: "", modelId: "", apiKey: "" });
  const availableModelsRef = A([]);
  const sidepanelDefaultIndexRef = A(-1);
  const agentDefaultIndexRef = A(-1);
  y(() => {
    availableModelsRef.current = availableModels;
  }, [availableModels]);
  y(() => {
    sidepanelDefaultIndexRef.current = sidepanelDefaultIndex;
  }, [sidepanelDefaultIndex]);
  y(() => {
    agentDefaultIndexRef.current = agentDefaultIndex;
  }, [agentDefaultIndex]);
  const refreshSetupState = q(async () => {
    const preservedSideConfig = serializeModelConfig(availableModelsRef.current[sidepanelDefaultIndexRef.current]);
    const preservedAgentConfig = serializeModelConfig(availableModelsRef.current[agentDefaultIndexRef.current]);
    const [config, oauth, codex] = await Promise.all([
      chrome.runtime.sendMessage({ type: "GET_CONFIG" }),
      chrome.runtime.sendMessage({ type: "GET_OAUTH_STATUS" }),
      chrome.runtime.sendMessage({ type: "GET_CODEX_STATUS" })
    ]);
    const models = buildAvailableModels(
      (config == null ? void 0 : config.providerKeys) || {},
      (config == null ? void 0 : config.customModels) || [],
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
  y(() => {
    void refreshSetupState();
  }, [refreshSetupState]);
  const continueFromWelcome = () => {
    setStep(STEPS.SETUP);
  };
  const handleImportClaude = async () => {
    setConnecting(true);
    setConnectError("");
    try {
      const result = await chrome.runtime.sendMessage({ type: "IMPORT_CLI_CREDENTIALS" });
      if (result.success) {
        await refreshSetupState();
      } else {
        setConnectError(result.error || "failed to import claude credentials. make sure you have run `claude login` first.");
      }
    } catch {
      setConnectError("failed to connect. is claude code installed?");
    }
    setConnecting(false);
  };
  const handleImportCodex = async () => {
    setConnecting(true);
    setConnectError("");
    try {
      const result = await chrome.runtime.sendMessage({ type: "IMPORT_CODEX_CREDENTIALS" });
      if (result.success) {
        await refreshSetupState();
      } else {
        setConnectError(result.error || "failed to import codex credentials. make sure you have run `codex login` first.");
      }
    } catch {
      setConnectError("failed to connect. is codex cli installed?");
    }
    setConnecting(false);
  };
  const handleSaveApiKey = async () => {
    if (!selectedApiProvider || !apiKey.trim()) return;
    setConnecting(true);
    setConnectError("");
    try {
      const currentConfig = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
      await chrome.runtime.sendMessage({
        type: "SAVE_CONFIG",
        payload: {
          providerKeys: {
            ...(currentConfig == null ? void 0 : currentConfig.providerKeys) || {},
            [selectedApiProvider]: apiKey.trim()
          }
        }
      });
      setApiKey("");
      setSelectedApiProvider(null);
      await refreshSetupState();
    } catch {
      setConnectError("failed to save api key.");
    }
    setConnecting(false);
  };
  const handleSaveCustomModel = async () => {
    if (!customModel.name || !customModel.baseUrl || !customModel.modelId) return;
    setConnecting(true);
    setConnectError("");
    try {
      const currentConfig = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
      await chrome.runtime.sendMessage({
        type: "SAVE_CONFIG",
        payload: {
          customModels: [
            ...(currentConfig == null ? void 0 : currentConfig.customModels) || [],
            { ...customModel }
          ]
        }
      });
      setCustomModel({ name: "", baseUrl: "", modelId: "", apiKey: "" });
      await refreshSetupState();
    } catch {
      setConnectError("failed to save custom model.");
    }
    setConnecting(false);
  };
  const finishOnboarding = async () => {
    if (availableModels.length > 0) {
      const sidepanelModel = availableModels[sidepanelDefaultIndex];
      const agentModel = availableModels[agentDefaultIndex];
      await chrome.runtime.sendMessage({
        type: "SAVE_CONFIG",
        payload: {
          ...sidepanelModel ? {
            currentModelIndex: sidepanelDefaultIndex,
            model: sidepanelModel.modelId,
            apiBaseUrl: sidepanelModel.baseUrl,
            apiKey: sidepanelModel.apiKey,
            authMethod: sidepanelModel.authMethod,
            provider: sidepanelModel.provider
          } : {},
          agentDefaultConfig: serializeModelConfig(agentModel)
        }
      });
    }
    await chrome.storage.local.set({
      onboarding_completed: true,
      onboarding_completed_at: Date.now(),
      onboarding_primary_mode: "both",
      onboarding_version: 1
    });
    setStep(STEPS.DONE);
  };
  if (step === STEPS.WELCOME) {
    return /* @__PURE__ */ u(WelcomeStep, { onContinue: continueFromWelcome });
  }
  if (step === STEPS.SETUP) {
    return /* @__PURE__ */ u(
      SetupStep,
      {
        onContinue: () => setStep(STEPS.CONNECT),
        onBack: () => setStep(STEPS.WELCOME)
      }
    );
  }
  if (step === STEPS.CONNECT) {
    return /* @__PURE__ */ u(
      ConnectStep,
      {
        connecting,
        connectError,
        connectedSources,
        availableModels,
        sidepanelDefaultIndex,
        agentDefaultIndex,
        selectedApiProvider,
        apiKey,
        customModel,
        onImportClaude: handleImportClaude,
        onImportCodex: handleImportCodex,
        onSelectApiProvider: setSelectedApiProvider,
        onApiKeyChange: setApiKey,
        onSaveApiKey: handleSaveApiKey,
        onCustomModelChange: setCustomModel,
        onSaveCustomModel: handleSaveCustomModel,
        onSidepanelDefaultChange: setSidepanelDefaultIndex,
        onAgentDefaultChange: setAgentDefaultIndex,
        onFinish: finishOnboarding,
        onBack: () => {
          setStep(STEPS.SETUP);
          setConnectError("");
        }
      }
    );
  }
  if (step === STEPS.DONE) {
    return /* @__PURE__ */ u(DoneStep, {});
  }
}
function ToolbarHint() {
  return /* @__PURE__ */ u("div", { class: "toolbar-hint", children: /* @__PURE__ */ u("svg", { viewBox: "0 0 480 100", fill: "none", xmlns: "http://www.w3.org/2000/svg", class: "toolbar-hint-svg", children: [
    /* @__PURE__ */ u("rect", { width: "480", height: "48", rx: "12", fill: "#e8eaed" }),
    /* @__PURE__ */ u("path", { d: "M36 24l2.3 4.7 5.2.8-3.8 3.7.9 5.2L36 35.8l-4.6 2.6.9-5.2-3.8-3.7 5.2-.8z", fill: "none", stroke: "#9aa0a6", "stroke-width": "1.5" }),
    /* @__PURE__ */ u("rect", { x: "56", y: "12", width: "1", height: "24", rx: "0.5", fill: "#dadce0" }),
    /* @__PURE__ */ u("circle", { cx: "84", cy: "24", r: "12", fill: "#c4c7cc" }),
    /* @__PURE__ */ u("circle", { cx: "116", cy: "24", r: "12", fill: "#c4c7cc" }),
    /* @__PURE__ */ u("circle", { cx: "148", cy: "24", r: "12", fill: "#c4c7cc" }),
    /* @__PURE__ */ u("g", { children: [
      /* @__PURE__ */ u("circle", { cx: "188", cy: "24", r: "17", fill: "none", stroke: "#5D9A9A", "stroke-width": "2", opacity: "0.3", children: [
        /* @__PURE__ */ u("animate", { attributeName: "r", values: "17;22;17", dur: "2s", repeatCount: "indefinite" }),
        /* @__PURE__ */ u("animate", { attributeName: "opacity", values: "0.3;0;0.3", dur: "2s", repeatCount: "indefinite" })
      ] }),
      /* @__PURE__ */ u("circle", { cx: "188", cy: "24", r: "16", fill: "none", stroke: "#5D9A9A", "stroke-width": "2" }),
      /* @__PURE__ */ u("image", { href: "data:image/png;base64,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", x: "175", y: "11", width: "26", height: "26" })
    ] }),
    /* @__PURE__ */ u("circle", { cx: "224", cy: "24", r: "12", fill: "#c4c7cc" }),
    /* @__PURE__ */ u("rect", { x: "248", y: "12", width: "1", height: "24", rx: "0.5", fill: "#dadce0" }),
    /* @__PURE__ */ u("circle", { cx: "272", cy: "24", r: "14", fill: "#c4c7cc" }),
    /* @__PURE__ */ u("circle", { cx: "300", cy: "17", r: "2", fill: "#9aa0a6" }),
    /* @__PURE__ */ u("circle", { cx: "300", cy: "24", r: "2", fill: "#9aa0a6" }),
    /* @__PURE__ */ u("circle", { cx: "300", cy: "31", r: "2", fill: "#9aa0a6" }),
    /* @__PURE__ */ u("path", { d: "M188 56 L188 50", stroke: "#5D9A9A", "stroke-width": "2.5", "stroke-linecap": "round" }),
    /* @__PURE__ */ u("path", { d: "M183 53 L188 47 L193 53", stroke: "#5D9A9A", "stroke-width": "2.5", "stroke-linecap": "round", "stroke-linejoin": "round", fill: "none" }),
    /* @__PURE__ */ u("rect", { x: "108", y: "60", width: "160", height: "32", rx: "8", fill: "#5D9A9A" }),
    /* @__PURE__ */ u("text", { x: "188", y: "81", "text-anchor": "middle", fill: "white", "font-size": "13", "font-weight": "600", "font-family": "-apple-system, BlinkMacSystemFont, sans-serif", children: "click this icon" })
  ] }) });
}
function WelcomeStep({ onContinue }) {
  return /* @__PURE__ */ u("div", { class: "onboarding-page", children: /* @__PURE__ */ u("div", { class: "onboarding-container", children: [
    /* @__PURE__ */ u("div", { class: "onboarding-header", children: [
      /* @__PURE__ */ u("div", { class: "logo-icon", children: /* @__PURE__ */ u("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.5", children: [
        /* @__PURE__ */ u("circle", { cx: "12", cy: "12", r: "10" }),
        /* @__PURE__ */ u("path", { d: "M12 6v6l4 2" })
      ] }) }),
      /* @__PURE__ */ u("h1", { children: "hanzi lets ai use your real chrome" }),
      /* @__PURE__ */ u("p", { class: "subtitle", children: "use it yourself in the sidepanel, or connect it to claude code / codex / mcp so your ai agent can drive your logged-in browser." })
    ] }),
    /* @__PURE__ */ u("div", { class: "mode-cards", children: [
      /* @__PURE__ */ u("div", { class: "mode-card", children: [
        /* @__PURE__ */ u("div", { class: "mode-preview", children: /* @__PURE__ */ u(
          "video",
          {
            src: sidepanelDemoVideo,
            autoPlay: true,
            muted: true,
            loop: true,
            playsInline: true,
            preload: "metadata"
          }
        ) }),
        /* @__PURE__ */ u("h2", { children: "use it myself" }),
        /* @__PURE__ */ u("p", { children: "open the sidepanel, describe what you want, and let hanzi browse for you directly inside chrome." }),
        /* @__PURE__ */ u("div", { class: "mode-setup", children: "sidepanel use" })
      ] }),
      /* @__PURE__ */ u("div", { class: "mode-card", children: [
        /* @__PURE__ */ u("div", { class: "mode-preview", children: /* @__PURE__ */ u(
          "video",
          {
            src: agentDemoVideo,
            autoPlay: true,
            muted: true,
            loop: true,
            playsInline: true,
            preload: "metadata"
          }
        ) }),
        /* @__PURE__ */ u("h2", { children: "use it from my ai agent" }),
        /* @__PURE__ */ u("p", { children: "connect claude code, codex cli, or any mcp client and let your agent drive the same logged-in browser." }),
        /* @__PURE__ */ u("div", { class: "mode-setup", children: "cli and mcp use" })
      ] })
    ] }),
    /* @__PURE__ */ u("div", { class: "onboarding-footer", children: /* @__PURE__ */ u("button", { class: "btn btn-primary btn-lg", onClick: onContinue, children: "continue setup" }) })
  ] }) });
}
function SetupStep({ onContinue, onBack }) {
  const [copied, setCopied] = d(false);
  return /* @__PURE__ */ u("div", { class: "onboarding-page", children: /* @__PURE__ */ u("div", { class: "onboarding-container", children: [
    /* @__PURE__ */ u("button", { class: "back-btn", onClick: onBack, children: [
      /* @__PURE__ */ u("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", width: "16", height: "16", children: /* @__PURE__ */ u("path", { d: "M19 12H5M12 19l-7-7 7-7" }) }),
      "back"
    ] }),
    /* @__PURE__ */ u("div", { class: "onboarding-header", children: [
      /* @__PURE__ */ u("h1", { children: "configure your agents" }),
      /* @__PURE__ */ u("p", { class: "subtitle", children: "run this in your terminal. it detects claude code, cursor, windsurf, and claude desktop — configures each one automatically." })
    ] }),
    /* @__PURE__ */ u("div", { class: "connect-sections", children: /* @__PURE__ */ u("div", { class: "connect-section", children: [
      /* @__PURE__ */ u("div", { class: "command-block", style: { margin: "12px 0" }, children: [
        /* @__PURE__ */ u("code", { children: "npx hanzi-in-chrome setup" }),
        /* @__PURE__ */ u(
          "button",
          {
            class: "copy-btn",
            onClick: () => {
              navigator.clipboard.writeText("npx hanzi-in-chrome setup");
              setCopied(true);
              setTimeout(() => setCopied(false), 2e3);
            },
            children: copied ? "copied!" : "copy"
          }
        )
      ] }),
      /* @__PURE__ */ u("p", { class: "connect-hint", children: "skip this step if you only want to use hanzi from the chrome sidepanel." })
    ] }) }),
    /* @__PURE__ */ u("div", { class: "onboarding-footer", children: /* @__PURE__ */ u("button", { class: "btn btn-primary btn-lg", onClick: onContinue, children: [
      "next",
      /* @__PURE__ */ u("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", width: "16", height: "16", children: /* @__PURE__ */ u("path", { d: "M5 12h14M12 5l7 7-7 7" }) })
    ] }) })
  ] }) });
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
  onBack
}) {
  const [showApiKeys, setShowApiKeys] = d(false);
  const hasAnySources = connectedSources.size > 0;
  const hasClaude = connectedSources.has("claude");
  const hasCodex = connectedSources.has("codex");
  const hasApiKey = (id) => connectedSources.has(`api_${id}`);
  return /* @__PURE__ */ u("div", { class: "onboarding-page", children: /* @__PURE__ */ u("div", { class: "onboarding-container", children: [
    /* @__PURE__ */ u("button", { class: "back-btn", onClick: onBack, children: [
      /* @__PURE__ */ u("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", width: "16", height: "16", children: /* @__PURE__ */ u("path", { d: "M19 12H5M12 19l-7-7 7-7" }) }),
      "back"
    ] }),
    /* @__PURE__ */ u("div", { class: "onboarding-header", children: [
      /* @__PURE__ */ u("h1", { children: "connect a model source" }),
      /* @__PURE__ */ u("p", { class: "subtitle", children: "hanzi needs credentials to run browser tasks. pick whichever you already have." })
    ] }),
    hasAnySources && /* @__PURE__ */ u("div", { class: "success-banner", children: [
      /* @__PURE__ */ u("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", width: "20", height: "20", children: /* @__PURE__ */ u("path", { d: "M20 6L9 17l-5-5" }) }),
      "connected ",
      connectedSources.size,
      " source",
      connectedSources.size === 1 ? "" : "s",
      ". you can keep going, or just review the defaults and continue."
    ] }),
    connectError && /* @__PURE__ */ u("div", { class: "error-banner", children: connectError }),
    /* @__PURE__ */ u("div", { class: "connect-sections", children: [
      /* @__PURE__ */ u("div", { class: "connect-section", children: [
        /* @__PURE__ */ u("div", { class: "quick-connect-grid", children: [
          /* @__PURE__ */ u(
            "button",
            {
              class: `quick-connect-card ${hasClaude ? "connected" : ""}`,
              onClick: onImportClaude,
              disabled: connecting || hasClaude,
              children: [
                /* @__PURE__ */ u("div", { class: "quick-connect-head", children: [
                  /* @__PURE__ */ u("span", { class: "quick-connect-title", children: "use claude" }),
                  hasClaude && /* @__PURE__ */ u("span", { class: "check-mark", children: "connected" })
                ] }),
                /* @__PURE__ */ u("span", { class: "quick-connect-desc", children: "import from `claude login` and use your claude subscription" })
              ]
            }
          ),
          /* @__PURE__ */ u(
            "button",
            {
              class: `quick-connect-card ${hasCodex ? "connected" : ""}`,
              onClick: onImportCodex,
              disabled: connecting || hasCodex,
              children: [
                /* @__PURE__ */ u("div", { class: "quick-connect-head", children: [
                  /* @__PURE__ */ u("span", { class: "quick-connect-title", children: "use codex" }),
                  hasCodex && /* @__PURE__ */ u("span", { class: "check-mark", children: "connected" })
                ] }),
                /* @__PURE__ */ u("span", { class: "quick-connect-desc", children: "import from `codex login` and use your chatgpt subscription" })
              ]
            }
          ),
          /* @__PURE__ */ u(
            "button",
            {
              class: `quick-connect-card ${showApiKeys ? "selected" : ""}`,
              onClick: () => setShowApiKeys(!showApiKeys),
              disabled: connecting,
              children: [
                /* @__PURE__ */ u("div", { class: "quick-connect-head", children: [
                  /* @__PURE__ */ u("span", { class: "quick-connect-title", children: "use an api key" }),
                  /* @__PURE__ */ u("span", { class: "quick-connect-pill", children: showApiKeys ? "open" : "choose provider" })
                ] }),
                /* @__PURE__ */ u("span", { class: "quick-connect-desc", children: "connect anthropic, openai, google, or openrouter directly" })
              ]
            }
          )
        ] }),
        showApiKeys && /* @__PURE__ */ u("div", { class: "nested-panel", children: [
          /* @__PURE__ */ u("div", { class: "api-provider-grid", children: Object.entries(PROVIDERS).map(([id, provider]) => /* @__PURE__ */ u(
            "button",
            {
              class: `api-provider-btn ${selectedApiProvider === id ? "selected" : ""} ${hasApiKey(id) ? "connected" : ""}`,
              onClick: () => onSelectApiProvider(selectedApiProvider === id ? null : id),
              children: [
                provider.name,
                hasApiKey(id) && /* @__PURE__ */ u("span", { class: "check-mark", children: "saved" })
              ]
            },
            id
          )) }),
          selectedApiProvider && /* @__PURE__ */ u("div", { class: "api-key-entry", children: [
            /* @__PURE__ */ u(
              "input",
              {
                type: "password",
                placeholder: `${PROVIDERS[selectedApiProvider].name.toLowerCase()} api key`,
                value: apiKey,
                onInput: (e) => onApiKeyChange(e.target.value),
                onKeyDown: (e) => e.key === "Enter" && onSaveApiKey()
              }
            ),
            /* @__PURE__ */ u(
              "button",
              {
                class: "btn btn-primary",
                onClick: onSaveApiKey,
                disabled: !apiKey.trim() || connecting,
                children: connecting ? "saving..." : "save"
              }
            )
          ] })
        ] })
      ] }),
      /* @__PURE__ */ u("div", { class: "connect-section", children: /* @__PURE__ */ u("details", { class: "advanced-section", children: [
        /* @__PURE__ */ u("summary", { children: "more ways to connect (ollama, lm studio, etc.)" }),
        /* @__PURE__ */ u("p", { class: "connect-hint", style: { marginBottom: "12px" }, children: [
          "add any openai-compatible endpoint. works with ollama (",
          /* @__PURE__ */ u("code", { children: "http://localhost:11434/v1" }),
          "), lm studio, vllm, or any hosted provider."
        ] }),
        /* @__PURE__ */ u("div", { class: "custom-model-form", children: [
          /* @__PURE__ */ u(
            "input",
            {
              type: "text",
              placeholder: "display name",
              value: customModel.name,
              onInput: (e) => onCustomModelChange({ ...customModel, name: e.target.value })
            }
          ),
          /* @__PURE__ */ u(
            "input",
            {
              type: "text",
              placeholder: "base url (e.g. http://localhost:11434/v1)",
              value: customModel.baseUrl,
              onInput: (e) => onCustomModelChange({ ...customModel, baseUrl: e.target.value })
            }
          ),
          /* @__PURE__ */ u(
            "input",
            {
              type: "text",
              placeholder: "model id",
              value: customModel.modelId,
              onInput: (e) => onCustomModelChange({ ...customModel, modelId: e.target.value })
            }
          ),
          /* @__PURE__ */ u(
            "input",
            {
              type: "password",
              placeholder: "api key (optional)",
              value: customModel.apiKey,
              onInput: (e) => onCustomModelChange({ ...customModel, apiKey: e.target.value })
            }
          ),
          /* @__PURE__ */ u(
            "button",
            {
              class: "btn btn-primary",
              onClick: onSaveCustomModel,
              disabled: !customModel.name || !customModel.baseUrl || !customModel.modelId || connecting,
              children: connecting ? "saving..." : "add model"
            }
          )
        ] })
      ] }) }),
      hasAnySources && availableModels.length > 0 && /* @__PURE__ */ u("div", { class: "connect-section", children: [
        /* @__PURE__ */ u("div", { class: "section-kicker", children: "defaults" }),
        /* @__PURE__ */ u("h3", { children: "pick your models" }),
        /* @__PURE__ */ u("div", { class: "defaults-grid", children: [
          /* @__PURE__ */ u("label", { class: "default-select-card primary", children: [
            /* @__PURE__ */ u("span", { class: "default-label", children: "sidepanel model" }),
            /* @__PURE__ */ u(
              "select",
              {
                value: String(sidepanelDefaultIndex),
                onChange: (e) => onSidepanelDefaultChange(Number(e.target.value)),
                children: availableModels.map((model, index) => /* @__PURE__ */ u("option", { value: String(index), children: model.name }, `primary-${model.provider}-${model.modelId}-${index}`))
              }
            ),
            /* @__PURE__ */ u("span", { class: "default-help", children: "sidepanel" })
          ] }),
          /* @__PURE__ */ u("label", { class: "default-select-card secondary", children: [
            /* @__PURE__ */ u("span", { class: "default-label", children: "automation model" }),
            /* @__PURE__ */ u(
              "select",
              {
                value: String(agentDefaultIndex),
                onChange: (e) => onAgentDefaultChange(Number(e.target.value)),
                children: availableModels.map((model, index) => /* @__PURE__ */ u("option", { value: String(index), children: model.name }, `secondary-${model.provider}-${model.modelId}-${index}`))
              }
            ),
            /* @__PURE__ */ u("span", { class: "default-help", children: "browser automation" })
          ] })
        ] })
      ] })
    ] }),
    /* @__PURE__ */ u("div", { class: "onboarding-footer", children: hasAnySources ? /* @__PURE__ */ u("button", { class: "btn btn-primary btn-lg", onClick: onFinish, children: [
      "finish setup",
      /* @__PURE__ */ u("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", width: "16", height: "16", children: /* @__PURE__ */ u("path", { d: "M5 12h14M12 5l7 7-7 7" }) })
    ] }) : /* @__PURE__ */ u("button", { class: "btn btn-secondary skip-btn", onClick: onFinish, children: "skip for now" }) })
  ] }) });
}
function DoneStep() {
  const [copied, setCopied] = d(null);
  return /* @__PURE__ */ u("div", { class: "onboarding-page", children: /* @__PURE__ */ u("div", { class: "onboarding-container", children: [
    /* @__PURE__ */ u("div", { class: "onboarding-header", children: [
      /* @__PURE__ */ u("div", { class: "success-icon", children: /* @__PURE__ */ u("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", children: /* @__PURE__ */ u("path", { d: "M20 6L9 17l-5-5" }) }) }),
      /* @__PURE__ */ u("h1", { children: "you're all set" }),
      /* @__PURE__ */ u("p", { class: "subtitle", children: "you can now use hanzi directly in chrome or connect it to your ai agent. both are ready." })
    ] }),
    /* @__PURE__ */ u("div", { class: "done-sections", children: [
      /* @__PURE__ */ u("div", { class: "done-section", children: [
        /* @__PURE__ */ u("h3", { children: "use it from your agent" }),
        /* @__PURE__ */ u("p", { class: "section-intro", children: "restart your agent and ask it to do something in the browser. the mcp tools are ready." })
      ] }),
      /* @__PURE__ */ u("div", { class: "done-section", children: [
        /* @__PURE__ */ u("h3", { children: "use it yourself in chrome" }),
        /* @__PURE__ */ u("p", { class: "section-intro", children: "click the hanzi icon in your chrome toolbar, then try one of these:" }),
        /* @__PURE__ */ u(ToolbarHint, {}),
        /* @__PURE__ */ u("div", { class: "example-tasks", children: [
          /* @__PURE__ */ u("div", { class: "example-task", children: '"summarize my open jira tickets"' }),
          /* @__PURE__ */ u("div", { class: "example-task", children: `"go to linkedin and draft a post about today's release"` }),
          /* @__PURE__ */ u("div", { class: "example-task", children: '"compare prices for flights to tokyo next week"' })
        ] })
      ] })
    ] }),
    /* @__PURE__ */ u("div", { class: "onboarding-footer", children: /* @__PURE__ */ u("button", { class: "btn btn-primary btn-lg", onClick: () => window.close(), children: "close setup" }) })
  ] }) });
}
G(/* @__PURE__ */ u(OnboardingApp, {}), document.getElementById("app"));
//# sourceMappingURL=onboarding.js.map
