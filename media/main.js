// @ts-check

// This script will be run within the webview itself
// It cannot access the main VS Code APIs directly.

(function () {
    /**
     * @typedef {{sender:string,message:string}} NaruhoHistoryEntry
     */
    /** @type {Record<string, NaruhoHistoryEntry[]> | undefined} */
    // @ts-ignore augment window
    window.__naruhodocsAllHistories;

    /** @type {string | undefined} */
    let activeThreadId = undefined;
    /** @type {Array<any>} */
    let threads = [];
    /** @type {Record<string, 'beginner' | 'developer'>} */
    let threadModes = {};
    // Global declarations for libraries loaded via script tags
    // @ts-ignore: mermaid is loaded as a global script
    const mermaidLib = window.mermaid;
    // @ts-ignore: acquireVsCodeApi is provided by VS Code webview
    const vscode = acquireVsCodeApi();
    /**
+     * Atomically replace the chat messages with normalized history.
+     * Hoisted function so early handler can call it without TS error.
+     * @param {Array<{sender?: string, message?: string}>} history
+     */
    // Track a simple hash of the currently rendered history to avoid unnecessary full re-renders
    let lastHistorySignature = '';
    /** Build a stable signature for a history array */
    /** @param {Array<{sender?:string,message?:string}>} history */
    function signatureFor(history) {
        try {
            if (!Array.isArray(history)) { return 'na'; }
            return history.map(h => (h.sender||'') + '::' + (h.message||'')).join('\u0001');
        } catch { return 'err'; }
    }
    /**
     * Flicker-free atomic replacement of chat history using an off-DOM buffer.
     * Applies a fade transition only when content actually changes.
     */
    /** @param {Array<{sender?:string,message?:string}>} history */
    function setFullHistory(history) {
        if (!chatMessages) { return; }
        const sig = signatureFor(history);
        console.log('[NaruhoDocs] setFullHistory called with signature:', sig, 'current:', lastHistorySignature);
        if (sig === lastHistorySignature) {
            // Skip redundant render
            console.log('[NaruhoDocs] setFullHistory: skipping redundant render');
            return;
        }
        lastHistorySignature = sig;
        // Off-DOM construction
        const frag = document.createDocumentFragment();
        if (Array.isArray(history)) {
            console.log('[NaruhoDocs] setFullHistory: building', history.length, 'messages');
            history.forEach(function (entry) {
                if (!entry || typeof entry !== 'object') { return; }
                const messageElement = buildMessageElement(entry.sender || 'Bot', entry.message || '');
                frag.appendChild(messageElement);
            });
        }
        // Use a temporary wrapper to allow fade-out/in without flashing empty state
        chatMessages.style.opacity = '0';
        // Microtask to allow CSS opacity transition (if defined in CSS) before DOM swap
        setTimeout(() => {
            console.log('[NaruhoDocs] setFullHistory: clearing and replacing chat messages');
            chatMessages.innerHTML = '';
            chatMessages.appendChild(frag);
            chatMessages.scrollTop = chatMessages.scrollHeight;
            requestAnimationFrame(() => { chatMessages.style.opacity = '1'; });
            try { vscode.setState(null); } catch { /* ignore */ }
            persistState();
        }, 0);
    }
    
    (function registerEarlyHandlers() {
        window.addEventListener('message', (e) => {
            const msg = e.data || {};
            if (msg.type === 'threadList') {
                threads = msg.threads || [];
                activeThreadId = msg.activeThreadId;
                // renderThreadListMenu is a hoisted function — safe to call
                try { renderThreadListMenu(); } catch (err) { /* ignore until rest of UI attaches */ }
            } else if (msg.type === 'allThreadHistories') {
                // Cache of all histories by thread id for instant reuse
                try {
                    /** @type {Record<string, NaruhoHistoryEntry[]>} */
                    // @ts-ignore
                    const store = (window.__naruhodocsAllHistories = window.__naruhodocsAllHistories || {});
                    if (msg.histories && typeof msg.histories === 'object') {
                        Object.keys(msg.histories).forEach(function (k) {
                            const arr = msg.histories[k];
                            if (Array.isArray(arr)) { store[k] = arr; }
                        });
                    }
                    if (activeThreadId && chatMessages && !chatMessages.innerHTML.trim() && store[activeThreadId]) {
                        chatMessages.innerHTML = '';
                        store[activeThreadId].forEach(function (entry) { if (entry) { addMessage(entry.sender || 'Bot', entry.message || ''); } });
                    }
                } catch (err) { console.warn('[NaruhoDocs] Failed to apply allThreadHistories:', err); }
            } else if (msg.type === 'toggleGeneralTabUI') {
                const gb = document.getElementById('general-buttons');
                if (gb) { gb.style.display = msg.visible ? 'flex' : 'none'; }
            } else if (msg.type === 'clearMessages') {
                const cm = document.getElementById('chat-messages');
                if (cm) { cm.innerHTML = ''; }
            } else if (msg.type === 'setFullHistory') {
                // Handle normalized history objects early (sender/message) to avoid losing general thread on fast loads
                const hist = Array.isArray(msg.history) ? msg.history : [];
                console.debug('[NaruhoDocs] setFullHistory received (early) length=', hist.length);
                const chatEl = document.getElementById('chat-messages');
                if (hist.length && (hist[0].sender || hist[0].message)) {
                    setFullHistory(hist);
                    try {
                        /** @type {Record<string, NaruhoHistoryEntry[]>} */
                        // @ts-ignore
                        const store = (window.__naruhodocsAllHistories = window.__naruhodocsAllHistories || {});
                        if (activeThreadId) { store[activeThreadId] = hist.slice(); }
                    } catch { /* ignore */ }
                } else if (typeof showHistory === 'function') {
                    // Fallback to legacy raw format
                    showHistory(hist);
                }
            }
        }, false);

        // Announce ready so extension can safely send restored history / thread list
        /** @returns {string} */
        function computeDisplayedSignature() {
            if (!chatMessages) { return ''; }
            try {
                /** @type {string[]} */
                const parts = [];
                const nodes = chatMessages.querySelectorAll('.message');
                nodes.forEach(function (el) {
                    let sender = 'Bot';
                    if (el.classList.contains('user')) { sender = 'You'; }
                    else if (el.classList.contains('system')) { sender = 'System'; }
                    const text = el.textContent || '';
                    parts.push(sender + '::' + text);
                });
                return parts.join('\u0001');
            } catch { return ''; }
        }
        try {
            const historySignature = computeDisplayedSignature();
            vscode.postMessage({ type: 'chatViewReady', historySignature });
        } catch (e) {
            console.warn('[NaruhoDocs] Failed to post chatViewReady early:', e);
        }
    })();

    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input'); // HTMLTextAreaElement
    
    console.log('[NaruhoDocs] DOM elements found:', {
        chatMessages: !!chatMessages,
        chatInput: !!chatInput,
        chatMessagesId: chatMessages?.id,
        chatMessagesClass: chatMessages?.className
    });
    const sendIcon = document.getElementById('send-icon');
    const hamburgerMenu = document.getElementById('hamburger-menu');
    const dropdownContainer = document.getElementById('dropdown-container');
    const threadListMenu = document.getElementById('thread-list-menu');
    const currentDocName = document.getElementById('current-doc-name');

    // (Variables moved above with explicit JSDoc typings)

    const oldState = vscode.getState() || {};

    if (oldState.activeDocName && currentDocName) {
        currentDocName.textContent = oldState.activeDocName;
    }
    // Restore previously rendered chat HTML immediately to avoid blank UI if
    // setFullHistory races with early clearMessages on sidebar reopen.
    if (oldState.chatHTML && typeof oldState.chatHTML === 'string' && chatMessages && !chatMessages.innerHTML.trim()) {
        try {
            chatMessages.innerHTML = oldState.chatHTML;
        } catch (e) {
            console.warn('[NaruhoDocs] Failed to restore cached chatHTML:', e);
        }
    }
    if (oldState.threads) {
        threads = oldState.threads;
    }
    if (oldState.activeThreadId) {
        activeThreadId = oldState.activeThreadId;
    }
    if (oldState.threadModes) {
        threadModes = oldState.threadModes;
    }
    if (typeof oldState.isHamburgerOpen === 'boolean' && dropdownContainer && hamburgerMenu) {
        dropdownContainer.style.display = oldState.isHamburgerOpen ? 'block' : 'none';
        hamburgerMenu.classList.toggle('open', oldState.isHamburgerOpen);
    }

    renderThreadListMenu();

    // Fallback: after a short delay, if active thread has cached history and UI is empty, render it.
    setTimeout(() => {
        try {
            if (chatMessages && !chatMessages.innerHTML.trim() && activeThreadId) {
                // @ts-ignore
                const store = window.__naruhodocsAllHistories;
                if (store && store[activeThreadId] && store[activeThreadId].length) {
                    store[activeThreadId].forEach(/** @param {NaruhoHistoryEntry} entry */function (entry) { if (entry) { addMessage(entry.sender || 'Bot', entry.message || ''); } });
                }
            }
        } catch (e) { /* ignore */ }
    }, 150);

    window.addEventListener('DOMContentLoaded', () => {
        const clearHistoryBtn = document.getElementById('clear-history');
        if (clearHistoryBtn) {
            clearHistoryBtn.onclick = () => {
                showClearHistoryConfirm();
            };
        }

        const refreshChatBtn = document.getElementById('refresh-vectordb');
        if (refreshChatBtn) {
                refreshChatBtn.onclick = () => {
                    vscode.postMessage({ type: 'vscodeReloadWindow' });
                };
        }
    });

    function showClearHistoryConfirm() {
        // Remove any existing modal
        let oldModal = document.getElementById('clear-history-modal');
        if (oldModal) {
            oldModal.remove();
        }

        // Create modal
        const modal = document.createElement('div');
        modal.id = 'clear-history-modal';
        modal.style.cssText = `
        position: fixed;
        top: 0; left: 0; width: 100vw; height: 100vh;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0,0,0,0.5); z-index: 9999;
    `;

        const box = document.createElement('div');
        box.style.cssText = `
        background: #222; color: #fff; padding: 32px 24px; border-radius: 10px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.3); text-align: center; min-width: 300px;
    `;
        box.innerHTML = `<div style="font-size:18px; margin-bottom:16px;">Are you sure you want to clear all chat history?</div>`;

        // Use save-btn class for both buttons
        const confirmBtn = document.createElement('button');
        confirmBtn.textContent = 'Yes';
        confirmBtn.className = 'clearHistory-btn';
        confirmBtn.onclick = () => {
            vscode.postMessage({ type: 'clearHistory' });
            modal.remove();
        };

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.className = 'clearHistory-btn cancel';
        cancelBtn.onclick = () => {
            modal.remove();
        };

        box.appendChild(confirmBtn);
        box.appendChild(cancelBtn);
        modal.appendChild(box);
        document.body.appendChild(modal);
    }

    function sendMessage() {
        console.log('[NaruhoDocs] sendMessage called, chatInput:', chatInput);
        if (chatInput && (chatInput instanceof HTMLTextAreaElement) && chatInput.value.trim()) {
            const messageText = chatInput.value;
            console.log('[NaruhoDocs] sendMessage triggered:', messageText);
            
            // Send to backend - backend will handle displaying both user and bot messages
            vscode.postMessage({
                type: 'sendMessage',
                value: messageText
            });
            
            // Clear input immediately
            chatInput.value = '';
            
            console.log('[NaruhoDocs] Message sent to backend, input cleared');
        } else {
            console.log('[NaruhoDocs] sendMessage: no input or empty value');
        }
    }

    // Reset chat icon removed from UI - reset functionality available via command palette

    console.log('[NaruhoDocs] Chat input element:', chatInput);
    if (chatInput) {
        console.log('[NaruhoDocs] Setting up chat input keydown listener');
        chatInput.addEventListener('keydown', (event) => {
            console.log('[NaruhoDocs] Key pressed:', event.key, 'Shift:', event.shiftKey);
            if (event.key === 'Enter' && !event.shiftKey) {
                console.log('[NaruhoDocs] Enter key detected, sending message');
                event.preventDefault();
                sendMessage();
            }
            // Add keyboard shortcut for reset: Ctrl+Shift+R
            if (event.key === 'R' && event.ctrlKey && event.shiftKey) {
                event.preventDefault();
                const confirmed = confirm('Are you sure you want to reset the current conversation? This will clear all chat history.\n\nKeyboard shortcut: Ctrl+Shift+R');
                if (confirmed) {
                    vscode.postMessage({ type: 'resetSession' });
                    console.log('[NaruhoDocs][UI] Reset chat via keyboard shortcut (Ctrl+Shift+R)');
                }
            }
        });
    }

    // Ensure send icon functionality is working - use setTimeout to ensure DOM is ready
    setTimeout(() => {
        console.log('[NaruhoDocs] Looking for send icon element...');
        const sendIconElement = document.getElementById('send-icon');
        console.log('[NaruhoDocs] Send icon element:', sendIconElement);
        
        if (sendIconElement) {
            console.log('[NaruhoDocs] Setting up send icon click listener');
            
            // Add click listener with debugging
            sendIconElement.addEventListener('click', (e) => {
                console.log('[NaruhoDocs] Send icon clicked!', e);
                e.preventDefault();
                e.stopPropagation();
                sendMessage();
            });
            
            // Also add mousedown and touchstart for better mobile/touch support
            sendIconElement.addEventListener('mousedown', (e) => {
                console.log('[NaruhoDocs] Send icon mousedown!', e);
            });
            
            sendIconElement.addEventListener('touchstart', (e) => {
                console.log('[NaruhoDocs] Send icon touchstart!', e);
                e.preventDefault();
                sendMessage();
            });
            
        } else {
            console.log('[NaruhoDocs] Send icon not found!');
            // Try to find it with different selectors
            const allElements = document.querySelectorAll('[id*="send"], [class*="send"], span');
            console.log('[NaruhoDocs] All potential send elements:', allElements);
            
            // Try to find it by traversing the DOM
            const chatContainer = document.querySelector('.chat-input-container');
            console.log('[NaruhoDocs] Chat input container:', chatContainer);
            if (chatContainer) {
                const spans = chatContainer.querySelectorAll('span');
                console.log('[NaruhoDocs] Spans in chat container:', spans);
            }
        }
    }, 100);

    // Also add event delegation as a fallback
    document.addEventListener('click', (e) => {
        const target = e.target;
        if (target && target instanceof Element) {
            if (target.id === 'send-icon' || target.closest('#send-icon')) {
                console.log('[NaruhoDocs] Send icon clicked via delegation!', target);
                e.preventDefault();
                e.stopPropagation();
                sendMessage();
            }
        }
    });

    function renderThreadListMenu() {
        // Sync backend mode on tab switch (if not general thread)
        if (typeof activeThreadId === 'string' && activeThreadId !== 'naruhodocs-general-thread') {
            const mode = threadModes[activeThreadId] || 'developer';
            if (mode === 'beginner') {
                vscode.postMessage({ type: 'setThreadBeginnerMode', sessionId: activeThreadId });
            } else {
                vscode.postMessage({ type: 'setThreadDeveloperMode', sessionId: activeThreadId });
            }
        }
        console.log('[NaruhoDocs] Rendering thread list menu. Active thread ID:', activeThreadId, 'Threads:', threads);
        if (!threadListMenu) { return; }
        threadListMenu.innerHTML = '';
        let activeTitle = '';
        let foundActive = false;
        // Move general buttons above chat input box
        const generalButtons = document.getElementById('general-buttons');
        const generalButtonsAnchor = document.getElementById('general-buttons-anchor');
        if (generalButtons && generalButtonsAnchor && generalButtonsAnchor.parentElement) {
            // Only move if not already in correct place
            if (generalButtons.parentElement !== generalButtonsAnchor.parentElement || generalButtons.previousElementSibling !== generalButtonsAnchor) {
                generalButtonsAnchor.parentElement.insertBefore(generalButtons, generalButtonsAnchor.nextSibling);
            }
            generalButtons.style.display = (activeThreadId === 'naruhodocs-general-thread') ? 'flex' : 'none';
        }

        // Remove mode buttons from menu area
        // Add mode switch buttons above chat input container
        let chatModeButtons = document.getElementById('chat-mode-buttons');
        const chatInputContainer = document.querySelector('.chat-input-container');
        if (!chatModeButtons) {
            chatModeButtons = document.createElement('div');
            chatModeButtons.id = 'chat-mode-buttons';
            // Insert above chat input container
            if (chatInputContainer && chatInputContainer.parentElement) {
                chatInputContainer.parentElement.insertBefore(chatModeButtons, chatInputContainer);
            }
        }
        if (typeof activeThreadId === 'string' && activeThreadId !== 'naruhodocs-general-thread') {
            chatModeButtons.innerHTML = '';
            // Create custom slide switch for mode selection
            const switchLabel = document.createElement('label');
            switchLabel.className = 'switch';

            // Hidden checkbox for accessibility and state
            const switchInput = document.createElement('input');
            switchInput.type = 'checkbox';
            switchInput.className = 'switch-checkbox';
            const mode = threadModes[activeThreadId] || 'developer';
            switchInput.checked = (mode === 'beginner');
            switchInput.style.display = 'none';

            // Custom slider
            const sliderSpan = document.createElement('span');
            sliderSpan.className = 'slider';
            // Knob
            const knob = document.createElement('span');
            knob.className = 'slider-knob';
            sliderSpan.appendChild(knob);

            // Add text label
            const modeText = document.createElement('span');
            modeText.className = 'mode-text';
            modeText.textContent = 'Beginner Mode';

            // Click slider to toggle
            sliderSpan.addEventListener('click', () => {
                switchInput.checked = !switchInput.checked;
                if (typeof activeThreadId === 'string') {
                    threadModes[activeThreadId] = switchInput.checked ? 'beginner' : 'developer';
                }
                persistState();
                updateSwitchUI();
                if (switchInput.checked) {
                    modeText.textContent = 'Beginner Mode';
                    modeText.classList.add('beginner');
                    modeText.classList.remove('developer');
                    vscode.postMessage({
                        type: 'setThreadBeginnerMode',
                        sessionId: activeThreadId
                    });
                    // Show chat message for switching to Beginner Mode
                    if (chatMessages) {
                        const msg = document.createElement('div');
                        msg.className = 'message system';
                        msg.textContent = 'Switched to Beginner Mode';

                        // Explanation
                        const explain = document.createElement('div');
                        explain.className = 'mode-explanation';

                        explain.textContent = 'Answers in this chatbot will be explained in a beginner-friendly way, with less technical jargon and more step-by-step guidance.';

                        chatMessages.appendChild(msg);
                        chatMessages.appendChild(explain);
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                    }
                } else {
                    modeText.textContent = 'Beginner Mode';
                    modeText.classList.add('developer');
                    modeText.classList.remove('beginner');
                    vscode.postMessage({
                        type: 'setThreadDeveloperMode',
                        sessionId: activeThreadId
                    });
                    // Show chat message for switching to Developer Mode
                    if (chatMessages) {
                        const msg = document.createElement('div');
                        msg.className = 'message system';
                        msg.textContent = 'Switched to Developer Mode';

                        // Explanation
                        const explain = document.createElement('div');
                        explain.className = 'mode-explanation';
                        explain.textContent = 'Answers in this chatbot will be more technical, concise, and assume programming experience.';

                        chatMessages.appendChild(msg);
                        chatMessages.appendChild(explain);
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                    }
                }
            });

            function updateSwitchUI() {
                if (switchInput.checked) {
                    knob.classList.add('checked');
                    sliderSpan.classList.add('checked');
                    modeText.classList.add('beginner');
                    modeText.classList.remove('developer');
                } else {
                    knob.classList.remove('checked');
                    sliderSpan.classList.remove('checked');
                    modeText.classList.add('developer');
                    modeText.classList.remove('beginner');
                }
            }
            updateSwitchUI();

            switchLabel.appendChild(sliderSpan);
            switchLabel.appendChild(modeText);
            chatModeButtons.appendChild(switchLabel);
            chatModeButtons.style.display = 'flex';
        } else {
            chatModeButtons.innerHTML = '';
            chatModeButtons.style.display = 'none';
        }

        // Modal for doc type selection
        function showDocTypeModal() {
            // Remove existing modal if present
            let oldModal = document.getElementById('doc-type-modal');
            if (oldModal) {
                oldModal.remove();
            }

            const modal = document.createElement('div');
            modal.id = 'doc-type-modal';

            const box = document.createElement('div');

            // Add close button inside the modal content box
            const closeBtn = document.createElement('button');
            closeBtn.className = 'doc-modal-close-btn';
            closeBtn.innerHTML = '&times;';
            closeBtn.title = 'Close';
            closeBtn.addEventListener('click', () => {
                modal.remove();
            });
            box.appendChild(closeBtn);
            modal.appendChild(box);

            // Show a smaller loading spinner/message (no 'suggest what what' text)
            const loading = document.createElement('div');
            loading.className = 'doc-modal-loading';
            loading.textContent = '';
            // Add a small spinner (all style in main.css)
            const spinner = document.createElement('span');
            spinner.className = 'doc-modal-spinner';
            loading.appendChild(spinner);
            box.appendChild(loading);

            document.body.appendChild(modal);

            // Always request a fresh scan of workspace files when modal opens
            vscode.postMessage({ type: 'scanDocs' });

            // Listen for aiSuggestedDocs and replace loading with real choices
            /** @param {MessageEvent} event */
            function handleAISuggestedDocs(event) {
                const message = event.data;
                console.log('[NaruhoDocs] Generate Doc modal received message:', message.type);
                if (message.type === 'aiSuggestedDocs') {
                    console.log('[NaruhoDocs] Generate Doc processing aiSuggestedDocs:', message);
                    // Remove loading
                    box.innerHTML = '';
                    box.appendChild(closeBtn);
                    // Only show the title and suggestion buttons after loading
                    const title = document.createElement('h2');
                    title.textContent = 'Select Documentation Type';
                    box.appendChild(title);
                    // Filter AI suggestions using existingFiles
                    const existingFiles = Array.isArray(message.existingFiles) ? message.existingFiles : [];
                    const filteredSuggestions = message.suggestions.filter((/** @type {any} */ s) =>
                        s.fileName && !existingFiles.includes(s.fileName.toLowerCase())
                    );
                    filteredSuggestions.forEach((/** @type {any} */ suggestion) => {
                        const btn = document.createElement('button');
                        btn.textContent = suggestion.displayName;
                        btn.title = suggestion.description || '';
                        btn.style.cssText = 'pointer-events: auto; position: relative; z-index: 10;';
                        btn.addEventListener('click', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            console.log('[NaruhoDocs] Generate Doc button clicked:', suggestion.displayName);
                            vscode.postMessage({ type: 'generateDoc', docType: suggestion.displayName, fileName: suggestion.fileName });
                            modal.remove();
                        });
                        box.appendChild(btn);
                    });
                    // Always add 'Others' button at the end
                    const othersBtn = document.createElement('button');
                    othersBtn.textContent = 'Others';
                    othersBtn.style.cssText = 'pointer-events: auto; position: relative; z-index: 10;';
                    othersBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        console.log('[NaruhoDocs] Generate Doc Others button clicked');
                        showCustomDocPrompt(modal);
                    });
                    box.appendChild(othersBtn);
                    window.removeEventListener('message', handleAISuggestedDocs);
                }
            }
            window.addEventListener('message', handleAISuggestedDocs);
        }

        /** @param {HTMLElement} modal */
        function showCustomDocPrompt(modal) {
            // Remove previous prompt if any
            let oldPrompt = document.getElementById('custom-doc-prompt');
            if (oldPrompt) { oldPrompt.remove(); }

            const promptBox = document.createElement('div');
            promptBox.id = 'custom-doc-prompt';

            const label = document.createElement('label');
            label.textContent = 'What documentation do you want?';
            promptBox.appendChild(label);

            const input = document.createElement('input');
            input.type = 'text';
            promptBox.appendChild(input);

            const submitBtn = document.createElement('button');
            submitBtn.textContent = 'Submit';
            submitBtn.style.cssText = 'pointer-events: auto; position: relative; z-index: 10;';
            submitBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (input.value.trim()) {
                    console.log('[NaruhoDocs] Custom Generate Doc submit:', input.value.trim());
                    vscode.postMessage({ type: 'generateDoc', docType: input.value.trim() });
                    if (modal) {
                        modal.remove();
                    }
                }
            });
            promptBox.appendChild(submitBtn);

            const innerDiv = modal.querySelector('div');
            if (innerDiv) { innerDiv.appendChild(promptBox); }
        }


        // Modal for template selection (uses AI suggestions and filters out existing docs)
        function showTemplateSelectionModal() {
            let oldModal = document.getElementById('doc-type-modal');
            if (oldModal) { oldModal.remove(); }

            const modal = document.createElement('div');
            modal.id = 'doc-type-modal';

            const box = document.createElement('div');

            const closeBtn = document.createElement('button');
            closeBtn.className = 'doc-modal-close-btn';
            closeBtn.innerHTML = '&times;';
            closeBtn.title = 'Close';
            closeBtn.addEventListener('click', () => { modal.remove(); });
            box.appendChild(closeBtn);

            // Show a smaller loading spinner/message (no text)
            const loading = document.createElement('div');
            loading.className = 'doc-modal-loading';
            loading.textContent = '';
            // Add a small spinner (all style in main.css)
            const spinner = document.createElement('span');
            spinner.className = 'doc-modal-spinner';
            loading.appendChild(spinner);
            box.appendChild(loading);

            modal.appendChild(box);
            document.body.appendChild(modal);

            // Listen for aiSuggestedDocs and replace loading with real choices
            /** @param {any} event */
            function handleAISuggestedDocs(event) {
                const message = event.data;
                console.log('[NaruhoDocs] Template modal received message:', message.type);
                if (message.type === 'aiSuggestedDocs') {
                    console.log('[NaruhoDocs] Template processing aiSuggestedDocs:', message);
                    // Remove loading
                    box.innerHTML = '';
                    box.appendChild(closeBtn);
                    // Only show the title and suggestion buttons after loading
                    const title = document.createElement('h2');
                    title.textContent = 'Select Documentation Template';
                    box.appendChild(title);
                    // Filter AI suggestions using existingFiles
                    const existingFiles = Array.isArray(message.existingFiles) ? message.existingFiles : [];
                    const filteredSuggestions = message.suggestions.filter((/** @type {any} */ s) =>
                        s.fileName && !existingFiles.includes(s.fileName.toLowerCase())
                    );
                    filteredSuggestions.forEach((/** @type {any} */ suggestion) => {
                        const btn = document.createElement('button');
                        btn.textContent = suggestion.displayName;
                        btn.title = suggestion.description || '';
                        btn.addEventListener('click', () => {
                            console.log('[NaruhoDocs] Generate Template button clicked:', suggestion.displayName);
                            vscode.postMessage({ type: 'generateTemplate', templateType: suggestion.displayName });
                            modal.remove();
                        });
                        box.appendChild(btn);
                    });
                    // Always add 'Others' button at the end
                    const othersBtn = document.createElement('button');
                    othersBtn.textContent = 'Others';
                    othersBtn.addEventListener('click', () => {
                        console.log('[NaruhoDocs] Generate Template Others button clicked');
                        showCustomTemplatePrompt(modal);
                    });
                    box.appendChild(othersBtn);
                    window.removeEventListener('message', handleAISuggestedDocs);
                }
            }
            window.addEventListener('message', handleAISuggestedDocs);
        }

        /** @param {any} modal */
        function showCustomTemplatePrompt(modal) {
            let oldPrompt = document.getElementById('custom-doc-prompt');
            if (oldPrompt) { oldPrompt.remove(); }

            const promptBox = document.createElement('div');
            promptBox.id = 'custom-doc-prompt';

            const label = document.createElement('label');
            label.textContent = 'Describe your documentation template:';
            promptBox.appendChild(label);

            const input = document.createElement('input');
            input.type = 'text';
            promptBox.appendChild(input);

            const submitBtn = document.createElement('button');
            submitBtn.textContent = 'Submit';
            submitBtn.addEventListener('click', () => {
                if (input.value.trim()) {
                    // Always send a canonical template request for custom input
                    const templateType = input.value.trim();
                    console.log('[NaruhoDocs] Custom Generate Template submit:', templateType);
                    vscode.postMessage({ type: 'generateTemplate', templateType: templateType });
                    if (modal) { modal.remove(); }
                }
            });
            promptBox.appendChild(submitBtn);

            modal.querySelector('div').appendChild(promptBox);
        }

        // Add event listeners for general buttons (only add if not already added)
        const generateDocBtn = document.getElementById('generate-doc-btn');
        if (generateDocBtn && !generateDocBtn.hasAttribute('data-listener-added')) {
            generateDocBtn.setAttribute('data-listener-added', 'true');
            generateDocBtn.addEventListener('click', () => {
                // Remove any previous modal and listeners
                let oldModal = document.getElementById('doc-type-modal');
                if (oldModal) {
                    oldModal.remove();
                }
                // Always trigger a fresh scan before showing modal
                vscode.postMessage({ type: 'scanDocs' });
                console.log('[NaruhoDocs][UI] Generate Doc button clicked, scanDocs posted');
                // Show modal dialog for doc type selection
                showDocTypeModal();
                console.log('[NaruhoDocs][UI] showDocTypeModal called');
                console.log('[NaruhoDocs][UI] showDocTypeModal rendering modal');
            });
        }

        const suggestTemplateBtn = document.getElementById('suggest-template-btn');
        if (suggestTemplateBtn && !suggestTemplateBtn.hasAttribute('data-listener-added')) {
            suggestTemplateBtn.setAttribute('data-listener-added', 'true');
            suggestTemplateBtn.addEventListener('click', () => {
                // Remove any previous modal and listeners
                let oldModal = document.getElementById('doc-type-modal');
                if (oldModal) {
                    oldModal.remove();
                }
                // Always trigger a fresh scan before showing modal
                vscode.postMessage({ type: 'scanDocs' });
                showTemplateSelectionModal();
            });
        }

        // Add event listener for visualize button
        const visualizeBtn = document.getElementById('visualize-btn');
        if (visualizeBtn && !visualizeBtn.hasAttribute('data-listener-added')) {
            visualizeBtn.setAttribute('data-listener-added', 'true');
            visualizeBtn.addEventListener('click', () => {
                // Send message to extension to show visualization menu
                vscode.postMessage({ type: 'showVisualizationMenu' });
            });
        }

        // Always keep General thread at the top, and ensure it exists in the dropdown
        let generalThread = threads.find(t => t.id === 'naruhodocs-general-thread');
        if (!generalThread) {
            generalThread = { id: 'naruhodocs-general-thread', title: 'General Purpose' };
        }
        const otherThreads = threads.filter(t => t.id !== 'naruhodocs-general-thread');
        const orderedThreads = [generalThread, ...otherThreads];

        orderedThreads.forEach(thread => {
            let fileName = thread.title.split(/[/\\]/).pop();
            if (thread.id === 'naruhodocs-general-thread') {
                fileName = 'General';
            }
            const item = document.createElement('div');
            item.className = 'thread-list-item';
            item.textContent = fileName;
            item.title = thread.title;
            if (thread.id === activeThreadId) {
                item.classList.add('active');
                activeTitle = fileName;
                foundActive = true;
            }
            item.addEventListener('click', () => {
                activeThreadId = thread.id;
                renderThreadListMenu(); // update UI immediately
                vscode.postMessage({ type: 'switchThread', sessionId: thread.id });
                if (dropdownContainer) { dropdownContainer.style.display = 'none'; }
                if (hamburgerMenu) { hamburgerMenu.classList.remove('open'); }
            });
            threadListMenu.appendChild(item);
        });
        // Fallback: if no active thread, show General
        if (!foundActive) {
            activeTitle = 'General';
        }
        if (currentDocName) {
            currentDocName.textContent = activeTitle;
        }
        persistState();
    }

    function clearMessages() {
        if (chatMessages) { chatMessages.innerHTML = ''; }
    }

    /** @param {any} history */
    function showHistory(history) {
        console.log('[NaruhoDocs] showHistory called, clearing messages and showing:', history);
        clearMessages();
        if (Array.isArray(history)) {
            console.log('[NaruhoDocs] Showing history with', history.length, 'entries');
            history.forEach(msg => {
                let sender = 'Bot';
                let text = '';
                if (msg.id && msg.id[2] === 'HumanMessage') {
                    sender = 'You';
                    text = msg.kwargs?.content || '';
                } else if (msg.id && msg.id[2] === 'AIMessage') {
                    sender = 'Bot';
                    text = msg.kwargs?.content || '';
                } else {
                    // fallback for other formats
                    text = msg.text || msg.content || '';
                }
                addMessage(sender, text);
            });
        }
        persistState();
    }

    /** @param {boolean} visible */
    function toggleGeneralTabUI(visible) {
        const generalTabUI = document.getElementById('general-tab-ui');
        if (generalTabUI) {
            generalTabUI.style.display = visible ? 'block' : 'none';
        }
    }

    function persistState() {
        vscode.setState({
            chatHTML: chatMessages?.innerHTML,
            activeDocName: currentDocName?.textContent,
            activeThreadId,
            threads,
            threadModes,
            isHamburgerOpen: dropdownContainer?.style.display === 'block'
        });
    }


    if (hamburgerMenu && dropdownContainer) {
        hamburgerMenu.addEventListener('click', () => {
            const isOpen = dropdownContainer.style.display === 'none' || dropdownContainer.style.display === '';
            dropdownContainer.style.display = isOpen ? 'block' : 'none';
            hamburgerMenu.classList.toggle('open', isOpen);
            persistState();
        });
    }

    // Add event listener for create file button
    const createFileBtn = document.getElementById('create-file-btn');
    if (createFileBtn) {
        createFileBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'createFile' });
            // Always close dropdown and set hamburger to close mode
            if (dropdownContainer) { dropdownContainer.style.display = 'none'; }
            if (hamburgerMenu) { hamburgerMenu.classList.remove('open'); }
        });
    }

    // Import and initialize markdown-it
    // @ts-ignore: markdown-it is loaded as a global script
    const md = window.markdownit({
        html: true, // Allow HTML tags in Markdown
        breaks: true, // Convert \n to <br>
        linkify: true // Automatically link URLs
    });

    // Initialize Mermaid if available
    if (typeof mermaidLib !== 'undefined') {
        mermaidLib.initialize({
            startOnLoad: false,
            theme: 'dark',
            themeVariables: {
                darkMode: true,
                primaryColor: '#007acc',
                primaryTextColor: '#ffffff',
                primaryBorderColor: '#007acc',
                lineColor: '#cccccc',
                secondaryColor: '#1e1e1e',
                tertiaryColor: '#252526'
            }
        });
    }

    // Function to open diagram in enlarged modal - request VS Code to open full window
    /** @param {any} mermaidCode @param {string} diagramId */
    function openDiagramModal(mermaidCode, diagramId) {
        // Send message to VS Code extension to open full window modal
        if (typeof vscode !== 'undefined') {
            vscode.postMessage({
                type: 'openFullWindowDiagram',
                mermaidCode: mermaidCode,
                diagramId: diagramId,
                title: 'Enlarged Diagram View'
            });
        } else {
            // Fallback to regular modal if VS Code API not available
            openFallbackModal(mermaidCode, diagramId);
        }
    }

    // Fallback modal for when VS Code API is not available
    /** @param {any} mermaidCode @param {string} diagramId */
    function openFallbackModal(mermaidCode, diagramId) {
        // Remove any existing modal
        const existingModal = document.getElementById('diagram-modal');
        if (existingModal) {
            existingModal.remove();
        }

        // Create modal overlay - full VS Code window
        const modal = document.createElement('div');
        modal.id = 'diagram-modal';
        modal.className = 'diagram-modal'; // Use class instead of inline style

        const modalContent = document.createElement('div');
        modalContent.className = 'diagram-modal-content';

        const modalHeader = document.createElement('div');
        modalHeader.className = 'diagram-modal-header';

        const modalTitle = document.createElement('h3');
        modalTitle.className = 'diagram-modal-title';

        const modalControls = document.createElement('div');
        modalControls.className = 'diagram-modal-controls';

        // Zoom controls
        const zoomOutBtn = createModalButton('🔍-', 'Zoom out');
        const zoomResetBtn = createModalButton('100%', 'Reset zoom');
        const zoomInBtn = createModalButton('🔍+', 'Zoom in');
        const fullscreenBtn = createModalButton('⛶', 'Fullscreen');
        const exportBtn = createModalButton('💾', 'Export');
        const closeBtn = createModalButton('✖', 'Close');

        modalControls.appendChild(zoomOutBtn);
        modalControls.appendChild(zoomResetBtn);
        modalControls.appendChild(zoomInBtn);
        modalControls.appendChild(fullscreenBtn);
        modalControls.appendChild(exportBtn);
        modalControls.appendChild(closeBtn);

        modalHeader.appendChild(modalTitle);
        modalHeader.appendChild(modalControls);

        // Create diagram container
        const diagramContainer = document.createElement('div');
        diagramContainer.id = 'modal-diagram-container';
        diagramContainer.style.cssText = `
            text-align: center;
            overflow: auto;
            max-height: calc(90vh - 100px);
            position: relative;
        `;

        modalContent.appendChild(modalHeader);
        modalContent.appendChild(diagramContainer);
        modal.appendChild(modalContent);
        document.body.appendChild(modal);

        // Render the enlarged diagram
        if (typeof mermaidLib !== 'undefined') {
            mermaidLib.render(`${diagramId}-modal`, mermaidCode)
                .then((/** @type {{svg: string}} */ { svg }) => {
                    diagramContainer.innerHTML = svg;
                    const svgElement = diagramContainer.querySelector('svg');
                    if (svgElement) {
                        svgElement.style.cssText = `
                            max-width: 100%;
                            height: auto;
                            transform-origin: center;
                            transition: transform 0.3s ease;
                        `;

                        // Set up zoom functionality
                        let currentZoom = 1;
                        const zoomStep = 0.2;

                        /** @param {number} newZoom */
                        function updateZoom(newZoom) {
                            currentZoom = Math.max(0.5, Math.min(3, newZoom));
                            if (svgElement) {
                                svgElement.style.transform = `scale(${currentZoom})`;
                            }
                            zoomResetBtn.textContent = `${Math.round(currentZoom * 100)}%`;
                        }

                        zoomInBtn.onclick = () => updateZoom(currentZoom + zoomStep);
                        zoomOutBtn.onclick = () => updateZoom(currentZoom - zoomStep);
                        zoomResetBtn.onclick = () => updateZoom(1);

                        // Export functionality
                        exportBtn.onclick = () => exportDiagram(svgElement, diagramId);

                        // Fullscreen functionality
                        fullscreenBtn.onclick = () => {
                            if (document.fullscreenElement) {
                                document.exitFullscreen();
                            } else {
                                modal.requestFullscreen().catch(err => {
                                    console.log('Fullscreen failed:', err);
                                });
                            }
                        };
                    }
                })
                .catch((/** @type {any} */ error) => {
                    diagramContainer.innerHTML = `<p style="color: var(--vscode-errorForeground); padding: 20px;">Failed to render diagram: ${error.message}</p>`;
                });
        }

        // Close modal functionality
        function closeModal() {
            modal.remove();
        }

        closeBtn.onclick = closeModal;
        modal.onclick = (e) => {
            if (e.target === modal) {
                closeModal();
            }
        };

        // Keyboard shortcuts
        /** @param {KeyboardEvent} e */
        function handleKeyDown(e) {
            if (e.key === 'Escape') {
                closeModal();
            } else if (e.key === '+' || e.key === '=') {
                e.preventDefault();
                zoomInBtn.click();
            } else if (e.key === '-') {
                e.preventDefault();
                zoomOutBtn.click();
            } else if (e.key === '0') {
                e.preventDefault();
                zoomResetBtn.click();
            }
        }

        document.addEventListener('keydown', handleKeyDown);
        modal.addEventListener('remove', () => {
            document.removeEventListener('keydown', handleKeyDown);
        });
    }

    // Function to create modal buttons
    /** @param {string} text @param {string} title */
    function createModalButton(text, title) {
        const button = document.createElement('button');
        button.textContent = text;
        button.title = title;
        button.style.cssText = `
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            padding: 6px 10px;
            cursor: pointer;
            font-size: 12px;
            transition: background 0.2s;
            min-width: 30px;
        `;
        button.onmouseenter = () => {
            button.style.background = 'var(--vscode-button-hoverBackground)';
        };
        button.onmouseleave = () => {
            button.style.background = 'var(--vscode-button-background)';
        };
        return button;
    }

    // Function to export diagram as SVG or PNG
    /** @param {SVGSVGElement} svgElement @param {string} diagramId */
    function exportDiagram(svgElement, diagramId) {
        try {
            // Clone the SVG to avoid modifying the original
            const clonedSvg = svgElement.cloneNode(true);

            // Get SVG source
            const svgData = new XMLSerializer().serializeToString(clonedSvg);
            const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });

            // Create download link
            const downloadLink = document.createElement('a');
            downloadLink.href = URL.createObjectURL(svgBlob);
            const fileName = `${diagramId || 'diagram'}.svg`;
            downloadLink.download = fileName;
            document.body.appendChild(downloadLink);
            downloadLink.click();
            document.body.removeChild(downloadLink);
            URL.revokeObjectURL(downloadLink.href);

            // Show success message with location info
            showToast(`Diagram exported as ${fileName} to your Downloads folder`, 'success');

            // Also send message to VS Code to show notification
            if (typeof vscode !== 'undefined') {
                vscode.postMessage({
                    type: 'showNotification',
                    message: `Diagram exported as ${fileName} to your Downloads folder`,
                    messageType: 'info'
                });
            }
        } catch (error) {
            console.error('Export failed:', error);
            showToast('Failed to export diagram', 'error');
        }
    }

    // For toast notifications:
    /**
     * @param {string} message
     * @param {'info'|'success'|'error'} [type]
     */
    function showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast-notification toast-${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => {
                document.body.removeChild(toast);
            }, 300);
        }, 3000);
    }

    /** @param {string} sender @param {string} message */
    function addMessage(sender, message) {
        console.log('[NaruhoDocs] addMessage called with:', sender, message);
        console.log('[NaruhoDocs] chatMessages element:', chatMessages);
        if (chatMessages) {
            console.log('[NaruhoDocs] chatMessages exists, building message element');
            const messageElement = buildMessageElement(sender, message);
            console.log('[NaruhoDocs] Built message element:', messageElement);

            // Process Mermaid diagrams
            if (typeof mermaidLib !== 'undefined') {
                const mermaidBlocks = messageElement.querySelectorAll('code.language-mermaid');
                mermaidBlocks.forEach(async (block, index) => {
                    try {
                        const mermaidCode = block.textContent;
                        const diagramId = `mermaid-${Date.now()}-${index}`;

                        // Create a container for the Mermaid diagram
                        const diagramContainer = document.createElement('div');
                        diagramContainer.className = 'mermaid-diagram-container';
                        diagramContainer.style.textAlign = 'center';
                        diagramContainer.style.margin = '10px 0';
                        diagramContainer.style.padding = '10px';
                        diagramContainer.style.border = '1px solid var(--vscode-panel-border)';
                        diagramContainer.style.borderRadius = '4px';
                        diagramContainer.style.backgroundColor = 'var(--vscode-editor-background)';
                        diagramContainer.style.position = 'relative';

                        // Create diagram controls
                        const controlsContainer = document.createElement('div');
                        controlsContainer.className = 'diagram-controls';
                        controlsContainer.style.position = 'absolute';
                        controlsContainer.style.top = '5px';
                        controlsContainer.style.right = '5px';
                        controlsContainer.style.display = 'flex';
                        controlsContainer.style.gap = '5px';
                        controlsContainer.style.opacity = '0.7';
                        controlsContainer.style.transition = 'opacity 0.2s';

                        // Enlarge button
                        const enlargeBtn = document.createElement('button');
                        enlargeBtn.className = 'diagram-control-btn';
                        enlargeBtn.innerHTML = 'Enlarge';
                        enlargeBtn.title = 'Enlarge diagram';
                        enlargeBtn.style.cssText = `
                            background: var(--vscode-button-background);
                            color: var(--vscode-button-foreground);
                            border: 1px solid var(--vscode-button-border, transparent);
                            border-radius: 4px;
                            padding: 4px 8px;
                            cursor: pointer;
                            font-size: 11px;
                            font-weight: 500;
                            transition: all 0.2s ease;
                        `;

                        // Export button
                        const exportBtn = document.createElement('button');
                        exportBtn.className = 'diagram-control-btn';
                        exportBtn.innerHTML = 'Export';
                        exportBtn.title = 'Export diagram';
                        exportBtn.style.cssText = enlargeBtn.style.cssText;

                        controlsContainer.appendChild(enlargeBtn);
                        controlsContainer.appendChild(exportBtn);
                        diagramContainer.appendChild(controlsContainer);

                        // Add hover effects to buttons
                        [enlargeBtn, exportBtn].forEach(btn => {
                            btn.addEventListener('mouseenter', () => {
                                btn.style.background = 'var(--vscode-button-hoverBackground)';
                                btn.style.transform = 'translateY(-1px)';
                            });
                            btn.addEventListener('mouseleave', () => {
                                btn.style.background = 'var(--vscode-button-background)';
                                btn.style.transform = 'translateY(0)';
                            });
                        });

                        // Show controls on hover
                        diagramContainer.addEventListener('mouseenter', () => {
                            controlsContainer.style.opacity = '1';
                        });
                        diagramContainer.addEventListener('mouseleave', () => {
                            controlsContainer.style.opacity = '0.7';
                        });

                        // Replace the code block with the diagram container
                        const preElement = block.parentElement;
                        if (preElement && preElement.tagName === 'PRE' && preElement.parentElement) {
                            preElement.parentElement.replaceChild(diagramContainer, preElement);
                        }

                        // Render the Mermaid diagram
                        if (typeof mermaidLib !== 'undefined') {
                            const { svg } = await mermaidLib.render(diagramId, mermaidCode);

                            // Create diagram content container
                            const diagramContent = document.createElement('div');
                            diagramContent.className = 'diagram-content';
                            diagramContent.innerHTML = svg;
                            diagramContainer.appendChild(diagramContent);

                            // Add click handlers for interactivity
                            const svgElement = diagramContent.querySelector('svg');
                            if (svgElement) {
                                svgElement.style.cursor = 'pointer';
                                svgElement.style.maxWidth = '100%';
                                svgElement.style.height = 'auto';

                                // Click to enlarge
                                svgElement.addEventListener('click', () => {
                                    openDiagramModal(mermaidCode, diagramId);
                                });

                                // Enlarge button handler
                                enlargeBtn.addEventListener('click', (e) => {
                                    e.stopPropagation();
                                    openDiagramModal(mermaidCode, diagramId);
                                });

                                // Export button handler
                                exportBtn.addEventListener('click', (e) => {
                                    e.stopPropagation();
                                    exportDiagram(svgElement, diagramId);
                                });
                            }
                        }
                    } catch (error) {
                        console.error('Error rendering Mermaid diagram:', error);
                        let msg = 'Unknown error';
                        if (error && typeof error === 'object' && 'message' in error) {
                            const m = error.message;
                            if (typeof m === 'string') { msg = m; }
                        }
                        // Fallback: show the code block with error styling
                        if (block instanceof HTMLElement) {
                            block.style.backgroundColor = 'var(--vscode-inputValidation-errorBackground)';
                            block.style.color = 'var(--vscode-inputValidation-errorForeground)';
                            block.textContent = 'Error rendering diagram: ' + msg;
                        }
                    }
                });
            }

            console.log('[NaruhoDocs] Appending message element to chatMessages');
            chatMessages.appendChild(messageElement);
            chatMessages.scrollTop = chatMessages.scrollHeight;
            console.log('[NaruhoDocs] Message appended and scrolled, chatMessages.children.length:', chatMessages.children.length);
        } else {
            console.log('[NaruhoDocs] chatMessages element not found!');
        }
        persistState();
    }

    /**
     * Build a chat message DOM element (shared by addMessage & setFullHistory for flicker-free rendering)
     * @param {string} sender
     * @param {string} message
     */
    function buildMessageElement(sender, message) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message');
        if (sender === 'You') {
            messageElement.classList.add('user');
        } else if (sender === 'System') {
            messageElement.classList.add('system');
        } else {
            messageElement.classList.add('bot');
        }
        const isProviderChange = sender === 'System' && /^Provider changed to /i.test(message.trim());
        if (isProviderChange) {
            const span = document.createElement('span');
            span.textContent = message.trim();
            messageElement.appendChild(span);
        } else {
            const parsedMessage = md.render(message);
            messageElement.innerHTML = parsedMessage;
        }
        return messageElement;
    }

    // ✅ single unified listener
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'setFullHistory':
                setFullHistory(message.history);
                break;
            case 'addMessage':
                console.log('[NaruhoDocs] Received addMessage:', message.sender, message.message);
                addMessage(message.sender, message.message);
                break;
            case 'clearMessages':
                clearMessages();
                break;
            case 'docCreated':
                addMessage('System', `Documentation file created: <code>${message.filePath}</code>`);
                break;
            case 'threadList':
                threads = message.threads || [];
                activeThreadId = message.activeThreadId;
                renderThreadListMenu();
                break;
            case 'showHistory':
                showHistory(message.history);
                break;
            case 'toggleGeneralTabUI':
                toggleGeneralTabUI(message.visible);
                break;
            case 'sendMessage':
                if (message.sessionId) {
                    activeThreadId = message.sessionId;
                    renderThreadListMenu();
                }
                if (chatInput && message.value) {
                    if (chatInput instanceof HTMLTextAreaElement) {
                        chatInput.value = message.value;
                        sendMessage();
                    }
                }
                break;
            case 'resetState':
                vscode.setState(null);
                if (chatMessages) { chatMessages.innerHTML = ''; }
                if (currentDocName) { currentDocName.textContent = ''; }
                activeThreadId = undefined;
                threads = [];
                if (dropdownContainer) { dropdownContainer.style.display = 'none'; }
                if (hamburgerMenu) { hamburgerMenu.classList.remove('open'); }
                break;
            case 'showSaveTranslationButtons':
                if (chatMessages) {
                    const prev = document.getElementById('save-translation-btn-container');
                    if (prev) {
                        prev.remove();
                    }

                    const btnContainer = document.createElement('div');
                    btnContainer.id = 'save-translation-btn-container';
                    btnContainer.className = 'button-group';

                    const labelDiv = document.createElement('div');
                    labelDiv.textContent = 'Save translation as new file?';
                    labelDiv.className = 'button-group-label';
                    btnContainer.appendChild(labelDiv);

                    const yesBtn = document.createElement('button');
                    yesBtn.textContent = 'Yes';
                    yesBtn.className = 'save-btn';
                    yesBtn.onclick = () => {
                        vscode.postMessage({ type: 'createAndSaveFile', text: message.translation, uri: message.sessionId });
                        btnContainer.remove();
                    };

                    const noBtn = document.createElement('button');
                    noBtn.textContent = 'No';
                    noBtn.className = 'save-btn';
                    noBtn.onclick = () => { btnContainer.remove(); };

                    btnContainer.appendChild(yesBtn);
                    btnContainer.appendChild(noBtn);
                    chatMessages.appendChild(btnContainer);
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                }
                break;
            // case 'showSaveTemplateButtons':
            //     if (chatMessages) {
            //         // If the template is a 'not needed' message, do not show save modal
            //         if (typeof message.template === 'string' && message.template.trim().toLowerCase().startsWith('this project does not require')) {
            //             // Do not show save modal
            //             break;
            //         }
            //         const prev = document.getElementById('save-template-btn-container');
            //         if (prev) {
            //             prev.remove();
            //         }

            //         const btnContainer = document.createElement('div');
            //         btnContainer.id = 'save-template-btn-container';
            //         btnContainer.className = 'button-group';

            //         const labelDiv = document.createElement('div');
            //         labelDiv.textContent = 'Save template as new file?';
            //         labelDiv.className = 'button-group-label';
            //         btnContainer.appendChild(labelDiv);

            //         const yesBtn = document.createElement('button');
            //         yesBtn.textContent = 'Yes';
            //         yesBtn.className = 'save-btn';
            //         yesBtn.onclick = () => {
            //             vscode.postMessage({
            //                 type: 'createAndSaveTemplateFile',
            //                 text: message.template,
            //                 uri: message.sessionId,
            //                 docType: message.docType || message.templateType || 'README'
            //             });

            //             // Notify extension that webview is fully initialized and ready to accept history
            //             try {
            //                 vscode.postMessage({ type: 'chatViewReady' });
            //             } catch (e) {
            //                 console.warn('[NaruhoDocs] Failed to post chatViewReady:', e);
            //             }
            //             btnContainer.remove();
            //         };

            //         const noBtn = document.createElement('button');
            //         noBtn.textContent = 'No';
            //         noBtn.className = 'save-btn';
            //         noBtn.onclick = () => { btnContainer.remove(); };

            //         btnContainer.appendChild(yesBtn);
            //         btnContainer.appendChild(noBtn);
            //         chatMessages.appendChild(btnContainer);
            //         chatMessages.scrollTop = chatMessages.scrollHeight;
            //     }
            //     break;
            case 'historyCleared':
                clearMessages();
                // Optionally show a toast notification
                showToast('Chat history cleared.', 'success');
                break;
        }
    });

}());
