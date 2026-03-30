import { d, y, q, C as CODEX_MODELS, P as PROVIDERS, A, u, k, J } from "./providers.js";
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
      } else if (providerId === "vertex" && hasApiKey) {
        let vertexBaseUrl = "";
        try {
          const sa = JSON.parse(hasApiKey);
          const projectId = sa.project_id;
          const region = "us-central1";
          vertexBaseUrl = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}`;
        } catch {
          console.warn("[Config] Invalid Vertex AI service account JSON");
        }
        if (vertexBaseUrl) {
          for (const model of provider.models) {
            models.push({
              name: `${model.name} (Vertex AI)`,
              provider: "google",
              // Use GoogleProvider which handles both
              modelId: model.id,
              baseUrl: vertexBaseUrl,
              apiKey: hasApiKey,
              // The full service account JSON
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
  const [_streamingMessageId, setStreamingMessageId] = d(null);
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
    chrome.runtime.sendMessage({ type: "PLAN_APPROVAL_RESPONSE", payload: { approved: true } }).catch(() => {
    });
    setPendingPlan(null);
  }, []);
  const cancelPlan = q(() => {
    chrome.runtime.sendMessage({ type: "PLAN_APPROVAL_RESPONSE", payload: { approved: false } }).catch(() => {
    });
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
  const handleKeyDown = (e) => {
    if (!isDropdownOpen) return;
    if (e.key === "Escape") {
      setIsDropdownOpen(false);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const direction = e.key === "ArrowDown" ? 1 : -1;
      const newIndex = Math.max(0, Math.min(availableModels.length - 1, currentModelIndex + direction));
      onModelSelect(newIndex);
    }
    if (e.key === "Enter" && isDropdownOpen) {
      setIsDropdownOpen(false);
    }
  };
  return /* @__PURE__ */ u("div", { class: "header", children: [
    /* @__PURE__ */ u("div", { class: "header-left", children: /* @__PURE__ */ u("div", { class: "model-selector", ref: dropdownRef, children: [
      /* @__PURE__ */ u(
        "button",
        {
          class: "model-selector-btn",
          onClick: () => availableModels.length > 0 && setIsDropdownOpen(!isDropdownOpen),
          onKeyDown: handleKeyDown,
          "aria-expanded": isDropdownOpen,
          "aria-haspopup": availableModels.length > 0 ? "listbox" : void 0,
          "aria-label": `Model: ${(currentModel == null ? void 0 : currentModel.name) || "Select Model"}${availableModels.length > 0 ? ". Click to change." : ""}`,
          style: availableModels.length === 0 ? { cursor: "default" } : void 0,
          children: [
            /* @__PURE__ */ u("span", { class: "current-model-name", children: (currentModel == null ? void 0 : currentModel.name) || "Select Model" }),
            availableModels.length > 0 && /* @__PURE__ */ u("svg", { class: "chevron", width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", children: /* @__PURE__ */ u("path", { d: "M6 9l6 6 6-6" }) })
          ]
        }
      ),
      isDropdownOpen && /* @__PURE__ */ u("div", { class: "model-dropdown", role: "listbox", "aria-label": "Select model", children: /* @__PURE__ */ u("div", { class: "model-list", role: "presentation", children: availableModels.length === 0 ? /* @__PURE__ */ u("div", { class: "model-item disabled", children: "No models configured" }) : availableModels.map((model, index) => /* @__PURE__ */ u(
        "button",
        {
          class: `model-item ${index === currentModelIndex ? "active" : ""}`,
          onClick: () => handleModelSelect(index),
          role: "option",
          "aria-selected": index === currentModelIndex,
          children: model.name
        },
        index
      )) }) })
    ] }) }),
    /* @__PURE__ */ u("div", { class: "header-right", children: [
      /* @__PURE__ */ u("button", { class: "icon-btn", onClick: () => {
        if (!document.querySelector(".messages .message") || confirm("Clear current chat?")) onNewChat();
      }, title: "New chat", "aria-label": "New chat", children: /* @__PURE__ */ u("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", children: /* @__PURE__ */ u("path", { d: "M12 5v14M5 12h14" }) }) }),
      /* @__PURE__ */ u("button", { class: "icon-btn", onClick: onOpenSettings, title: "Settings", "aria-label": "Settings", children: /* @__PURE__ */ u("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", children: [
        /* @__PURE__ */ u("circle", { cx: "12", cy: "12", r: "3" }),
        /* @__PURE__ */ u("path", { d: "M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" })
      ] }) })
    ] })
  ] });
}
function formatMarkdown(text) {
  if (!text) return "";
  const lines = text.split("\n");
  const result = [];
  const state = { inList: false, listType: null };
  for (const line of lines) {
    const ulMatch = line.match(/^[-*]\s+(.+)$/);
    const olMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (ulMatch) {
      openList(result, state, "ul");
      result.push(`<li>${formatInline(ulMatch[1])}</li>`);
    } else if (olMatch) {
      openList(result, state, "ol");
      result.push(`<li>${formatInline(olMatch[2])}</li>`);
    } else {
      closeList(result, state);
      result.push(line.trim() === "" ? "<br>" : `<p>${formatInline(line)}</p>`);
    }
  }
  closeListTag(result, state);
  return result.join("");
}
function closeListTag(result, state) {
  if (state.inList) result.push(state.listType === "ol" ? "</ol>" : "</ul>");
}
function openList(result, state, type) {
  if (state.inList && state.listType === type) return;
  closeListTag(result, state);
  result.push(type === "ol" ? "<ol>" : "<ul>");
  state.inList = true;
  state.listType = type;
}
function closeList(result, state) {
  if (!state.inList) return;
  closeListTag(result, state);
  state.inList = false;
  state.listType = null;
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
    return /* @__PURE__ */ u("div", { class: "message assistant streaming", "aria-live": "polite", "aria-atomic": "false", children: [
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
  const [isExpanded, setIsExpanded] = d(!!pendingStep);
  y(() => {
    if (pendingStep) setIsExpanded(true);
  }, [pendingStep]);
  const totalSteps = steps.length + (pendingStep ? 1 : 0);
  if (totalSteps === 0) return null;
  return /* @__PURE__ */ u("div", { class: "steps-section", children: [
    /* @__PURE__ */ u(
      "button",
      {
        class: `steps-toggle ${isExpanded ? "expanded" : ""}`,
        onClick: () => setIsExpanded(!isExpanded),
        "aria-expanded": isExpanded,
        "aria-label": `${steps.length} steps completed${pendingStep ? ", 1 in progress" : ""}. Click to ${isExpanded ? "collapse" : "expand"}.`,
        type: "button",
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
    const target = e.target;
    requestAnimationFrame(() => {
      target.style.height = "auto";
      target.style.height = Math.min(target.scrollHeight, 150) + "px";
    });
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
              rows: 1,
              "aria-label": "Task description"
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
function useFocusTrap(active = true) {
  const containerRef = A(null);
  y(() => {
    if (!active || !containerRef.current) return;
    const container = containerRef.current;
    const previouslyFocused = document.activeElement;
    const getFocusable = () => {
      return container.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
    };
    const focusable = getFocusable();
    if (focusable.length > 0) {
      focusable[0].focus();
    }
    const handleKeyDown = (e) => {
      if (e.key !== "Tab") return;
      const elements = getFocusable();
      if (elements.length === 0) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    container.addEventListener("keydown", handleKeyDown);
    return () => {
      container.removeEventListener("keydown", handleKeyDown);
      if (previouslyFocused && previouslyFocused.focus) {
        previouslyFocused.focus();
      }
    };
  }, [active]);
  return containerRef;
}
function SettingsModal({ config, onClose }) {
  const [activeTab, setActiveTab] = d("providers");
  const [selectedProvider, setSelectedProvider] = d(null);
  const [localKeys, setLocalKeys] = d({ ...config.providerKeys });
  const [newCustomModel, setNewCustomModel] = d({ name: "", baseUrl: "", modelId: "", apiKey: "" });
  const [skillForm, setSkillForm] = d({ domain: "", skill: "", isOpen: false, editIndex: -1 });
  const [formError, setFormError] = d("");
  const [managedStatus, setManagedStatus] = d(null);
  const trapRef = useFocusTrap(true);
  y(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onClose]);
  y(() => {
    chrome.runtime.sendMessage({ type: "GET_MANAGED_STATUS" }, (res) => {
      if (res) setManagedStatus(res);
    });
    const listener = (changes) => {
      if (changes.managed_session_token) {
        chrome.runtime.sendMessage({ type: "GET_MANAGED_STATUS" }, (res) => {
          if (res) setManagedStatus(res);
        });
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
  const handleSave = async () => {
    for (const [provider, key] of Object.entries(localKeys)) {
      if (key !== config.providerKeys[provider]) {
        config.setProviderKey(provider, key);
      }
    }
    await config.saveConfig();
    onClose();
  };
  const handleAddCustomModel = () => {
    if (!newCustomModel.name || !newCustomModel.baseUrl || !newCustomModel.modelId) {
      setFormError("Please fill in name, base URL, and model ID");
      return;
    }
    setFormError("");
    config.addCustomModel({ ...newCustomModel });
    setNewCustomModel({ name: "", baseUrl: "", modelId: "", apiKey: "" });
  };
  const handleAddSkill = () => {
    if (!skillForm.domain || !skillForm.skill) {
      setFormError("Please fill in both domain and tips/guidance");
      return;
    }
    setFormError("");
    config.addUserSkill({ domain: skillForm.domain.toLowerCase(), skill: skillForm.skill });
    setSkillForm({ domain: "", skill: "", isOpen: false, editIndex: -1 });
  };
  const handleEditSkill = (index) => {
    const skill = config.userSkills[index];
    setSkillForm({ domain: skill.domain, skill: skill.skill, isOpen: true, editIndex: index });
  };
  const isPaired = managedStatus == null ? void 0 : managedStatus.isManaged;
  if (isPaired) {
    const handleDisconnect = () => {
      chrome.runtime.sendMessage({ type: "MANAGED_DISCONNECT" }, () => {
        setManagedStatus({ isManaged: false, browserSessionId: null });
      });
    };
    return /* @__PURE__ */ u("div", { class: "modal-overlay", onClick: (e) => e.target === e.currentTarget && onClose(), children: /* @__PURE__ */ u("div", { class: "modal settings-modal", role: "dialog", "aria-modal": "true", "aria-label": "Settings", ref: trapRef, children: [
      /* @__PURE__ */ u("div", { class: "modal-header", children: [
        /* @__PURE__ */ u("span", { children: "Settings" }),
        /* @__PURE__ */ u("button", { class: "close-btn", onClick: onClose, "aria-label": "Close settings", children: "×" })
      ] }),
      /* @__PURE__ */ u("div", { class: "modal-body", children: /* @__PURE__ */ u("div", { class: "provider-section", children: [
        /* @__PURE__ */ u("div", { class: "connected-status", children: [
          /* @__PURE__ */ u("span", { class: "status-badge connected", children: "Connected" }),
          /* @__PURE__ */ u("span", { style: { fontSize: "14px", marginLeft: "8px" }, children: "Hanzi Managed" })
        ] }),
        /* @__PURE__ */ u("p", { class: "provider-desc", style: { marginTop: "12px" }, children: "Your browser is connected to Hanzi's managed AI service. Tasks you run in the sidepanel use your managed account." }),
        /* @__PURE__ */ u("button", { class: "btn btn-secondary btn-sm", onClick: handleDisconnect, style: { marginTop: "8px" }, children: "Disconnect" })
      ] }) }),
      /* @__PURE__ */ u("div", { class: "modal-footer", children: /* @__PURE__ */ u("button", { class: "btn btn-primary", onClick: onClose, children: "Done" }) })
    ] }) });
  }
  return /* @__PURE__ */ u("div", { class: "modal-overlay", onClick: (e) => e.target === e.currentTarget && onClose(), children: /* @__PURE__ */ u("div", { class: "modal settings-modal", role: "dialog", "aria-modal": "true", "aria-label": "Settings", ref: trapRef, children: [
    /* @__PURE__ */ u("div", { class: "modal-header", children: [
      /* @__PURE__ */ u("span", { children: "Settings" }),
      /* @__PURE__ */ u("button", { class: "close-btn", onClick: onClose, "aria-label": "Close settings", children: "×" })
    ] }),
    /* @__PURE__ */ u("div", { class: "tabs", children: [
      /* @__PURE__ */ u(
        "button",
        {
          class: `tab ${activeTab === "providers" ? "active" : ""}`,
          onClick: () => setActiveTab("providers"),
          children: "Connections"
        }
      ),
      /* @__PURE__ */ u(
        "button",
        {
          class: `tab ${activeTab === "skills" ? "active" : ""}`,
          onClick: () => setActiveTab("skills"),
          children: "Site Tips"
        }
      )
    ] }),
    /* @__PURE__ */ u("div", { class: "modal-body", children: [
      activeTab === "providers" && /* @__PURE__ */ u(
        ConnectionsTab,
        {
          localKeys,
          setLocalKeys,
          selectedProvider,
          setSelectedProvider,
          config,
          newCustomModel,
          setNewCustomModel,
          onAddCustomModel: handleAddCustomModel,
          formError
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
          onRemove: config.removeUserSkill,
          formError
        }
      )
    ] }),
    /* @__PURE__ */ u("div", { class: "modal-footer", children: [
      /* @__PURE__ */ u("button", { class: "btn btn-secondary", onClick: onClose, children: "Close" }),
      /* @__PURE__ */ u("button", { class: "btn btn-primary", onClick: handleSave, children: "Save" })
    ] })
  ] }) });
}
function ConnectionsTab({
  localKeys,
  setLocalKeys,
  selectedProvider,
  setSelectedProvider,
  config,
  newCustomModel,
  setNewCustomModel,
  onAddCustomModel,
  formError
}) {
  return /* @__PURE__ */ u("div", { class: "tab-content", children: [
    /* @__PURE__ */ u("div", { class: "provider-section", children: [
      /* @__PURE__ */ u("h4", { children: "Hanzi Managed" }),
      /* @__PURE__ */ u("p", { class: "provider-desc", children: "We handle the AI. 20 free tasks/month, then $0.05/task. No API key needed." }),
      /* @__PURE__ */ u(
        "a",
        {
          class: "btn btn-primary",
          href: "https://api.hanzilla.co/pair-self",
          target: "_blank",
          rel: "noreferrer",
          style: { textDecoration: "none" },
          children: "Sign in & connect"
        }
      )
    ] }),
    /* @__PURE__ */ u("hr", {}),
    /* @__PURE__ */ u("div", { class: "provider-section", children: [
      /* @__PURE__ */ u("h4", { children: "Bring your own model" }),
      /* @__PURE__ */ u("p", { class: "provider-desc", children: "Use your existing AI subscription. Free forever." })
    ] }),
    /* @__PURE__ */ u("div", { class: "provider-section", children: [
      /* @__PURE__ */ u("h4", { children: "Claude" }),
      /* @__PURE__ */ u("p", { class: "provider-desc", children: [
        "Use your Claude Pro/Max subscription via ",
        /* @__PURE__ */ u("code", { children: "claude login" })
      ] }),
      config.oauthStatus.isAuthenticated ? /* @__PURE__ */ u("div", { class: "connected-status", children: [
        /* @__PURE__ */ u("span", { class: "status-badge connected", children: "Connected" }),
        /* @__PURE__ */ u("button", { class: "btn btn-secondary btn-sm", onClick: config.logoutCLI, children: "Disconnect" })
      ] }) : /* @__PURE__ */ u("button", { class: "btn btn-primary", onClick: config.importCLI, children: "Import from claude login" })
    ] }),
    /* @__PURE__ */ u("div", { class: "provider-section", children: [
      /* @__PURE__ */ u("h4", { children: "Codex" }),
      /* @__PURE__ */ u("p", { class: "provider-desc", children: [
        "Use your ChatGPT Pro/Plus subscription via ",
        /* @__PURE__ */ u("code", { children: "codex login" })
      ] }),
      config.codexStatus.isAuthenticated ? /* @__PURE__ */ u("div", { class: "connected-status", children: [
        /* @__PURE__ */ u("span", { class: "status-badge connected", children: "Connected" }),
        /* @__PURE__ */ u("button", { class: "btn btn-secondary btn-sm", onClick: config.logoutCodex, children: "Disconnect" })
      ] }) : /* @__PURE__ */ u("button", { class: "btn btn-primary", onClick: config.importCodex, children: "Import from codex login" })
    ] }),
    /* @__PURE__ */ u("hr", {}),
    /* @__PURE__ */ u("h4", { children: "API Keys" }),
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
        " ",
        selectedProvider === "vertex" ? "Service Account JSON" : "API Key"
      ] }),
      selectedProvider === "vertex" ? /* @__PURE__ */ u(
        "textarea",
        {
          value: localKeys[selectedProvider] || "",
          onInput: (e) => setLocalKeys({ ...localKeys, [selectedProvider]: e.target.value }),
          placeholder: "Paste the entire service account JSON file contents here...",
          rows: 4,
          style: { fontFamily: "monospace", fontSize: "0.8em" }
        }
      ) : /* @__PURE__ */ u(
        "input",
        {
          type: "password",
          value: localKeys[selectedProvider] || "",
          onInput: (e) => setLocalKeys({ ...localKeys, [selectedProvider]: e.target.value }),
          placeholder: "Enter API key..."
        }
      )
    ] }),
    /* @__PURE__ */ u("details", { class: "advanced-section", style: { marginTop: "16px" }, children: [
      /* @__PURE__ */ u("summary", { children: "Custom endpoint (Ollama, LM Studio, etc.)" }),
      /* @__PURE__ */ u("div", { class: "custom-model-form", style: { marginTop: "12px" }, children: [
        /* @__PURE__ */ u(
          "input",
          {
            type: "text",
            placeholder: "Display Name",
            value: newCustomModel.name,
            onInput: (e) => setNewCustomModel({ ...newCustomModel, name: e.target.value })
          }
        ),
        /* @__PURE__ */ u(
          "input",
          {
            type: "text",
            placeholder: "Base URL (e.g. http://localhost:11434/v1)",
            value: newCustomModel.baseUrl,
            onInput: (e) => setNewCustomModel({ ...newCustomModel, baseUrl: e.target.value })
          }
        ),
        /* @__PURE__ */ u(
          "input",
          {
            type: "text",
            placeholder: "Model ID",
            value: newCustomModel.modelId,
            onInput: (e) => setNewCustomModel({ ...newCustomModel, modelId: e.target.value })
          }
        ),
        /* @__PURE__ */ u(
          "input",
          {
            type: "password",
            placeholder: "API Key (optional)",
            value: newCustomModel.apiKey,
            onInput: (e) => setNewCustomModel({ ...newCustomModel, apiKey: e.target.value })
          }
        ),
        formError && /* @__PURE__ */ u("p", { class: "provider-desc", style: { color: "var(--color-error)", marginBottom: "8px" }, children: formError }),
        /* @__PURE__ */ u(
          "button",
          {
            class: "btn btn-primary",
            onClick: onAddCustomModel,
            disabled: !newCustomModel.name || !newCustomModel.baseUrl || !newCustomModel.modelId,
            children: "Add"
          }
        )
      ] }),
      config.customModels.length > 0 && /* @__PURE__ */ u("div", { class: "custom-models-list", children: config.customModels.map((model, i) => /* @__PURE__ */ u("div", { class: "custom-model-item", children: [
        /* @__PURE__ */ u("div", { class: "model-info", children: [
          /* @__PURE__ */ u("span", { class: "model-name", children: model.name }),
          /* @__PURE__ */ u("span", { class: "model-url", children: model.baseUrl })
        ] }),
        /* @__PURE__ */ u("button", { class: "btn btn-danger btn-sm", onClick: () => config.removeCustomModel(i), children: "Remove" })
      ] }, i)) })
    ] })
  ] });
}
function SkillsTab({ userSkills, builtInSkills, skillForm, setSkillForm, onAdd, onEdit, onRemove, formError }) {
  return /* @__PURE__ */ u("div", { class: "tab-content", children: [
    /* @__PURE__ */ u("p", { class: "tab-desc", children: "Teach Hanzi how to navigate specific websites better" }),
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
      formError && /* @__PURE__ */ u("p", { class: "provider-desc", style: { color: "var(--color-error)", marginBottom: "8px" }, children: formError }),
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
  y(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onCancel]);
  const trapRef = useFocusTrap(true);
  return /* @__PURE__ */ u("div", { class: "modal-overlay", onClick: (e) => e.target === e.currentTarget && onCancel(), children: /* @__PURE__ */ u("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": "Review plan", ref: trapRef, children: [
    /* @__PURE__ */ u("div", { class: "modal-header", children: [
      /* @__PURE__ */ u("span", { children: "Review Plan" }),
      /* @__PURE__ */ u("button", { class: "close-btn", onClick: onCancel, "aria-label": "Close plan review", children: "×" })
    ] }),
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
  "Check the staging deployment for errors",
  "Fill out this form with my details",
  "Read the docs and summarize the setup steps"
];
function EmptyState({ onSelectExample, primaryMode }) {
  const examples = primaryMode === "agent" ? AGENT_EXAMPLES : HUMAN_EXAMPLES;
  return /* @__PURE__ */ u("div", { class: "empty-state", children: [
    /* @__PURE__ */ u("div", { class: "empty-icon", children: /* @__PURE__ */ u("svg", { viewBox: "0 0 24 24", fill: "none", xmlns: "http://www.w3.org/2000/svg", children: [
      /* @__PURE__ */ u("rect", { width: "24", height: "24", rx: "6", fill: "currentColor" }),
      /* @__PURE__ */ u("path", { d: "M7 7v10M17 7v10M7 12h10", stroke: "var(--bg-primary)", "stroke-width": "2.5", "stroke-linecap": "round" })
    ] }) }),
    /* @__PURE__ */ u("h2", { children: "What should we browse?" }),
    /* @__PURE__ */ u("p", { children: "Tell Hanzi what to do and it will take over the browser." }),
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
  const [isManaged, setIsManaged] = d(false);
  const config = useConfig();
  const chat = useChat();
  y(() => {
    chrome.runtime.sendMessage({ type: "GET_MANAGED_STATUS" }, (res) => {
      if (res == null ? void 0 : res.isManaged) setIsManaged(true);
    });
    const listener = (changes) => {
      if (changes.managed_session_token) {
        setIsManaged(!!changes.managed_session_token.newValue);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
  y(() => {
    const handleKeyboard = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        chat.clearChat();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setIsSettingsOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", handleKeyboard);
    return () => document.removeEventListener("keydown", handleKeyboard);
  }, [chat]);
  if (config.isLoading) {
    return /* @__PURE__ */ u("div", { class: "loading-container", children: /* @__PURE__ */ u("div", { class: "loading-spinner" }) });
  }
  if (config.availableModels.length === 0 && !isManaged) {
    return /* @__PURE__ */ u("div", { class: "app", children: [
      /* @__PURE__ */ u("div", { class: "empty-state", children: [
        /* @__PURE__ */ u("div", { class: "empty-icon", children: /* @__PURE__ */ u("svg", { viewBox: "0 0 24 24", fill: "none", xmlns: "http://www.w3.org/2000/svg", children: [
          /* @__PURE__ */ u("rect", { width: "24", height: "24", rx: "6", fill: "currentColor" }),
          /* @__PURE__ */ u("path", { d: "M7 7v10M17 7v10M7 12h10", stroke: "var(--bg-primary)", "stroke-width": "2.5", "stroke-linecap": "round" })
        ] }) }),
        /* @__PURE__ */ u("h2", { children: "Almost ready" }),
        /* @__PURE__ */ u("p", { children: "Connect a model to start browsing. The fastest way:" }),
        /* @__PURE__ */ u("div", { style: { display: "flex", flexDirection: "column", gap: "8px", alignItems: "center", marginTop: "8px" }, children: [
          /* @__PURE__ */ u("code", { style: { padding: "8px 14px", background: "var(--bg-tertiary)", borderRadius: "8px", fontSize: "13px" }, children: "npx hanzi-browse setup" }),
          /* @__PURE__ */ u(
            "button",
            {
              class: "btn btn-secondary",
              onClick: () => setIsSettingsOpen(true),
              children: "Or connect manually"
            }
          )
        ] })
      ] }),
      isSettingsOpen && /* @__PURE__ */ u(
        SettingsModal,
        {
          config,
          onClose: () => setIsSettingsOpen(false)
        }
      )
    ] });
  }
  const hasMessages = chat.messages.length > 0;
  return /* @__PURE__ */ u("div", { class: "app", children: [
    /* @__PURE__ */ u(
      Header,
      {
        currentModel: isManaged ? { name: "Hanzi Managed" } : config.currentModel,
        availableModels: isManaged ? [] : config.availableModels,
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
        hasModels: config.availableModels.length > 0 || isManaged,
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
J(/* @__PURE__ */ u(App, {}), document.getElementById("app"));
//# sourceMappingURL=sidepanel.js.map
