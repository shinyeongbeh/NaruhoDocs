// @ts-check

// This script will be run within the webview itself
// It cannot access the main VS Code APIs directly.

(function () {
    // @ts-ignore: acquireVsCodeApi is provided by VS Code webview
    const vscode = acquireVsCodeApi();

    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input'); // HTMLTextAreaElement
    const sendIcon = document.getElementById('send-icon');
    const threadTabs = document.getElementById('thread-tabs');

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

    function renderThreadTabs() {
        if (!threadTabs) { return; }
        threadTabs.innerHTML = '';
        threads.forEach(thread => {
            const tab = document.createElement('button');
            // Show only file name, tooltip full path
            const fileName = thread.title.split(/[/\\]/).pop();
            tab.textContent = fileName;
            tab.title = thread.title; // Tooltip full path
            tab.className = 'thread-tab';
            if (thread.id === activeThreadId) {
                tab.style.fontWeight = 'bold';
                tab.style.background = 'var(--vscode-list-activeSelectionBackground)';
            }
            tab.onclick = () => {
                vscode.postMessage({ type: 'switchThread', sessionId: thread.id });
            };
            threadTabs.appendChild(tab);
        });
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

    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'addMessage':
                addMessage(message.sender, message.message);
                break;
            case 'threadList':
                threads = message.threads || [];
                activeThreadId = message.activeThreadId;
                renderThreadTabs();
                break;
            case 'showHistory':
                showHistory(message.history);
                break;
        }
    });

    function addMessage(sender, message) {
        if (chatMessages) {
            const messageElement = document.createElement('div');
            messageElement.classList.add('message');
            if (sender === 'You') {
                messageElement.classList.add('user');
            } else {
                messageElement.classList.add('bot');
            }
            messageElement.innerHTML = `<strong>${sender}:</strong> ${message}`;
            chatMessages.appendChild(messageElement);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
    }
}());
