import { execSync } from 'child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'fs';
import { PNG } from 'pngjs';
import { chromium as chrome, Page } from 'playwright';
import * as pixelmatch from 'pixelmatch';

type OverridableConfig = {
  takeScreenshot?: boolean;
  timeout?: number;
  useScreenshotComparison?: boolean;
  useTerminalNotifier?: boolean;
};

type Watcher = OverridableConfig & {
  name: string;
  url: string;
  actions?: string[] | string[][];
  screenshot?: {
    selector?: string;
    ignoreFoundFileForScreenshotDiff?: boolean;
  };
  waitForText?: {
    isPresent?: boolean;
    text: string;
  };
};
type Config = OverridableConfig & {
  defaultActions?: string[] | string[][];
  ignoreFoundFileForScreenshotDiff?: boolean;
  sendSms?: string[];
  smsPath?: string;
  terminalNotifierPath?: string;
  watchers: Watcher[];
};

const WIDTH = 1440;
const HEIGHT = 2560;

const config: Config = require('./config.json');

const Logger = (name: string) => {
  const helper = (severity: 'log' | 'error' | 'debug') => (...message: any[]) => {
    const dateString = new Date().toLocaleString('en', {
      timeZoneName: 'short',
    });
    console[severity](`[${dateString}] [${name}]`, message);
  };

  const log = helper('debug');
  const debug = helper('debug');
  const error = helper('error');

  return {
    log,
    error,
    debug,
  };
};
const nonInstancedLogger = Logger('scrape');

