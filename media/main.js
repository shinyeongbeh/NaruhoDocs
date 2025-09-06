// @ts-check

// This script will be run within the webview itself
// It cannot access the main VS Code APIs directly.

(function () {
    // @ts-ignore: acquireVsCodeApi is provided by VS Code webview
    const vscode = acquireVsCodeApi();

    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input'); // HTMLTextAreaElement
    const sendIcon = document.getElementById('send-icon');
    const hamburgerMenu = document.getElementById('hamburger-menu');
    const dropdownContainer = document.getElementById('dropdown-container');
    const threadListMenu = document.getElementById('thread-list-menu');
    const currentDocName = document.getElementById('current-doc-name');

    let activeThreadId = undefined;
    let threads = [];
    // Store mode for each thread: 'beginner' or 'developer'
    let threadModes = {};

    const oldState = vscode.getState() || {};

    if (oldState.chatHTML && chatMessages) {
        chatMessages.innerHTML = oldState.chatHTML;
    }
    if (oldState.activeDocName && currentDocName) {
        currentDocName.textContent = oldState.activeDocName;
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

    function sendMessage() {
        if (chatInput && (chatInput instanceof HTMLTextAreaElement) && chatInput.value) {
            console.log('[NaruhoDocs] sendMessage triggered:', chatInput.value);
            vscode.postMessage({
                type: 'sendMessage',
                value: chatInput.value
            });
            addMessage('You', chatInput.value);
            chatInput.value = '';
        }
    }

    if (sendIcon) {
        sendIcon.addEventListener('click', sendMessage);
    }

    if (chatInput) {
        chatInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        });
    }

    function renderThreadListMenu() {
        // Sync backend mode on tab switch (if not general thread)
        if (activeThreadId && activeThreadId !== 'naruhodocs-general-thread') {
            let mode = threadModes[activeThreadId] || 'developer';
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
        if (activeThreadId !== 'naruhodocs-general-thread') {
            chatModeButtons.innerHTML = '';
            // Create custom slide switch for mode selection
            const switchLabel = document.createElement('label');
            switchLabel.className = 'switch';

            // Hidden checkbox for accessibility and state
            const switchInput = document.createElement('input');
            switchInput.type = 'checkbox';
            switchInput.className = 'switch-checkbox';
            let mode = threadModes[activeThreadId] || 'developer';
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
                threadModes[activeThreadId] = switchInput.checked ? 'beginner' : 'developer';
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
        // Add event listeners for general buttons
        const generateDocBtn = document.getElementById('generate-doc-btn');
        if (generateDocBtn) {
            generateDocBtn.addEventListener('click', () => {
                // Remove any previous modal and listeners
                let oldModal = document.getElementById('doc-type-modal');
                if (oldModal) oldModal.remove();
                // Always trigger a fresh scan before showing modal
                vscode.postMessage({ type: 'scanDocs' });
                console.log('[NaruhoDocs][UI] Generate Doc button clicked, scanDocs posted');
                // Show modal dialog for doc type selection
                showDocTypeModal();
                console.log('[NaruhoDocs][UI] showDocTypeModal called');
                console.log('[NaruhoDocs][UI] showDocTypeModal rendering modal');
            });
        }
        // Modal for doc type selection
        function showDocTypeModal() {
            // Remove existing modal if present
            let oldModal = document.getElementById('doc-type-modal');
            if (oldModal) oldModal.remove();

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
            function handleAISuggestedDocs(event) {
                const message = event.data;
                if (message.type === 'aiSuggestedDocs') {
                    // Remove loading
                    box.innerHTML = '';
                    box.appendChild(closeBtn);
                    // Only show the title and suggestion buttons after loading
                    const title = document.createElement('h2');
                    title.textContent = 'Select Documentation Type';
                    box.appendChild(title);
                    // Filter AI suggestions using existingFiles
                    const existingFiles = Array.isArray(message.existingFiles) ? message.existingFiles : [];
                    const filteredSuggestions = message.suggestions.filter(s =>
                        s.fileName && !existingFiles.includes(s.fileName.toLowerCase())
                    );
                    filteredSuggestions.forEach(suggestion => {
                        const btn = document.createElement('button');
                        btn.textContent = suggestion.displayName;
                        btn.title = suggestion.description || '';
                        btn.addEventListener('click', () => {
                            addMessage('System', 'Generating documentation...');
                            vscode.postMessage({ type: 'generateDoc', docType: suggestion.displayName, fileName: suggestion.fileName });
                            modal.remove();
                        });
                        box.appendChild(btn);
                    });
                    // Always add 'Others' button at the end
                    const othersBtn = document.createElement('button');
                    othersBtn.textContent = 'Others';
                    othersBtn.addEventListener('click', () => {
                        addMessage('System', 'Generating documentation...');
                        showCustomDocPrompt(modal);
                    });
                    box.appendChild(othersBtn);
                    window.removeEventListener('message', handleAISuggestedDocs);
                }
            }
            window.addEventListener('message', handleAISuggestedDocs);
        }

        function showCustomDocPrompt(modal) {
            // Remove previous prompt if any
            let oldPrompt = document.getElementById('custom-doc-prompt');
            if (oldPrompt) oldPrompt.remove();

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
            submitBtn.addEventListener('click', () => {
                if (input.value.trim()) {
                    addMessage('System', 'Generating documentation...');
                    vscode.postMessage({ type: 'generateDoc', docType: input.value.trim() });
                    if (modal) modal.remove();
                }
            });
            promptBox.appendChild(submitBtn);

            modal.querySelector('div').appendChild(promptBox);
        }
        const suggestTemplateBtn = document.getElementById('suggest-template-btn');
        if (suggestTemplateBtn) {
            suggestTemplateBtn.addEventListener('click', () => {
                // Remove any previous modal and listeners
                let oldModal = document.getElementById('doc-type-modal');
                if (oldModal) oldModal.remove();
                // Always trigger a fresh scan before showing modal
                vscode.postMessage({ type: 'scanDocs' });
                showTemplateSelectionModal();
            });
        }

        // Modal for template selection (uses AI suggestions and filters out existing docs)
        function showTemplateSelectionModal() {
            let oldModal = document.getElementById('doc-type-modal');
            if (oldModal) oldModal.remove();

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
            function handleAISuggestedDocs(event) {
                const message = event.data;
                if (message.type === 'aiSuggestedDocs') {
                    // Remove loading
                    box.innerHTML = '';
                    box.appendChild(closeBtn);
                    // Only show the title and suggestion buttons after loading
                    const title = document.createElement('h2');
                    title.textContent = 'Select Documentation Template';
                    box.appendChild(title);
                    // Filter AI suggestions using existingFiles
                    const existingFiles = Array.isArray(message.existingFiles) ? message.existingFiles : [];
                    const filteredSuggestions = message.suggestions.filter(s =>
                        s.fileName && !existingFiles.includes(s.fileName.toLowerCase())
                    );
                    filteredSuggestions.forEach(suggestion => {
                        const btn = document.createElement('button');
                        btn.textContent = suggestion.displayName;
                        btn.title = suggestion.description || '';
                        btn.addEventListener('click', () => {
                            addMessage('You', `Generate a ${suggestion.displayName} template.`);
                            vscode.postMessage({ type: 'sendMessage', value: `Generate a ${suggestion.displayName} template.` });
                            modal.remove();
                        });
                        box.appendChild(btn);
                    });
                    // Always add 'Others' button at the end
                    const othersBtn = document.createElement('button');
                    othersBtn.textContent = 'Others';
                    othersBtn.addEventListener('click', () => {
                        showCustomTemplatePrompt(modal);
                    });
                    box.appendChild(othersBtn);
                    window.removeEventListener('message', handleAISuggestedDocs);
                }
            }
            window.addEventListener('message', handleAISuggestedDocs);
        }

        function showCustomTemplatePrompt(modal) {
            let oldPrompt = document.getElementById('custom-doc-prompt');
            if (oldPrompt) oldPrompt.remove();

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
                    addMessage('You', `Generate a ${templateType} template.`);
                    vscode.postMessage({ type: 'sendMessage', value: `Generate a ${templateType} template.` });
                    if (modal) modal.remove();
                }
            });
            promptBox.appendChild(submitBtn);

            modal.querySelector('div').appendChild(promptBox);
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

    function showHistory(history) {
        clearMessages();
        if (Array.isArray(history)) {
            console.log('[NaruhoDocs] Showing history:', history);
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
            const isOpen = dropdownContainer.style.display === 'none';
            dropdownContainer.style.display = isOpen ? 'block' : 'none';
            hamburgerMenu.classList.toggle('open', isOpen);
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

    // --- remove the first duplicate window.addEventListener(...) block above ---

    function addMessage(sender, message) {
        if (chatMessages) {
            const messageElement = document.createElement('div');
            messageElement.classList.add('message');
            if (sender === 'You') {
                messageElement.classList.add('user');
            } else {
                messageElement.classList.add('bot');
            }

            const parsedMessage = md.render(message);
            messageElement.innerHTML = parsedMessage;

            chatMessages.appendChild(messageElement);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
        persistState();
    }

    // ✅ single unified listener
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'addMessage':
                addMessage(message.sender, message.message);
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
                    if (prev) prev.remove();

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
            case 'showSaveTemplateButtons':
                if (chatMessages) {
                    // If the template is a 'not needed' message, do not show save modal
                    if (typeof message.template === 'string' && message.template.trim().toLowerCase().startsWith('this project does not require')) {
                        // Do not show save modal
                        break;
                    }
                    const prev = document.getElementById('save-template-btn-container');
                    if (prev) prev.remove();

                    const btnContainer = document.createElement('div');
                    btnContainer.id = 'save-template-btn-container';
                    btnContainer.className = 'button-group';

                    const labelDiv = document.createElement('div');
                    labelDiv.textContent = 'Save template as new file?';
                    labelDiv.className = 'button-group-label';
                    btnContainer.appendChild(labelDiv);

                    const yesBtn = document.createElement('button');
                    yesBtn.textContent = 'Yes';
                    yesBtn.className = 'save-btn';
                    yesBtn.onclick = () => {
                        vscode.postMessage({
                            type: 'createAndSaveTemplateFile',
                            text: message.template,
                            uri: message.sessionId,
                            docType: message.docType || message.templateType || 'README'
                        });
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
        }
    });

}());
