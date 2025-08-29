// @ts-check

// This script will be run within the webview itself
// It cannot access the main VS Code APIs directly.
(function () {
    const vscode = acquireVsCodeApi();

    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const sendButton = document.getElementById('send-button');

    function sendMessage() {
        if (chatInput && chatInput.value) {
            vscode.postMessage({
                type: 'sendMessage',
                value: chatInput.value
            });
            addMessage('You', chatInput.value);
            chatInput.value = '';
        }
    }

    if (sendButton) {
        sendButton.addEventListener('click', sendMessage);
    }

    if (chatInput) {
        chatInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        });
    }

    window.addEventListener('message', event => {
        const message = event.data; // The JSON data our extension sent
        switch (message.type) {
            case 'addMessage':
                addMessage(message.sender, message.message);
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
