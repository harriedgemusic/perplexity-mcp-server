import * as vscode from 'vscode';
import axios from 'axios';

// ==================== TYPES ====================

interface SearchResponse {
  success: boolean;
  answer?: string;
  sources?: Array<{ title: string; url: string }>;
  error?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  sources?: Array<{ title: string; url: string }>;
  timestamp: Date;
}

// ==================== MCP CLIENT ====================

class McpClient {
  private serverUrl: string;

  constructor() {
    this.serverUrl = vscode.workspace.getConfiguration('perplexityMcp').get('serverUrl', 'http://localhost:3333');
  }

  async isServerRunning(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.serverUrl}/health`, { timeout: 2000 });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async search(query: string, mode: 'concise' | 'copilot' | 'deep' = 'concise'): Promise<SearchResponse> {
    try {
      const response = await axios.post(`${this.serverUrl}/search`, { query, mode }, {
        timeout: 120000, // 2 minutes timeout for long searches
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        return {
          success: false,
          error: error.response?.data?.error || error.message,
        };
      }
      return {
        success: false,
        error: 'Unknown error occurred',
      };
    }
  }

  async initialize(): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
      const response = await axios.post(`${this.serverUrl}/init`, {}, { timeout: 30000 });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        return {
          success: false,
          error: error.response?.data?.error || error.message,
        };
      }
      return {
        success: false,
        error: 'Unknown error occurred',
      };
    }
  }
}

// ==================== CHAT PROVIDER ====================

class PerplexityChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'perplexity.chatView';
  private _view?: vscode.WebviewView;
  private mcpClient: McpClient;
  private messages: ChatMessage[] = [];
  private extensionUri: vscode.Uri;

  constructor(extensionUri: vscode.Uri, mcpClient: McpClient) {
    this.extensionUri = extensionUri;
    this.mcpClient = mcpClient;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'search':
          await this._handleSearch(data.query, data.mode);
          break;
        case 'init':
          await this._handleInit();
          break;
        case 'clear':
          this.messages = [];
          this._updateMessages();
          break;
      }
    });

    // Check server status
    this._checkServerStatus();
  }

  private async _checkServerStatus(): Promise<void> {
    const isRunning = await this.mcpClient.isServerRunning();
    this._sendMessage({
      type: 'serverStatus',
      isRunning,
    });
  }

  private async _handleInit(): Promise<void> {
    this._sendMessage({ type: 'loading', isLoading: true, message: 'Initializing Perplexity session...' });

    const result = await this.mcpClient.initialize();

    this._sendMessage({ type: 'loading', isLoading: false });

    if (result.success) {
      vscode.window.showInformationMessage('Perplexity session initialized successfully!');
      this._sendMessage({
        type: 'initResult',
        success: true,
        message: result.message,
      });
    } else {
      vscode.window.showErrorMessage(`Failed to initialize: ${result.error}`);
      this._sendMessage({
        type: 'initResult',
        success: false,
        error: result.error,
      });
    }
  }

  private async _handleSearch(query: string, mode: 'concise' | 'copilot' | 'deep'): Promise<void> {
    if (!query.trim()) {
      return;
    }

    // Add user message
    const userMessage: ChatMessage = {
      role: 'user',
      content: query,
      timestamp: new Date(),
    };
    this.messages.push(userMessage);
    this._updateMessages();

    // Show loading
    this._sendMessage({ type: 'loading', isLoading: true, message: 'Searching Perplexity...' });

    // Perform search
    const response = await this.mcpClient.search(query, mode);

    this._sendMessage({ type: 'loading', isLoading: false });

    // Add assistant message
    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: response.success && response.answer ? response.answer : `Error: ${response.error || 'Unknown error'}`,
      sources: response.sources,
      timestamp: new Date(),
    };
    this.messages.push(assistantMessage);
    this._updateMessages();
  }

  private _updateMessages(): void {
    this._sendMessage({
      type: 'messages',
      messages: this.messages,
    });
  }

  private _sendMessage(message: object): void {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  public async search(query: string, mode: 'concise' | 'copilot' | 'deep' = 'concise'): Promise<void> {
    if (this._view) {
      this._view.show(true);
    }
    await this._handleSearch(query, mode);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Perplexity AI</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--vscode-font-family);
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      padding: 12px;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .header h2 {
      font-size: 14px;
      font-weight: 600;
    }

    .status-indicator {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #f48771;
    }

    .status-dot.connected {
      background: #89d185;
    }

    .controls {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }

    .mode-select {
      flex: 1;
      padding: 6px 10px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font-size: 12px;
    }

    .init-btn, .clear-btn {
      padding: 6px 12px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }

    .init-btn:hover, .clear-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .chat-container {
      flex: 1;
      overflow-y: auto;
      margin-bottom: 12px;
      padding: 8px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
    }

    .message {
      margin-bottom: 16px;
      padding: 10px;
      border-radius: 8px;
      max-width: 95%;
    }

    .message.user {
      background: var(--vscode-input-background);
      margin-left: auto;
      border-bottom-right-radius: 2px;
    }

    .message.assistant {
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-bottom-left-radius: 2px;
    }

    .message-role {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      margin-bottom: 6px;
      color: var(--vscode-descriptionForeground);
    }

    .message-content {
      font-size: 13px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    .sources {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .sources-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }

    .source-link {
      display: block;
      font-size: 11px;
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      margin-bottom: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .source-link:hover {
      text-decoration: underline;
    }

    .loading {
      display: none;
      align-items: center;
      justify-content: center;
      padding: 12px;
      background: var(--vscode-input-background);
      border-radius: 6px;
      margin-bottom: 12px;
    }

    .loading.active {
      display: flex;
    }

    .loading-spinner {
      width: 16px;
      height: 16px;
      border: 2px solid var(--vscode-progressBar-background);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-right: 8px;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .input-container {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .search-input {
      width: 100%;
      padding: 10px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      color: var(--vscode-input-foreground);
      border-radius: 6px;
      font-size: 13px;
      resize: vertical;
      min-height: 60px;
      max-height: 150px;
      font-family: inherit;
    }

    .search-input:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }

    .search-btn {
      padding: 10px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
    }

    .search-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .search-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .empty-state {
      text-align: center;
      padding: 24px;
      color: var(--vscode-descriptionForeground);
    }

    .empty-state-icon {
      font-size: 32px;
      margin-bottom: 8px;
    }

    .error-state {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      padding: 10px;
      border-radius: 4px;
      margin-bottom: 12px;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="header">
    <h2>🔮 Perplexity AI</h2>
    <div class="status-indicator">
      <div class="status-dot" id="statusDot"></div>
      <span id="statusText">Checking...</span>
    </div>
  </div>

  <div class="controls">
    <select class="mode-select" id="modeSelect">
      <option value="concise">Concise</option>
      <option value="copilot">Copilot</option>
      <option value="deep">Deep Search</option>
    </select>
    <button class="init-btn" id="initBtn" title="Initialize Session">⚙️</button>
    <button class="clear-btn" id="clearBtn" title="Clear Chat">🗑️</button>
  </div>

  <div class="error-state" id="errorState" style="display: none;"></div>

  <div class="loading" id="loading">
    <div class="loading-spinner"></div>
    <span id="loadingText">Loading...</span>
  </div>

  <div class="chat-container" id="chatContainer">
    <div class="empty-state">
      <div class="empty-state-icon">🔍</div>
      <p>Ask Perplexity anything...</p>
    </div>
  </div>

  <div class="input-container">
    <textarea class="search-input" id="searchInput" placeholder="Enter your question..." rows="2"></textarea>
    <button class="search-btn" id="searchBtn">Search Perplexity</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const modeSelect = document.getElementById('modeSelect');
    const initBtn = document.getElementById('initBtn');
    const clearBtn = document.getElementById('clearBtn');
    const errorState = document.getElementById('errorState');
    const loading = document.getElementById('loading');
    const loadingText = document.getElementById('loadingText');
    const chatContainer = document.getElementById('chatContainer');
    const searchInput = document.getElementById('searchInput');
    const searchBtn = document.getElementById('searchBtn');

    let isLoading = false;

    // Send search
    function doSearch() {
      const query = searchInput.value.trim();
      const mode = modeSelect.value;

      if (!query || isLoading) return;

      vscode.postMessage({ type: 'search', query, mode });
      searchInput.value = '';
    }

    searchBtn.addEventListener('click', doSearch);
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        doSearch();
      }
    });

    initBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'init' });
    });

    clearBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'clear' });
    });

    // Handle messages from extension
    window.addEventListener('message', (event) => {
      const message = event.data;

      switch (message.type) {
        case 'serverStatus':
          statusDot.classList.toggle('connected', message.isRunning);
          statusText.textContent = message.isRunning ? 'Connected' : 'Disconnected';
          break;

        case 'loading':
          isLoading = message.isLoading;
          loading.classList.toggle('active', message.isLoading);
          loadingText.textContent = message.message || 'Loading...';
          searchBtn.disabled = message.isLoading;
          break;

        case 'initResult':
          if (message.success) {
            errorState.style.display = 'none';
          } else {
            errorState.textContent = message.error;
            errorState.style.display = 'block';
          }
          break;

        case 'messages':
          renderMessages(message.messages);
          break;
      }
    });

    function renderMessages(messages) {
      if (messages.length === 0) {
        chatContainer.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🔍</div><p>Ask Perplexity anything...</p></div>';
        return;
      }

      chatContainer.innerHTML = messages.map(msg => {
        let sourcesHtml = '';
        if (msg.sources && msg.sources.length > 0) {
          sourcesHtml = '<div class="sources">' +
            '<div class="sources-title">Sources:</div>' +
            msg.sources.map(s => '<a class="source-link" href="' + s.url + '" target="_blank">' + s.title + '</a>').join('') +
            '</div>';
        }

        return '<div class="message ' + msg.role + '">' +
          '<div class="message-role">' + msg.role + '</div>' +
          '<div class="message-content">' + escapeHtml(msg.content) + '</div>' +
          sourcesHtml +
          '</div>';
      }).join('');

      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
  </script>
</body>
</html>`;
  }
}

