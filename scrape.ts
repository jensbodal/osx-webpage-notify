import { execSync } from 'child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { PNG } from 'pngjs';
import { chromium as chrome, Page } from 'playwright';
import { got } from 'got';
import { diff } from 'deep-object-diff';
import * as pixelmatch from 'pixelmatch';

// set this elsewhere but whatever right now
let temp_num_diff_pixels = 0;
let temp_links = [];

type OverridableConfig = {
  takeScreenshot?: boolean;
  timeout?: number;
  useScreenshotComparison?: boolean;
  useTerminalNotifier?: boolean;
  waitForPageManual?: number;
};

type Watcher = OverridableConfig & {
  name: string;
  url: string;
  actions?: string[] | string[][];
  screenshot?: {
    selector?: string;
    ignoreFoundFileForScreenshotDiff?: boolean;
  };
  /**
   * Currently only supports GET operations
   */
  useAPI?: {
    openLinkOnDiff?: string;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
  };
  waitForText?: {
    isPresent?: boolean;
    text: string;
  };
};

type Config = OverridableConfig & {
  browserExecutablePath?: string;
  userAgent?: string;
  defaultActions?: string[] | string[][];
  ignoreFoundFileForScreenshotDiff?: boolean;
  sendSms?: string[];
  /**
   * defaults to ./bin/imessage
   */
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

const writeJson = (filepath: string, json: any) => {
  writeFileSync(filepath, JSON.stringify(json, null, 2));
}

const instance = async (defaultConfig: Omit<Config, 'watchers'>, watcherConfig: Watcher) => {
  const timeout = watcherConfig.timeout || defaultConfig.timeout || 15000;
  const { name, url, waitForText: { text = '', isPresent } = {} } = watcherConfig;
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
  const dataDir =  resolve(`.data/${name}`);
  const binDir = resolve('bin');
  const dataPath = `${dataDir}/${name}`;
  const baseScreenshotPath = `${dataPath}_Base.png`;
  const baseScreenshotPathOld = `${dataPath}_Base_Old.png`;
  const latestScreenshotPath = `${dataPath}_Latest.png`;
  const diffScreenshotPath = `${dataPath}_Diff.png`;
  const resultsPathBase = `${dataPath}_Base.json`;
  const resultsPathOld = `${dataPath}_Old.json`;
  const resultsPathLatest = `${dataPath}_Latest.json`;
  const resultsPathDiff = `${dataPath}_Diff.json`;
  const resultsPathDiffOld = `${dataPath}_Diff_Old.json`;
  const foundFile = `${dataDir}/FOUND_${new Date().toLocaleDateString().replace(/\//g, '_')}`;
  const browserExecutablePath = defaultConfig.browserExecutablePath || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const userAgent =
    defaultConfig.userAgent ||
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.0.0 Safari/537.36';
  const ignoreFoundFileForScreenshotDiff =
    useScreenshotComparison &&
    (defaultConfig.ignoreFoundFileForScreenshotDiff === true ||
      watcherConfig.screenshot?.ignoreFoundFileForScreenshotDiff === true);

  logger.log('Checking...');

  mkdirSync(dataDir, { recursive: true });

  // TODO this logic is bad, will ignore found file for any type of watcher
  if (existsSync(foundFile) && !ignoreFoundFileForScreenshotDiff && !!!watcherConfig.useAPI) {
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
    const browser = await chrome.launch({
      headless: true,
      executablePath: browserExecutablePath,
    });
    const context = await browser.newContext({
      bypassCSP: true,
      extraHTTPHeaders: {
      'user-agent': userAgent,
      accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      },
      userAgent
    });
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
      // add an arbitrary wait here because domcontentloaded and networkidle
      // are not reliable for SPAs
      logger.log('Waiting for load state "domcontentloaded"');
      await page.waitForLoadState('domcontentloaded');
      logger.log('Waiting for load state "load"');
      await page.waitForLoadState('load');
      logger.log('Manually waiting for 3s');
      await page.waitForTimeout(3_000);

      if (screenshot || useScreenshotComparison) {
        const screenshotElement = screenshot?.selector ? await page.$(screenshot?.selector) : page;

        logger.log('Waiting for load state "networkidle"');
        await page.waitForLoadState('networkidle', { timeout });
        logger.log('Waiting for load state "domcontentloaded"');
        await page.waitForLoadState('domcontentloaded')
        logger.log('Waiting for load state "load"');

        if (watcherConfig.waitForPageManual) {
          logger.log(`Manually waiting for ${watcherConfig.waitForPageManual/1000.0}s`);
          await page.waitForTimeout(watcherConfig.waitForPageManual);
        }

        if (!existsSync(baseScreenshotPath)) {
          await screenshotElement?.screenshot({ path: baseScreenshotPath });
          copyFileSync(baseScreenshotPath, baseScreenshotPathOld);
          copyFileSync(baseScreenshotPath, latestScreenshotPath);
          copyFileSync(baseScreenshotPath, diffScreenshotPath);
          logger.log(`No existing dataPath, taking base images and returning true: "${baseScreenshotPath}"`);
          return true;
        }

        const baseScreenshot = PNG.sync.read(readFileSync(baseScreenshotPath));
        const newScreenshot = PNG.sync.read(await screenshotElement!.screenshot({ path: latestScreenshotPath }));
        const { height, width } = baseScreenshot;
        const diff = new PNG({ width, height });
        const numDiffPixels = pixelmatch(baseScreenshot.data, newScreenshot.data, diff.data, width, height, {
          threshold: 0.1,
        });

        temp_num_diff_pixels = numDiffPixels;

        writeFileSync(`${diffScreenshotPath}`, PNG.sync.write(diff));

        logger.log(`Screenshot diff difference: (${numDiffPixels}px)`);

        if (numDiffPixels > 500) {
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
        const dataPath = `${dataDir}/${name}_${(conditionMet && 'AVAILABLE') || 'UNAVAILABLE'}.png`;
        await page.screenshot({
          path: dataPath,
        });
      }

      return conditionMet;
    } catch (e) {
      logger.error(e);
    } finally {
      await browser.close();
    }
  };

  const useAPI = async (url: string, options: Watcher['useAPI']) => {
    try {
      if (options?.queryParams) {
        url = `${url}${encodeURIComponent(JSON.stringify(options.queryParams))}`
      }
      // TODO this could be better
      const result: any = await got.get(url, {
        headers: {
          'user-agent': userAgent,
          ...options?.headers
        },
      }).json();

      if (!existsSync(resultsPathBase)) {
        writeJson(`${resultsPathBase}`, {});
      }
      if (!existsSync(resultsPathDiff)) {
        writeJson(`${resultsPathDiff}`, {});
      }

      const baseJson = JSON.parse(readFileSync(resultsPathBase).toString());
      const diffJson = diff(baseJson, result);
      const isDifferent = Object.keys(diffJson).length > 0;

      if (isDifferent) {
        copyFileSync(resultsPathBase, resultsPathOld);
        copyFileSync(resultsPathDiff, resultsPathDiffOld);
        writeJson(resultsPathBase, result);
        writeJson(resultsPathDiff, diffJson);

        // TODO this is currently hardcoded to tesla
        temp_links = result?.results?.map((r: Record<string, unknown>) => `https://www.tesla.com/my/order/${r.VIN}`);
        logger.log(temp_links);
      }

      writeJson(resultsPathLatest, result);

      logger.log(`[useAPI] [${name}] results`, { isDifferent });

      return isDifferent;
    } catch (e) {
      logger.error('Error fetching from API')
      logger.error(e);
      return false;
    }
  };

  // TODO: refactor
  // This is the entry point for each watcher
  const conditionMet = watcherConfig.useAPI ? await useAPI(url, watcherConfig.useAPI) : await scrape(name, url, text, isPresent);

  if (text) {
    logger.log(
      `[${conditionMet ? 'AVAILABLE' : 'NOT AVAILABLE'}] text "${watcherConfig.waitForText?.text}" was ${
        ((conditionMet && isPresent) || (!conditionMet && !isPresent)) ? 'FOUND' : 'NOT found'
      }`
    );
  }

  const dateStamp = new Date(new Date().getTime()-(7*60*60*1000)).toISOString().slice(0,-5);

  if (conditionMet) {
    execSync(`touch "${foundFile}"`);

    const replaceVariables = (str: string) => str.replace('%URL%', url).replace('%NAME%', `${name}`);
    // allows passing empty array of actions so that we don't use the defaultActions
    const actions = (watcherConfig.actions ? watcherConfig.actions : defaultConfig.defaultActions) ?? [];
    const updatedActions = actions.map((action: string | string[]) => {
      if (Array.isArray(action)) {
        return replaceVariables(action.join(' '));
      }
      return replaceVariables(action);
    });

    updatedActions.forEach(execSync);

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
        `-title "Scraped! [${name}] ${dateStamp}"`,
        `-subtitle "${subtitle}"`,
        '-sound sosumi',
        `-open -a "${browserExecutablePath.replace(/(.*?.app)(.*)/, '$1')}" "${url}"`,
      ].join(' ');
      logger.log(`[notification] \"Scraped! [${name} | ${temp_num_diff_pixels}px] ${dateStamp} ${url}\"`);
      execSync(terminalNotifierCommand);
    }

    logger.log(resolve(binDir, 'imessage'));

    if (defaultConfig.sendSms?.length) {
      const smsPath = defaultConfig.smsPath || resolve(binDir, 'imessage');

      const smsMessage = watcherConfig.useAPI
        ? `\"Scraped! [${name} | object diff] ${dateStamp} ${'\n * ' + watcherConfig.useAPI.openLinkOnDiff ?? url}${temp_links.length ? ' \n * ' : ''}${temp_links.join(' \n * ')}\"`
        : `\"Scraped! [${name} | ${temp_num_diff_pixels}px] ${dateStamp} ${url}\"`;

      logger.log(`[sms] ${smsMessage}`)

      defaultConfig.sendSms.forEach((phoneNumber) => {
        const smsCommand = [
          smsPath,
          phoneNumber,
          smsMessage,
          watcherConfig.useScreenshotComparison ? `"${diffScreenshotPath}"` : undefined,
        ].join(' ');
        execSync(smsCommand);
      });
    }
  }
};

try {
  (async () => {
    const { watchers, ...defaultConfig } = config;
    for (const watcher of watchers) {
      await instance(defaultConfig, watcher);
    }
    return;
  })();
} catch (e) {
  nonInstancedLogger.log(e);
}

export {};
