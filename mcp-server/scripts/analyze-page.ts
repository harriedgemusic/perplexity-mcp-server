import { chromium } from 'playwright';

async function analyzePerplexityPage() {
  console.log('Launching browser...');
  
  const context = await chromium.launchPersistentContext('./perplexity-user-data', {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();

  console.log('Navigating to Perplexity...');
  await page.goto('https://www.perplexity.ai', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Find and fill search input
  const searchInput = page.locator('textarea, [contenteditable="true"], div[role="textbox"]').first();
  await searchInput.waitFor({ state: 'visible', timeout: 10000 });
  await searchInput.click();
  await searchInput.fill('What is machine learning?');
  await page.keyboard.press('Enter');

  console.log('Waiting for response to complete...');
  await page.waitForTimeout(5000);

  // Wait for completion indicator
  let attempts = 0;
  while (attempts < 60) {
    const completeIndicator = page.locator('div.flex.items-center.justify-between').first();
    if (await completeIndicator.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log('✅ Completion indicator found!');
      break;
    }
    await page.waitForTimeout(2000);
    attempts++;
    console.log(`Waiting... ${attempts * 2}s`);
  }

  await page.waitForTimeout(2000);

  // Analyze page structure
  console.log('\n========================================');
  console.log('ANALYZING PAGE STRUCTURE');
  console.log('========================================\n');

  // Get full HTML structure around the answer area
  const pageStructure = await page.evaluate(() => {
    const results: any = {
      bodyClasses: document.body.className,
      mainStructure: '',
      answerContainers: [],
      gapYMdElements: [],
      finishedNearby: [],
      allClasses: new Set<string>(),
    };

    // Collect all unique classes
    document.querySelectorAll('[class]').forEach(el => {
      el.className.split(' ').forEach((c: string) => results.allClasses.add(c));
    });

    // Find elements containing "Finished" text
    const finishedElements = Array.from(document.querySelectorAll('*')).filter(el => 
      el.textContent?.includes('Finished') && el.textContent?.length < 100
    );

    finishedElements.forEach(el => {
      const parent = el.parentElement;
      const grandParent = parent?.parentElement;
      const greatGrandParent = grandParent?.parentElement;
      
      results.finishedNearby.push({
        element: el.tagName,
        text: el.textContent?.trim().substring(0, 100),
        parent: parent ? {
          tag: parent.tagName,
          class: parent.className,
          id: parent.id,
        } : null,
        grandParent: grandParent ? {
          tag: grandParent.tagName,
          class: grandParent.className,
          id: grandParent.id,
        } : null,
        greatGrandParent: greatGrandParent ? {
          tag: greatGrandParent.tagName,
          class: greatGrandParent.className,
          id: greatGrandParent.id,
          innerHTML: greatGrandParent.innerHTML.substring(0, 500),
        } : null,
      });
    });

    // Find .gap-y-md elements
    document.querySelectorAll('.gap-y-md').forEach((el, i) => {
      const parent = el.parentElement;
      const children = Array.from(el.children).map(c => ({
        tag: c.tagName,
        class: c.className,
        textPreview: c.textContent?.substring(0, 100),
      }));
      
      results.gapYMdElements.push({
        index: i,
        class: el.className,
        parentClass: parent?.className,
        parentTag: parent?.tagName,
        childrenCount: el.children.length,
        children: children.slice(0, 5),
        innerHTML: el.innerHTML.substring(0, 1000),
        fullText: el.textContent?.substring(0, 2000),
      });
    });

    // Find answer-related elements
    const answerSelectors = [
      '[class*="answer"]',
      '[class*="response"]',
      '[class*="result"]',
      '[class*="content"]',
      '[class*="markdown"]',
      '[class*="prose"]',
      '.prose',
      'article',
    ];

    answerSelectors.forEach(selector => {
      document.querySelectorAll(selector).forEach((el, i) => {
        if (el.textContent && el.textContent.length > 100) {
          results.answerContainers.push({
            selector,
            index: i,
            class: el.className,
            tag: el.tagName,
            textLength: el.textContent?.length,
            textPreview: el.textContent?.substring(0, 300),
          });
        }
      });
    });

    // Get main content area structure
    const main = document.querySelector('main');
    if (main) {
      results.mainStructure = main.innerHTML.substring(0, 3000);
    }

    return results;
  });

  console.log('BODY CLASSES:', pageStructure.bodyClasses);
  console.log('\n--- UNIQUE CLASSES (relevant ones) ---');
  const relevantClasses = Array.from(pageStructure.allClasses).filter(c => 
    c.includes('answer') || 
    c.includes('response') || 
    c.includes('result') ||
    c.includes('content') ||
    c.includes('markdown') ||
    c.includes('prose') ||
    c.includes('gap') ||
    c.includes('finished') ||
    c.includes('complete')
  );
  console.log(relevantClasses.join('\n'));

  console.log('\n--- ELEMENTS NEAR "Finished" ---');
  pageStructure.finishedNearby.forEach((el: any, i: number) => {
    console.log(`\n[${i}] ${el.element}: "${el.text}"`);
    console.log('  Parent:', el.parent);
    console.log('  GrandParent:', el.grandParent);
    if (el.greatGrandParent) {
      console.log('  GreatGrandParent class:', el.greatGrandParent.class);
      console.log('  GreatGrandParent HTML preview:', el.greatGrandParent.innerHTML?.substring(0, 300));
    }
  });

  console.log('\n--- .gap-y-md ELEMENTS ---');
  pageStructure.gapYMdElements.forEach((el: any, i: number) => {
    console.log(`\n[${i}] class: "${el.class}"`);
    console.log('  Parent:', el.parentTag, '.', el.parentClass);
    console.log('  Children count:', el.childrenCount);
    console.log('  Text preview:', el.fullText?.substring(0, 500));
    console.log('  HTML preview:', el.innerHTML?.substring(0, 300));
  });

  console.log('\n--- ANSWER CONTAINERS ---');
  pageStructure.answerContainers.slice(0, 10).forEach((el: any, i: number) => {
    console.log(`\n[${i}] ${el.selector} [${el.index}]`);
    console.log('  Class:', el.class);
    console.log('  Text length:', el.textLength);
    console.log('  Preview:', el.textPreview?.substring(0, 200));
  });

  // Take screenshot
  await page.screenshot({ path: 'debug-page-analysis.png', fullPage: true });
  console.log('\nScreenshot saved: debug-page-analysis.png');

  // Keep browser open for manual inspection
  console.log('\n========================================');
  console.log('Browser will stay open for 60 seconds for manual inspection...');
  console.log('Open DevTools (F12) to explore the DOM');
  console.log('========================================');
  
  await page.waitForTimeout(60000);

  await context.close();
}

analyzePerplexityPage().catch(console.error);
