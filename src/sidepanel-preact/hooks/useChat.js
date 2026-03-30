import { useState, useEffect, useCallback, useRef } from 'preact/hooks';

export function useChat() {
  const [messages, setMessages] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [attachedImages, setAttachedImages] = useState([]);
  const [sessionTabGroupId, setSessionTabGroupId] = useState(null);
  const [pendingPlan, setPendingPlan] = useState(null);

  // Steps tracking for current task
  const [pendingStep, setPendingStep] = useState(null);
  const currentStepsRef = useRef([]);

  // Streaming state
  const streamingTextRef = useRef('');
  const [_streamingMessageId, setStreamingMessageId] = useState(null);

  // Listen for messages from service worker
  useEffect(() => {
    const listener = (message) => {
      switch (message.type) {
        case 'TASK_UPDATE':
          handleTaskUpdate(message.update);
          break;
        case 'TASK_COMPLETE':
          handleTaskComplete(message.result);
          break;
        case 'TASK_ERROR':
          handleTaskError(message.error);
          break;
        case 'PLAN_APPROVAL_REQUIRED':
          setPendingPlan(message.plan);
          break;
        case 'SESSION_GROUP_UPDATE':
          setSessionTabGroupId(message.tabGroupId);
          break;
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const handleTaskUpdate = useCallback((update) => {
    if (update.status === 'thinking') {
      // Show thinking indicator - add a thinking message
      setMessages(prev => {
        const filtered = prev.filter(m => m.type !== 'thinking');
        return [...filtered, { id: Date.now(), type: 'thinking' }];
      });
      setStreamingMessageId(null);
      streamingTextRef.current = '';
    } else if (update.status === 'streaming' && update.text) {
      // Remove thinking indicator and update streaming message
      streamingTextRef.current = update.text;
      setMessages(prev => {
        const filtered = prev.filter(m => m.type !== 'thinking');
        const existingStreamingIndex = filtered.findIndex(m => m.type === 'streaming');

        if (existingStreamingIndex >= 0) {
          const updated = [...filtered];
          updated[existingStreamingIndex] = {
            ...updated[existingStreamingIndex],
            text: update.text,
          };
          return updated;
        } else {
          const msgId = Date.now();
          setStreamingMessageId(msgId);
          return [...filtered, {
            id: msgId,
            type: 'streaming',
            text: update.text,
          }];
        }
      });
    } else if (update.status === 'executing') {
      // Remove thinking indicator, store pending step
      setMessages(prev => prev.filter(m => m.type !== 'thinking'));
      setPendingStep({ tool: update.tool, input: update.input });
    } else if (update.status === 'executed') {
      // Add completed step to ref
      currentStepsRef.current = [...currentStepsRef.current, {
        tool: update.tool,
        input: pendingStep?.input || update.input,
        result: update.result,
      }];
      setPendingStep(null);
    } else if (update.status === 'message' && update.text) {
      // Finalize message with its steps
      const stepsForMessage = [...currentStepsRef.current];
      currentStepsRef.current = []; // Reset for next turn
      setMessages(prev => {
        const filtered = prev.filter(m => m.type !== 'thinking' && m.type !== 'streaming');
        return [...filtered, {
          id: Date.now(),
          type: 'assistant',
          text: update.text,
          steps: stepsForMessage, // Attach steps to this message
        }];
      });
      setStreamingMessageId(null);
      streamingTextRef.current = '';
    }
  }, [pendingStep]);

  const handleTaskComplete = useCallback((result) => {
    setIsRunning(false);
    setMessages(prev => prev.filter(m => m.type !== 'thinking'));
    setStreamingMessageId(null);
    streamingTextRef.current = '';

    if (result.message && !result.success) {
      setMessages(prev => [...prev, {
        id: Date.now(),
        type: 'system',
        text: result.message,
      }]);
    }
  }, []);

  const handleTaskError = useCallback((error) => {
    setIsRunning(false);
    setMessages(prev => {
      const filtered = prev.filter(m => m.type !== 'thinking' && m.type !== 'streaming');
      return [...filtered, {
        id: Date.now(),
        type: 'error',
        text: `Error: ${error}`,
      }];
    });
    setStreamingMessageId(null);
    streamingTextRef.current = '';
  }, []);

  const sendMessage = useCallback(async (text) => {
    if (!text.trim() || isRunning) return;

    // Add user message
    const userMessage = {
      id: Date.now(),
      type: 'user',
      text,
      images: [...attachedImages],
    };
    setMessages(prev => [...prev, userMessage]);

    // Clear attached images and reset steps
    const imagesToSend = [...attachedImages];
    setAttachedImages([]);
    currentStepsRef.current = [];
    setPendingStep(null);

    // Get active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      setMessages(prev => [...prev, {
        id: Date.now(),
        type: 'error',
        text: 'No active tab found',
      }]);
      return;
    }

    setIsRunning(true);

    try {
      await chrome.runtime.sendMessage({
        type: 'START_TASK',
        payload: {
          tabId: tab.id,
          task: text,
          askBeforeActing: false,
          images: imagesToSend,
          tabGroupId: sessionTabGroupId,
        },
      });
    } catch (error) {
      setMessages(prev => [...prev, {
        id: Date.now(),
        type: 'error',
        text: `Error: ${error.message}`,
      }]);
      setIsRunning(false);
    }
  }, [isRunning, attachedImages, sessionTabGroupId]);

  const stopTask = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'STOP_TASK' }).catch(() => {});
    setIsRunning(false);
  }, []);

  const clearChat = useCallback(() => {
    setMessages([]);
    currentStepsRef.current = [];
    setPendingStep(null);
    setStreamingMessageId(null);
    streamingTextRef.current = '';
    setSessionTabGroupId(null);
    chrome.runtime.sendMessage({ type: 'CLEAR_CONVERSATION' }).catch(() => {});
  }, []);

  const approvePlan = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'PLAN_APPROVAL_RESPONSE', payload: { approved: true } }).catch(() => {});
    setPendingPlan(null);
  }, []);

  const cancelPlan = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'PLAN_APPROVAL_RESPONSE', payload: { approved: false } }).catch(() => {});
    setPendingPlan(null);
  }, []);

  const addImage = useCallback((dataUrl) => {
    setAttachedImages(prev => [...prev, dataUrl]);
  }, []);

  const removeImage = useCallback((index) => {
    setAttachedImages(prev => prev.filter((_, i) => i !== index));
  }, []);

  const clearImages = useCallback(() => {
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
    clearImages,
  };
}
