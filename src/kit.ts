/* eslint-disable no-nested-ternary */
/* eslint-disable import/prefer-default-export */
/* eslint-disable no-case-declarations */
import { app } from 'electron';
import minimist from 'minimist';
import log from 'electron-log';
import path from 'path';
import { pathExistsSync } from 'fs-extra';
import { fork, ForkOptions } from 'child_process';
import { homedir } from 'os';

import { Channel, UI } from '@johnlindquist/kit/cjs/enum';
import {
  parseScript,
  kitPath,
  kenvPath,
  getMainScriptPath,
  KIT_FIRST_PATH,
  getLogFromScriptPath,
} from '@johnlindquist/kit/cjs/utils';
import { ProcessInfo } from '@johnlindquist/kit';

import { subscribeKey } from 'valtio/utils';
import { emitter, KitEvent } from './events';
import { ensureIdleProcess, getIdles, processes } from './process';
import {
  hideAppIfNoWindows,
  isVisible,
  sendToPrompt,
  setScript,
  attemptPreload,
  isFocused,
  focusPrompt,
  initShowPrompt,
} from './prompt';
import { getKitScript, kitState, kitStore } from './state';
import { pathsAreEqual } from './helpers';
import { HideReason, Trigger } from './enums';
import { TrackEvent, trackEvent } from './track';

app.on('second-instance', async (_event, argv) => {
  log.info('second-instance', argv);
  const { _ } = minimist(argv);
  const [, , argScript, ...argArgs] = _;

  // on windows, the protocol is passed as the argScript
  const maybeProtocol = argv?.[2];
  if (maybeProtocol?.startsWith('kit:')) {
    log.info('Detected kit: protocol:', maybeProtocol);
    app.emit('open-url', null, maybeProtocol);
  }

  if (!argScript || !pathExistsSync(argScript)) {
    log.info(`${argScript} does not exist. Ignoring.`);
    return;
  }
  runPromptProcess(argScript, argArgs, {
    force: false,
    trigger: Trigger.Kit,
  });
});

app.on('activate', async (_event, hasVisibleWindows) => {
  kitState.isActivated = true;
  runPromptProcess(getMainScriptPath(), [], {
    force: true,
    trigger: Trigger.Kit,
  });
});

// process.on('unhandledRejection', (reason, p) => {
//   log.warn('Unhandled Rejection at: Promise', p, 'reason:', reason);

//   // application specific logging, throwing an error, or other logic here
// });

process.on('uncaughtException', (error) => {
  log.warn(`Uncaught Exception: ${error.message}`);
  log.warn(error);
});

emitter.on(
  KitEvent.RunPromptProcess,
  (
    scriptOrScriptAndData:
      | {
          scriptPath: string;
          args: string[];
          options: {
            force: boolean;
            trigger: Trigger;
          };
        }
      | string
  ) => {
    const { scriptPath, args, options } =
      typeof scriptOrScriptAndData === 'string'
        ? {
            scriptPath: scriptOrScriptAndData,
            args: [],
            options: {
              force: false,
              trigger: Trigger.Kit,
            },
          }
        : scriptOrScriptAndData;

    if (isVisible()) {
      kitState.ignoreBlur = false;
      hideAppIfNoWindows(HideReason.RunPromptProcess);
    } else {
      log.info(`Show App: ${scriptPath}`);
    }
    runPromptProcess(scriptPath, args, options);
  }
);

emitter.on(KitEvent.RunBackgroundProcess, (scriptPath: string) => {
  runPromptProcess(scriptPath, [], {
    force: false,
    trigger: Trigger.Background,
  });
});

// TODO: Consider removing the "parseScript" and just reading from the scripts db?
const findScript = async (scriptPath: string) => {
  if (scriptPath === getMainScriptPath()) {
    return getKitScript(getMainScriptPath());
  }

  if (
    scriptPath.startsWith(kitPath()) &&
    !scriptPath.startsWith(kitPath('tmp'))
  ) {
    return getKitScript(scriptPath);
  }

  const script = await parseScript(scriptPath);

  return script;
};

