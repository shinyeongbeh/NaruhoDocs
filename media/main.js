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
        if (!threadListMenu) return;
        threadListMenu.innerHTML = '';
        let activeTitle = '';
        let foundActive = false;
        // Show/hide general buttons
        const generalButtons = document.getElementById('general-buttons');
        if (generalButtons) {
            generalButtons.style.display = (activeThreadId === 'naruhodocs-general-thread') ? 'flex' : 'none';
        }

    // Remove mode buttons from menu area
    // Add mode switch buttons inside chat area for document-specific threads
    let chatModeButtons = document.getElementById('chat-mode-buttons');
    if (!chatModeButtons) {
        chatModeButtons = document.createElement('div');
        chatModeButtons.id = 'chat-mode-buttons';
        chatModeButtons.style.display = 'flex';
        chatModeButtons.style.gap = '8px';
        chatModeButtons.style.margin = '12px 0';
        // Insert above chat input container
        const chatInputContainer = document.querySelector('.chat-input-container');
        if (chatInputContainer && chatInputContainer.parentElement) {
            chatInputContainer.parentElement.insertBefore(chatModeButtons, chatInputContainer);
        }
    }
    if (activeThreadId !== 'naruhodocs-general-thread') {
        chatModeButtons.innerHTML = '';
        const beginnerBtn = document.createElement('button');
        beginnerBtn.textContent = 'Beginner Mode';
        beginnerBtn.onclick = () => {
            console.log('Beginner mode clicked');
            vscode.postMessage({
                type: 'setThreadBeginnerMode',
                sessionId: activeThreadId
            });
        };
        const devBtn = document.createElement('button');
        devBtn.textContent = 'Developer Mode';
        devBtn.onclick = () => {
            console.log('Developer mode clicked');
            vscode.postMessage({
                type: 'setThreadDeveloperMode',
                sessionId: activeThreadId
            });
        };
        chatModeButtons.appendChild(beginnerBtn);
        chatModeButtons.appendChild(devBtn);
        chatModeButtons.style.display = 'flex';
    } else {
        chatModeButtons.innerHTML = '';
        chatModeButtons.style.display = 'none';
    }
        // Add event listeners for general buttons
        const generateDocBtn = document.getElementById('generate-doc-btn');
        if (generateDocBtn) {
            generateDocBtn.addEventListener('click', () => {
                // Show modal dialog for doc type selection
                showDocTypeModal();
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

    const title = document.createElement('h2');
    title.textContent = 'Select Documentation Type';
    box.appendChild(title);

        // Example starter doc types
        const docTypes = ['README', 'API Reference', 'Getting Started', 'Contributing Guide', 'Others'];
        docTypes.forEach(type => {
            const btn = document.createElement('button');
            btn.textContent = type;
            btn.addEventListener('click', () => {
                if (type === 'Others') {
                    showCustomDocPrompt(modal);
                } else {
                    vscode.postMessage({ type: 'generateDoc', docType: type });
                    modal.remove();
                }
            });
            box.appendChild(btn);
        });

        modal.appendChild(box);
        document.body.appendChild(modal);
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
                vscode.postMessage({ type: 'suggestTemplate' });
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
                if (dropdownContainer) dropdownContainer.style.display = 'none';
                if (hamburgerMenu) hamburgerMenu.classList.remove('open');
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
            if (dropdownContainer) dropdownContainer.style.display = 'none';
            if (hamburgerMenu) hamburgerMenu.classList.remove('open');
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
                // If sessionId is provided, set active thread
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
            case 'resetState':  // ✅ reset support
                vscode.setState(null);
                if (chatMessages) chatMessages.innerHTML = '';
                if (currentDocName) currentDocName.textContent = '';
                activeThreadId = undefined;
                threads = [];
                if (dropdownContainer) dropdownContainer.style.display = 'none';
                if (hamburgerMenu) hamburgerMenu.classList.remove('open');
                break;
        }
    });

}());
