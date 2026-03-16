import { d, y, q, C as CODEX_MODELS, P as PROVIDERS, A, u, k, G } from "./providers.js";
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
  if (!selection || !selection.model || !selection.apiBaseUrl) {
    return -1;
  }
  return models.findIndex(
    (model) => model.modelId === selection.model && model.baseUrl === selection.apiBaseUrl && model.authMethod === selection.authMethod && model.provider === selection.provider
  );
}
function useConfig() {
  const [providerKeys, setProviderKeys] = d({});
  const [customModels, setCustomModels] = d([]);
  const [currentModelIndex, setCurrentModelIndex] = d(0);
  const [agentDefaultConfig, setAgentDefaultConfig] = d(null);
  const [userSkills, setUserSkills] = d([]);
  const [builtInSkills, setBuiltInSkills] = d([]);
  const [availableModels, setAvailableModels] = d([]);
  const [oauthStatus, setOauthStatus] = d({ isOAuthEnabled: false, isAuthenticated: false });
  const [codexStatus, setCodexStatus] = d({ isAuthenticated: false });
  const [isLoading, setIsLoading] = d(true);
  const [onboarding, setOnboarding] = d({ completed: true, primaryMode: null });
  y(() => {
    loadConfig();
  }, []);
  const loadConfig = q(async () => {
    try {
      const config = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
      setProviderKeys(config.providerKeys || {});
      setCustomModels(config.customModels || []);
      setCurrentModelIndex(config.currentModelIndex || 0);
      setAgentDefaultConfig(config.agentDefaultConfig || null);
      setUserSkills(config.userSkills || []);
      setBuiltInSkills(config.builtInSkills || []);
      const obState = await chrome.storage.local.get([
        "onboarding_completed",
        "onboarding_primary_mode"
      ]);
      setOnboarding({
        completed: obState.onboarding_completed !== false,
        primaryMode: obState.onboarding_primary_mode || null
      });
      const oauth = await chrome.runtime.sendMessage({ type: "GET_OAUTH_STATUS" });
      setOauthStatus(oauth || { isOAuthEnabled: false, isAuthenticated: false });
      const codex = await chrome.runtime.sendMessage({ type: "GET_CODEX_STATUS" });
      setCodexStatus(codex || { isAuthenticated: false });
      await buildAvailableModels(
        config.providerKeys || {},
        config.customModels || [],
        oauth,
        codex
      );
      setIsLoading(false);
    } catch (error) {
      console.error("Failed to load config:", error);
      setIsLoading(false);
    }
  }, []);
  const buildAvailableModels = q(async (keys, custom, oauth, codex) => {
    const models = [];
    const hasOAuth = (oauth == null ? void 0 : oauth.isOAuthEnabled) && (oauth == null ? void 0 : oauth.isAuthenticated);
    const hasCodexOAuth = codex == null ? void 0 : codex.isAuthenticated;
    if (hasCodexOAuth) {
      for (const model of CODEX_MODELS) {
        models.push({
          name: `${model.name} (Codex Plan)`,
          provider: "codex",
          modelId: model.id,
          baseUrl: "https://chatgpt.com/backend-api/codex/responses",
          apiKey: null,
          authMethod: "codex_oauth"
        });
      }
    }
    for (const [providerId, provider] of Object.entries(PROVIDERS)) {
      const hasApiKey = keys[providerId];
      if (providerId === "anthropic") {
        if (hasOAuth) {
          for (const model of provider.models) {
            models.push({
              name: `${model.name} (Claude Code)`,
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
              name: `${model.name} (API)`,
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
            name: `${model.name} (API)`,
            provider: providerId,
            modelId: model.id,
            baseUrl: provider.baseUrl,
            apiKey: hasApiKey,
            authMethod: "api_key"
          });
        }
      }
    }
    for (const customModel of custom) {
      models.push({
        name: customModel.name,
        provider: "openai",
        modelId: customModel.modelId,
        baseUrl: customModel.baseUrl,
        apiKey: customModel.apiKey,
        authMethod: "api_key"
      });
    }
    setAvailableModels(models);
  }, []);
  const saveConfig = q(async () => {
    await chrome.runtime.sendMessage({
      type: "SAVE_CONFIG",
      payload: {
        providerKeys,
        customModels,
        currentModelIndex,
        userSkills
      }
    });
  }, [providerKeys, customModels, currentModelIndex, userSkills]);
  const selectModel = q(async (index) => {
    setCurrentModelIndex(index);
    const model = availableModels[index];
    if (model) {
      await chrome.runtime.sendMessage({ type: "CLEAR_CHAT" }).catch(() => {
      });
      await chrome.runtime.sendMessage({
        type: "SAVE_CONFIG",
        payload: {
          currentModelIndex: index,
          model: model.modelId,
          apiBaseUrl: model.baseUrl,
          apiKey: model.apiKey,
          authMethod: model.authMethod,
          provider: model.provider
        }
      });
    }
  }, [availableModels]);
  const selectAgentDefault = q(async (index) => {
    const model = availableModels[index];
    if (!model) return;
    const serialized = serializeModelConfig(model);
    setAgentDefaultConfig(serialized);
    await chrome.runtime.sendMessage({
      type: "SAVE_CONFIG",
      payload: {
        agentDefaultConfig: serialized
      }
    });
  }, [availableModels]);
  const setProviderKey = q((provider, key) => {
    setProviderKeys((prev) => ({ ...prev, [provider]: key }));
  }, []);
  const addCustomModel = q((model) => {
    setCustomModels((prev) => [...prev, model]);
  }, []);
  const removeCustomModel = q((index) => {
    setCustomModels((prev) => prev.filter((_, i) => i !== index));
  }, []);
  const addUserSkill = q((skill) => {
    setUserSkills((prev) => {
      const existingIndex = prev.findIndex((s) => s.domain === skill.domain);
      if (existingIndex >= 0) {
        const updated = [...prev];
        updated[existingIndex] = skill;
        return updated;
      }
      return [...prev, skill];
    });
  }, []);
  const removeUserSkill = q((index) => {
    setUserSkills((prev) => prev.filter((_, i) => i !== index));
  }, []);
  const importCLI = q(async () => {
    const result = await chrome.runtime.sendMessage({ type: "IMPORT_CLI_CREDENTIALS" });
    if (result.success) {
      await loadConfig();
    }
    return result;
  }, [loadConfig]);
  const logoutCLI = q(async () => {
    await chrome.runtime.sendMessage({ type: "OAUTH_LOGOUT" });
    await loadConfig();
  }, [loadConfig]);
  const importCodex = q(async () => {
    const result = await chrome.runtime.sendMessage({ type: "IMPORT_CODEX_CREDENTIALS" });
    if (result.success) {
      await loadConfig();
    }
    return result;
  }, [loadConfig]);
  const logoutCodex = q(async () => {
    await chrome.runtime.sendMessage({ type: "CODEX_LOGOUT" });
    await loadConfig();
  }, [loadConfig]);
  const currentModel = availableModels[currentModelIndex] || null;
  const currentAgentDefaultIndex = findModelIndex(availableModels, agentDefaultConfig);
  return {
    // State
    providerKeys,
    customModels,
    currentModelIndex,
    agentDefaultConfig,
    userSkills,
    builtInSkills,
    availableModels,
    currentModel,
    currentAgentDefaultIndex,
    oauthStatus,
    codexStatus,
    isLoading,
    onboarding,
    // Actions
    loadConfig,
    saveConfig,
    selectModel,
    selectAgentDefault,
    setProviderKey,
    addCustomModel,
    removeCustomModel,
    addUserSkill,
    removeUserSkill,
    importCLI,
    logoutCLI,
    importCodex,
    logoutCodex
  };
}
function useChat() {
  const [messages, setMessages] = d([]);
  const [isRunning, setIsRunning] = d(false);
  const [attachedImages, setAttachedImages] = d([]);
  const [sessionTabGroupId, setSessionTabGroupId] = d(null);
  const [pendingPlan, setPendingPlan] = d(null);
  const [pendingStep, setPendingStep] = d(null);
  const currentStepsRef = A([]);
  const streamingTextRef = A("");
  const [streamingMessageId, setStreamingMessageId] = d(null);
  y(() => {
    const listener = (message) => {
      switch (message.type) {
        case "TASK_UPDATE":
          handleTaskUpdate(message.update);
          break;
        case "TASK_COMPLETE":
          handleTaskComplete(message.result);
          break;
        case "TASK_ERROR":
          handleTaskError(message.error);
          break;
        case "PLAN_APPROVAL_REQUIRED":
          setPendingPlan(message.plan);
          break;
        case "SESSION_GROUP_UPDATE":
          setSessionTabGroupId(message.tabGroupId);
          break;
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);
  const handleTaskUpdate = q((update) => {
    if (update.status === "thinking") {
      setMessages((prev) => {
        const filtered = prev.filter((m) => m.type !== "thinking");
        return [...filtered, { id: Date.now(), type: "thinking" }];
      });
      setStreamingMessageId(null);
      streamingTextRef.current = "";
    } else if (update.status === "streaming" && update.text) {
      streamingTextRef.current = update.text;
      setMessages((prev) => {
        const filtered = prev.filter((m) => m.type !== "thinking");
        const existingStreamingIndex = filtered.findIndex((m) => m.type === "streaming");
        if (existingStreamingIndex >= 0) {
          const updated = [...filtered];
          updated[existingStreamingIndex] = {
            ...updated[existingStreamingIndex],
            text: update.text
          };
          return updated;
        } else {
          const msgId = Date.now();
          setStreamingMessageId(msgId);
          return [...filtered, {
            id: msgId,
            type: "streaming",
            text: update.text
          }];
        }
      });
    } else if (update.status === "executing") {
      setMessages((prev) => prev.filter((m) => m.type !== "thinking"));
      setPendingStep({ tool: update.tool, input: update.input });
    } else if (update.status === "executed") {
      currentStepsRef.current = [...currentStepsRef.current, {
        tool: update.tool,
        input: (pendingStep == null ? void 0 : pendingStep.input) || update.input,
        result: update.result
      }];
      setPendingStep(null);
    } else if (update.status === "message" && update.text) {
      const stepsForMessage = [...currentStepsRef.current];
      currentStepsRef.current = [];
      setMessages((prev) => {
        const filtered = prev.filter((m) => m.type !== "thinking" && m.type !== "streaming");
        return [...filtered, {
          id: Date.now(),
          type: "assistant",
          text: update.text,
          steps: stepsForMessage
          // Attach steps to this message
        }];
      });
      setStreamingMessageId(null);
      streamingTextRef.current = "";
    }
  }, [pendingStep]);
  const handleTaskComplete = q((result) => {
    setIsRunning(false);
    setMessages((prev) => prev.filter((m) => m.type !== "thinking"));
    setStreamingMessageId(null);
    streamingTextRef.current = "";
    if (result.message && !result.success) {
      setMessages((prev) => [...prev, {
        id: Date.now(),
        type: "system",
        text: result.message
      }]);
    }
  }, []);
  const handleTaskError = q((error) => {
    setIsRunning(false);
    setMessages((prev) => {
      const filtered = prev.filter((m) => m.type !== "thinking" && m.type !== "streaming");
      return [...filtered, {
        id: Date.now(),
        type: "error",
        text: `Error: ${error}`
      }];
    });
    setStreamingMessageId(null);
    streamingTextRef.current = "";
  }, []);
  const sendMessage = q(async (text) => {
    if (!text.trim() || isRunning) return;
    const userMessage = {
      id: Date.now(),
      type: "user",
      text,
      images: [...attachedImages]
    };
    setMessages((prev) => [...prev, userMessage]);
    const imagesToSend = [...attachedImages];
    setAttachedImages([]);
    currentStepsRef.current = [];
    setPendingStep(null);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      setMessages((prev) => [...prev, {
        id: Date.now(),
        type: "error",
        text: "No active tab found"
      }]);
      return;
    }
    setIsRunning(true);
    try {
      await chrome.runtime.sendMessage({
        type: "START_TASK",
        payload: {
          tabId: tab.id,
          task: text,
          askBeforeActing: false,
          images: imagesToSend,
          tabGroupId: sessionTabGroupId
        }
      });
    } catch (error) {
      setMessages((prev) => [...prev, {
        id: Date.now(),
        type: "error",
        text: `Error: ${error.message}`
      }]);
      setIsRunning(false);
    }
  }, [isRunning, attachedImages, sessionTabGroupId]);
  const stopTask = q(() => {
    chrome.runtime.sendMessage({ type: "STOP_TASK" }).catch(() => {
    });
    setIsRunning(false);
  }, []);
  const clearChat = q(() => {
    setMessages([]);
    currentStepsRef.current = [];
    setPendingStep(null);
    setStreamingMessageId(null);
    streamingTextRef.current = "";
    setSessionTabGroupId(null);
    chrome.runtime.sendMessage({ type: "CLEAR_CONVERSATION" }).catch(() => {
    });
  }, []);
  const approvePlan = q(() => {
    chrome.runtime.sendMessage({ type: "PLAN_APPROVAL_RESPONSE", payload: { approved: true } });
    setPendingPlan(null);
  }, []);
  const cancelPlan = q(() => {
    chrome.runtime.sendMessage({ type: "PLAN_APPROVAL_RESPONSE", payload: { approved: false } });
    setPendingPlan(null);
  }, []);
  const addImage = q((dataUrl) => {
    setAttachedImages((prev) => [...prev, dataUrl]);
  }, []);
  const removeImage = q((index) => {
    setAttachedImages((prev) => prev.filter((_, i) => i !== index));
  }, []);
  const clearImages = q(() => {
    setAttachedImages([]);
  }, []);
  return {
    // State
    messages,
    isRunning,
    attachedImages,
    pendingStep,
    pendingPlan,
    // Actions
    sendMessage,
    stopTask,
    clearChat,
    approvePlan,
    cancelPlan,
    addImage,
    removeImage,
    clearImages
  };
}
function Header({
  currentModel,
  availableModels,
  currentModelIndex,
  onModelSelect,
  onNewChat,
  onOpenSettings
}) {
  const [isDropdownOpen, setIsDropdownOpen] = d(false);
  const dropdownRef = A(null);
  y(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, []);
  const handleModelSelect = (index) => {
    onModelSelect(index);
    setIsDropdownOpen(false);
  };
  return /* @__PURE__ */ u("div", { class: "header", children: [
    /* @__PURE__ */ u("div", { class: "header-left", children: /* @__PURE__ */ u("div", { class: "model-selector", ref: dropdownRef, children: [
      /* @__PURE__ */ u(
        "button",
        {
          class: "model-selector-btn",
          onClick: () => setIsDropdownOpen(!isDropdownOpen),
          children: [
            /* @__PURE__ */ u("span", { class: "current-model-name", children: (currentModel == null ? void 0 : currentModel.name) || "Select Model" }),
            /* @__PURE__ */ u("svg", { class: "chevron", width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", children: /* @__PURE__ */ u("path", { d: "M6 9l6 6 6-6" }) })
          ]
        }
      ),
      isDropdownOpen && /* @__PURE__ */ u("div", { class: "model-dropdown", children: /* @__PURE__ */ u("div", { class: "model-list", children: availableModels.length === 0 ? /* @__PURE__ */ u("div", { class: "model-item disabled", children: "No models configured" }) : availableModels.map((model, index) => /* @__PURE__ */ u(
        "button",
        {
          class: `model-item ${index === currentModelIndex ? "active" : ""}`,
          onClick: () => handleModelSelect(index),
          children: model.name
        },
        index
      )) }) })
    ] }) }),
    /* @__PURE__ */ u("div", { class: "header-right", children: [
      /* @__PURE__ */ u("button", { class: "icon-btn", onClick: onNewChat, title: "New chat", children: /* @__PURE__ */ u("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", children: /* @__PURE__ */ u("path", { d: "M12 5v14M5 12h14" }) }) }),
      /* @__PURE__ */ u("button", { class: "icon-btn", onClick: onOpenSettings, title: "Settings", children: /* @__PURE__ */ u("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", children: [
        /* @__PURE__ */ u("circle", { cx: "12", cy: "12", r: "3" }),
        /* @__PURE__ */ u("path", { d: "M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" })
      ] }) })
    ] })
  ] });
}
function formatMarkdown(text) {
  if (!text) return "";
  const lines = text.split("\n");
  let result = [];
  let inList = false;
  let listType = null;
  for (const line of lines) {
    const ulMatch = line.match(/^[-*]\s+(.+)$/);
    const olMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (ulMatch) {
      if (!inList || listType !== "ul") {
        if (inList) result.push(listType === "ol" ? "</ol>" : "</ul>");
        result.push("<ul>");
        inList = true;
        listType = "ul";
      }
      result.push(`<li>${formatInline(ulMatch[1])}</li>`);
    } else if (olMatch) {
      if (!inList || listType !== "ol") {
        if (inList) result.push(listType === "ol" ? "</ol>" : "</ul>");
        result.push("<ol>");
        inList = true;
        listType = "ol";
      }
      result.push(`<li>${formatInline(olMatch[2])}</li>`);
    } else {
      if (inList) {
        result.push(listType === "ol" ? "</ol>" : "</ul>");
        inList = false;
        listType = null;
      }
      if (line.trim() === "") {
        result.push("<br>");
      } else {
        result.push(`<p>${formatInline(line)}</p>`);
      }
    }
  }
  if (inList) result.push(listType === "ol" ? "</ol>" : "</ul>");
  return result.join("");
}
function formatInline(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>").replace(/`(.+?)`/g, "<code>$1</code>");
}
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
function getActionDescription(toolName, input) {
  var _a;
  if (!input) return toolName;
  switch (toolName) {
    case "computer": {
      const action = input.action;
      if (action === "screenshot") return "Taking screenshot";
      if (action === "left_click") {
        if (input.ref) return `Clicking ${input.ref}`;
        if (input.coordinate) return `Clicking at (${input.coordinate[0]}, ${input.coordinate[1]})`;
        return "Clicking";
      }
      if (action === "right_click") return "Right-clicking";
      if (action === "double_click") return "Double-clicking";
      if (action === "type") return `Typing "${(input.text || "").substring(0, 30)}${((_a = input.text) == null ? void 0 : _a.length) > 30 ? "..." : ""}"`;
      if (action === "key") return `Pressing ${input.text}`;
      if (action === "scroll") return `Scrolling ${input.scroll_direction}`;
      if (action === "mouse_move") return "Moving mouse";
      if (action === "drag") return "Dragging";
      return `Computer: ${action}`;
    }
    case "navigate":
      if (input.action === "back") return "Going back";
      if (input.action === "forward") return "Going forward";
      return `Navigating to ${(input.url || "").substring(0, 50)}...`;
    case "read_page":
      return "Reading page structure";
    case "get_page_text":
      return "Extracting page text";
    case "find":
      return `Finding "${input.query}"`;
    case "form_input":
      return `Filling form field ${input.ref}`;
    case "file_upload":
      return "Uploading file";
    case "javascript_tool":
      return "Running JavaScript";
    case "tabs_context":
      return "Getting tab context";
    case "tabs_create":
      return "Creating new tab";
    case "tabs_close":
      return "Closing tab";
    case "read_console_messages":
      return "Reading console";
    case "read_network_requests":
      return "Reading network requests";
    default:
      return toolName;
  }
}
function getToolIcon(toolName) {
  const icons = {
    computer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    navigate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>',
    read_page: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>',
    get_page_text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>',
    find: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>',
    form_input: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    javascript_tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></svg>',
    tabs_context: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>',
    tabs_create: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/></svg>',
    tabs_close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
    default: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>'
  };
  return icons[toolName] || icons.default;
}
function formatStepResult(result) {
  if (!result) return "";
  if (typeof result === "string") {
    if (result.length > 100) {
      return result.substring(0, 100) + "...";
    }
    return result;
  }
  if (typeof result === "object") {
    if (result.error) return `Error: ${result.error}`;
    if (result.output) {
      const output = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
      return output.length > 100 ? output.substring(0, 100) + "..." : output;
    }
  }
  return "";
}
function Message({ message }) {
  const { type, text, images } = message;
  if (type === "thinking") {
    return /* @__PURE__ */ u("div", { class: "message thinking", children: /* @__PURE__ */ u("div", { class: "thinking-indicator", children: [
      /* @__PURE__ */ u("div", { class: "sparkle-container", children: /* @__PURE__ */ u("svg", { class: "sparkle", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", children: [
        /* @__PURE__ */ u("circle", { cx: "12", cy: "12", r: "10" }),
        /* @__PURE__ */ u("path", { d: "M12 6v6l4 2" })
      ] }) }),
      /* @__PURE__ */ u("span", { children: "Thinking..." })
    ] }) });
  }
  if (type === "streaming") {
    return /* @__PURE__ */ u("div", { class: "message assistant streaming", children: [
      /* @__PURE__ */ u("div", { class: "bullet" }),
      /* @__PURE__ */ u(
        "div",
        {
          class: "content",
          dangerouslySetInnerHTML: { __html: formatMarkdown(text) }
        }
      )
    ] });
  }
  if (type === "user") {
    return /* @__PURE__ */ u("div", { class: "message user", children: [
      images && images.length > 0 && /* @__PURE__ */ u("div", { class: "message-images", children: images.map((img, i) => /* @__PURE__ */ u("img", { src: img, alt: `Attached ${i + 1}` }, i)) }),
      text && /* @__PURE__ */ u("span", { children: text })
    ] });
  }
  if (type === "assistant") {
    return /* @__PURE__ */ u("div", { class: "message assistant", children: [
      /* @__PURE__ */ u("div", { class: "bullet" }),
      /* @__PURE__ */ u(
        "div",
        {
          class: "content",
          dangerouslySetInnerHTML: { __html: formatMarkdown(text) }
        }
      )
    ] });
  }
  if (type === "error") {
    return /* @__PURE__ */ u("div", { class: "message error", children: text });
  }
  if (type === "system") {
    return /* @__PURE__ */ u("div", { class: "message system", children: text });
  }
  return null;
}
function StepsSection({ steps, pendingStep }) {
  const [isExpanded, setIsExpanded] = d(false);
  const totalSteps = steps.length + (pendingStep ? 1 : 0);
  if (totalSteps === 0) return null;
  return /* @__PURE__ */ u("div", { class: "steps-section", children: [
    /* @__PURE__ */ u(
      "div",
      {
        class: `steps-toggle ${isExpanded ? "expanded" : ""}`,
        onClick: () => setIsExpanded(!isExpanded),
        children: [
          /* @__PURE__ */ u("div", { class: "toggle-icon", children: /* @__PURE__ */ u("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", children: [
            /* @__PURE__ */ u("polyline", { points: "9 11 12 14 22 4" }),
            /* @__PURE__ */ u("path", { d: "M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" })
          ] }) }),
          /* @__PURE__ */ u("span", { class: "toggle-text", children: [
            steps.length,
            " step",
            steps.length !== 1 ? "s" : "",
            " completed",
            pendingStep && " (1 in progress)"
          ] }),
          /* @__PURE__ */ u("svg", { class: "chevron", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", children: /* @__PURE__ */ u("path", { d: "M6 9l6 6 6-6" }) })
        ]
      }
    ),
    /* @__PURE__ */ u("div", { class: `steps-list ${isExpanded ? "visible" : ""}`, children: [
      steps.map((step, index) => /* @__PURE__ */ u(StepItem, { step, status: "completed" }, index)),
      pendingStep && /* @__PURE__ */ u(StepItem, { step: pendingStep, status: "pending" })
    ] })
  ] });
}
function StepItem({ step, status }) {
  const description = getActionDescription(step.tool, step.input);
  const resultText = status === "completed" ? formatStepResult(step.result) : null;
  return /* @__PURE__ */ u("div", { class: `step-item ${status}`, children: [
    /* @__PURE__ */ u("div", { class: `step-icon ${status === "completed" ? "success" : "pending"}`, children: status === "pending" ? /* @__PURE__ */ u("svg", { class: "spinner", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", children: /* @__PURE__ */ u("circle", { cx: "12", cy: "12", r: "10" }) }) : /* @__PURE__ */ u("span", { dangerouslySetInnerHTML: { __html: getToolIcon(step.tool) } }) }),
    /* @__PURE__ */ u("div", { class: "step-content", children: [
      /* @__PURE__ */ u("div", { class: "step-label", children: escapeHtml(description) }),
      resultText && /* @__PURE__ */ u("div", { class: "step-result", children: escapeHtml(resultText) })
    ] }),
    /* @__PURE__ */ u("div", { class: "step-status", children: status === "completed" ? "✓" : "..." })
  ] });
}
function MessageList({ messages, pendingStep }) {
  const containerRef = A(null);
  const isAtBottomRef = A(true);
  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 50;
  };
  y(() => {
    if (isAtBottomRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages]);
  const renderContent = () => {
    const content = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.type === "assistant" && msg.steps && msg.steps.length > 0) {
        content.push(
          /* @__PURE__ */ u(
            StepsSection,
            {
              steps: msg.steps,
              pendingStep: null
            },
            `steps-${msg.id}`
          )
        );
      }
      content.push(/* @__PURE__ */ u(Message, { message: msg }, msg.id));
    }
    if (pendingStep) {
      content.push(
        /* @__PURE__ */ u(
          StepsSection,
          {
            steps: [],
            pendingStep
          },
          "steps-pending"
        )
      );
    }
    return content;
  };
  return /* @__PURE__ */ u(
    "div",
    {
      class: "messages",
      ref: containerRef,
      onScroll: handleScroll,
      children: renderContent()
    }
  );
}
function InputArea({
  isRunning,
  attachedImages,
  onSend,
  onStop,
  onAddImage,
  onRemoveImage,
  hasModels,
  suggestedText,
  onClearSuggestion,
  onOpenSettings
}) {
  const [text, setText] = d("");
  y(() => {
    if (suggestedText) {
      setText(suggestedText);
      onClearSuggestion();
    }
  }, [suggestedText, onClearSuggestion]);
  const [isDragging, setIsDragging] = d(false);
  const inputRef = A(null);
  const handleSubmit = () => {
    if (!text.trim() || isRunning) return;
    if (!hasModels) {
      if (onOpenSettings) onOpenSettings();
      return;
    }
    onSend(text);
    setText("");
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
  };
  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };
  const handleInput = (e) => {
    setText(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 150) + "px";
  };
  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };
  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    for (const file of files) {
      if (file.type.startsWith("image/")) {
        readImageFile(file);
      }
    }
  };
  const handlePaste = (e) => {
    var _a;
    const items = (_a = e.clipboardData) == null ? void 0 : _a.items;
    if (items) {
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) readImageFile(file);
          break;
        }
      }
    }
  };
  const readImageFile = (file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      onAddImage(e.target.result);
    };
    reader.readAsDataURL(file);
  };
  return /* @__PURE__ */ u(
    "div",
    {
      class: `input-container ${isDragging ? "drag-over" : ""}`,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
      children: [
        attachedImages.length > 0 && /* @__PURE__ */ u("div", { class: "image-preview", children: attachedImages.map((img, i) => /* @__PURE__ */ u("div", { class: "image-preview-item", children: [
          /* @__PURE__ */ u("img", { src: img, alt: `Preview ${i + 1}` }),
          /* @__PURE__ */ u(
            "button",
            {
              class: "remove-image-btn",
              onClick: () => onRemoveImage(i),
              children: "×"
            }
          )
        ] }, i)) }),
        /* @__PURE__ */ u("div", { class: "input-row", children: [
          /* @__PURE__ */ u(
            "textarea",
            {
              ref: inputRef,
              class: "input",
              placeholder: "What would you like me to do?",
              value: text,
              onInput: handleInput,
              onKeyDown: handleKeyDown,
              onPaste: handlePaste,
              rows: 1
            }
          ),
          isRunning ? /* @__PURE__ */ u("button", { class: "btn stop-btn", onClick: onStop, children: [
            /* @__PURE__ */ u("svg", { viewBox: "0 0 24 24", fill: "currentColor", children: /* @__PURE__ */ u("rect", { x: "6", y: "6", width: "12", height: "12", rx: "2" }) }),
            "Stop"
          ] }) : /* @__PURE__ */ u(
            "button",
            {
              class: "btn send-btn",
              onClick: handleSubmit,
              disabled: !text.trim(),
              children: [
                /* @__PURE__ */ u("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", children: /* @__PURE__ */ u("path", { d: "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" }) }),
                "Send"
              ]
            }
          )
        ] })
      ]
    }
  );
}
function SettingsModal({ config, onClose }) {
  const [activeTab, setActiveTab] = d("providers");
  const [selectedProvider, setSelectedProvider] = d(null);
  const [localKeys, setLocalKeys] = d({ ...config.providerKeys });
  const [agentDefaultIndex, setAgentDefaultIndex] = d(config.currentAgentDefaultIndex);
  const [newCustomModel, setNewCustomModel] = d({ name: "", baseUrl: "", modelId: "", apiKey: "" });
  const [skillForm, setSkillForm] = d({ domain: "", skill: "", isOpen: false, editIndex: -1 });
  y(() => {
    setAgentDefaultIndex(config.currentAgentDefaultIndex);
  }, [config.currentAgentDefaultIndex]);
  const handleSave = async () => {
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
      alert("Please fill in name, base URL, and model ID");
      return;
    }
    config.addCustomModel({ ...newCustomModel });
    setNewCustomModel({ name: "", baseUrl: "", modelId: "", apiKey: "" });
  };
  const handleAddSkill = () => {
    if (!skillForm.domain || !skillForm.skill) {
      alert("Please fill in both domain and tips/guidance");
      return;
    }
    config.addUserSkill({ domain: skillForm.domain.toLowerCase(), skill: skillForm.skill });
    setSkillForm({ domain: "", skill: "", isOpen: false, editIndex: -1 });
  };
  const handleEditSkill = (index) => {
    const skill = config.userSkills[index];
    setSkillForm({ domain: skill.domain, skill: skill.skill, isOpen: true, editIndex: index });
  };
  return /* @__PURE__ */ u("div", { class: "modal-overlay", onClick: (e) => e.target === e.currentTarget && onClose(), children: /* @__PURE__ */ u("div", { class: "modal settings-modal", children: [
    /* @__PURE__ */ u("div", { class: "modal-header", children: [
      /* @__PURE__ */ u("span", { children: "Settings" }),
      /* @__PURE__ */ u("button", { class: "close-btn", onClick: onClose, children: "×" })
    ] }),
    /* @__PURE__ */ u("div", { class: "tabs", children: [
      /* @__PURE__ */ u(
        "button",
        {
          class: `tab ${activeTab === "providers" ? "active" : ""}`,
          onClick: () => setActiveTab("providers"),
          children: "Providers"
        }
      ),
      /* @__PURE__ */ u(
        "button",
        {
          class: `tab ${activeTab === "custom" ? "active" : ""}`,
          onClick: () => setActiveTab("custom"),
          children: "Custom Models"
        }
      ),
      /* @__PURE__ */ u(
        "button",
        {
          class: `tab ${activeTab === "skills" ? "active" : ""}`,
          onClick: () => setActiveTab("skills"),
          children: "Domain Skills"
        }
      ),
      /* @__PURE__ */ u(
        "button",
        {
          class: `tab ${activeTab === "license" ? "active" : ""}`,
          onClick: () => setActiveTab("license"),
          children: "License"
        }
      )
    ] }),
    /* @__PURE__ */ u("div", { class: "modal-body", children: [
      activeTab === "providers" && /* @__PURE__ */ u(
        ProvidersTab,
        {
          localKeys,
          setLocalKeys,
          selectedProvider,
          setSelectedProvider,
          agentDefaultIndex,
          setAgentDefaultIndex,
          config
        }
      ),
      activeTab === "custom" && /* @__PURE__ */ u(
        CustomModelsTab,
        {
          customModels: config.customModels,
          newModel: newCustomModel,
          setNewModel: setNewCustomModel,
          onAdd: handleAddCustomModel,
          onRemove: config.removeCustomModel
        }
      ),
      activeTab === "skills" && /* @__PURE__ */ u(
        SkillsTab,
        {
          userSkills: config.userSkills,
          builtInSkills: config.builtInSkills,
          skillForm,
          setSkillForm,
          onAdd: handleAddSkill,
          onEdit: handleEditSkill,
          onRemove: config.removeUserSkill
        }
      ),
      activeTab === "license" && /* @__PURE__ */ u(LicenseTab, {})
    ] }),
    /* @__PURE__ */ u("div", { class: "modal-footer", children: [
      /* @__PURE__ */ u("button", { class: "btn btn-secondary", onClick: onClose, children: "Close" }),
      /* @__PURE__ */ u("button", { class: "btn btn-primary", onClick: handleSave, children: "Save" })
    ] })
  ] }) });
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
  return /* @__PURE__ */ u("div", { class: "tab-content", children: [
    /* @__PURE__ */ u("div", { class: "provider-section", children: [
      /* @__PURE__ */ u("h4", { children: "Import Claude credentials" }),
      /* @__PURE__ */ u("p", { class: "provider-desc", children: [
        "Import from ",
        /* @__PURE__ */ u("code", { children: "claude login" }),
        " to use your Claude Pro/Max subscription. ",
        /* @__PURE__ */ u("a", { href: "https://github.com/hanzili/hanzi-in-chrome#claude-code-plan-setup", target: "_blank", children: "Setup guide" })
      ] }),
      config.oauthStatus.isAuthenticated ? /* @__PURE__ */ u("div", { class: "connected-status", children: [
        /* @__PURE__ */ u("span", { class: "status-badge connected", children: "Connected" }),
        /* @__PURE__ */ u("button", { class: "btn btn-secondary btn-sm", onClick: config.logoutCLI, children: "Disconnect" })
      ] }) : /* @__PURE__ */ u("button", { class: "btn btn-primary", onClick: config.importCLI, children: "Import from claude login" })
    ] }),
    /* @__PURE__ */ u("div", { class: "provider-section", children: [
      /* @__PURE__ */ u("h4", { children: "Import Codex credentials" }),
      /* @__PURE__ */ u("p", { class: "provider-desc", children: [
        "Import from ",
        /* @__PURE__ */ u("code", { children: "codex login" }),
        " to use your ChatGPT Pro/Plus subscription. ",
        /* @__PURE__ */ u("a", { href: "https://github.com/hanzili/hanzi-in-chrome#codex-plan-setup", target: "_blank", children: "Setup guide" })
      ] }),
      config.codexStatus.isAuthenticated ? /* @__PURE__ */ u("div", { class: "connected-status", children: [
        /* @__PURE__ */ u("span", { class: "status-badge connected", children: "Connected" }),
        /* @__PURE__ */ u("button", { class: "btn btn-secondary btn-sm", onClick: config.logoutCodex, children: "Disconnect" })
      ] }) : /* @__PURE__ */ u("button", { class: "btn btn-primary", onClick: config.importCodex, children: "Import from codex login" })
    ] }),
    /* @__PURE__ */ u("hr", {}),
    /* @__PURE__ */ u("h4", { children: "API Keys (Pay-per-use)" }),
    /* @__PURE__ */ u("div", { class: "provider-cards", children: Object.entries(PROVIDERS).map(([id, provider]) => /* @__PURE__ */ u(
      "div",
      {
        class: `provider-card ${selectedProvider === id ? "selected" : ""} ${localKeys[id] ? "configured" : ""}`,
        onClick: () => setSelectedProvider(selectedProvider === id ? null : id),
        children: [
          /* @__PURE__ */ u("div", { class: "provider-name", children: provider.name }),
          localKeys[id] && /* @__PURE__ */ u("span", { class: "check-badge", children: "✓" })
        ]
      },
      id
    )) }),
    selectedProvider && /* @__PURE__ */ u("div", { class: "api-key-input", children: [
      /* @__PURE__ */ u("label", { children: [
        PROVIDERS[selectedProvider].name,
        " API Key"
      ] }),
      /* @__PURE__ */ u(
        "input",
        {
          type: "password",
          value: localKeys[selectedProvider] || "",
          onInput: (e) => setLocalKeys({ ...localKeys, [selectedProvider]: e.target.value }),
          placeholder: "Enter API key..."
        }
      )
    ] }),
    /* @__PURE__ */ u("hr", {}),
    /* @__PURE__ */ u("div", { class: "provider-section", children: [
      /* @__PURE__ */ u("h4", { children: "browser automation default" }),
      /* @__PURE__ */ u("p", { class: "provider-desc", children: [
        "used by ",
        /* @__PURE__ */ u("code", { children: "hanzi-browser" }),
        " and mcp browser tasks. the sidepanel model is still selected from the header."
      ] }),
      /* @__PURE__ */ u("div", { class: "api-key-input", children: [
        /* @__PURE__ */ u("label", { children: "default model for cli / mcp" }),
        /* @__PURE__ */ u(
          "select",
          {
            value: agentDefaultIndex >= 0 ? String(agentDefaultIndex) : "",
            onChange: (e) => setAgentDefaultIndex(Number(e.target.value)),
            disabled: config.availableModels.length === 0,
            children: config.availableModels.length === 0 ? /* @__PURE__ */ u("option", { value: "", children: "connect a model source first" }) : config.availableModels.map((model, index) => /* @__PURE__ */ u("option", { value: String(index), children: model.name }, `${model.provider}-${model.modelId}-${index}`))
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ u("hr", {}),
    /* @__PURE__ */ u("div", { class: "provider-section", children: [
      /* @__PURE__ */ u("h4", { children: "MCP Server" }),
      /* @__PURE__ */ u("p", { class: "provider-desc", children: [
        "Control this browser from Claude Code or any MCP client.",
        " ",
        /* @__PURE__ */ u("a", { href: "https://github.com/hanzili/hanzi-in-chrome#setup", target: "_blank", children: "Setup guide" })
      ] }),
      /* @__PURE__ */ u("code", { class: "install-cmd", children: "npm install -g hanzi-in-chrome" })
    ] })
  ] });
}
function CustomModelsTab({ customModels, newModel, setNewModel, onAdd, onRemove }) {
  return /* @__PURE__ */ u("div", { class: "tab-content", children: [
    /* @__PURE__ */ u("p", { class: "tab-desc", children: "Add custom OpenAI-compatible endpoints" }),
    /* @__PURE__ */ u("div", { class: "custom-model-form", children: [
      /* @__PURE__ */ u(
        "input",
        {
          type: "text",
          placeholder: "Display Name",
          value: newModel.name,
          onInput: (e) => setNewModel({ ...newModel, name: e.target.value })
        }
      ),
      /* @__PURE__ */ u(
        "input",
        {
          type: "text",
          placeholder: "Base URL (e.g., https://api.example.com/v1/chat/completions)",
          value: newModel.baseUrl,
          onInput: (e) => setNewModel({ ...newModel, baseUrl: e.target.value })
        }
      ),
      /* @__PURE__ */ u(
        "input",
        {
          type: "text",
          placeholder: "Model ID",
          value: newModel.modelId,
          onInput: (e) => setNewModel({ ...newModel, modelId: e.target.value })
        }
      ),
      /* @__PURE__ */ u(
        "input",
        {
          type: "password",
          placeholder: "API Key (optional)",
          value: newModel.apiKey,
          onInput: (e) => setNewModel({ ...newModel, apiKey: e.target.value })
        }
      ),
      /* @__PURE__ */ u("button", { class: "btn btn-primary", onClick: onAdd, children: "Add Model" })
    ] }),
    customModels.length > 0 && /* @__PURE__ */ u("div", { class: "custom-models-list", children: [
      /* @__PURE__ */ u("h4", { children: "Custom Models" }),
      customModels.map((model, i) => /* @__PURE__ */ u("div", { class: "custom-model-item", children: [
        /* @__PURE__ */ u("div", { class: "model-info", children: [
          /* @__PURE__ */ u("span", { class: "model-name", children: model.name }),
          /* @__PURE__ */ u("span", { class: "model-url", children: model.baseUrl })
        ] }),
        /* @__PURE__ */ u("button", { class: "btn btn-danger btn-sm", onClick: () => onRemove(i), children: "Remove" })
      ] }, i))
    ] })
  ] });
}
function LicenseTab() {
  var _a, _b;
  const [status, setStatus] = d(null);
  const [keyInput, setKeyInput] = d("");
  const [activating, setActivating] = d(false);
  const [message, setMessage] = d("");
  y(() => {
    chrome.runtime.sendMessage({ type: "GET_LICENSE_STATUS" }, (res) => {
      if (res) setStatus(res);
    });
  }, []);
  const handleActivate = () => {
    if (!keyInput.trim()) return;
    setActivating(true);
    setMessage("");
    chrome.runtime.sendMessage({ type: "ACTIVATE_LICENSE", payload: { key: keyInput.trim() } }, (res) => {
      setActivating(false);
      setMessage(res.message);
      if (res.success) {
        setKeyInput("");
        chrome.runtime.sendMessage({ type: "GET_LICENSE_STATUS" }, (s) => {
          if (s) setStatus(s);
        });
      }
    });
  };
  const handleDeactivate = () => {
    chrome.runtime.sendMessage({ type: "DEACTIVATE_LICENSE" }, () => {
      chrome.runtime.sendMessage({ type: "GET_LICENSE_STATUS" }, (s) => {
        if (s) setStatus(s);
      });
      setMessage("License deactivated.");
    });
  };
  if (!status) return /* @__PURE__ */ u("div", { class: "tab-content", children: /* @__PURE__ */ u("p", { children: "Loading..." }) });
  return /* @__PURE__ */ u("div", { class: "tab-content", children: [
    /* @__PURE__ */ u("div", { class: "provider-section", children: [
      /* @__PURE__ */ u("h4", { children: "Current Plan" }),
      /* @__PURE__ */ u("p", { class: "provider-desc", style: { fontSize: "1.1em", fontWeight: 500 }, children: status.isPro ? /* @__PURE__ */ u(k, { children: [
        /* @__PURE__ */ u("span", { class: "status-badge connected", children: "Pro" }),
        " Unlimited tasks"
      ] }) : /* @__PURE__ */ u(k, { children: [
        /* @__PURE__ */ u("span", { class: "status-badge", children: [
          status.tasksUsed,
          "/",
          status.taskLimit,
          " tasks used"
        ] }),
        " Free tier"
      ] }) })
    ] }),
    !status.isPro && /* @__PURE__ */ u("div", { class: "provider-section", children: [
      /* @__PURE__ */ u("h4", { children: "Upgrade to Pro" }),
      /* @__PURE__ */ u("p", { class: "provider-desc", children: "Unlimited tasks for a one-time payment of $29." }),
      /* @__PURE__ */ u(
        "a",
        {
          href: "https://hanziinchrome.lemonsqueezy.com/checkout/buy/5f9be29a-b862-43bf-a440-b4a3cdc9b28e",
          target: "_blank",
          class: "btn btn-primary",
          style: { display: "inline-block", textDecoration: "none", marginBottom: "12px" },
          children: "Buy Pro — $29"
        }
      )
    ] }),
    /* @__PURE__ */ u("div", { class: "provider-section", children: [
      /* @__PURE__ */ u("h4", { children: status.isPro ? "License Key" : "Activate License" }),
      status.isPro ? /* @__PURE__ */ u("div", { class: "connected-status", children: [
        /* @__PURE__ */ u("code", { style: { fontSize: "0.85em" }, children: [
          (_a = status.key) == null ? void 0 : _a.slice(0, 8),
          "...",
          (_b = status.key) == null ? void 0 : _b.slice(-4)
        ] }),
        /* @__PURE__ */ u("button", { class: "btn btn-secondary btn-sm", onClick: handleDeactivate, children: "Deactivate" })
      ] }) : /* @__PURE__ */ u("div", { class: "api-key-input", children: [
        /* @__PURE__ */ u(
          "input",
          {
            type: "text",
            value: keyInput,
            onInput: (e) => setKeyInput(e.target.value),
            placeholder: "Paste license key...",
            onKeyDown: (e) => e.key === "Enter" && handleActivate()
          }
        ),
        /* @__PURE__ */ u("button", { class: "btn btn-primary", onClick: handleActivate, disabled: activating, children: activating ? "Activating..." : "Activate" })
      ] }),
      message && /* @__PURE__ */ u("p", { class: "provider-desc", style: { marginTop: "8px" }, children: message })
    ] }),
    !status.isPro && /* @__PURE__ */ u("div", { class: "provider-section", children: /* @__PURE__ */ u("p", { class: "provider-desc", style: { opacity: 0.7, fontSize: "0.85em" }, children: [
      "Tip: MCP/CLI users can also set the ",
      /* @__PURE__ */ u("code", { children: "HANZI_IN_CHROME_LICENSE_KEY" }),
      " environment variable."
    ] }) })
  ] });
}
function SkillsTab({ userSkills, builtInSkills, skillForm, setSkillForm, onAdd, onEdit, onRemove }) {
  return /* @__PURE__ */ u("div", { class: "tab-content", children: [
    /* @__PURE__ */ u("p", { class: "tab-desc", children: "Add domain-specific tips to help the AI navigate websites" }),
    /* @__PURE__ */ u(
      "button",
      {
        class: "btn btn-secondary",
        onClick: () => setSkillForm({ ...skillForm, isOpen: true, editIndex: -1, domain: "", skill: "" }),
        children: "+ Add Skill"
      }
    ),
    skillForm.isOpen && /* @__PURE__ */ u("div", { class: "skill-form", children: [
      /* @__PURE__ */ u(
        "input",
        {
          type: "text",
          placeholder: "Domain (e.g., github.com)",
          value: skillForm.domain,
          onInput: (e) => setSkillForm({ ...skillForm, domain: e.target.value })
        }
      ),
      /* @__PURE__ */ u(
        "textarea",
        {
          placeholder: "Tips and guidance for this domain...",
          value: skillForm.skill,
          onInput: (e) => setSkillForm({ ...skillForm, skill: e.target.value }),
          rows: 4
        }
      ),
      /* @__PURE__ */ u("div", { class: "skill-form-actions", children: [
        /* @__PURE__ */ u("button", { class: "btn btn-secondary", onClick: () => setSkillForm({ ...skillForm, isOpen: false }), children: "Cancel" }),
        /* @__PURE__ */ u("button", { class: "btn btn-primary", onClick: onAdd, children: skillForm.editIndex >= 0 ? "Update" : "Add" })
      ] })
    ] }),
    /* @__PURE__ */ u("div", { class: "skills-list", children: [
      userSkills.length > 0 && /* @__PURE__ */ u(k, { children: [
        /* @__PURE__ */ u("h4", { children: "Your Skills" }),
        userSkills.map((skill, i) => /* @__PURE__ */ u("div", { class: "skill-item", children: [
          /* @__PURE__ */ u("div", { class: "skill-domain", children: skill.domain }),
          /* @__PURE__ */ u("div", { class: "skill-preview", children: [
            skill.skill.substring(0, 100),
            "..."
          ] }),
          /* @__PURE__ */ u("div", { class: "skill-actions", children: [
            /* @__PURE__ */ u("button", { class: "btn btn-sm", onClick: () => onEdit(i), children: "Edit" }),
            /* @__PURE__ */ u("button", { class: "btn btn-sm btn-danger", onClick: () => onRemove(i), children: "Delete" })
          ] })
        ] }, i))
      ] }),
      builtInSkills.length > 0 && /* @__PURE__ */ u(k, { children: [
        /* @__PURE__ */ u("h4", { children: "Built-in Skills" }),
        builtInSkills.map((skill, i) => /* @__PURE__ */ u("div", { class: "skill-item builtin", children: [
          /* @__PURE__ */ u("div", { class: "skill-domain", children: skill.domain }),
          /* @__PURE__ */ u("div", { class: "skill-preview", children: [
            skill.skill.substring(0, 100),
            "..."
          ] })
        ] }, i))
      ] })
    ] })
  ] });
}
function PlanModal({ plan, onApprove, onCancel }) {
  return /* @__PURE__ */ u("div", { class: "modal-overlay", children: /* @__PURE__ */ u("div", { class: "modal", children: [
    /* @__PURE__ */ u("div", { class: "modal-header", children: "Review Plan" }),
    /* @__PURE__ */ u("div", { class: "modal-body", children: [
      /* @__PURE__ */ u("div", { class: "plan-section", children: [
        /* @__PURE__ */ u("h4", { children: "Domains to visit:" }),
        /* @__PURE__ */ u("ul", { class: "plan-domains", children: (plan.domains || []).map((domain, i) => /* @__PURE__ */ u("li", { children: domain }, i)) })
      ] }),
      /* @__PURE__ */ u("div", { class: "plan-section", children: [
        /* @__PURE__ */ u("h4", { children: "Approach:" }),
        /* @__PURE__ */ u("ul", { class: "plan-steps", children: (Array.isArray(plan.approach) ? plan.approach : [plan.approach]).map((step, i) => /* @__PURE__ */ u("li", { children: step }, i)) })
      ] })
    ] }),
    /* @__PURE__ */ u("div", { class: "modal-footer", children: [
      /* @__PURE__ */ u("button", { class: "btn btn-secondary", onClick: onCancel, children: "Cancel" }),
      /* @__PURE__ */ u("button", { class: "btn btn-primary", onClick: onApprove, children: "Approve & Continue" })
    ] })
  ] }) });
}
const HUMAN_EXAMPLES = [
  "Summarize my open Jira tickets",
  "Go to LinkedIn and draft a post about today's release",
  "Compare prices for flights to Tokyo next week"
];
const AGENT_EXAMPLES = [
  "Search for recent AI news",
  "Fill out this form with my details",
  "Find the best price for..."
];
function EmptyState({ onSelectExample, primaryMode }) {
  const examples = primaryMode === "agent" ? AGENT_EXAMPLES : HUMAN_EXAMPLES;
  return /* @__PURE__ */ u("div", { class: "empty-state", children: [
    /* @__PURE__ */ u("div", { class: "empty-icon", children: /* @__PURE__ */ u("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.5", children: [
      /* @__PURE__ */ u("circle", { cx: "12", cy: "12", r: "10" }),
      /* @__PURE__ */ u("path", { d: "M12 6v6l4 2" })
    ] }) }),
    /* @__PURE__ */ u("h2", { children: "Hanzi in Chrome" }),
    /* @__PURE__ */ u("p", { children: "Describe what you want to accomplish and the AI will browse autonomously to complete your task." }),
    /* @__PURE__ */ u("div", { class: "empty-examples", children: examples.map((example, i) => /* @__PURE__ */ u(
      "button",
      {
        class: "example-chip",
        onClick: () => onSelectExample(example),
        children: example
      },
      i
    )) })
  ] });
}
function App() {
  const [isSettingsOpen, setIsSettingsOpen] = d(false);
  const [suggestedText, setSuggestedText] = d("");
  const config = useConfig();
  const chat = useChat();
  if (config.isLoading) {
    return /* @__PURE__ */ u("div", { class: "loading-container", children: /* @__PURE__ */ u("div", { class: "loading-spinner" }) });
  }
  if (!config.onboarding.completed) {
    return /* @__PURE__ */ u("div", { class: "app", children: /* @__PURE__ */ u("div", { class: "empty-state", children: [
      /* @__PURE__ */ u("div", { class: "empty-icon", children: /* @__PURE__ */ u("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.5", children: [
        /* @__PURE__ */ u("circle", { cx: "12", cy: "12", r: "10" }),
        /* @__PURE__ */ u("path", { d: "M12 6v6l4 2" })
      ] }) }),
      /* @__PURE__ */ u("h2", { children: "Welcome to Hanzi" }),
      /* @__PURE__ */ u("p", { children: "Complete setup to get started." }),
      /* @__PURE__ */ u(
        "button",
        {
          class: "btn btn-primary",
          onClick: () => chrome.tabs.create({ url: chrome.runtime.getURL("dist/onboarding.html") }),
          children: "Open Setup"
        }
      )
    ] }) });
  }
  const hasMessages = chat.messages.length > 0;
  return /* @__PURE__ */ u("div", { class: "app", children: [
    /* @__PURE__ */ u(
      Header,
      {
        currentModel: config.currentModel,
        availableModels: config.availableModels,
        currentModelIndex: config.currentModelIndex,
        onModelSelect: config.selectModel,
        onNewChat: chat.clearChat,
        onOpenSettings: () => setIsSettingsOpen(true)
      }
    ),
    /* @__PURE__ */ u("div", { class: "messages-container", children: !hasMessages ? /* @__PURE__ */ u(EmptyState, { onSelectExample: setSuggestedText, primaryMode: config.onboarding.primaryMode }) : /* @__PURE__ */ u(
      MessageList,
      {
        messages: chat.messages,
        pendingStep: chat.pendingStep
      }
    ) }),
    /* @__PURE__ */ u(
      InputArea,
      {
        isRunning: chat.isRunning,
        attachedImages: chat.attachedImages,
        onSend: chat.sendMessage,
        onStop: chat.stopTask,
        onAddImage: chat.addImage,
        onRemoveImage: chat.removeImage,
        hasModels: config.availableModels.length > 0,
        suggestedText,
        onClearSuggestion: () => setSuggestedText(""),
        onOpenSettings: () => setIsSettingsOpen(true)
      }
    ),
    isSettingsOpen && /* @__PURE__ */ u(
      SettingsModal,
      {
        config,
        onClose: () => setIsSettingsOpen(false)
      }
    ),
    chat.pendingPlan && /* @__PURE__ */ u(
      PlanModal,
      {
        plan: chat.pendingPlan,
        onApprove: chat.approvePlan,
        onCancel: chat.cancelPlan
      }
    )
  ] });
}
G(/* @__PURE__ */ u(App, {}), document.getElementById("app"));
//# sourceMappingURL=sidepanel.js.map
