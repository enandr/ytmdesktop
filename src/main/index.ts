import {
  app,
  autoUpdater,
  BrowserView,
  BrowserWindow,
  clipboard,
  crashReporter,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  MenuItemConstructorOptions,
  nativeImage,
  safeStorage,
  screen,
  session,
  shell,
  Tray
} from "electron";
import Conf from "conf";
import log from "electron-log";
import path from "path";
import url from "url";
import handleSquirrel from "./squirrel/events";

import MemoryStore from "./memory-store";
import playerStateStore, { PlayerState, VideoState } from "./player-state-store";
import { MemoryStoreSchema, StoreSchema } from "~shared/store/schema";

import CompanionServer from "./integrations/companion-server";
import CustomCSS from "./integrations/custom-css";
import DiscordPresence from "./integrations/discord-presence";
import LastFM from "./integrations/last-fm";
import NowPlayingNotifications from "./integrations/notifications";
import VolumeRatio from "./integrations/volume-ratio";
import fs from "fs/promises";

const assetFolder = path.join(process.env.NODE_ENV === "development" ? path.join(app.getAppPath(), "src/assets") : process.resourcesPath);
const isDarwin = process.platform === "darwin";
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

let applicationExited = false;
let applicationQuitting = false;
let appUpdateAvailable = false;
let appUpdateDownloaded = false;
let appLaunchUpdateCheck = true;

let stateSaverInterval: NodeJS.Timeout | null = null;

//#region   Crash + Error reporting
crashReporter.start({ uploadToServer: false });

log.transports.console.format = "[{processType}][{level}]{text}";
log.transports.file.format = "[{y}-{m}-{d} {h}:{i}:{s}.{ms}][{processType}][{level}]{text}";
log.eventLogger.format = "Electron event {eventSource}#{eventName} observed";

log.initialize({
  preload: true,
  spyRendererConsole: true
});
// Handle logs and errors
log.errorHandler.startCatching({
  showDialog: false,
  onError({ error, processType, versions }) {
    if (applicationExited) return;
    if (processType === "renderer") return;

    if (stateSaverInterval) clearInterval(stateSaverInterval);

    log.error(error);

    let result = 1; // Default to Exit

    const dialogMessage =
      `Environment Details:\n    ${versions.app}\n    ${versions.electron}\n    ${versions.os}\n\n` +
      `Name: ${error.name}\nMessage: ${error.message}\nCause: ${error.cause ?? "Unknown"}\n\n` +
      `${error.stack}`;

    if (!app.isReady()) {
      dialog.showErrorBox(`YouTube Music Desktop App Crashed`, `Application crashed before ready\n\n${dialogMessage}`);
    } else {
      const options = ["Copy to Clipboard and Exit", "Exit"];
      if (!app.isPackaged) {
        options.push("Copy to Clipboard and Continue", "Continue");
      }

      result = dialog.showMessageBoxSync({
        title: "Error",
        message: "YouTube Music Desktop App Crashed",
        detail: dialogMessage,
        type: "error",
        buttons: options
      });

      // Copy to Clipboard
      if (result === 0 || result === 2) {
        clipboard.writeText(`YouTube Music Desktop App Crashed\n\n${dialogMessage}`);
      }
    }

    // Exit
    if (result === 0 || result === 1) {
      applicationExited = true;
      app.exit(1);
    }
  }
});
log.eventLogger.startLogging();

Object.assign(console, log.functions);
//#endregion  Crash + Error reporting

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (await handleSquirrel()) {
  app.quit(); // Always run app quit if squirrel arguments are handled
}

log.info("Application launched");

// Enforce sandbox on all renderers
app.enableSandbox();

// appMenu allows for some basic windows management, editMenu allow for copy and paste shortcuts on MacOS
const template: MenuItemConstructorOptions[] = [{ role: "appMenu", label: "YouTube Music Desktop App" }, { role: "editMenu" }];
const builtMenu = isDarwin ? Menu.buildFromTemplate(template) : null; // null for performance https://www.electronjs.org/docs/latest/tutorial/performance#8-call-menusetapplicationmenunull-when-you-do-not-need-a-default-menu
Menu.setApplicationMenu(builtMenu);

const companionServer = new CompanionServer();
const customCss = new CustomCSS();
const discordPresence = new DiscordPresence();
const lastFMScrobbler = new LastFM();
const nowPlayingNotifications = new NowPlayingNotifications();
const ratioVolume = new VolumeRatio();

const ytmViewIntegrationScripts: { [name: string]: { [name: string]: string } } = {};

let mainWindow: BrowserWindow = null;
let settingsWindow: BrowserWindow = null;
let ytmView: BrowserView = null;
let tray = null;
let trayContextMenu = null;

// These variables tend to be changed often so we store it in memory and write on close (less disk usage)
let lastUrl = "";
let lastVideoId = "";
let lastPlaylistId = "";

let companionAuthWindowEnableTimeout: NodeJS.Timeout | null = null;
let ytmViewLoadTimeout: NodeJS.Timeout | null = null;

// Single Instances Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.exit(0);
} else {
  app.on("second-instance", (_, commandLine) => {
    if (mainWindow) {
      mainWindow.show();
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }

    handleProtocol(commandLine[commandLine.length - 1]);
  });
}

// Protocol handler
function handleProtocol(url: string) {
  log.info("Handling protocol url", url);
  const urlPaths = url.split("://")[1];
  if (urlPaths) {
    const paths = urlPaths.split("/");
    if (paths.length > 0) {
      switch (paths[0]) {
        case "play": {
          if (paths.length >= 2) {
            const videoId = paths[1];
            const playlistId = paths[2];

            if (ytmView) {
              ytmView.webContents.send("remoteControl:execute", "navigate", {
                watchEndpoint: {
                  videoId: videoId,
                  playlistId: playlistId
                }
              });
            }
          }
        }
      }
    }
  }
}

// This will register the protocol in development, this is intentional and should stay this way for development purposes
if (!app.isDefaultProtocolClient("ytmd")) {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      log.info("Application set as default protcol client for 'ytmd'");
      app.setAsDefaultProtocolClient("ytmd", process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    log.info("Application set as default protcol client for 'ytmd'");
    app.setAsDefaultProtocolClient("ytmd", process.execPath);
  }
}

// Create the in-memory store for state within the UI
const memoryStore = new MemoryStore<MemoryStoreSchema>();
memoryStore.onStateChanged((newState, oldState) => {
  if (mainWindow !== null) {
    mainWindow.webContents.send("memoryStore:stateChanged", newState, oldState);
  }

  if (settingsWindow !== null) {
    settingsWindow.webContents.send("memoryStore:stateChanged", newState, oldState);
  }

  if (ytmView !== null) {
    ytmView.webContents.send("memoryStore:stateChanged", newState, oldState);
  }
});
log.info("Created memory store");

function shouldDisableUpdates() {
  // macOS can't have auto updates without a code signature
  // linux is not supported on the update server https://github.com/ytmdesktop/ytmdesktop/issues/1247 (hanging issue resolved)
  if (process.platform !== "win32") return true;
}