const instance = async (defaultConfig: Omit<Config, 'watchers'>, watcherConfig: Watcher) => {
  const timeout = watcherConfig.timeout || defaultConfig.timeout || 15000;
  const { name, url, waitForText: { text, isPresent } = {} } = watcherConfig;
  const screenshot = watcherConfig.screenshot;
  const takeScreenshot =
    (defaultConfig.takeScreenshot || watcherConfig.takeScreenshot) && watcherConfig.takeScreenshot !== false;
  const useTerminalNotifier =
    (defaultConfig.useTerminalNotifier || watcherConfig.useTerminalNotifier) &&
    watcherConfig.useTerminalNotifier !== false;
  const useScreenshotComparison =
    watcherConfig.screenshot ||
    ((defaultConfig.useScreenshotComparison || watcherConfig.useScreenshotComparison) &&
      watcherConfig.useScreenshotComparison !== false);
  const logger = Logger(name);
  const dataDir = `.data/${name}`;
  const foundFile = `${dataDir}/FOUND_${new Date().toLocaleDateString().replace(/\//g, '_')}`;
  const ignoreFoundFileForScreenshotDiff =
    useScreenshotComparison &&
    (defaultConfig.ignoreFoundFileForScreenshotDiff === true ||
      watcherConfig.screenshot?.ignoreFoundFileForScreenshotDiff === true);

  logger.log('Checking...');

  mkdirSync(dataDir, { recursive: true });

  if (existsSync(foundFile) && !ignoreFoundFileForScreenshotDiff) {
    logger.log(`Already found.`);
    return;
  }

  const waitForText = async (page: Page, text: string) => {
    try {
      await page.waitForLoadState('networkidle', { timeout });
      await page.waitForSelector(`text=${text}`, { timeout });
      return true;
    } catch (e) {
      if (e.name === 'TimeoutError') {
        return false;
      }
      logger.log(e);
      return false;
    }
  };

  const scrape = async (name: string, url: string, searchString: string, waitForTextToBePresent = false) => {
    const browser = await chrome.launch();
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.setViewportSize({
      width: WIDTH,
      height: HEIGHT,
    });

    try {
      const [request] = await Promise.all([
        page.goto(url, {
          timeout,
          waitUntil: 'networkidle',
        }),
      ]);

      if (screenshot || useScreenshotComparison) {
        const screenshotElement = screenshot?.selector ? await page.$(screenshot?.selector) : page;

        await page.waitForTimeout(10000);
        await page.waitForLoadState('networkidle', { timeout });
        const screenshotPath = `${dataDir}/${name}`;
        const baseScreenshotPath = `${screenshotPath}_Base.png`;
        const baseScreenshotPathOld = `${screenshotPath}_Base_Old.png`;
        const latestScreenshotPath = `${screenshotPath}_Latest.png`;
        const diffScreenshotPath = `${screenshotPath}_Diff.png`;

        if (!existsSync(baseScreenshotPath)) {
          await screenshotElement.screenshot({ path: baseScreenshotPath });
          logger.log(`No existing screenshotPath, taking base image and returning true: "${baseScreenshotPath}"`);
          return true;
        }

        const baseScreenshot = PNG.sync.read(readFileSync(baseScreenshotPath));
        const newScreenshot = PNG.sync.read(await screenshotElement.screenshot({ path: latestScreenshotPath }));
        const { height, width } = baseScreenshot;
        const diff = new PNG({ width, height });
        const numDiffPixels = pixelmatch(baseScreenshot.data, newScreenshot.data, diff.data, width, height, {
          threshold: 0.1,
        });
        logger.log(`Screenshot diff: ${numDiffPixels} different pixels`);
        writeFileSync(`${diffScreenshotPath}`, PNG.sync.write(diff));

        if (numDiffPixels > 0) {
          logger.log(`Updating base image because we have a match :)`, { numDiffPixels });
          copyFileSync(baseScreenshotPath, baseScreenshotPathOld);
          copyFileSync(latestScreenshotPath, baseScreenshotPath);
          return true;
        }

        return false;
      }

      const textIsPresent = await waitForText(page, searchString);
      const conditionMet = waitForTextToBePresent ? textIsPresent === true : textIsPresent === false;

      if (takeScreenshot) {
        const screenshotPath = `${dataDir}/${name}_${(conditionMet && 'AVAILABLE') || 'UNAVAILABLE'}.png`;
        await page.screenshot({
          path: screenshotPath,
        });
      }

      return conditionMet;
    } catch (e) {
      logger.error(e);
    } finally {
      await browser.close();
    }
  };

  const conditionMet = await scrape(name, url, text, isPresent);

  if (text) {
    logger.log(
      `[${(conditionMet && 'AVAILABLE') || 'No appointments'}] text "${watcherConfig.waitForText.text}" was ${
        (((conditionMet && isPresent) || (!conditionMet && !isPresent)) && 'FOUND') || 'NOT found'
      }`
    );
  }

  if (conditionMet) {
    execSync(`touch "${foundFile}"`);

    const replaceVariables = (str: string) => str.replace('%URL%', url).replace('%NAME%', `${name}`);
    const actions = watcherConfig.actions?.length ? watcherConfig.actions : defaultConfig.defaultActions ?? [];
    const updatedActions = actions.map((action: string | string[]) => {
      if (Array.isArray(action)) {
        return replaceVariables(action.join(' '));
      }
      return replaceVariables(action);
    });

    if (useTerminalNotifier) {
      if (!defaultConfig.terminalNotifierPath) {
        logger.error(`Missing setting for "terminalNotifierPath"`);
        return;
      }
      const subtitle =
        useScreenshotComparison || watcherConfig.screenshot
          ? 'Screenshot diff'
          : isPresent
          ? `Found the text: '${text}'`
          : `Did not find the text: '${text}'`;
      const terminalNotifierCommand = [
        defaultConfig.terminalNotifierPath,
        `-title "Covid Alert! [${name}]"`,
        `-subtitle "${subtitle}"`,
        '-sound sosumi',
        `-open "${url}"`,
      ].join(' ');
      execSync(terminalNotifierCommand);
    }

    if (defaultConfig.sendSms?.length) {
      if (!defaultConfig.smsPath) {
        logger.error(`Missing setting for "smsPath"`);
        return;
      }
      defaultConfig.sendSms.forEach((phoneNumber) => {
        const smsCommand = [
          defaultConfig.smsPath,
          phoneNumber,
          `\"Book a vaccine appointment! [${name}] ${url}\"`,
        ].join(' ');
        execSync(smsCommand);
      });
    }

    updatedActions.forEach(execSync);
  }
};

try {
  (async () => {
    const { watchers, ...defaultConfig } = config;
    for (const watcher of watchers) {
      await instance(defaultConfig, watcher);
    }
    return;
    //return await Promise.all(watchers.map((watcher) => instance(defaultConfig, watcher)));
  })();
} catch (e) {
  nonInstancedLogger.log(e);
}

export {};
