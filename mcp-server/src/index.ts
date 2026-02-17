#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { chromium, Browser, Page, BrowserContext } from 'playwright';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';

// ==================== TYPES ====================

interface PerplexitySession {
  context: BrowserContext;
  page: Page;
  isLoggedIn: boolean;
}

interface SearchResponse {
  success: boolean;
  answer?: string;
  sources?: Array<{ title: string; url: string }>;
  error?: string;
}

// ==================== PERPLEXITY AUTOMATION ====================

class PerplexityAutomation {
  private session: PerplexitySession | null = null;
  private userDataDir = './perplexity-user-data';

  async initialize(): Promise<void> {
    if (this.session) return;

    console.error('[Perplexity] Initializing browser session...');

    const context = await chromium.launchPersistentContext(this.userDataDir, {
      headless: false,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    const page = context.pages()[0] || await context.newPage();

    // Set up stealth mode
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });

    // Check if already logged in
    await page.goto('https://www.perplexity.ai', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    const loginButton = await page.locator('button:has-text("Sign In"), button:has-text("Log in")').first();
    const isLoggedIn = !(await loginButton.isVisible().catch(() => false));

    this.session = {
      context,
      page,
      isLoggedIn,
    };

    console.error(`[Perplexity] Session initialized. Logged in: ${isLoggedIn}`);
  }

  async search(query: string, options: { mode?: 'concise' | 'copilot' | 'deep' } = {}): Promise<SearchResponse> {
    if (!this.session) {
      await this.initialize();
    }

    if (!this.session) {
      return { success: false, error: 'Failed to initialize browser session' };
    }

    const { page } = this.session;
    const mode = options.mode || 'concise';

    try {
      console.error(`[Perplexity] Searching: "${query}" (mode: ${mode})`);

      // Navigate to Perplexity
      await page.goto('https://www.perplexity.ai', { waitUntil: 'networkidle' });
      await page.waitForTimeout(1000);

      // Select mode if needed (for copilot or deep search)
      if (mode !== 'concise') {
        try {
          const modeSelector = page.locator('[data-testid="mode-selector"], button:has-text("Focus")').first();
          if (await modeSelector.isVisible({ timeout: 2000 })) {
            await modeSelector.click();
            await page.waitForTimeout(500);

            const modeOption = page.locator(`button:has-text("${mode.charAt(0).toUpperCase() + mode.slice(1)}")`).first();
            if (await modeOption.isVisible({ timeout: 1000 })) {
              await modeOption.click();
              await page.waitForTimeout(500);
            }
          }
        } catch {
          // Mode selection not available, continue with default
        }
      }

      // Find and fill the search input
      const searchInput = page.locator('textarea[placeholder*="Ask"], textarea[placeholder*="question"], textarea').first();
      await searchInput.waitFor({ state: 'visible', timeout: 10000 });
      await searchInput.click();
      await searchInput.fill('');

      // Type the query with human-like delay
      await searchInput.type(query, { delay: 30 });

      // Submit the search
      await page.keyboard.press('Enter');

      console.error('[Perplexity] Waiting for response...');

      // Wait for the response to appear
      await page.waitForSelector('[data-testid="answer"], .prose, [class*="answer"]', {
        timeout: 60000,
      }).catch(() => null);

      // Wait a bit for the full response to load
      await page.waitForTimeout(3000);

      // Extract the answer
      const answerElement = await page.locator('[data-testid="answer"], .prose, [class*="answer"], [class*="response"]').first();
      let answer = '';

      try {
        answer = await answerElement.innerText({ timeout: 5000 });
      } catch {
        // Try alternative selectors
        const alternativeAnswer = await page.locator('main').locator('div').nth(2).innerText().catch(() => '');
        if (alternativeAnswer) {
          answer = alternativeAnswer;
        }
      }

      // Extract sources
      const sources: Array<{ title: string; url: string }> = [];
      try {
        const sourceElements = await page.locator('a[href^="http"]').all();
        for (const source of sourceElements.slice(0, 10)) {
          const title = await source.innerText().catch(() => '');
          const url = await source.getAttribute('href').catch(() => '');
          if (url && title && !sources.find(s => s.url === url)) {
            sources.push({ title: title.trim(), url });
          }
        }
      } catch {
        // Sources extraction failed, continue without them
      }

      console.error(`[Perplexity] Got response (${answer.length} chars, ${sources.length} sources)`);

      return {
        success: true,
        answer: answer || 'No answer received from Perplexity',
        sources,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Perplexity] Error: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  async close(): Promise<void> {
    if (this.session) {
      await this.session.context.close();
      this.session = null;
      console.error('[Perplexity] Session closed');
    }
  }
}

// ==================== MCP SERVER ====================

const perplexity = new PerplexityAutomation();

const server = new Server(
  {
    name: 'perplexity-web-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'perplexity_search',
        description: 'Search the web using Perplexity AI. Returns comprehensive answers with sources.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The search query to send to Perplexity',
            },
            mode: {
              type: 'string',
              enum: ['concise', 'copilot', 'deep'],
              description: 'Search mode: concise (quick), copilot (interactive), or deep (thorough)',
              default: 'concise',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'perplexity_pro_search',
        description: 'Perform a Pro search with more detailed analysis and follow-up capabilities.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The detailed search query',
            },
            focus: {
              type: 'string',
              enum: ['internet', 'academic', 'writing', 'wolfram', 'youtube', 'reddit'],
              description: 'Search focus area',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'perplexity_init',
        description: 'Initialize or reinitialize the Perplexity browser session. Use if experiencing connection issues.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'perplexity_search': {
        const querySchema = z.object({
          query: z.string().min(1),
          mode: z.enum(['concise', 'copilot', 'deep']).optional().default('concise'),
        });

        const parsed = querySchema.parse(args);
        const result = await perplexity.search(parsed.query, { mode: parsed.mode });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'perplexity_pro_search': {
        const proSchema = z.object({
          query: z.string().min(1),
          focus: z.enum(['internet', 'academic', 'writing', 'wolfram', 'youtube', 'reddit']).optional(),
        });

        const parsed = proSchema.parse(args);

        // Navigate with focus if specified
        let searchQuery = parsed.query;
        if (parsed.focus) {
          // Add focus indicator to the search
          searchQuery = `[${parsed.focus}] ${parsed.query}`;
        }

        const result = await perplexity.search(searchQuery, { mode: 'deep' });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'perplexity_init': {
        await perplexity.close();
        await perplexity.initialize();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, message: 'Perplexity session initialized' }),
            },
          ],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${error.message}`);
    }
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${error}`);
  }
});