// Configure the autoupdater
// macOS cannot use the autoUpdater without a code signature at this time
if (app.isPackaged && !shouldDisableUpdates() && !YTMD_DISABLE_UPDATES) {
  const updateServer = "https://update.electronjs.org";
  const updateFeed = `${updateServer}/${YTMD_UPDATE_FEED_OWNER}/${YTMD_UPDATE_FEED_REPOSITORY}/${process.platform}-${process.arch}/${app.getVersion()}`;

  autoUpdater.setFeedURL({
    url: updateFeed
  });
  autoUpdater.on("checking-for-update", () => {
    if (appLaunchUpdateCheck) memoryStore.set("ytmViewLoadingStatus", "Checking for updates...");
    if (settingsWindow) settingsWindow.webContents.send("app:checkingForUpdates");
  });
  autoUpdater.on("update-available", () => {
    log.info("Application update available");
    memoryStore.set("appUpdateAvailable", true);
    appUpdateAvailable = true;
    if (appLaunchUpdateCheck) memoryStore.set("ytmViewLoadingStatus", "Downloading update...");
    if (settingsWindow) settingsWindow.webContents.send("app:updateAvailable");
  });
  autoUpdater.on("update-not-available", () => {
    if (appLaunchUpdateCheck) appLaunchUpdateCheck = false;
    if (settingsWindow) settingsWindow.webContents.send("app:updateNotAvailable");
  });
  autoUpdater.on("update-downloaded", () => {
    log.info("Application update downloaded");
    appUpdateDownloaded = true;
    memoryStore.set("appUpdateDownloaded", true);
    if (appLaunchUpdateCheck) autoUpdater.quitAndInstall();
    if (settingsWindow) settingsWindow.webContents.send("app:updateDownloaded");
  });
  autoUpdater.on("error", () => {
    if (appLaunchUpdateCheck) appLaunchUpdateCheck = false;
    if (settingsWindow) settingsWindow.webContents.send("app:updateNotAvailable");
  });
  log.info("Setup application updater");

  setInterval(
    () => {
      autoUpdater.checkForUpdates();
    },
    1000 * 60 * 15
  );
} else {
  memoryStore.set("autoUpdaterDisabled", true);
}

function getIconPath(icon: string) {
  return path.join(assetFolder, `${process.env.NODE_ENV === "development" ? "icons/" : ""}${icon}`);
}
function getControlsIconPath(icon: string) {
  return getIconPath(`${process.env.NODE_ENV === "development" ? "controls/" : ""}${icon}`);
}

function anyShortcutChanged(newState: Readonly<StoreSchema>, oldState: Readonly<StoreSchema>) {
  if (newState.shortcuts.next !== oldState.shortcuts.next) return true;
  if (newState.shortcuts.playPause !== oldState.shortcuts.playPause) return true;
  if (newState.shortcuts.previous !== oldState.shortcuts.previous) return true;
  if (newState.shortcuts.thumbsDown !== oldState.shortcuts.thumbsDown) return true;
  if (newState.shortcuts.thumbsUp !== oldState.shortcuts.thumbsUp) return true;
  if (newState.shortcuts.volumeDown !== oldState.shortcuts.volumeDown) return true;
  if (newState.shortcuts.volumeUp !== oldState.shortcuts.volumeUp) return true;

  return false;
}

// Create the persistent config store
const store = new Conf<StoreSchema>({
  configName: "config",
  cwd: app.getPath("userData"),
  projectVersion: app.getVersion(),
  watch: true,
  defaults: {
    metadata: {
      version: 1
    },
    general: {
      disableHardwareAcceleration: false,
      hideToTrayOnClose: false,
      showNotificationOnSongChange: false,
      startOnBoot: false,
      startMinimized: false
    },
    appearance: {
      alwaysShowVolumeSlider: false,
      customCSSEnabled: false,
      customCSSPath: null,
      zoom: 100
    },
    playback: {
      continueWhereYouLeftOff: true,
      continueWhereYouLeftOffPaused: true,
      enableSpeakerFill: false,
      progressInTaskbar: false,
      ratioVolume: false
    },
    integrations: {
      companionServerEnabled: false,
      companionServerAuthTokens: null,
      companionServerCORSWildcardEnabled: false,
      discordPresenceEnabled: false,
      lastFMEnabled: false
    },
    shortcuts: {
      playPause: "",
      next: "",
      previous: "",
      thumbsUp: "",
      thumbsDown: "",
      volumeUp: "",
      volumeDown: ""
    },
    state: {
      lastUrl: "https://music.youtube.com/",
      lastPlaylistId: "",
      lastVideoId: "",
      windowBounds: null,
      windowMaximized: false
    },
    lastfm: {
      // Last FM Keys belong to @Alipoodle
      api_key: "2a69bcf769a7a28a8bf2f6a5100accad",
      secret: "46eea23770a459a49eb4d26cbf46b41c",
      token: null,
      sessionKey: null,
      scrobblePercent: 50
    },
    developer: {
      enableDevTools: false
    }
  },
  beforeEachMigration: (store, context) => {
    log.info(`Performing store migration from ${context.fromVersion} to ${context.toVersion}`);
  },
  migrations: {
    ">=2.0.0": store => {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      store.delete("integrations.companionServerAuthWindowEnabled");
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      store.delete("state.companionServerAuthWindowEnableTime");
      if (!store.has("appearance.zoom")) {
        store.set("appearance.zoom", 100);
      }
    },
    ">=2.0.1": store => {
      if (!store.has("lastfm.scrobblePercent")) {
        store.set("lastfm.scrobblePercent", 50);
      }
    }
  }
});
store.onDidAnyChange(async (newState, oldState) => {
  if (settingsWindow !== null) {
    settingsWindow.webContents.send("settings:stateChanged", newState, oldState);
  }

  if (ytmView !== null) {
    ytmView.webContents.send("settings:stateChanged", newState, oldState);
  }

  // Setting start on boot in development tends to cause a blank electron executable to start on boot so let's never set that
  if (process.env.NODE_ENV !== "development") {
    app.setLoginItemSettings({
      openAtLogin: newState.general.startOnBoot
    });
  }

  // General
  if (newState.general.showNotificationOnSongChange) {
    nowPlayingNotifications.enable();
    log.info("Integration enabled: Now playing notifications");
  } else if (!newState.general.showNotificationOnSongChange && oldState.general.showNotificationOnSongChange) {
    nowPlayingNotifications.disable();
    log.info("Integration disabled: Now playing notifications");
  }

  if (newState.appearance.zoom !== oldState.appearance.zoom) {
    if (ytmView) {
      ytmView.webContents.setZoomFactor(newState.appearance.zoom / 100);
      log.info("Integration update: Zoom Factor");
    }
  }

  // Appearance
  if (newState.appearance.customCSSEnabled) {
    customCss.provide(store, ytmView);
  }
  if (newState.appearance.customCSSEnabled && !oldState.appearance.customCSSEnabled) {
    customCss.enable();
    log.info("Integration enabled: Custom CSS");
  } else if (!newState.appearance.customCSSEnabled && oldState.appearance.customCSSEnabled) {
    customCss.disable();
    log.info("Integration disabled: Custom CSS");
  }

  // Playback
  if (newState.playback.ratioVolume) {
    ratioVolume.provide(ytmView);
  }
  if (newState.playback.ratioVolume && !oldState.playback.ratioVolume) {
    ratioVolume.enable();
    log.info("Integration enabled: Ratio volume");
  } else if (!newState.playback.ratioVolume && oldState.playback.ratioVolume) {
    ratioVolume.disable();
    log.info("Integration disabled: Ratio volume");
  }

  // Integrations
  let companionServerAuthWindowEnabled = memoryStore.get("companionServerAuthWindowEnabled") ?? false;

  if (newState.integrations.companionServerEnabled) {
    companionServer.provide(store, memoryStore, ytmView);
  }
  if (newState.integrations.companionServerEnabled && !oldState.integrations.companionServerEnabled) {
    companionServer.enable();
    log.info("Integration enabled: Companion server");
  } else if (!newState.integrations.companionServerEnabled && oldState.integrations.companionServerEnabled) {
    companionServer.disable();
    log.info("Integration disabled: Companion server");

    if (companionServerAuthWindowEnabled) {
      memoryStore.set("companionServerAuthWindowEnabled", false);
      clearInterval(companionAuthWindowEnableTimeout);
      companionAuthWindowEnableTimeout = null;
      companionServerAuthWindowEnabled = false;
    }
  }

  if (companionServerAuthWindowEnabled) {
    if (!companionAuthWindowEnableTimeout) {
      companionAuthWindowEnableTimeout = setTimeout(() => {
        memoryStore.set("companionServerAuthWindowEnabled", null);
        companionAuthWindowEnableTimeout = null;
      }, 300 * 1000);
    }
  }

  if (newState.integrations.companionServerCORSWildcardEnabled && !oldState.integrations.companionServerCORSWildcardEnabled) {
    // Check if the companion server has been enabled and needs a restart from CORS wildcard change
    if (newState.integrations.companionServerEnabled && oldState.integrations.companionServerEnabled) {
      await companionServer.disable();
      await companionServer.enable();
    }
  } else if (!newState.integrations.companionServerCORSWildcardEnabled && oldState.integrations.companionServerCORSWildcardEnabled) {
    // Check if the companion server has been disabled and needs a restart from CORS wildcard change
    if (newState.integrations.companionServerEnabled && oldState.integrations.companionServerEnabled) {
      await companionServer.disable();
      await companionServer.enable();
    }
  }

  if (newState.integrations.discordPresenceEnabled) {
    discordPresence.provide(memoryStore);
  }
  if (newState.integrations.discordPresenceEnabled && !oldState.integrations.discordPresenceEnabled) {
    discordPresence.enable();
    log.info("Integration enabled: Discord presence");
  } else if (!newState.integrations.discordPresenceEnabled && oldState.integrations.discordPresenceEnabled) {
    discordPresence.disable();
    log.info("Integration disabled: Discord presence");
  }

  if (newState.integrations.lastFMEnabled) {
    lastFMScrobbler.provide(store, memoryStore);
  }
  if (newState.integrations.lastFMEnabled && !oldState.integrations.lastFMEnabled) {
    lastFMScrobbler.enable();
    log.info("Integration enabled: Last.fm");
  } else if (!newState.integrations.lastFMEnabled && oldState.integrations.lastFMEnabled) {
    lastFMScrobbler.disable();
    log.info("Integration disabled: Last.fm");
  }

  if (anyShortcutChanged(newState, oldState)) registerShortcuts();
});
log.info("Created electron store");

