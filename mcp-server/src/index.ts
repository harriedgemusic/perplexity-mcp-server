#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { chromium, Page, BrowserContext } from 'playwright';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

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
  debug?: string;
}

// ==================== PERPLEXITY AUTOMATION ====================

class PerplexityAutomation {
  private session: PerplexitySession | null = null;
  private userDataDir = './perplexity-user-data';
  private debugDir = './debug-screenshots';

  private async saveDebugScreenshot(page: Page, name: string): Promise<string | null> {
    try {
      if (!fs.existsSync(this.debugDir)) {
        fs.mkdirSync(this.debugDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filepath = path.join(this.debugDir, `${name}-${timestamp}.png`);
      await page.screenshot({ path: filepath, fullPage: true });
      console.error(`[Debug] Screenshot saved: ${filepath}`);
      return filepath;
    } catch (e) {
      console.error('[Debug] Failed to save screenshot:', e);
      return null;
    }
  }

  private async findSearchInput(page: Page): Promise<{ locator: any; method: string } | null> {
    // Try multiple selectors for the search input
    const selectors = [
      // Current Perplexity selectors (2024-2025)
      { locator: page.locator('textarea').first(), method: 'textarea' },
      { locator: page.locator('[contenteditable="true"]').first(), method: 'contenteditable' },
      { locator: page.locator('div[role="textbox"]').first(), method: 'role-textbox' },
      { locator: page.locator('input[type="text"]').first(), method: 'input-text' },
      // Try placeholder variations
      { locator: page.locator('[placeholder*="Ask"]'), method: 'placeholder-ask' },
      { locator: page.locator('[placeholder*="ask"]'), method: 'placeholder-ask-lower' },
      { locator: page.locator('[placeholder*="question"]'), method: 'placeholder-question' },
      { locator: page.locator('[placeholder*="Search"]'), method: 'placeholder-search' },
      // Try aria-label
      { locator: page.locator('[aria-label*="Ask"]'), method: 'aria-ask' },
      { locator: page.locator('[aria-label*="Search"]'), method: 'aria-search' },
      // Generic selectors
      { locator: page.locator('.ProseMirror').first(), method: 'prosemirror' },
      { locator: page.locator('[data-testid*="search"]').first(), method: 'testid-search' },
      { locator: page.locator('[data-testid*="input"]').first(), method: 'testid-input' },
    ];

    for (const { locator, method } of selectors) {
      try {
        const isVisible = await locator.isVisible({ timeout: 1000 });
        if (isVisible) {
          console.error(`[Perplexity] Found input using method: ${method}`);
          return { locator, method };
        }
      } catch {
        // Try next selector
      }
    }

    return null;
  }

  private async findSubmitButton(page: Page): Promise<any | null> {
    const selectors = [
      page.locator('button[type="submit"]'),
      page.locator('button:has-text("Search")'),
      page.locator('button[aria-label*="Search"]'),
      page.locator('button[aria-label*="Send"]'),
      page.locator('button:has-text("Ask")'),
      page.locator('svg[class*="send"]').locator('..'),
      page.locator('[data-testid*="submit"]'),
      page.locator('[data-testid*="send"]'),
    ];

    for (const locator of selectors) {
      try {
        if (await locator.first().isVisible({ timeout: 500 })) {
          return locator.first();
        }
      } catch {
        // Try next
      }
    }

    return null;
  }

  /**
   * Check if response is complete by looking for the completion indicator
   */
  private async isResponseComplete(page: Page): Promise<boolean> {
    try {
      // This selector appears when Perplexity finishes generating the answer
      const completeIndicator = page.locator('div.flex.items-center.justify-between').first();
      return await completeIndicator.isVisible({ timeout: 1000 });
    } catch {
      return false;
    }
  }

  /**
   * Analyze page structure and log details for debugging
   */
  private async analyzePageStructure(page: Page): Promise<void> {
    console.error('\n[DEBUG] ========== PAGE STRUCTURE ANALYSIS ==========\n');

    try {
      const analysis = await page.evaluate(() => {
        const results: any = {
          finishedElements: [],
          gapYMdElements: [],
          answerContainers: [],
          siblingStructure: [],
        };

        // 1. Find all elements containing "Finished" text
        const allElements = Array.from(document.querySelectorAll('*'));
        const finishedEls = allElements.filter(el => {
          const text = el.textContent || '';
          return text.includes('Finished') && text.length < 200;
        });

        finishedEls.forEach((el, i) => {
          const parent = el.parentElement;
          const grandParent = parent?.parentElement;
          const greatGrandParent = grandParent?.parentElement;
          const greatGreatGrandParent = greatGrandParent?.parentElement;

          results.finishedElements.push({
            index: i,
            tagName: el.tagName,
            text: el.textContent?.trim().substring(0, 100),
            className: el.className,
            parent: parent ? {
              tag: parent.tagName,
              class: parent.className,
            } : null,
            grandParent: grandParent ? {
              tag: grandParent.tagName,
              class: grandParent.className,
            } : null,
            greatGrandParent: greatGrandParent ? {
              tag: greatGrandParent.tagName,
              class: greatGrandParent.className,
              id: greatGrandParent.id,
            } : null,
            greatGreatGrandParent: greatGreatGrandParent ? {
              tag: greatGreatGrandParent.tagName,
              class: greatGreatGrandParent.className,
              childCount: greatGreatGrandParent.children.length,
              innerHTML: greatGreatGrandParent.innerHTML.substring(0, 500),
            } : null,
          });
        });

        // 2. Find .gap-y-md elements and their structure
        document.querySelectorAll('.gap-y-md').forEach((el, i) => {
          const parent = el.parentElement;
          const siblings = parent ? Array.from(parent.children) : [];
          
          results.gapYMdElements.push({
            index: i,
            className: el.className,
            parentClass: parent?.className,
            parentTag: parent?.tagName,
            siblingCount: siblings.length,
            siblingIndex: siblings.indexOf(el),
            innerHTML: el.innerHTML.substring(0, 800),
            textContent: el.textContent?.substring(0, 500),
            childCount: el.children.length,
          });
        });

        // 3. Find structure around "div.flex.items-center.justify-between"
        const completeIndicators = document.querySelectorAll('div.flex.items-center.justify-between');
        completeIndicators.forEach((el, i) => {
          const parent = el.parentElement;
          const siblings = parent ? Array.from(parent.children) : [];
          const prevSibling = el.previousElementSibling;
          const nextSibling = el.nextElementSibling;

          results.siblingStructure.push({
            index: i,
            className: el.className,
            parentClass: parent?.className,
            siblingIndex: siblings.indexOf(el),
            prevSibling: prevSibling ? {
              tag: prevSibling.tagName,
              class: prevSibling.className,
              text: prevSibling.textContent?.substring(0, 200),
            } : null,
            nextSibling: nextSibling ? {
              tag: nextSibling.tagName,
              class: nextSibling.className,
              text: nextSibling.textContent?.substring(0, 200),
            } : null,
          });
        });

        // 4. Find potential answer containers
        const containerSelectors = [
          { name: 'prose', selector: '.prose' },
          { name: 'markdown', selector: '[class*="markdown"], [class*="Markdown"]' },
          { name: 'answer', selector: '[class*="answer"]' },
          { name: 'response', selector: '[class*="response"]' },
          { name: 'article', selector: 'article' },
          { name: 'main-div', selector: 'main > div' },
        ];

        containerSelectors.forEach(({ name, selector }) => {
          document.querySelectorAll(selector).forEach((el, i) => {
            const text = el.textContent || '';
            if (text.length > 100) {
              results.answerContainers.push({
                type: name,
                index: i,
                className: el.className,
                tagName: el.tagName,
                textLength: text.length,
                textPreview: text.substring(0, 300),
              });
            }
          });
        });

        return results;
      });

      // Log results
      console.error('[DEBUG] --- FINISHED ELEMENTS ---');
      analysis.finishedElements.forEach((el: any) => {
        console.error(`  [${el.index}] <${el.tagName}> "${el.text}"`);
        console.error(`      class: ${el.className}`);
        if (el.greatGreatGrandParent) {
          console.error(`      great-great-grandparent: <${el.greatGreatGrandParent.tag}> class="${el.greatGreatGrandParent.class}"`);
          console.error(`      children count: ${el.greatGreatGrandParent.childCount}`);
        }
      });

      console.error('\n[DEBUG] --- GAP-Y-MD ELEMENTS ---');
      analysis.gapYMdElements.forEach((el: any) => {
        console.error(`  [${el.index}] parent: <${el.parentTag}> class="${el.parentClass}"`);
        console.error(`      sibling index: ${el.siblingIndex} of ${el.siblingCount}`);
        console.error(`      text: ${el.textContent?.substring(0, 200)}`);
      });

      console.error('\n[DEBUG] --- COMPLETION INDICATOR STRUCTURE ---');
      analysis.siblingStructure.forEach((el: any) => {
        console.error(`  [${el.index}] sibling index: ${el.siblingIndex}`);
        console.error(`      prev sibling: <${el.prevSibling?.tag}> class="${el.prevSibling?.class}"`);
        console.error(`      next sibling: <${el.nextSibling?.tag}> class="${el.nextSibling?.class}"`);
      });

      console.error('\n[DEBUG] --- ANSWER CONTAINERS ---');
      analysis.answerContainers.slice(0, 10).forEach((el: any) => {
        console.error(`  [${el.type}] ${el.textLength} chars`);
        console.error(`      class: ${el.className}`);
        console.error(`      preview: ${el.textPreview?.substring(0, 150)}...`);
      });

      console.error('\n[DEBUG] ==========================================\n');

    } catch (e) {
      console.error('[DEBUG] Analysis failed:', e);
    }
  }

  /**
   * Extract answer - find the markdown container with the main response
   */
  private async extractAnswer(page: Page): Promise<string> {
    console.error('[Perplexity] Extracting answer from markdown container...');

    // First, analyze the page structure for debugging
    await this.analyzePageStructure(page);

    // Primary: Find markdown container - the main answer content
    const markdownSelectors = [
      // Perplexity markdown containers
      '[class*="markdown"]',
      '[class*="Markdown"]',
      '.markdown-body',
      '.markdown-content',
      '.prose',
      // Generic markdown classes
      '[class*="prose"]',
      'article .prose',
      // Content containers
      '[data-testid*="answer"]',
      '[data-testid*="response"]',
    ];

    for (const selector of markdownSelectors) {
      try {
        const elements = await page.locator(selector).all();
        console.error(`[Perplexity] Checking ${elements.length} elements for selector: ${selector}`);
        
        for (const element of elements) {
          const text = await element.innerText();
          if (text && text.length > 100) {
            // Check if this looks like an answer (not navigation, not footer)
            const className = await element.getAttribute('class') || '';
            const isNavigation = className.includes('nav') || className.includes('header') || className.includes('footer');
            
            if (!isNavigation) {
              console.error(`[Perplexity] Found markdown answer using selector: ${selector}`);
              console.error(`[Perplexity] Answer length: ${text.length} chars`);
              return text.trim();
            }
          }
        }
      } catch (e) {
        console.error(`[Perplexity] Selector ${selector} failed:`, e);
      }
    }

    // Fallback: Look for the largest text block in main content area
    try {
      const mainContent = page.locator('main').first();
      if (await mainContent.isVisible({ timeout: 2000 })) {
        // Find the largest div/section inside main
        const children = await mainContent.locator('> div, > section, > article').all();
        let largestText = '';
        
        for (const child of children) {
          const text = await child.innerText();
          if (text && text.length > largestText.length) {
            largestText = text;
          }
        }
        
        if (largestText.length > 50) {
          console.error('[Perplexity] Found answer in main content (largest block)');
          return largestText.trim();
        }
      }
    } catch (e) {
      console.error('[Perplexity] Main content fallback failed:', e);
    }

    // Last resort: get visible text from page
    try {
      const bodyText = await page.locator('body').innerText();
      // Try to extract relevant portion
      const lines = bodyText.split('\n').filter(l => l.trim().length > 30);
      if (lines.length > 0) {
        console.error('[Perplexity] Using fallback body text');
        return lines.slice(0, 30).join('\n');
      }
    } catch (e) {
      console.error('[Perplexity] Body text fallback failed:', e);
    }

    return '';
  }

  async initialize(): Promise<void> {
    if (this.session) return;

    console.error('[Perplexity] Initializing browser session...');

    // Use Arc (Comet) browser on macOS
    const arcPath = '/Applications/Arc.app/Contents/MacOS/Arc';
    
    const context = await chromium.launchPersistentContext(this.userDataDir, {
      headless: false,
      executablePath: arcPath, // Use Arc (Comet) browser
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
      ignoreHTTPSErrors: true,
    });

    const page = context.pages()[0] || await context.newPage();

    // Set up stealth mode
    await page.addInitScript(() => {
      // Remove webdriver property
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
      // Override plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });
      // Override languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
      // Override chrome property
      (window as any).chrome = { runtime: {} };
    });

    // Navigate to Perplexity
    console.error('[Perplexity] Navigating to perplexity.ai...');
    await page.goto('https://www.perplexity.ai', { 
      waitUntil: 'domcontentloaded',
      timeout: 60000 
    });

    // Wait for page to stabilize
    await page.waitForTimeout(3000);

    // Save screenshot for debugging
    await this.saveDebugScreenshot(page, 'init');

    // Check login status
    let isLoggedIn = true;
    try {
      const signInButton = page.locator('button:has-text("Sign"), a:has-text("Sign"), [href*="login"], [href*="auth"]').first();
      isLoggedIn = !(await signInButton.isVisible({ timeout: 2000 }));
    } catch {
      isLoggedIn = true;
    }

    // Check for cookie consent
    try {
      const acceptCookies = page.locator('button:has-text("Accept"), button:has-text("Accept All"), button:has-text("I agree")').first();
      if (await acceptCookies.isVisible({ timeout: 2000 })) {
        await acceptCookies.click();
        await page.waitForTimeout(1000);
      }
    } catch {
      // No cookie consent
    }

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
      await page.goto('https://www.perplexity.ai', { 
        waitUntil: 'domcontentloaded',
        timeout: 60000 
      });
      await page.waitForTimeout(2000);

      // Save debug screenshot
      await this.saveDebugScreenshot(page, 'before-search');

      // Find search input
      console.error('[Perplexity] Looking for search input...');
      const searchInput = await this.findSearchInput(page);

      if (!searchInput) {
        await this.saveDebugScreenshot(page, 'no-input-found');
        return { 
          success: false, 
          error: 'Could not find search input on page. The page may have changed or there may be a popup.',
          debug: 'Screenshot saved to debug-screenshots/'
        };
      }

      const { locator } = searchInput;

      // Clear and focus the input
      await locator.click();
      await page.waitForTimeout(300);

      // Select all and clear
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(300);

      // Type the query
      console.error('[Perplexity] Typing query...');
      await locator.type(query, { delay: 20 });
      await page.waitForTimeout(500);

      // Try to find and click submit button, or press Enter
      const submitButton = await this.findSubmitButton(page);
      if (submitButton) {
        console.error('[Perplexity] Clicking submit button...');
        await submitButton.click();
      } else {
        console.error('[Perplexity] Pressing Enter...');
        await page.keyboard.press('Enter');
      }

      console.error('[Perplexity] Waiting for response...');

      // Wait for page to start loading
      await page.waitForTimeout(2000);

      // Wait for the completion indicator: div.flex.items-center.justify-between
      // This element appears when Perplexity finishes generating the answer
      console.error('[Perplexity] Waiting for completion indicator...');
      const completionSelector = 'div.flex.items-center.justify-between';
      
      let attempts = 0;
      const maxAttempts = 60; // 60 attempts x 2 seconds = 2 minutes max
      
      while (attempts < maxAttempts) {
        const isComplete = await this.isResponseComplete(page);
        
        if (isComplete) {
          console.error('[Perplexity] Completion indicator found! Response is ready.');
          break;
        }
        
        await page.waitForTimeout(2000);
        attempts++;
        
        if (attempts % 10 === 0) {
          console.error(`[Perplexity] Still waiting for response... (${attempts * 2}s)`);
          await this.saveDebugScreenshot(page, `waiting-${attempts}`);
        }
      }

      if (attempts >= maxAttempts) {
        console.error('[Perplexity] Timeout waiting for completion indicator');
        await this.saveDebugScreenshot(page, 'timeout');
      }

      // Small delay to ensure content is fully rendered
      await page.waitForTimeout(1000);

      // Now extract the answer from .gap-y-md
      const answer = await this.extractAnswer(page);

      // Save final screenshot
      await this.saveDebugScreenshot(page, 'response');

      // Extract sources
      const sources: Array<{ title: string; url: string }> = [];
      try {
        const links = await page.locator('a[href^="http"]').all();
        for (const link of links.slice(0, 15)) {
          try {
            const href = await link.getAttribute('href');
            const text = await link.innerText();
            if (href && text && text.trim().length > 0 && text.length < 200) {
              // Filter out navigation links
              if (!href.includes('perplexity.ai') && !sources.find(s => s.url === href)) {
                sources.push({ title: text.trim().substring(0, 100), url: href });
              }
            }
          } catch {
            // Skip this link
          }
        }
      } catch (e) {
        console.error('[Perplexity] Failed to extract sources:', e);
      }

      console.error(`[Perplexity] Got response (${answer.length} chars, ${sources.length} sources)`);

      return {
        success: true,
        answer: answer || 'No answer received from Perplexity',
        sources: sources.slice(0, 10),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Perplexity] Error: ${errorMessage}`);
      
      await this.saveDebugScreenshot(page, 'error');
      
      return {
        success: false,
        error: errorMessage,
        debug: 'Screenshot saved to debug-screenshots/',
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

        let searchQuery = parsed.query;
        if (parsed.focus) {
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

// Debug endpoint - list screenshots
app.get('/debug/screenshots', (req, res) => {
  const debugDir = './debug-screenshots';
  if (!fs.existsSync(debugDir)) {
    res.json({ screenshots: [] });
    return;
  }
  const files = fs.readdirSync(debugDir).filter(f => f.endsWith('.png'));
  res.json({ screenshots: files });
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