// ==================== EXTENSION ACTIVATION ====================

export function activate(context: vscode.ExtensionContext): void {
  console.log('Perplexity MCP Client extension is activating...');

  const mcpClient = new McpClient();
  const chatProvider = new PerplexityChatProvider(context.extensionUri, mcpClient);

  // Register the sidebar view
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      PerplexityChatProvider.viewType,
      chatProvider
    )
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('perplexity.search', async () => {
      const editor = vscode.window.activeTextEditor;
      let initialQuery = '';

      if (editor) {
        const selection = editor.selection;
        if (!selection.isEmpty) {
          initialQuery = editor.document.getText(selection);
        }
      }

      const query = await vscode.window.showInputBox({
        prompt: 'Enter your Perplexity search query',
        value: initialQuery,
        placeHolder: 'Ask anything...',
      });

      if (query) {
        const config = vscode.workspace.getConfiguration('perplexityMcp');
        const defaultMode = config.get<'concise' | 'copilot' | 'deep'>('defaultMode', 'concise');
        await chatProvider.search(query, defaultMode);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('perplexity.proSearch', async () => {
      const query = await vscode.window.showInputBox({
        prompt: 'Enter your Pro search query',
        placeHolder: 'Detailed question for deep analysis...',
      });

      if (query) {
        await chatProvider.search(query, 'deep');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('perplexity.initSession', async () => {
      const result = await mcpClient.initialize();
      if (result.success) {
        vscode.window.showInformationMessage('Perplexity session initialized successfully!');
      } else {
        vscode.window.showErrorMessage(`Failed to initialize session: ${result.error}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('perplexity.openPanel', () => {
      vscode.commands.executeCommand('workbench.view.extension.perplexity-sidebar');
    })
  );

  // Auto-initialize if configured
  const config = vscode.workspace.getConfiguration('perplexityMcp');
  if (config.get('autoInit', true)) {
    setTimeout(async () => {
      const isRunning = await mcpClient.isServerRunning();
      if (isRunning) {
        console.log('Perplexity MCP Server is running');
      } else {
        vscode.window.showWarningMessage(
          'Perplexity MCP Server is not running. Please start the server first.',
          'Start Server',
          'Dismiss'
        ).then((selection) => {
          if (selection === 'Start Server') {
            // Open terminal with instructions
            const terminal = vscode.window.createTerminal('Perplexity MCP Server');
            terminal.show();
            terminal.sendText('cd perplexity-mcp-server/mcp-server && npm run dev');
          }
        });
      }
    }, 2000);
  }

  console.log('Perplexity MCP Client extension activated');
}

export function deactivate(): void {
  console.log('Perplexity MCP Client extension deactivated');
}