if (store.get("general").disableHardwareAcceleration) {
  app.disableHardwareAcceleration();
}

if (store.get("playback").enableSpeakerFill) {
  app.commandLine.appendSwitch("try-supported-channel-layouts");
}

function saveState() {
  store.set("state.lastUrl", lastUrl);
  store.set("state.lastVideoId", lastVideoId);
  store.set("state.lastPlaylistId", lastPlaylistId);
}

// Automatic background state saving every 5 minutes
stateSaverInterval = setInterval(
  () => {
    saveState();
  },
  5 * 60 * 1000
);

function setupTaskbarFeatures() {
  // Setup Taskbar Icons
  if (mainWindow && mainWindow.isVisible() && process.platform === "win32") {
    mainWindow.setThumbarButtons([
      {
        tooltip: "Previous",
        icon: nativeImage.createFromPath(getControlsIconPath("play-previous-button.png")),
        flags: ["disabled"],
        click() {
          if (ytmView) {
            ytmView.webContents.send("remoteControl:execute", "previous");
          }
        }
      },
      {
        tooltip: "Play/Pause",
        icon: nativeImage.createFromPath(getControlsIconPath("play-button.png")),
        flags: ["disabled"],
        click() {
          if (ytmView) {
            ytmView.webContents.send("remoteControl:execute", "playPause");
          }
        }
      },
      {
        tooltip: "Next",
        icon: nativeImage.createFromPath(getControlsIconPath("play-next-button.png")),
        flags: ["disabled"],
        click() {
          if (ytmView) {
            ytmView.webContents.send("remoteControl:execute", "next");
          }
        }
      }
    ]);
  }
  playerStateStore.addEventListener((state: PlayerState) => {
    const hasVideo = !!state.videoDetails;
    const isPlaying = state.trackState === VideoState.Playing;

    if (process.platform == "win32") {
      const taskbarFlags = [];
      if (!hasVideo) {
        taskbarFlags.push("disabled");
      }

      if (mainWindow && mainWindow.isVisible()) {
        mainWindow.setThumbarButtons([
          {
            tooltip: "Previous",
            icon: nativeImage.createFromPath(getControlsIconPath("play-previous-button.png")),
            flags: taskbarFlags,
            click() {
              if (ytmView) {
                ytmView.webContents.send("remoteControl:execute", "previous");
              }
            }
          },
          {
            tooltip: "Play/Pause",
            icon: isPlaying
              ? nativeImage.createFromPath(getControlsIconPath("pause-button.png"))
              : nativeImage.createFromPath(getControlsIconPath("play-button.png")),
            flags: taskbarFlags,
            click() {
              if (ytmView) {
                ytmView.webContents.send("remoteControl:execute", "playPause");
              }
            }
          },
          {
            tooltip: "Next",
            icon: nativeImage.createFromPath(getControlsIconPath("play-next-button.png")),
            flags: taskbarFlags,
            click() {
              if (ytmView) {
                ytmView.webContents.send("remoteControl:execute", "next");
              }
            }
          }
        ]);
      }
    }

    if (mainWindow && store.get("playback.progressInTaskbar")) {
      mainWindow.setProgressBar(hasVideo ? state.videoProgress / state.videoDetails.durationSeconds : -1, {
        mode: isPlaying ? "normal" : "paused"
      });
    }
  });

  store.onDidChange("playback", (newValue, oldValue) => {
    if (mainWindow && newValue.progressInTaskbar !== oldValue.progressInTaskbar && !newValue.progressInTaskbar) {
      mainWindow.setProgressBar(-1);
    }
  });
}