export const runPromptProcess = async (
  promptScriptPath: string,
  args: string[] = [],
  options: {
    force: boolean;
    trigger: Trigger;
  } = {
    force: false,
    trigger: Trigger.App,
  }
): Promise<ProcessInfo | null> => {
  const isMain = pathsAreEqual(promptScriptPath || '', getMainScriptPath());
  const isSplash = kitState.ui === UI.splash;

  if (isMain && !isSplash) {
    kitState.mainMenuHasRun = true;
  }

  // readJson(kitPath('db', 'mainShortcuts.json'))
  //   .then(setShortcuts)
  //   .catch((error) => {});

  // If the window is already open, interrupt the process with the new script
  const visible = isVisible();
  const focused = isFocused();
  log.info(`👀 Visible: ${visible ? 'true' : 'false'}`);
  if (visible && !focused) {
    initShowPrompt();
  }
  if (visible) {
    sendToPrompt(
      Channel.START,
      options?.force ? kitState.scriptPath : promptScriptPath
    );
  }
  if (focused) {
    const sameScript = kitState.scriptPath === promptScriptPath;
    if (sameScript && !isSplash) {
      emitter.emit(KitEvent.KillProcess, kitState.pid);
      return null;
    }
  }

  const idlesLength = getIdles().length;
  log.info(`🗿 ${idlesLength} idles`);

  if (isSplash && isMain) {
    log.info(`💦 Splash install screen visible. Preload Main Menu...`);
    try {
      kitState.scriptPath = getMainScriptPath();
      kitState.preloaded = false;
      attemptPreload(getMainScriptPath());
    } catch (error) {
      log.error(error);
    }
  } else if (idlesLength > 0) {
    // This is required so if you press the same shortcut twice, it will close the script
    attemptPreload(promptScriptPath);
  } else {
    ensureIdleProcess();
  }

  log.info(`🏃‍♀️ Run ${promptScriptPath}`);

  const processInfo = processes.findIdlePromptProcess();
  // Add another to the process pool when exhausted.
  const { pid, child } = processInfo;

  log.info(`${pid}: 🏎 ${promptScriptPath} `);
  processInfo.scriptPath = promptScriptPath;
  processInfo.date = Date.now();

  trackEvent(TrackEvent.ScriptTrigger, {
    script: path.basename(promptScriptPath),
    trigger: options.trigger,
    force: options.force,
  });

  const script = await findScript(promptScriptPath);

  const status = await setScript({ ...script }, pid, options?.force);
  if (status === 'denied') {
    log.info(
      `Another script is already controlling the UI. Denying UI control: ${path.basename(
        promptScriptPath
      )}`
    );
  }

  // processes.assignScriptToProcess(promptScriptPath, pid);
  // alwaysOnTop(true);
  // if (!pathsAreEqual(promptScriptPath || '', getMainScriptPath())) {
  //   log.info(`Enabling ignore blur: ${promptScriptPath}`);
  //   kitState.ignoreBlur = true;
  // }

  const argsWithTrigger = [
    ...args,
    `--trigger`,
    options?.trigger ? options.trigger : 'unknown',
    '--force',
    options?.force ? 'true' : 'false',
  ];

  child?.send({
    channel: Channel.VALUE_SUBMITTED,
    input: '',
    value: {
      script: promptScriptPath,
      args: argsWithTrigger,
      trigger: options?.trigger,
    },
  });

  return processInfo;
};

const KIT = kitPath();
const forkOptions: ForkOptions = {
  cwd: homedir(),
  // execPath,
  env: {
    KIT,
    KENV: kenvPath(),
    PATH: KIT_FIRST_PATH + path.delimiter + process?.env?.PATH,
  },
};

export const runScript = (...args: string[]) => {
  log.info(`Run`, ...args);

  return new Promise((resolve, reject) => {
    try {
      const child = fork(kitPath('run', 'terminal.js'), args, forkOptions);

      child.on('message', (data) => {
        const dataString = data.toString();
        log.info(args[0], dataString);
      });

      child.on('exit', () => {
        resolve('success');
      });

      child.on('error', (error: Error) => {
        reject(error);
      });
    } catch (error) {
      log.warn(`Failed to run script ${args}`);
    }
  });
};

subscribeKey(kitState, 'isSponsor', (isSponsor) => {
  log.info(`🎨 Sponsor changed:`, isSponsor);

  // runScript(
  //   kitPath('config', 'toggle-sponsor.js'),
  //   isSponsor ? 'true' : 'false'
  // );

  kitStore.set('sponsor', isSponsor);
});

emitter.on(KitEvent.OpenLog, async (scriptPath) => {
  const logPath = getLogFromScriptPath(scriptPath);
  await runPromptProcess(kitPath('cli/edit-file.js'), [logPath], {
    force: true,
    trigger: Trigger.Kit,
  });
});

emitter.on(KitEvent.OpenScript, async (scriptPath) => {
  await runPromptProcess(kitPath('cli/edit-file.js'), [scriptPath], {
    force: true,
    trigger: Trigger.App,
  });
});
