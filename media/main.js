// @ts-check

// This script will be run within the webview itself
// It cannot access the main VS Code APIs directly.

(function () {
    /**
     * @typedef {{sender:string,message:string,messageType?:string}} NaruhoHistoryEntry
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
    /** @param {Array<{sender?:string,message?:string,messageType?:string,rawMermaid?:string}>} history */
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
    /** @param {Array<{sender?:string,message?:string,messageType?:string}>} history */
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
                const messageElement = buildMessageElement(entry.sender || 'Bot', entry.message || '', entry.messageType);
                try {
                    // If backend provided rawMermaid and markdown renderer removed code fence (edge legacy), inject it.
                    const rawMermaid = /** @type {any} */(entry).rawMermaid;
                    if (rawMermaid && !messageElement.querySelector('code.language-mermaid')) {
                        const pre = document.createElement('pre');
                        const code = document.createElement('code');
                        code.className = 'language-mermaid';
                        code.textContent = rawMermaid;
                        pre.appendChild(code);
                        messageElement.appendChild(pre);
                    }
                } catch { /* ignore */ }
                // Ensure mermaid diagrams re-render on history hydration
                try { enhanceMessageElement(messageElement, entry.messageType); } catch { /* ignore */ }
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
                        store[activeThreadId].forEach(function (entry) { if (entry) { addMessage(entry.sender || 'Bot', entry.message || '', entry.messageType); } });
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
        // After raw HTML restore, upgrade any legacy mermaid blocks/toolbars to new wrapper format
        try { upgradeLegacyDiagrams(); } catch (e) { console.warn('[NaruhoDocs] Legacy diagram upgrade failed:', e); }
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
        
        // Restore icon state
        const hamburgerIcon = hamburgerMenu.querySelector('.hamburger-icon');
        const closeIcon = hamburgerMenu.querySelector('.close-icon');
        if (hamburgerIcon && closeIcon) {
            if (oldState.isHamburgerOpen) {
                /** @type {HTMLElement} */ (hamburgerIcon).style.display = 'none';
                /** @type {HTMLElement} */ (closeIcon).style.display = 'inline';
            } else {
                /** @type {HTMLElement} */ (hamburgerIcon).style.display = 'inline';
                /** @type {HTMLElement} */ (closeIcon).style.display = 'none';
            }
        }
    }

    renderThreadListMenu();

    // Fallback: after a short delay, if active thread has cached history and UI is empty, render it.
    setTimeout(() => {
        try {
            if (chatMessages && !chatMessages.innerHTML.trim() && activeThreadId) {
                // @ts-ignore
                const store = window.__naruhodocsAllHistories;
                if (store && store[activeThreadId] && store[activeThreadId].length) {
                    store[activeThreadId].forEach(/** @param {NaruhoHistoryEntry} entry */function (entry) { if (entry) { addMessage(entry.sender || 'Bot', entry.message || '', entry.messageType); } });
                }
            }
        } catch (e) { /* ignore */ }
    }, 150);

    // Removed in-webview clear history / rebuild vector DB buttons.
    // Functionality now lives in VS Code view title toolbar commands.
    window.addEventListener('DOMContentLoaded', () => { /* no-op placeholder */ });

    function showClearHistoryConfirm() { // still used by keyboard shortcut or future triggers
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
            addMessage('You', chatInput.value, undefined);
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
        // Sync backend mode on tab switch for both general and document threads
        if (typeof activeThreadId === 'string') {
            const mode = threadModes[activeThreadId] || 'developer';
            if (activeThreadId === 'naruhodocs-general-thread') {
                vscode.postMessage({ type: mode === 'beginner' ? 'setGeneralBeginnerMode' : 'setGeneralDeveloperMode', sessionId: activeThreadId });
            } else {
                vscode.postMessage({ type: mode === 'beginner' ? 'setThreadBeginnerMode' : 'setThreadDeveloperMode', sessionId: activeThreadId });
            }
        }
        console.log('[NaruhoDocs] Rendering thread list menu. Active thread ID:', activeThreadId, 'Threads:', threads);
        if (!threadListMenu) { return; }
        threadListMenu.innerHTML = '';
        let activeTitle = '';
        let foundActive = false;
        // We no longer position #general-buttons above the chat input; its buttons are converted
        // into compact icon buttons that live to the right of the mode toggle (within #chat-mode-buttons).

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
        if (typeof activeThreadId === 'string') {
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
                        type: activeThreadId === 'naruhodocs-general-thread' ? 'setGeneralBeginnerMode' : 'setThreadBeginnerMode',
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
                        type: activeThreadId === 'naruhodocs-general-thread' ? 'setGeneralDeveloperMode' : 'setThreadDeveloperMode',
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

            // --- Integrate Generate / Template / Visualize buttons as compact icons on the right ---
            try {
                const isGeneral = !activeThreadId || activeThreadId === 'naruhodocs-general-thread';
                const legacy = document.getElementById('general-buttons');
                if (legacy) { legacy.style.display = 'none'; }
                let actionsWrapper = chatModeButtons.querySelector('.mode-actions-wrapper');
                if (!actionsWrapper) {
                    actionsWrapper = document.createElement('div');
                    actionsWrapper.className = 'mode-actions-wrapper';
                    chatModeButtons.appendChild(actionsWrapper);
                }
                /** @type {Array<{id:string,label:string,svg:string,title:string,create?:boolean}>} */
                const spec = [
                    { id: 'generate-doc-btn', label: 'Generate Document', title: 'Generate Documentation', svg: 'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z', create: true },
                    { id: 'suggest-template-btn', label: 'Suggest Template', title: 'Suggest Documentation Template', svg: 'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z', create: true },
                    { id: 'visualize-btn', label: 'Visualize', title: 'Visualize Project', svg: 'M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z', create: true }
                ];
                spec.forEach(def => {
                    let btn = document.getElementById(def.id);
                    if (!btn && def.create) {
                        btn = document.createElement('button');
                        btn.id = def.id;
                        btn.textContent = def.label; // fallback text for accessibility if styles fail
                        // Attach baseline listeners (duplicates avoided by attribute flag later)
                        if (def.id === 'visualize-btn') {
                            btn.addEventListener('click', () => vscode.postMessage({ type: 'showVisualizationMenu' }));
                        }
                        if (def.id === 'generate-doc-btn') {
                            btn.addEventListener('click', () => { try { vscode.postMessage({ type:'scanDocs' }); showDocTypeModal(); } catch {} });
                        }
                        if (def.id === 'suggest-template-btn') {
                            btn.addEventListener('click', () => { try { vscode.postMessage({ type:'scanDocs' }); showTemplateSelectionModal(); } catch {} });
                        }
                    }
                    if (!btn) { return; }
                    if (!btn.classList.contains('mode-action-btn')) {
                        btn.classList.add('mode-action-btn');
                        btn.setAttribute('aria-label', def.label);
                        btn.title = def.title;
                        btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${def.svg}"/></svg>`;
                    }
                    btn.style.display = isGeneral ? 'inline-flex' : 'none';
                    if (btn.parentElement !== actionsWrapper) { actionsWrapper.appendChild(btn); }
                });
            } catch (e) { console.warn('[NaruhoDocs] Failed to integrate icon buttons (wrapper phase):', e); }
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
                            console.log('[NaruhoDocs] Generate Doc button clicked:', suggestion.displayName, undefined);
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
                        console.log('[NaruhoDocs] Generate Doc Others button clicked', undefined);
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
                    console.log('[NaruhoDocs] Custom Generate Doc submit:', input.value.trim(), undefined);
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

            vscode.postMessage({ type: 'scanDocs' });


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
                            vscode.postMessage({ type: 'generateTemplate', templateType: suggestion.displayName, fileName: suggestion.fileName });
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
                if (hamburgerMenu) { 
                    hamburgerMenu.classList.remove('open');
                    // Reset icons when closing dropdown
                    const hamburgerIcon = hamburgerMenu.querySelector('.hamburger-icon');
                    const closeIcon = hamburgerMenu.querySelector('.close-icon');
                    if (hamburgerIcon && closeIcon) {
                        /** @type {HTMLElement} */ (hamburgerIcon).style.display = 'inline';
                        /** @type {HTMLElement} */ (closeIcon).style.display = 'none';
                    }
                }
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
                addMessage(sender, text, undefined);
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
            
            // Toggle between hamburger and close icons
            const hamburgerIcon = hamburgerMenu.querySelector('.hamburger-icon');
            const closeIcon = hamburgerMenu.querySelector('.close-icon');
            if (hamburgerIcon && closeIcon) {
                if (isOpen) {
                    /** @type {HTMLElement} */ (hamburgerIcon).style.display = 'none';
                    /** @type {HTMLElement} */ (closeIcon).style.display = 'inline';
                } else {
                    /** @type {HTMLElement} */ (hamburgerIcon).style.display = 'inline';
                    /** @type {HTMLElement} */ (closeIcon).style.display = 'none';
                }
            }
            
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
            if (hamburgerMenu) { 
                hamburgerMenu.classList.remove('open');
                // Reset icons when closing dropdown
                const hamburgerIcon = hamburgerMenu.querySelector('.hamburger-icon');
                const closeIcon = hamburgerMenu.querySelector('.close-icon');
                if (hamburgerIcon && closeIcon) {
                    /** @type {HTMLElement} */ (hamburgerIcon).style.display = 'inline';
                    /** @type {HTMLElement} */ (closeIcon).style.display = 'none';
                }
            }
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
    /** @param {string} mermaidCode @param {string} diagramId */
    function openFallbackModal(mermaidCode, diagramId) {
        const existing = document.getElementById('diagram-modal');
        if (existing) { existing.remove(); }

        const modal = document.createElement('div');
        modal.id = 'diagram-modal';
        modal.className = 'diagram-modal';

        const modalContent = document.createElement('div');
        modalContent.className = 'diagram-modal-content';

        const header = document.createElement('div');
        header.className = 'diagram-modal-header';

        const titleEl = document.createElement('h3');
        titleEl.className = 'diagram-modal-title';
        titleEl.textContent = 'Diagram';

        const controls = document.createElement('div');
        controls.className = 'diagram-modal-controls';
        controls.style.display = 'flex';
        controls.style.alignItems = 'center';
        controls.style.gap = '4px';

        // Zoom indicator badge
        const zoomBadge = document.createElement('span');
        zoomBadge.id = 'zoom-indicator';
        zoomBadge.style.cssText = 'font-size:11px;padding:2px 6px;border:1px solid var(--vscode-editorWidget-border);border-radius:4px;opacity:0.8;';
        zoomBadge.textContent = '100%';

        // Button factory
        /** @param {string} label @param {string} title @param {() => void} onClick */
        function createIconButton(label, title, onClick) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = label;
            btn.title = title;
            btn.style.cssText = 'background:var(--vscode-button-secondaryBackground, var(--vscode-button-background));color:var(--vscode-button-foreground);border:none;border-radius:4px;cursor:pointer;padding:4px 6px;min-width:28px;font-size:12px;line-height:1;display:inline-flex;align-items:center;justify-content:center;';
            btn.onmouseenter = () => { btn.style.background = 'var(--vscode-button-hoverBackground)'; };
            btn.onmouseleave = () => { btn.style.background = 'var(--vscode-button-secondaryBackground, var(--vscode-button-background))'; };
            btn.onclick = onClick;
            return btn;
        }

        // State
        let currentScale = 1;
        let fitScale = 1;
        const MIN_SCALE = 0.2;
        const MAX_SCALE = 4;
        const STEP = 0.2;

        /** @type {SVGSVGElement | null} */
        let svgElement = null;
        /** @type {HTMLElement | null} */
        let innerStage = null;

        function updateZoomBadge() {
            zoomBadge.textContent = `${Math.round(currentScale * 100)}%`;
        }

        /** @param {number} newScale */
        function applyScale(newScale) {
            currentScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
            if (innerStage) { innerStage.style.transform = `scale(${currentScale})`; }
            updateZoomBadge();
        }

        function computeFitScale() {
            if (!svgElement || !innerStage) { return 1; }
            const container = innerStage.parentElement; // outer stage
            if (!container) { return 1; }
            const availW = container.clientWidth - 16; // padding allowance
            const availH = container.clientHeight - 16;

            let vbW, vbH;
            if (svgElement.viewBox && svgElement.viewBox.baseVal && svgElement.viewBox.baseVal.width && svgElement.viewBox.baseVal.height) {
                vbW = svgElement.viewBox.baseVal.width;
                vbH = svgElement.viewBox.baseVal.height;
            } else {
                try {
                    const bbox = svgElement.getBBox();
                    vbW = bbox.width || 1;
                    vbH = bbox.height || 1;
                } catch {
                    vbW = svgElement.clientWidth || 1;
                    vbH = svgElement.clientHeight || 1;
                }
            }
            if (vbW === 0 || vbH === 0) { return 1; }
            const scale = Math.min(availW / vbW, availH / vbH, 1); // never upscale above 1
            return scale <= 0 || !isFinite(scale) ? 1 : scale;
        }

        // Diagram stage wrappers
        const outerStage = document.createElement('div');
        outerStage.style.cssText = 'position:relative;overflow:auto;max-height:calc(90vh - 100px);display:flex;justify-content:center;align-items:center;';
        innerStage = document.createElement('div');
        innerStage.style.cssText = 'transform-origin:center center;transition:transform 0.25s ease;display:inline-block;';
        outerStage.appendChild(innerStage);

        // Buttons
        const btnZoomOut = createIconButton('−', 'Zoom out', () => applyScale(currentScale - STEP));
        const btnZoomIn = createIconButton('+', 'Zoom in', () => applyScale(currentScale + STEP));
        const btnFit = createIconButton('⤢', 'Fit to view', () => { fitScale = computeFitScale(); applyScale(fitScale); });
        const btnReset = createIconButton('1:1', 'Reset to 100%', () => applyScale(1));
        const btnCopy = createIconButton('⧉', 'Copy Mermaid source', () => {
            const toCopy = mermaidCode || (svgElement ? new XMLSerializer().serializeToString(svgElement) : '');
            try {
                if (navigator.clipboard && toCopy) {
                    navigator.clipboard.writeText(toCopy).then(() => showToast('Mermaid source copied', 'info')).catch(() => fallbackCopy());
                } else {
                    fallbackCopy();
                }
            } catch { fallbackCopy(); }
            function fallbackCopy() {
                if (!toCopy) { return; }
                const ta = document.createElement('textarea');
                ta.value = toCopy;
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand('copy'); showToast('Mermaid source copied', 'info'); } catch {}
                document.body.removeChild(ta);
            }
        });
        const btnFullscreen = createIconButton('⛶', 'Toggle fullscreen', () => {
            if (document.fullscreenElement) {
                document.exitFullscreen();
            } else {
                modal.requestFullscreen().then(() => { setTimeout(() => { fitScale = computeFitScale(); applyScale(fitScale); }, 50); }).catch(()=>{});
            }
        });
        const btnClose = createIconButton('✖', 'Close', () => closeModal());

        controls.appendChild(zoomBadge);
        controls.appendChild(btnZoomOut);
        controls.appendChild(btnZoomIn);
        controls.appendChild(btnFit);
        controls.appendChild(btnReset);
        controls.appendChild(btnCopy);
        controls.appendChild(btnFullscreen);
        controls.appendChild(btnClose);

        header.appendChild(titleEl);
        header.appendChild(controls);
        modalContent.appendChild(header);
        modalContent.appendChild(outerStage);
        modal.appendChild(modalContent);
        document.body.appendChild(modal);

        // Render mermaid
        if (typeof mermaidLib !== 'undefined') {
            mermaidLib.render(`${diagramId}-modal`, mermaidCode).then((/** @type {{svg:string}} */ res) => {
                const svg = res.svg;
                innerStage.innerHTML = svg;
                svgElement = /** @type {SVGSVGElement|null} */ (innerStage.querySelector('svg'));
                // Initial fit
                fitScale = computeFitScale();
                applyScale(fitScale);
                // Recompute on window resize
                const resizeHandler = () => { const prev = currentScale; fitScale = computeFitScale(); if (Math.abs(prev - fitScale) < 0.01) { return; } applyScale(fitScale); };
                window.addEventListener('resize', resizeHandler);
                modal.addEventListener('remove', () => window.removeEventListener('resize', resizeHandler));
            }).catch((/** @type {any} */ error) => {
                innerStage.innerHTML = `<p style="color: var(--vscode-errorForeground); padding: 20px;">Failed to render diagram: ${error.message}</p>`;
            });
        }

        function closeModal() { modal.remove(); }
    modal.onclick = (e) => { if (e.target === modal) { closeModal(); } };

        // Keyboard shortcuts
        /** @param {KeyboardEvent} e */
        function handleKey(e) {
            if (e.key === 'Escape') { closeModal(); }
            else if (e.key === '+' || e.key === '=') { e.preventDefault(); btnZoomIn.click(); }
            else if (e.key === '-') { e.preventDefault(); btnZoomOut.click(); }
            else if (e.key === '0') { e.preventDefault(); btnReset.click(); }
            else if (e.key.toLowerCase() === 'f') { e.preventDefault(); btnFit.click(); }
        }
        document.addEventListener('keydown', handleKey);
        modal.addEventListener('remove', () => document.removeEventListener('keydown', handleKey));
    }

    // Legacy createModalButton retained for backward compatibility (unused after refactor)
    /** @deprecated */
    function createModalButton() { /* no-op retained */ }

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

    /** @param {string} sender @param {string} message @param {string|undefined} messageType */
    function addMessage(sender, message, messageType) {
        console.log('[NaruhoDocs] addMessage called with:', sender, message);
        console.log('[NaruhoDocs] chatMessages element:', chatMessages);
        if (chatMessages) {
            const messageElement = buildMessageElement(sender, message, messageType);
            // Enhance (mermaid rendering etc.) in both live add & history restore paths
            try { enhanceMessageElement(messageElement, messageType); } catch { /* ignore */ }

            chatMessages.appendChild(messageElement);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
        persistState();
    }

    /**
     * Enhance a freshly built message element: render Mermaid diagrams with controls.
     * Shared between addMessage() and setFullHistory() so diagrams persist after sidebar reopen.
     * @param {HTMLElement} messageElement
     */
    /**
     * @param {HTMLElement} messageElement
     * @param {string | undefined} messageType
     */
    function enhanceMessageElement(messageElement, messageType) {
        if (typeof mermaidLib === 'undefined') { return; }
        const mermaidBlocks = messageElement.querySelectorAll('code.language-mermaid');
        mermaidBlocks.forEach(async (block, index) => {
            const preElement = block.parentElement;
            if (!preElement || preElement.tagName !== 'PRE' || !preElement.parentElement) { return; }
            // If already wrapped (legacy upgrade may have processed), skip
            if (preElement.parentElement.classList && preElement.parentElement.classList.contains('mermaid-diagram-wrapper')) { return; }
            try {
                const mermaidCode = block.textContent || '';
                // Persist original code for hydration on wrapper (not disappearing pre element)
                const diagramId = `mermaid-${Date.now()}-${index}`;

                // Replace pre with container + external toolbar wrapper
                const outerWrapper = document.createElement('div');
                outerWrapper.className = 'mermaid-diagram-wrapper';
                outerWrapper.style.position = 'relative';
                outerWrapper.style.margin = '14px 0 24px 0';
                outerWrapper.dataset.mermaidSource = mermaidCode;
                outerWrapper.dataset.diagramId = diagramId;
                outerWrapper.dataset.enhanced = '1';

                const toolbar = document.createElement('div');
                toolbar.className = 'mermaid-diagram-toolbar';
                toolbar.style.position = 'absolute';
                toolbar.style.top = '-8px';
                toolbar.style.right = '0';
                toolbar.style.display = 'flex';
                toolbar.style.gap = '6px';
                toolbar.style.zIndex = '5';

                /**
                 * @param {string} svgPath
                 * @param {string} title
                 */
                function iconButton(svgPath, title) {
                    const btn = document.createElement('button');
                    btn.title = title;
                    btn.style.cssText = 'background:transparent;border:1px solid var(--vscode-panel-border);width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:6px;cursor:pointer;padding:0;color:var(--vscode-editor-foreground);';
                    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${svgPath}"/></svg>`;
                    btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--vscode-button-hoverBackground)'; });
                    btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
                    return btn;
                }

                const enlargeBtn = iconButton('M15 3h6v6M3 9V3h6M15 21h6v-6M3 15v6h6', 'Open full view');
                const exportBtn = iconButton('M12 5v11m0 0l-4-4m4 4 4-4M5 19h14', 'Export SVG');

                toolbar.appendChild(enlargeBtn);
                toolbar.appendChild(exportBtn);

                const diagramContainer = document.createElement('div');
                diagramContainer.className = 'mermaid-diagram-container';
                diagramContainer.style.textAlign = 'center';
                diagramContainer.style.padding = '10px';
                diagramContainer.style.border = '1px solid var(--vscode-panel-border)';
                diagramContainer.style.borderRadius = '6px';
                diagramContainer.style.backgroundColor = 'var(--vscode-editor-background)';

                outerWrapper.appendChild(toolbar);
                outerWrapper.appendChild(diagramContainer);
                preElement.parentElement.replaceChild(outerWrapper, preElement);

                const { svg } = await mermaidLib.render(diagramId, mermaidCode);
                const diagramContent = document.createElement('div');
                diagramContent.className = 'diagram-content';
                diagramContent.innerHTML = svg;
                diagramContainer.appendChild(diagramContent);
                const svgElement = diagramContent.querySelector('svg');
                if (svgElement) {
                    svgElement.style.cursor = 'pointer';
                    svgElement.style.maxWidth = '100%';
                    svgElement.style.height = 'auto';
                    svgElement.addEventListener('click', () => { openDiagramModal(mermaidCode, diagramId); });
                    enlargeBtn.addEventListener('click', (e) => { e.stopPropagation(); openDiagramModal(mermaidCode, diagramId); });
                    exportBtn.addEventListener('click', (e) => { e.stopPropagation(); if (svgElement) { exportDiagram(svgElement, diagramId); } });
                }
            } catch (error) {
                console.error('Error rendering Mermaid diagram:', error);
                if (preElement instanceof HTMLElement) {
                    preElement.style.backgroundColor = 'var(--vscode-inputValidation-errorBackground)';
                    preElement.style.color = 'var(--vscode-inputValidation-errorForeground)';
                }
            }
        });
        // Hydration pass: wrappers missing SVG but having data-mermaid-source
        const staleWrappers = messageElement.querySelectorAll('div.mermaid-diagram-wrapper');
        staleWrappers.forEach(wrapper => {
            // Deduplicate multiple toolbars if somehow duplicated
            const toolbars = wrapper.querySelectorAll('.mermaid-diagram-toolbar');
            if (toolbars.length > 1) {
                for (let i = 1; i < toolbars.length; i++) { toolbars[i].remove(); }
            }
            const hasSvg = wrapper.querySelector('svg');
            if (hasSvg) { return; }
            const code = wrapper.getAttribute('data-mermaid-source');
            if (!code) { return; }
            try {
                const diagramId = wrapper.getAttribute('data-diagram-id') || `rehydrated-${Date.now()}`;
                let toolbar = wrapper.querySelector('.mermaid-diagram-toolbar');
                // Clear wrapper but keep toolbar node (not cloning) to avoid duplicate stacks
                const toolbarNode = toolbar ? toolbar : null;
                wrapper.innerHTML = '';
                if (toolbarNode) { wrapper.appendChild(toolbarNode); }
                const diagramContainer = document.createElement('div');
                diagramContainer.className = 'mermaid-diagram-container';
                diagramContainer.style.textAlign = 'center';
                diagramContainer.style.padding = '10px';
                diagramContainer.style.border = '1px solid var(--vscode-panel-border)';
                diagramContainer.style.borderRadius = '6px';
                diagramContainer.style.backgroundColor = 'var(--vscode-editor-background)';
                wrapper.appendChild(diagramContainer);
                mermaidLib.render(diagramId, code).then((/** @type {{svg:string}} */ { svg }) => {
                    const diagramContent = document.createElement('div');
                    diagramContent.className = 'diagram-content';
                    diagramContent.innerHTML = svg;
                    diagramContainer.appendChild(diagramContent);
                    const svgElement = diagramContent.querySelector('svg');
                    if (svgElement) {
                        svgElement.style.cursor = 'pointer';
                        svgElement.style.maxWidth = '100%';
                        svgElement.style.height = 'auto';
                        svgElement.addEventListener('click', () => { openDiagramModal(code, diagramId); });
                    }
                }).catch(()=>{});
            } catch { /* ignore */ }
        });
    }

    /**
     * Build a chat message DOM element (shared by addMessage & setFullHistory for flicker-free rendering)
     * @param {string} sender
     * @param {string} message
     */
    /**
     * @param {string} sender
     * @param {string} message
     * @param {string | undefined} messageType
     */
    function buildMessageElement(sender, message, messageType) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message');
        if (sender === 'You') {
            messageElement.classList.add('user');
        } else if (sender === 'System') {
            messageElement.classList.add('system');
        } else {
            messageElement.classList.add('bot');
        }
        if (messageType === 'diagram') {
            messageElement.classList.add('diagram');
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

    /**
     * Upgrade any legacy-rendered mermaid diagrams (text buttons or raw code blocks) to new wrapper/icon format.
     */
    function upgradeLegacyDiagrams() {
        if (!chatMessages) { return; }
        // Convert raw code blocks not yet wrapped
        const rawBlocks = chatMessages.querySelectorAll('pre > code.language-mermaid');
        rawBlocks.forEach(code => {
            const msgEl = code.closest('.message');
            if (msgEl && msgEl instanceof HTMLElement) { try { enhanceMessageElement(msgEl, 'diagram'); } catch { /* ignore */ } }
        });
        // Replace any text-based buttons labeled Enlarge / Export inside diagrams
        const legacyButtons = chatMessages.querySelectorAll('.message button');
        legacyButtons.forEach(btn => {
            const txt = (btn.textContent||'').trim().toLowerCase();
            if (txt === 'enlarge' || txt === 'export') {
                const msgEl = btn.closest('.message');
                if (msgEl && msgEl instanceof HTMLElement) { try { enhanceMessageElement(msgEl, 'diagram'); } catch { /* ignore */ } }
            }
        });
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
                addMessage(message.sender, message.message, message.messageType);
                break;
            case 'clearMessages':
                clearMessages();
                break;
            case 'docCreated':
                addMessage('System', `Documentation file created: <code>${message.filePath}</code>`, undefined);
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