// Shortcut registration
function registerShortcuts() {
  const shortcuts = store.get("shortcuts");

  globalShortcut.unregisterAll();
  log.info("Unregistered shortcuts");

  if (shortcuts.playPause) {
    let registered = false;
    try {
      registered = globalShortcut.register(shortcuts.playPause, () => {
        if (ytmView) {
          ytmView.webContents.send("remoteControl:execute", "playPause");
        }
      });
    } catch {
      /* ignored */
    }

    if (!registered) {
      log.info("Failed to register shortcut: playPause");
      memoryStore.set("shortcutsPlayPauseRegisterFailed", true);
    } else {
      log.info("Registered shortcut: playPause");
      memoryStore.set("shortcutsPlayPauseRegisterFailed", false);
    }
  } else {
    memoryStore.set("shortcutsPlayPauseRegisterFailed", false);
  }

  if (shortcuts.next) {
    let registered = false;
    try {
      registered = globalShortcut.register(shortcuts.next, () => {
        if (ytmView) {
          ytmView.webContents.send("remoteControl:execute", "next");
        }
      });
    } catch {
      /* empty */
    }

    if (!registered) {
      log.info("Failed to register shortcut: next");
      memoryStore.set("shortcutsNextRegisterFailed", true);
    } else {
      log.info("Registered shortcut: next");
      memoryStore.set("shortcutsNextRegisterFailed", false);
    }
  } else {
    memoryStore.set("shortcutsNextRegisterFailed", false);
  }

  if (shortcuts.previous) {
    let registered = false;
    try {
      registered = globalShortcut.register(shortcuts.previous, () => {
        if (ytmView) {
          ytmView.webContents.send("remoteControl:execute", "previous");
        }
      });
    } catch {
      /* empty */
    }

    if (!registered) {
      log.info("Failed to register shortcut: previous");
      memoryStore.set("shortcutsPreviousRegisterFailed", true);
    } else {
      log.info("Registered shortcut: previous");
      memoryStore.set("shortcutsPreviousRegisterFailed", false);
    }
  } else {
    memoryStore.set("shortcutsPreviousRegisterFailed", false);
  }

  if (shortcuts.thumbsUp) {
    let registered = false;
    try {
      registered = globalShortcut.register(shortcuts.thumbsUp, () => {
        if (ytmView) {
          ytmView.webContents.send("remoteControl:execute", "toggleLike");
        }
      });
    } catch {
      /* empty */
    }

    if (!registered) {
      log.info("Failed to register shortcut: thumbsUp");
      memoryStore.set("shortcutsThumbsUpRegisterFailed", true);
    } else {
      log.info("Registered shortcut: thumbsUp");
      memoryStore.set("shortcutsThumbsUpRegisterFailed", false);
    }
  } else {
    memoryStore.set("shortcutsThumbsUpRegisterFailed", false);
  }

  if (shortcuts.thumbsDown) {
    let registered = false;
    try {
      registered = globalShortcut.register(shortcuts.thumbsDown, () => {
        if (ytmView) {
          ytmView.webContents.send("remoteControl:execute", "toggleDislike");
        }
      });
    } catch {
      /* empty */
    }

    if (!registered) {
      log.info("Failed to register shortcut: thumbsDown");
      memoryStore.set("shortcutsThumbsDownRegisterFailed", true);
    } else {
      log.info("Registered shortcut: thumbsDown");
      memoryStore.set("shortcutsThumbsDownRegisterFailed", false);
    }
  } else {
    memoryStore.set("shortcutsThumbsDownRegisterFailed", false);
  }

  if (shortcuts.volumeUp) {
    let registered = false;
    try {
      registered = globalShortcut.register(shortcuts.volumeUp, () => {
        if (ytmView) {
          ytmView.webContents.send("remoteControl:execute", "volumeUp");
        }
      });
    } catch {
      /* empty */
    }

    if (!registered) {
      log.info("Failed to register shortcut: volumeUp");
      memoryStore.set("shortcutsVolumeUpRegisterFailed", true);
    } else {
      log.info("Registered shortcut: volumeUp");
      memoryStore.set("shortcutsVolumeUpRegisterFailed", false);
    }
  } else {
    memoryStore.set("shortcutsVolumeUpRegisterFailed", false);
  }

  if (shortcuts.volumeDown) {
    let registered = false;
    try {
      registered = globalShortcut.register(shortcuts.volumeDown, () => {
        if (ytmView) {
          ytmView.webContents.send("remoteControl:execute", "volumeDown");
        }
      });
    } catch {
      /* empty */
    }

    if (!registered) {
      log.info("Failed to register shortcut: volumeDown");
      memoryStore.set("shortcutsVolumeDownRegisterFailed", true);
    } else {
      log.info("Registered shortcut: volumeDown");
      memoryStore.set("shortcutsVolumeDownRegisterFailed", false);
    }
  } else {
    memoryStore.set("shortcutsVolumeDownRegisterFailed", false);
  }

  log.info("Registered shortcuts");
}

// Functions which call to mainWindow renderer
function sendMainWindowStateIpc() {
  if (mainWindow !== null) {
    mainWindow.webContents.send("mainWindow:stateChanged", {
      minimized: mainWindow.isMinimized(),
      maximized: mainWindow.isMaximized(),
      fullscreen: mainWindow.isFullScreen()
    });
  }
}

// Functions with call to ytmView renderer
function ytmViewNavigated() {
  if (ytmView !== null) {
    const url = ytmView.webContents.getURL();
    if (url.startsWith("https://music.youtube.com/")) {
      lastUrl = url;
      ytmView.webContents.send("ytmView:navigationStateChanged", {
        canGoBack: ytmView.webContents.canGoBack(),
        canGoForward: ytmView.webContents.canGoForward()
      });
    }
  }
}

// Functions which call to settingsWindow renderer
function sendSettingsWindowStateIpc() {
  if (settingsWindow !== null) {
    settingsWindow.webContents.send("settingsWindow:stateChanged", {
      minimized: settingsWindow.isMinimized(),
      maximized: settingsWindow.isMaximized()
    });
  }
}

// Handles any navigation or window opening from ytmView
function openExternalFromYtmView(urlString: string) {
  const url = new URL(urlString);
  const domainSplit = url.hostname.split(".");
  domainSplit.reverse();
  const domain = `${domainSplit[1]}.${domainSplit[0]}`;
  if (domain === "google.com" || domain === "youtube.com") {
    shell.openExternal(urlString);
  }
}

const createOrShowSettingsWindow = (): void => {
  if (mainWindow === null) {
    return;
  }

  if (settingsWindow !== null) {
    settingsWindow.focus();
    return;
  }

  const mainWindowBounds = mainWindow.getBounds();

  // Create the browser window.
  settingsWindow = new BrowserWindow({
    width: 800,
    height: 600,
    x: Math.round(mainWindowBounds.x + (mainWindowBounds.width / 2 - 400)),
    y: Math.round(mainWindowBounds.y + (mainWindowBounds.height / 2 - 300)),
    minimizable: false,
    maximizable: false,
    resizable: false,
    frame: false,
    show: false,
    icon: getIconPath("ytmd.png"),
    parent: mainWindow,
    modal: !isDarwin,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#000000",
      symbolColor: "#BBBBBB",
      height: 36
    },
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      preload: path.join(__dirname, "settings_window/preload.js"),
      devTools: store.get("developer.enableDevTools")
    }
  });

  // Attach events to settings window
  settingsWindow.on("maximize", sendSettingsWindowStateIpc);
  settingsWindow.on("unmaximize", sendSettingsWindowStateIpc);
  settingsWindow.on("minimize", sendSettingsWindowStateIpc);
  settingsWindow.on("restore", sendSettingsWindowStateIpc);

  settingsWindow.once("closed", () => {
    settingsWindow = null;
  });

  settingsWindow.webContents.setWindowOpenHandler(details => {
    if (details.url === "https://github.com/ytmdesktop/ytmdesktop" || details.url === "https://ytmdesktop.app/") {
      shell.openExternal(details.url);
    }

    return {
      action: "deny"
    };
  });

  settingsWindow.webContents.on("will-navigate", event => {
    if (process.env.NODE_ENV === "development") if (event.url.startsWith("http://localhost")) return;

    event.preventDefault();
  });

  settingsWindow.on("ready-to-show", () => {
    settingsWindow.show();
    // Open the DevTools.
    if (process.env.NODE_ENV === "development") {
      settingsWindow.webContents.openDevTools({
        mode: "detach"
      });
    }
  });

  // and load the index.html of the app.
  if (SETTINGS_WINDOW_VITE_DEV_SERVER_URL) {
    settingsWindow.loadURL(SETTINGS_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    settingsWindow.loadFile(path.join(__dirname, `../renderer/${SETTINGS_WINDOW_VITE_NAME}/index.html`));
  }
};

