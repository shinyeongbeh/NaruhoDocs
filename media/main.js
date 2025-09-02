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
    const threadDropdown = document.getElementById('thread-dropdown'); // No longer used
    const threadListMenu = document.getElementById('thread-list-menu');
    const currentDocName = document.getElementById('current-doc-name');

    let activeThreadId = undefined;
    let threads = [];

    function sendMessage() {
        if (chatInput && (chatInput instanceof HTMLTextAreaElement) && chatInput.value) {
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
        threads.forEach(thread => {
            const fileName = thread.title.split(/[/\\]/).pop();
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
                vscode.postMessage({ type: 'switchThread', sessionId: thread.id });
                if (dropdownContainer) dropdownContainer.style.display = 'none';
            });
            threadListMenu.appendChild(item);
        });
        // Fallback: if no active thread, show first thread name
        if (!foundActive && threads.length > 0) {
            activeTitle = threads[0].title.split(/[/\\]/).pop();
        }
        if (currentDocName) {
            currentDocName.textContent = activeTitle;
        }
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
}

    function toggleGeneralTabUI(visible) {
        const generalTabUI = document.getElementById('general-tab-ui');
        if (generalTabUI) {
            generalTabUI.style.display = visible ? 'block' : 'none';
        }
    }

    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'addMessage':
                addMessage(message.sender, message.message);
                break;
            case 'threadList':
                threads = message.threads || [];
                activeThreadId = message.activeThreadId;
                renderThreadListMenu();
                // Always close dropdown and set hamburger to close mode when thread list updates
                if (dropdownContainer) dropdownContainer.style.display = 'none';
                if (hamburgerMenu) hamburgerMenu.classList.remove('open');
                break;
            case 'showHistory':
                showHistory(message.history);
                break;
            case 'toggleGeneralTabUI':
                toggleGeneralTabUI(message.visible);
                break;
        }
    });

    // No dropdown change handler needed

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

    function addMessage(sender, message) {
        if (chatMessages) {
            const messageElement = document.createElement('div');
            messageElement.classList.add('message');
            if (sender === 'You') {
                messageElement.classList.add('user');
            } else {
                messageElement.classList.add('bot');
            }
            messageElement.innerHTML = `</strong> ${message}`;
            chatMessages.appendChild(messageElement);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
    }
}());