// ==================== HTTP SERVER (for VSCode extension) ====================

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'perplexity-mcp-server' });
});

// Search endpoint
app.post('/search', async (req, res) => {
  try {
    const { query, mode } = req.body;

    if (!query) {
      res.status(400).json({ error: 'Query is required' });
      return;
    }

    const result = await perplexity.search(query, { mode });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Initialize endpoint
app.post('/init', async (req, res) => {
  try {
    await perplexity.close();
    await perplexity.initialize();
    res.json({ success: true, message: 'Session initialized' });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Start HTTP server
const HTTP_PORT = process.env.MCP_HTTP_PORT ? parseInt(process.env.MCP_HTTP_PORT) : 3333;
app.listen(HTTP_PORT, () => {
  console.error(`[MCP HTTP Server] Listening on port ${HTTP_PORT}`);
});

// ==================== START MCP SERVER ====================

async function main() {
  console.error('[MCP Server] Starting Perplexity MCP Server...');
  console.error('[MCP Server] HTTP endpoint: http://localhost:' + HTTP_PORT);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[MCP Server] Connected via stdio transport');

  // Initialize Perplexity session on startup
  await perplexity.initialize().catch(err => {
    console.error('[MCP Server] Failed to initialize Perplexity:', err);
  });
}

main().catch((error) => {
  console.error('[MCP Server] Fatal error:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.error('[MCP Server] Shutting down...');
  await perplexity.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('[MCP Server] Shutting down...');
  await perplexity.close();
  process.exit(0);
});