function urlIsGoogleAccountsDomain(url: URL): boolean {
  // https://www.google.com/supported_domains
  // prettier-ignore
  const supportedDomains = [".google.com",".google.ad",".google.ae",".google.com.af",".google.com.ag",".google.al",".google.am",".google.co.ao",".google.com.ar",".google.as",".google.at",".google.com.au",".google.az",".google.ba",".google.com.bd",".google.be",".google.bf",".google.bg",".google.com.bh",".google.bi",".google.bj",".google.com.bn",".google.com.bo",".google.com.br",".google.bs",".google.bt",".google.co.bw",".google.by",".google.com.bz",".google.ca",".google.cd",".google.cf",".google.cg",".google.ch",".google.ci",".google.co.ck",".google.cl",".google.cm",".google.cn",".google.com.co",".google.co.cr",".google.com.cu",".google.cv",".google.com.cy",".google.cz",".google.de",".google.dj",".google.dk",".google.dm",".google.com.do",".google.dz",".google.com.ec",".google.ee",".google.com.eg",".google.es",".google.com.et",".google.fi",".google.com.fj",".google.fm",".google.fr",".google.ga",".google.ge",".google.gg",".google.com.gh",".google.com.gi",".google.gl",".google.gm",".google.gr",".google.com.gt",".google.gy",".google.com.hk",".google.hn",".google.hr",".google.ht",".google.hu",".google.co.id",".google.ie",".google.co.il",".google.im",".google.co.in",".google.iq",".google.is",".google.it",".google.je",".google.com.jm",".google.jo",".google.co.jp",".google.co.ke",".google.com.kh",".google.ki",".google.kg",".google.co.kr",".google.com.kw",".google.kz",".google.la",".google.com.lb",".google.li",".google.lk",".google.co.ls",".google.lt",".google.lu",".google.lv",".google.com.ly",".google.co.ma",".google.md",".google.me",".google.mg",".google.mk",".google.ml",".google.com.mm",".google.mn",".google.com.mt",".google.mu",".google.mv",".google.mw",".google.com.mx",".google.com.my",".google.co.mz",".google.com.na",".google.com.ng",".google.com.ni",".google.ne",".google.nl",".google.no",".google.com.np",".google.nr",".google.nu",".google.co.nz",".google.com.om",".google.com.pa",".google.com.pe",".google.com.pg",".google.com.ph",".google.com.pk",".google.pl",".google.pn",".google.com.pr",".google.ps",".google.pt",".google.com.py",".google.com.qa",".google.ro",".google.ru",".google.rw",".google.com.sa",".google.com.sb",".google.sc",".google.se",".google.com.sg",".google.sh",".google.si",".google.sk",".google.com.sl",".google.sn",".google.so",".google.sm",".google.sr",".google.st",".google.com.sv",".google.td",".google.tg",".google.co.th",".google.com.tj",".google.tl",".google.tm",".google.tn",".google.to",".google.com.tr",".google.tt",".google.com.tw",".google.co.tz",".google.com.ua",".google.co.ug",".google.co.uk",".google.com.uy",".google.co.uz",".google.com.vc",".google.co.ve",".google.co.vi",".google.com.vn",".google.vu",".google.ws",".google.rs",".google.co.za",".google.co.zm",".google.co.zw",".google.cat"];
  const domain = url.hostname.split("accounts")[1];
  if (supportedDomains.includes(domain)) return true;
  return false;
}
function isPreventedNavOrRedirect(url: URL): boolean {
  return (
    url.hostname !== "consent.youtube.com" &&
    url.hostname !== "accounts.youtube.com" &&
    url.hostname !== "music.youtube.com" &&
    !(
      (url.hostname === "www.youtube.com" || url.hostname === "youtube.com") &&
      (url.pathname === "/signin" || url.pathname === "/premium" || url.pathname === "/signin_prompt")
    ) &&
    !urlIsGoogleAccountsDomain(url)
  );
}

const createYTMView = (): void => {
  memoryStore.set("ytmViewLoadTimedout", false);
  memoryStore.set("ytmViewLoading", true);
  memoryStore.set("ytmViewLoadingStatus", "Initializing...");

  ytmView = new BrowserView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      partition: "persist:ytmview",
      preload: path.join(__dirname, "ytmview/preload.js"),
      autoplayPolicy: store.get("playback.continueWhereYouLeftOffPaused") ? "document-user-activation-required" : "no-user-gesture-required"
    }
  });
  companionServer.provide(store, memoryStore, ytmView);
  customCss.provide(store, ytmView);
  ratioVolume.provide(ytmView);

  // Attach events to ytm view
  ytmView.webContents.on("will-navigate", event => {
    const url = new URL(event.url);
    if (isPreventedNavOrRedirect(url)) {
      event.preventDefault();
      log.info(`Blocking YTM View navigation to ${event.url}`);

      openExternalFromYtmView(event.url);
    }
  });
  ytmView.webContents.on("will-redirect", event => {
    const url = new URL(event.url);
    if (isPreventedNavOrRedirect(url)) {
      event.preventDefault();
      log.info(`Blocking YTM View redirect to ${event.url}`);
    }

    if ((url.hostname === "www.youtube.com" && url.pathname === "/premium") || (url.hostname === "youtube.com" && url.pathname === "/premium")) {
      // This users region requires a premium subscription to use YTM
      ytmView.webContents.loadURL(
        "https://accounts.google.com/ServiceLogin?ltmpl=music&service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26app%3Ddesktop%26next%3Dhttps%253A%252F%252Fmusic.youtube.com%252F"
      );
    }
  });
  ytmView.webContents.on("did-navigate", ytmViewNavigated);
  ytmView.webContents.on("did-navigate-in-page", ytmViewNavigated);
  ytmView.webContents.on("enter-html-full-screen", () => {
    if (mainWindow) {
      mainWindow.setFullScreen(true);
    }
  });
  ytmView.webContents.on("leave-html-full-screen", () => {
    if (mainWindow) {
      mainWindow.setFullScreen(false);
    }
  });
  ytmView.webContents.on("render-process-gone", () => {
    store.set("state.lastUrl", lastUrl);
    store.set("state.lastVideoId", lastVideoId);
    store.set("state.lastPlaylistId", lastPlaylistId);
    createYTMView();
  });
  ytmView.webContents.on("page-title-updated", (_event, title) => {
    if (mainWindow) {
      mainWindow.setTitle(`${title} | YouTube Music Desktop App`);
    }
  });
  ytmView.webContents.on("context-menu", (_event, params) => {
    if (store.get("developer.enableDevTools")) {
      Menu.buildFromTemplate([
        {
          label: "YouTube Music Desktop",
          type: "normal",
          enabled: false
        },
        {
          type: "separator"
        },
        {
          label: "Open Developer Tools",
          type: "normal",
          click: () => {
            if (ytmView) {
              ytmView.webContents.openDevTools({
                mode: "detach"
              });
            }
          }
        }
      ]).popup({
        window: mainWindow,
        x: params.x,
        y: params.y,
        sourceType: params.menuSourceType
      });
    }
  });
  ytmView.webContents.on("will-prevent-unload", event => {
    if (mainWindow) {
      if (!applicationQuitting) {
        if (ytmView.webContents.getURL().startsWith("https://music.youtube.com/")) {
          const choice = dialog.showMessageBoxSync(mainWindow, {
            type: "question",
            buttons: ["Leave", "Stay"],
            title: "Navigation",
            message: "YouTube Music is preventing navigation. Do you want to leave or stay?",
            defaultId: 0,
            cancelId: 1
          });

          if (choice !== 0) {
            return;
          }
        }
      }
    }

    event.preventDefault();
  });
  ytmView.webContents.on("unresponsive", () => {
    memoryStore.set("ytmViewUnresponsive", true);
  });
  ytmView.webContents.on("responsive", () => {
    memoryStore.set("ytmViewUnresponsive", false);
  });

  ytmView.webContents.setWindowOpenHandler(details => {
    openExternalFromYtmView(details.url);

    return {
      action: "deny"
    };
  });

  // Loading status event handlers
  ytmView.webContents.on("did-start-loading", () => {
    memoryStore.set("ytmViewLoadingStatus", "Loading YouTube Music...");
  });

  ytmView.webContents.on("did-stop-loading", () => {
    if (!memoryStore.get("ytmViewLoadingError")) {
      memoryStore.set("ytmViewLoadingStatus", "Loaded YouTube Music");
    }
  });

  ytmView.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (isMainFrame) {
      if (ytmViewLoadTimeout) clearTimeout(ytmViewLoadTimeout);

      memoryStore.set("ytmViewLoadingError", true);
      memoryStore.set("ytmViewLoadingStatus", `Failed to load YouTube Music: ${errorDescription} (${errorCode})`);
    }
  });

  memoryStore.set("ytmViewLoadingStatus", "Initialized");

  let navigateDefault = true;

  const continueWhereYouLeftOff: boolean = store.get("playback.continueWhereYouLeftOff");
  if (continueWhereYouLeftOff) {
    const lastUrl: string = store.get("state.lastUrl");
    if (lastUrl) {
      if (lastUrl.startsWith("https://music.youtube.com/")) {
        ytmView.webContents.loadURL(lastUrl);
        navigateDefault = false;
      }
    }
  }

  if (navigateDefault) {
    ytmView.webContents.loadURL("https://music.youtube.com/");
    store.set("state.lastUrl", "https://music.youtube.com/");
  }

  ytmViewLoadTimeout = setTimeout(() => {
    memoryStore.set("ytmViewLoadTimedout", true);
  }, 30 * 1000);
};

const createMainWindow = (): void => {
  // Create the browser window.
  const scaleFactor = screen.getPrimaryDisplay().scaleFactor;
  const windowBounds = store.get("state").windowBounds;
  mainWindow = new BrowserWindow({
    width: windowBounds?.width ?? 1280 / scaleFactor,
    height: windowBounds?.height ?? 720 / scaleFactor,
    x: windowBounds?.x,
    y: windowBounds?.y,
    minWidth: 156,
    minHeight: 180,
    frame: false,
    show: false,
    icon: getIconPath("ytmd.png"),
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#000000",
      symbolColor: "#BBBBBB",
      height: 36
    },
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      preload: path.join(__dirname, "main_window/preload.js"),
      devTools: store.get("developer.enableDevTools")
    }
  });
  const windowMaximized = store.get("state").windowMaximized;
  // Even though bounds are set when creating the main window we set the bounds again to fix scaling issues. This is classified as an upstream chromium bug.
  if (windowBounds) {
    mainWindow.setBounds(windowBounds);
  }
  if (windowMaximized) {
    mainWindow.maximize();
  }

  // Attach events to main window
  mainWindow.on("resize", () => {
    setTimeout(() => {
      if (ytmView) {
        if (mainWindow.fullScreen) {
          ytmView.setBounds({
            x: 0,
            y: 0,
            width: mainWindow.getContentBounds().width,
            height: mainWindow.getContentBounds().height
          });
        } else {
          ytmView.setBounds({
            x: 0,
            y: 36,
            width: mainWindow.getContentBounds().width,
            height: mainWindow.getContentBounds().height - 36
          });
        }
      }
    });
  });

  mainWindow.on("enter-full-screen", () => {
    setTimeout(() => {
      if (ytmView) {
        ytmView.setBounds({
          x: 0,
          y: 0,
          width: mainWindow.getContentBounds().width,
          height: mainWindow.getContentBounds().height
        });
      }
    });
    sendMainWindowStateIpc();
  });
  mainWindow.on("leave-full-screen", () => {
    setTimeout(() => {
      ytmView.setBounds({
        x: 0,
        y: 36,
        width: mainWindow.getContentBounds().width,
        height: mainWindow.getContentBounds().height - 36
      });
    });
    sendMainWindowStateIpc();
  });
  mainWindow.on("maximize", sendMainWindowStateIpc);
  mainWindow.on("unmaximize", sendMainWindowStateIpc);
  mainWindow.on("minimize", sendMainWindowStateIpc);
  mainWindow.on("restore", sendMainWindowStateIpc);
  mainWindow.on("close", event => {
    if (!applicationQuitting && (store.get("general").hideToTrayOnClose || isDarwin)) {
      event.preventDefault();
      mainWindow.hide();
    }

    store.set("state.windowBounds", mainWindow.getNormalBounds());
    store.set("state.windowMaximized", mainWindow.isMaximized());
  });

  mainWindow.once("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(() => {
    return {
      action: "deny"
    };
  });

  mainWindow.webContents.on("will-navigate", event => {
    if (process.env.NODE_ENV === "development") if (event.url.startsWith("http://localhost")) return;

    event.preventDefault();
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
    // Open the DevTools.
    if (process.env.NODE_ENV === "development") {
      mainWindow.webContents.openDevTools({
        mode: "detach"
      });
    }
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", async () => {
  log.info("Application ready");

  // First run checks
  const firstRunPath = path.join(app.getPath("userData"), ".first-run");
  try {
    await fs.access(firstRunPath, fs.constants.F_OK);
  } catch (_) {
    // This is the first run of the program
    const firstRunTouch = await fs.open(firstRunPath, "a");
    await firstRunTouch.close();

    const v1ConfigPath = path.join(app.getPath("userData"), "..", "youtube-music-desktop-app", "config.json");
    try {
      const v1Config = JSON.parse(await fs.readFile(v1ConfigPath, { encoding: "utf-8" }));
      const migrateDialog = await dialog.showMessageBox({
        type: "question",
        message: "Would you like to migrate your settings?",
        detail:
          "A configuration file for YouTube Music Desktop App v1 was found. Your settings can be migrated.\n\nWARNING: Not all settings will be migrated as they may no longer be available in v2.",
        buttons: ["No", "Migrate Settings"]
      });

      if (migrateDialog.response === 1) {
        if ("settings-companion-server" in v1Config) {
          store.set("integrations.companionServerEnabled", v1Config["settings-companion-server"]);
        }

        if ("settings-continue-where-left-of" in v1Config) {
          store.set("playback.continueWhereYouLeftOff", v1Config["settings-continue-where-left-of"]);
        }

        if ("settings-custom-css-page" in v1Config) {
          if (v1Config["settings-custom-css-page"]) {
            const v1CustomCSSPath = path.join(app.getPath("userData"), "..", "youtube-music-desktop-app", "custom", "css", "page.css");
            const copyPath = path.join(app.getPath("userData"), "custom_css.css");
            await fs.copyFile(v1CustomCSSPath, copyPath);

            store.set("appearance.customCSSPath", copyPath);
            store.set("appearance.customCSSEnabled", true);
          }
        }

        if ("settings-decibel-volume" in v1Config) {
          store.set("playback.ratioVolume", v1Config["settings-decibel-volume"]);
        }

        if ("settings-discord-rich-presence" in v1Config) {
          store.set("integrations.discordPresenceEnabled", v1Config["settings-discord-rich-presence"]);
        }

        if ("settings-page-zoom" in v1Config) {
          store.set("appearance.zoom", v1Config["settings-page-zoom"]);
        }

        if ("settings-keep-background" in v1Config) {
          store.set("general.hideToTrayOnClose", v1Config["settings-keep-background"]);
        }

        if ("settings-show-notifications" in v1Config) {
          store.set("general.showNotificationOnSongChange", v1Config["settings-show-notifications"]);
        }

        if ("settings-start-minimized" in v1Config) {
          store.set("general.startMinimized", v1Config["settings-start-minimized"]);
        }

        if ("settings-start-on-boot" in v1Config) {
          store.set("general.startOnBoot", v1Config["settings-start-on-boot"]);
        }

        if ("settings-surround-sound" in v1Config) {
          store.set("playback.enableSpeakerFill", v1Config["settings-surround-sound"]);
        }

        if ("settings-accelerators" in v1Config) {
          if ("media-play-pause" in v1Config["settings-accelerators"]) {
            if (v1Config["settings-accelerators"]["media-play-pause"].toLowerCase() !== "disabled") {
              store.set("shortcuts.playPause", v1Config["settings-accelerators"]["media-play-pause"]);
            }
          }

          if ("media-track-next" in v1Config["settings-accelerators"]) {
            if (v1Config["settings-accelerators"]["media-track-next"].toLowerCase() !== "disabled") {
              store.set("shortcuts.next", v1Config["settings-accelerators"]["media-track-next"]);
            }
          }

          if ("media-track-previous" in v1Config["settings-accelerators"]) {
            if (v1Config["settings-accelerators"]["media-track-previous"].toLowerCase() !== "disabled") {
              store.set("shortcuts.previous", v1Config["settings-accelerators"]["media-track-previous"]);
            }
          }

          if ("media-track-like" in v1Config["settings-accelerators"]) {
            if (v1Config["settings-accelerators"]["media-track-like"].toLowerCase() !== "disabled") {
              store.set("shortcuts.thumbsUp", v1Config["settings-accelerators"]["media-track-like"]);
            }
          }

          if ("media-track-dislike" in v1Config["settings-accelerators"]) {
            if (v1Config["settings-accelerators"]["media-track-dislike"].toLowerCase() !== "disabled") {
              store.set("shortcuts.thumbsDown", v1Config["settings-accelerators"]["media-track-dislike"]);
            }
          }

          if ("media-volume-up" in v1Config["settings-accelerators"]) {
            if (v1Config["settings-accelerators"]["media-volume-up"].toLowerCase() !== "disabled") {
              store.set("shortcuts.volumeUp", v1Config["settings-accelerators"]["media-volume-up"]);
            }
          }

          if ("media-volume-down" in v1Config["settings-accelerators"]) {
            if (v1Config["settings-accelerators"]["media-volume-down"].toLowerCase() !== "disabled") {
              store.set("shortcuts.volumeDown", v1Config["settings-accelerators"]["media-volume-down"]);
            }
          }
        }

        if ("last-fm-login" in v1Config) {
          const usernameEmpty = v1Config["last-fm-login"]["username"] === null || v1Config["last-fm-login"]["username"].trim() === "";
          const passwordEmpty = v1Config["last-fm-login"]["password"] === null || v1Config["last-fm-login"]["password"].trim() === "";
          if (!usernameEmpty && !passwordEmpty) {
            store.set("integrations.lastFMEnabled", true);

            await dialog.showMessageBox({
              type: "info",
              message: "Last.fm",
              detail: "Last.fm configuration was found and has NOT been migrated. Re-authentication is required."
            });
          }
        }

        await dialog.showMessageBox({
          type: "info",
          message: "Settings migrated.",
          detail: "Your settings have been migrated."
        });
      }
    } catch (_) {
      /* do nothing */
    }
  }

  if (!safeStorage.isEncryptionAvailable()) {
    memoryStore.set("safeStorageAvailable", false);
  } else {
    memoryStore.set("safeStorageAvailable", true);
  }

  // Handle main window ipc
  ipcMain.on("mainWindow:minimize", event => {
    if (mainWindow !== null) {
      if (event.sender !== mainWindow.webContents) return;

      mainWindow.minimize();
    }
  });

  ipcMain.on("mainWindow:maximize", event => {
    if (mainWindow !== null) {
      if (event.sender !== mainWindow.webContents) return;

      mainWindow.maximize();
    }
  });

  ipcMain.on("mainWindow:restore", event => {
    if (mainWindow !== null) {
      if (event.sender !== mainWindow.webContents) return;

      mainWindow.restore();
    }
  });

  ipcMain.on("mainWindow:close", event => {
    if (mainWindow !== null) {
      if (event.sender !== mainWindow.webContents) return;

      if (store.get("general").hideToTrayOnClose || isDarwin) {
        mainWindow.hide();
      } else {
        app.quit();
      }
    }
  });

  ipcMain.on("mainWindow:requestWindowState", event => {
    if (event.sender !== mainWindow.webContents) return;

    sendMainWindowStateIpc();
  });

  // Handle settings window ipc
  ipcMain.on("settingsWindow:open", event => {
    if (event.sender !== mainWindow.webContents) return;

    createOrShowSettingsWindow();
  });

  ipcMain.on("settingsWindow:minimize", event => {
    if (settingsWindow !== null) {
      if (event.sender !== settingsWindow.webContents) return;

      settingsWindow.minimize();
    }
  });

  ipcMain.on("settingsWindow:maximize", event => {
    if (settingsWindow !== null) {
      if (event.sender !== settingsWindow.webContents) return;

      settingsWindow.maximize();
    }
  });

  ipcMain.on("settingsWindow:restore", event => {
    if (settingsWindow !== null) {
      if (event.sender !== settingsWindow.webContents) return;

      settingsWindow.restore();
    }
  });

  ipcMain.on("settingsWindow:close", event => {
    if (settingsWindow !== null) {
      if (event.sender !== settingsWindow.webContents) return;

      settingsWindow.close();
    }
  });

  ipcMain.on("settingsWindow:restartapplication", event => {
    if (event.sender !== settingsWindow.webContents) return;

    app.relaunch();
    app.quit();
  });

  // Handle ytm view ipc
  ipcMain.on("ytmView:loaded", event => {
    if (ytmView !== null && mainWindow !== null) {
      if (event.sender !== ytmView.webContents) return;

      memoryStore.set("ytmViewLoading", false);
      clearTimeout(ytmViewLoadTimeout);
      mainWindow.addBrowserView(ytmView);
      ytmView.setBounds({
        x: 0,
        y: 36,
        width: mainWindow.getContentBounds().width,
        height: mainWindow.getContentBounds().height - 36
      });
      if (process.env.NODE_ENV === "development") {
        ytmView.webContents.openDevTools({
          mode: "detach"
        });
      }

      // TODO: this is just a hack fix for ratio volume to run the enable script
      ratioVolume.ytmViewLoaded();
      // TODO: this is just a hack fix for custom css to update CSS when the view loads
      customCss.updateCSS();
    }
  });

  ipcMain.on("ytmView:videoProgressChanged", (event, progress) => {
    if (event.sender !== ytmView.webContents) return;

    playerStateStore.updateVideoProgress(progress);
  });

  ipcMain.on("ytmView:videoStateChanged", (event, state) => {
    if (event.sender !== ytmView.webContents) return;

    // ytm state mapping definitions
    // -1 -> Unstarted
    // 1 -> Playing
    // 2 -> Paused
    // 3 -> Buffering
    // 5 -> Video Cued

    // ytm state flow
    // Play Button Click
    //   -1 -> 5 -> -1 -> 3 -> 1
    // First Play Button Click (Only happens when the player is first loaded)
    //   -1 -> 3 -> 1
    // Previous/Next Song Click
    //   -1 -> 5 -> -1 -> 5 -> -1 -> 3 -> 1

    playerStateStore.updateVideoState(state);
  });

  ipcMain.on("ytmView:videoDataChanged", (event, videoDetails, playlistId) => {
    if (event.sender !== ytmView.webContents) return;

    lastVideoId = videoDetails.videoId;
    lastPlaylistId = playlistId;

    playerStateStore.updateVideoDetails(videoDetails, playlistId);
  });

  ipcMain.on("ytmView:storeStateChanged", (event, queue, thumbnails, album, likeStatus, volume, muted, adPlaying) => {
    if (event.sender !== ytmView.webContents) return;

    playerStateStore.updateFromStore(queue, thumbnails, album, likeStatus, volume, muted, adPlaying);
  });

  ipcMain.on("ytmView:switchFocus", (event, context) => {
    if (event.sender !== ytmView.webContents && event.sender !== mainWindow.webContents) return;

    if (context === "main") {
      if (mainWindow && ytmView.webContents.isFocused()) {
        mainWindow.webContents.focus();
      }
    } else if (context === "ytm") {
      if (ytmView && mainWindow.webContents.isFocused()) {
        ytmView.webContents.focus();
      }
    }
  });

  ipcMain.on("ytmView:navigateDefault", event => {
    if (ytmView) {
      if (event.sender !== mainWindow.webContents) return;

      ytmView.webContents.loadURL("https://music.youtube.com/");
    }
  });

  ipcMain.on("ytmView:recreate", event => {
    if (event.sender !== mainWindow.webContents) return;

    if (ytmView) {
      if (mainWindow) {
        mainWindow.removeBrowserView(ytmView);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ytmView.webContents as any).destroy();
      ytmView = null;
      createYTMView();
    }
  });

  ipcMain.handle("ytmView:getIntegrationScripts", event => {
    if (event.sender !== ytmView.webContents) return;

    return ytmViewIntegrationScripts;
  });

  // Handle memory store ipc
  ipcMain.on("memoryStore:set", (event, key: string, value?: unknown) => {
    if (settingsWindow && event.sender !== settingsWindow.webContents && event.sender !== mainWindow.webContents) return;

    memoryStore.set(key, value);
  });

  ipcMain.handle("memoryStore:get", (event, key: string) => {
    if (settingsWindow && event.sender !== settingsWindow.webContents) return;

    return memoryStore.get(key);
  });

  // Handle settings store ipc
  ipcMain.on("settings:set", (event, key: string, value?: unknown) => {
    if (settingsWindow && event.sender !== settingsWindow.webContents) return;

    store.set(key, value);
  });

  ipcMain.handle("settings:get", (event, key: string) => {
    if (
      mainWindow &&
      event.sender !== mainWindow.webContents &&
      settingsWindow &&
      event.sender !== settingsWindow.webContents &&
      ytmView &&
      event.sender !== ytmView.webContents
    )
      return;

    return store.get(key);
  });

  ipcMain.handle("settings:reset", (event, key: keyof StoreSchema) => {
    if (event.sender !== settingsWindow.webContents) return;

    store.reset(key);
  });

  // Handle safeStorage ipc
  ipcMain.handle("safeStorage:decryptString", (event, value: string) => {
    if (!memoryStore.get("safeStorageAvailable")) throw new Error("safeStorage is unavailable");
    if (event.sender !== settingsWindow.webContents) return;

    if (value) {
      return safeStorage.decryptString(Buffer.from(value, "hex"));
    } else {
      return null;
    }
  });

  ipcMain.handle("safeStorage:encryptString", (event, value: string) => {
    if (!memoryStore.get("safeStorageAvailable")) throw new Error("safeStorage is unavailable");
    if (event.sender !== settingsWindow.webContents) return;

    return safeStorage.encryptString(value).toString("hex");
  });

  // Handle app ipc
  ipcMain.handle("app:getVersion", event => {
    if (event.sender !== settingsWindow.webContents) return;

    return app.getVersion();
  });

  ipcMain.on("app:checkForUpdates", event => {
    if (event.sender !== settingsWindow.webContents) return;

    // autoUpdater downloads automatically and calling checkForUpdates causes duplicate install
    if (!appUpdateAvailable || !appUpdateDownloaded) {
      autoUpdater.checkForUpdates();
    }
  });

  ipcMain.handle("app:isUpdateAvailable", event => {
    if (event.sender !== settingsWindow.webContents) return;

    return appUpdateAvailable;
  });

  ipcMain.handle("app:isUpdateDownloaded", event => {
    if (event.sender !== settingsWindow.webContents) return;

    return appUpdateDownloaded;
  });

  ipcMain.on("app:restartApplicationForUpdate", event => {
    if (mainWindow && event.sender !== mainWindow.webContents && settingsWindow && event.sender !== settingsWindow.webContents) return;

    // Electron explicitly will not call before-quit until after all the windows have closed, requiring us to have set that the application is quitting before hand
    applicationQuitting = true;
    autoUpdater.quitAndInstall();
  });

  log.info("Setup IPC handlers");

  // Create the permission handlers
  session.fromPartition("persist:ytmview").setPermissionCheckHandler((webContents, permission) => {
    if (webContents == ytmView.webContents) {
      if (permission === "fullscreen") {
        return true;
      }
    }

    return false;
  });
  session.fromPartition("persist:ytmview").setPermissionRequestHandler((webContents, permission, callback) => {
    if (webContents == ytmView.webContents) {
      if (permission === "fullscreen") {
        return callback(true);
      }
    }

    return callback(false);
  });

  log.info("Setup permission handlers");

  // Register global shortcuts
  registerShortcuts();

  // Create the tray
  tray = new Tray(
    path.join(
      process.env.NODE_ENV === "development" ? path.join(app.getAppPath(), "src/assets/icons") : process.resourcesPath,
      process.platform === "win32" ? "tray.ico" : "trayTemplate.png"
    )
  );
  trayContextMenu = Menu.buildFromTemplate([
    {
      label: "YouTube Music Desktop",
      type: "normal",
      enabled: false
    },
    {
      type: "separator"
    },
    {
      label: "Show/Hide Window",
      type: "normal",
      click: () => {
        if (mainWindow) {
          if (mainWindow.isVisible()) {
            mainWindow.hide();
          } else {
            mainWindow.show();
          }
        }
      }
    },
    {
      label: "Play/Pause",
      type: "normal",
      click: () => {
        ytmView.webContents.send("remoteControl:execute", "playPause");
      }
    },
    {
      label: "Previous",
      type: "normal",
      click: () => {
        ytmView.webContents.send("remoteControl:execute", "previous");
      }
    },
    {
      label: "Next",
      type: "normal",
      click: () => {
        ytmView.webContents.send("remoteControl:execute", "next");
      }
    },
    {
      type: "separator"
    },
    {
      label: "Quit",
      type: "normal",
      click: () => {
        app.quit();
      }
    }
  ]);
  tray.setToolTip("YouTube Music Desktop");
  tray.setContextMenu(trayContextMenu);
  tray.on("click", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      } else {
        mainWindow.show();
      }
    }
  });

  log.info("Created tray icon");

  createMainWindow();
  log.info("Created main window");

  memoryStore.set("ytmViewLoading", true);
  memoryStore.set("ytmViewLoadingStatus", "Checking for updates...");

  // Check for application updates
  if (app.isPackaged && !shouldDisableUpdates() && !YTMD_DISABLE_UPDATES) {
    autoUpdater.checkForUpdates();
    await new Promise<void>(resolve => {
      setInterval(() => {
        if (!appLaunchUpdateCheck) resolve();
      }, 250);
    });
  } else {
    appLaunchUpdateCheck = false;
  }

  // Integrations preflight initialization
  ytmViewIntegrationScripts["ratioVolume"] = ratioVolume.getYTMScripts().reduce<{ [name: string]: string }>((map, obj) => {
    map[obj.name] = obj.script;
    return map;
  }, {});

  // Create the YouTube Music view
  createYTMView();
  log.info("Created YTM view");

  // Setup taskbar features
  setupTaskbarFeatures();
  log.info("Setup taskbar features");

  if (store.get("appearance").zoom) {
    log.info("Integration update: Zoom Factor");
    ytmView.webContents.setZoomFactor(store.get("appearance").zoom / 100);
  }

  // Integrations setup
  log.info("Starting enabled integrations");

  // NowPlayingNotifications
  if (store.get("general").showNotificationOnSongChange) {
    nowPlayingNotifications.enable();
    log.info("Integration enabled: Now playing notifications");
  }

  // CustomCSS
  if (store.get("appearance").customCSSEnabled) {
    customCss.provide(store, ytmView);
    customCss.enable();
    log.info("Integration enabled: Custom CSS");
  }

  // RatioVolume
  if (store.get("playback").ratioVolume) {
    ratioVolume.provide(ytmView);
    ratioVolume.enable();
    log.info("Integration enabled: Ratio volume");
  }

  // CompanionServer
  if (store.get("integrations").companionServerEnabled) {
    companionServer.provide(store, memoryStore, ytmView);
    companionServer.enable();
    log.info("Integration enabled: Companion server");
  }

  // DiscordPresence
  if (store.get("integrations").discordPresenceEnabled) {
    discordPresence.provide(memoryStore);
    discordPresence.enable();
    log.info("Integration enabled: Discord presence");
  }

  // LastFM
  if (store.get("integrations").lastFMEnabled) {
    lastFMScrobbler.provide(store, memoryStore);
    lastFMScrobbler.enable();
    log.info("Integration enabled: Last.fm");
  }
});

app.on("before-quit", () => {
  log.info("Application quitting\n\n");
  applicationQuitting = true;
  saveState();
});

app.on("open-url", (_, url) => {
  handleProtocol(url);
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (!isDarwin) {
    app.quit();
  }
});

app.on("activate", () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
    createYTMView();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
