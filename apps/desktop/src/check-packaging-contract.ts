import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { allowedReactions } from "./local-ipc-protocol.js";
import { pickReactionMessage, reactionMessagePools } from "./reaction-messages.js";

const distDir = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(distDir);
const repoRoot = resolve(appDir, "../..");
const packageJson = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; description?: string; author?: string };
const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
const workspaceConfig = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
const builderConfigPath = join(appDir, "electron-builder.yml");
const builderConfig = readFileSync(builderConfigPath, "utf8");

assert.equal(packageJson.description, "OpenPets tray-first desktop companion app.");
assert.equal(packageJson.author, "OpenPets");
assert.match(packageJson.scripts?.["dev:debug"] ?? "", /OPENPETS_LOG_LEVEL=debug OPENPETS_LOG_CONSOLE=1 pnpm dev/, "desktop debug dev script must enable verbose log mirroring.");
assert.match(packageJson.scripts?.package ?? "", /node scripts\/clean-package-output\.cjs && electron-builder/);
assert.match(packageJson.scripts?.["package:dir"] ?? "", /node scripts\/clean-package-output\.cjs && electron-builder --dir/);
assert.equal(rootPackageJson.scripts?.["package:desktop:dir"], "pnpm build && pnpm --filter @open-pets/desktop package:dir");
assert.equal(packageJson.dependencies?.["@open-pets/claude"], "workspace:*");
assert.equal(packageJson.dependencies?.["@open-pets/cli"], "workspace:*");
assert.equal(packageJson.dependencies?.["@open-pets/cursor"], "workspace:*");
assert.equal(packageJson.dependencies?.["@open-pets/mcp"], "workspace:*");
assert.equal(packageJson.dependencies?.["@open-pets/opencode"], "workspace:*");
assert.equal(packageJson.dependencies?.["@open-pets/agent-events"], "workspace:*");
assert.equal(packageJson.dependencies?.["@img/sharp-win32-x64"], undefined, "sharp platform binaries must stay optional transitive deps, not direct host-breaking dependencies.");
assert.match(workspaceConfig, /supportedArchitectures:[\s\S]*?os:[\s\S]*?- darwin[\s\S]*?- win32[\s\S]*?- linux/, "pnpm must install optional sharp binaries for desktop release OS targets.");
assert.match(workspaceConfig, /supportedArchitectures:[\s\S]*?cpu:[\s\S]*?- x64[\s\S]*?- arm64/, "pnpm must install optional sharp binaries for desktop release CPU targets.");
assert.match(workspaceConfig, /supportedArchitectures:[\s\S]*?libc:[\s\S]*?- glibc/, "pnpm must install optional sharp binaries for Linux glibc release targets.");
assert.match(packageJson.devDependencies?.["electron-builder"] ?? "", /^\^26\.(?:9|[1-9]\d)\./, "desktop AppImage packaging must use electron-builder 26.9+ for conditional Linux sandbox handling.");
assert.match(builderConfig, /appId:\s*dev\.openpets\.app/);
assert.match(builderConfig, /productName:\s*OpenPets/);
assert.match(builderConfig, /executableName:\s*openpets/, "desktop packages must use a safe executable name for the stricter AppImage toolset.");
assert.match(builderConfig, /output:\s*dist-electron/);
assert.match(builderConfig, /publish:\s*null/);
assert.doesNotMatch(builderConfig, /no-sandbox/, "desktop packaging must not force --no-sandbox for every Linux AppImage launch.");
assert.match(builderConfig, /toolsets:\s*\n\s*appimage:\s*1\.0\.3/, "desktop AppImage packaging must use the AppImage 1.0.3 toolset so the launcher can conditionally fall back when Linux sandboxing is unavailable.");
assert.match(builderConfig, /asar:\s*true/);
assert.match(builderConfig, /asarUnpack:/);
assert.match(builderConfig, /node_modules\/\*\*/);
assert.match(builderConfig, /dist\/\*\*/);
assert.match(builderConfig, /preload\.cjs/);
assert.match(builderConfig, /pet-preload\.cjs/);
assert.match(builderConfig, /assets\/\*\*/);
assert.match(builderConfig, /icon:\s*assets\/app-icon\.icns/);

assert.ok(existsSync(join(appDir, "preload.cjs")), "preload.cjs must exist for packaging.");
assert.ok(existsSync(join(appDir, "pet-preload.cjs")), "pet-preload.cjs must exist for pet window motion state updates.");
assert.ok(existsSync(join(appDir, "assets", "tray-icon.png")), "tray icon must exist for packaging.");
assert.ok(existsSync(join(appDir, "assets", "app-icon.icns")), "app icon must exist for packaging.");
assert.ok(existsSync(join(appDir, "assets", "app-icon.ico")), "Windows app icon must exist for packaging.");
assertNonEmptyFile(join(appDir, "assets", "default-pet-spritesheet.webp"), "default pet spritesheet must exist for packaging.");
assertNonEmptyFile(join(appDir, "assets", "default-pet-thumbnail.png"), "default pet thumbnail must exist for Pet Manager preview.");
assertNonEmptyFile(join(appDir, "assets", "onboarding-logo.webp"), "onboarding logo asset must exist for packaging.");
assertNonEmptyFile(join(appDir, "assets", "onboarding-pets.webp"), "onboarding pet scene asset must exist for packaging.");
for (const icon of ["claude.svg", "cursor.svg", "opencode.svg", "pi.svg", "vscode.svg", "windsurf.svg", "zed.svg"]) {
  assertSafeBundledSvg(join(appDir, "assets", "integrations", icon), `integration icon must be safe and packaged: ${icon}`);
}
assert.match(readFileSync(join(appDir, "src", "assets.ts"), "utf8"), /assets["']?,\s*["']tray-icon\.png|join\("assets", "tray-icon\.png"\)/, "tray icon code must keep using assets/tray-icon.png.");
const petWindowSource = readFileSync(join(appDir, "src", "pet-window.ts"), "utf8");
const petPreloadSource = readFileSync(join(appDir, "pet-preload.cjs"), "utf8");
const reactionMessagesSource = readFileSync(join(appDir, "src", "reaction-messages.ts"), "utf8");
const displaySource = readFileSync(join(appDir, "src", "display.ts"), "utf8");
const updateCheckerSource = readFileSync(join(appDir, "src", "update-checker.ts"), "utf8");
const traySource = readFileSync(join(appDir, "src", "tray.ts"), "utf8");
const windowsSource = readFileSync(join(appDir, "src", "windows.ts"), "utf8");
const agentSetupSource = readFileSync(join(appDir, "src", "agent-setup.ts"), "utf8");
const preloadSource = readFileSync(join(appDir, "preload.cjs"), "utf8");
const loggerSource = readFileSync(join(appDir, "src", "logger.ts"), "utf8");
const mainSource = readFileSync(join(appDir, "src", "main.ts"), "utf8");
const localIpcSourceForLogging = readFileSync(join(appDir, "src", "local-ipc.ts"), "utf8");
const localIpcPathsSource = readFileSync(join(appDir, "src", "local-ipc-paths.ts"), "utf8");
const leaseManagerSource = readFileSync(join(appDir, "src", "lease-manager.ts"), "utf8");
const defaultPetControllerSource = readFileSync(join(appDir, "src", "default-pet-controller.ts"), "utf8");
const agentPetControllerSourceForLogging = readFileSync(join(appDir, "src", "agent-pet-controller.ts"), "utf8");
const mappingDoc = readFileSync(join(repoRoot, "docs", "mapping.md"), "utf8");
assert.match(loggerSource, /openpets\.log/, "desktop logger must write a user-sendable openpets.log file.");
assert.match(loggerSource, /openpets\.previous\.log/, "desktop logger must retain a previous log file for bug reports.");
assert.match(loggerSource, /OPENPETS_LOG_LEVEL/, "desktop logger must support verbose dev logging via environment.");
assert.match(loggerSource, /normalizeLogLevel\(process\.env\.OPENPETS_LOG_LEVEL\) \?\? "debug"/, "desktop production logger must default to debug for user-sendable diagnostics.");
assert.match(loggerSource, /redacted-token/, "desktop logger must redact token-looking values.");
assert.match(mainSource, /initializeLogger\(\)/, "desktop startup must initialize logging before subsystem startup.");
assert.match(traySource, /Open Logs Folder/, "desktop tray must expose user-sendable logs for bug reports.");
assert.match(localIpcSourceForLogging, /request received/, "desktop IPC must log request methods for diagnostics.");
assert.match(localIpcPathsSource, /OPENPETS_IPC_BIND[\s\S]*?OPENPETS_IPC_ENDPOINT[\s\S]*?validateBindHost[\s\S]*?validateAdvertisedHost/, "WSL NAT IPC must separate bind and advertised endpoints with validation.");
assert.match(localIpcPathsSource, /OPENPETS_IPC_ENDPOINT only controls the advertised discovery endpoint[\s\S]*?OPENPETS_IPC_BIND to opt into TCP IPC listening/, "OPENPETS_IPC_ENDPOINT-only mode must not start TCP listening; OPENPETS_IPC_BIND is the explicit TCP opt-in.");
assert.match(localIpcPathsSource, /OPENPETS_IPC_ENDPOINT must use the same port as OPENPETS_IPC_BIND unless OPENPETS_IPC_BIND uses port 0/, "WSL NAT advertised endpoint must not silently override mismatched ports.");
assert.match(leaseManagerSource, /acquired/, "lease manager must log lease acquisition details.");
assert.match(defaultPetControllerSource, /show requested/, "default pet controller must log show lifecycle events.");
assert.match(agentPetControllerSourceForLogging, /show requested/, "agent pet controller must log show lifecycle events.");
assert.match(petWindowSource, /default-pet-spritesheet\.webp/, "default pet renderer must reference the bundled WebP spritesheet asset.");
assert.match(petWindowSource, /columns:\s*8/, "default pet renderer must keep the real catalog sprite sheet column count.");
assert.match(petWindowSource, /rows:\s*9/, "default pet renderer must keep the real catalog sprite sheet row count.");
assert.match(petWindowSource, /frameWidth:\s*192/, "default pet renderer must keep the universal Codex frame width.");
assert.match(petWindowSource, /frameHeight:\s*208/, "default pet renderer must keep the universal Codex frame height.");
assert.ok(petWindowSource.includes("defaultPetSprite.frameWidth * defaultPetSprite.columns") && petWindowSource.includes("defaultPetSprite.frameHeight * defaultPetSprite.rows"), "pet renderer must derive universal spritesheet dimensions from frame size and row/column counts.");
for (const state of ["idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review"]) {
  assert.match(petWindowSource, new RegExp(`["']?${state}["']?:\\s*\\{\\s*row:`), `pet renderer must define universal sprite state: ${state}`);
}
for (const reaction of ["idle", "thinking", "working", "editing", "running", "testing", "waiting", "waving", "success", "error", "celebrating"]) {
  assert.match(petWindowSource, new RegExp(`${reaction}:\\s*["']`), `pet renderer must map reaction to sprite state: ${reaction}`);
  assert.match(reactionMessagesSource, new RegExp(`${reaction}:\\s*\\[`), `reaction messages must define a pool for: ${reaction}`);
}
assert.match(petWindowSource, /satisfies Record<OpenPetsReaction, UniversalSpriteState>/, "reaction-to-sprite-state mapping must be exhaustive over OpenPetsReaction.");
assert.match(reactionMessagesSource, /satisfies Record<OpenPetsReaction, readonly string\[\]>/, "reaction-only bubble message pools must be exhaustive over OpenPetsReaction.");
assert.match(petWindowSource, /pickReactionMessage\(display\.reaction\)/, "reaction-only bubbles must render randomized messages instead of raw lowercase reaction ids.");
assert.match(petWindowSource, /function preparePetTransientDisplay/, "reaction-only bubbles must prepare a stable random message before rerenders.");
assert.match(petWindowSource, /function mergePetTransientDisplay/, "reaction-only events must not replace an active explicit message bubble.");
assert.match(petWindowSource, /function getTransientDisplayDurationMs[\s\S]*?12_000[\s\S]*?message\.length \* 70/, "speech bubbles must stay visible longer for longer messages without becoming permanent.");
assert.match(defaultPetControllerSource, /getTransientDisplayDurationMs\(transientDisplay\)/, "default pet speech bubble timeout must be length-aware.");
assert.match(agentPetControllerSourceForLogging, /getTransientDisplayDurationMs\(preparedDisplay\)/, "agent pet speech bubble timeout must be length-aware.");
assert.match(petWindowSource, /function getTransientReactionAnimationMs/, "finite reaction animations must expose their own shorter lifetime.");
assert.match(petWindowSource, /function clearTransientReaction/, "finite reaction animations must be clearable while the bubble remains visible.");
assert.match(petWindowSource, /webContents\.send\("openpets:pet-reaction-state"/, "finite reaction animations must clear sprite state without reloading the bubble.");
assert.match(petPreloadSource, /openpets:pet-reaction-state/, "pet preload must accept in-place reaction state updates.");
assert.match(petWindowSource, /const webContents = window\.webContents[\s\S]*?const removeListeners = \(\): void => \{[\s\S]*?if \(!webContents\.isDestroyed\(\)\)/, "pet window cleanup must capture webContents and avoid touching destroyed BrowserWindow objects.");
assert.match(petWindowSource, /window\.on\("close", removeListeners\);\s*window\.once\("closed", removeListeners\);/, "pet window cleanup must run before and after close so agent lease release and Cmd/Ctrl+W are idempotent.");
assert.match(displaySource, /width:\s*220/, "pet windows must stay tightly bounded around pet and bubble.");
assert.match(displaySource, /height:\s*320/, "pet windows must be tall enough for adaptive long message bubbles at large pet scale without becoming a huge click shield.");
assert.match(petWindowSource, /function getBubbleClassName/, "pet bubbles must classify explicit messages by length.");
assert.match(petWindowSource, /is-long-message/, "pet bubbles must have a long-message layout.");
assert.match(petWindowSource, /is-very-long-message/, "pet bubbles must have a very-long-message layout for 140-character say messages.");
assert.match(petWindowSource, /body \{ -webkit-app-region: no-drag; pointer-events: none; \}/, "transparent pet window background must not capture clicks or drags.");
assert.match(petWindowSource, /function installMousePassthroughAndDrag/, "pet windows must install real mouse passthrough and controlled drag behavior.");
assert.match(petWindowSource, /setIgnoreMouseEvents\(true, \{ forward: true \}\)/, "transparent pet window background must use OS-level mouse passthrough.");
assert.match(petWindowSource, /setIgnoreMouseEvents\(false\)/, "visible pet and bubble hit targets must re-enable mouse handling.");
assert.match(petWindowSource, /openpets:pet-ready/, "pet windows must resync passthrough after each renderer reload.");
assert.match(petWindowSource, /function installMousePassthroughAndDrag[\s\S]*?const rearmPassthroughAfterLoad[\s\S]*?process\.platform !== "win32"[\s\S]*?window\.setIgnoreMouseEvents\(false\);[\s\S]*?window\.setIgnoreMouseEvents\(true, \{ forward: true \}\);/, "Windows pet reloads must toggle forwarded mouse passthrough to re-register hover and drag tracking.");
assert.match(petWindowSource, /scheduleWindowsMouseForwardingRearm\("did-finish-load\+75ms", 75\);[\s\S]*?scheduleWindowsMouseForwardingRearm\("did-finish-load\+175ms", 175\);/, "Windows pet reloads must retry mouse forwarding rearm after load settles.");
assert.match(petWindowSource, /openpets:pet-probe-hit-test/, "Windows pet reloads must probe current cursor hit target when mousemove forwarding is stale.");
assert.match(petPreloadSource, /openpets:pet-probe-hit-test[\s\S]*?elementFromPoint\(clientX, clientY\)[\s\S]*?reportInteractiveHit/, "pet preload must answer main-process cursor hit-test probes.");
assert.match(petWindowSource, /did-finish-load", rearmAfterLoad/, "pet windows must re-arm mouse passthrough after every content load.");
assert.match(petWindowSource, /did-fail-load", handleLoadFailure/, "pet windows must restore passthrough after failed content loads.");
assert.match(petWindowSource, /window\.setIgnoreMouseEvents\(false\);[\s\S]*?await window\.loadFile/, "pet reloads must reset OS mouse passthrough before navigation.");
assert.match(petWindowSource, /function allocateWindowLoadSequence/, "pet content reloads must allocate request sequence before async rendering.");
assert.match(petWindowSource, /tryUpdateLoadedPetContent\(window, render, "default", sequence\)/, "default pet transient updates must avoid BrowserWindow reloads when the pet document is already loaded.");
assert.match(petPreloadSource, /openpets:pet-content-state[\s\S]*?document\.body\.innerHTML/, "pet preload must accept sanitized in-place content updates for transient bubbles and badges.");
assert.match(petWindowSource, /windowLoadChains\.set\(window, next\)/, "pet content reloads must serialize loadFile calls per BrowserWindow.");
assert.match(petWindowSource, /next\.catch\(\(\) => \{\}\)\.finally/, "pet content reload chain cleanup must not create unhandled rejections.");
assert.match(petWindowSource, /destroyed-after-write/, "pet content reloads must re-check destroyed windows after writing HTML.");
assert.match(petWindowSource, /process\.platform === "win32" \? "none" : "drop-shadow/, "Windows pet windows must avoid CSS drop-shadow on transparent layered windows.");
assert.match(petWindowSource, /process\.platform === "win32" \? "none" : "blur\(10px\)"/, "Windows pet windows must avoid backdrop-filter on transparent layered windows.");
assert.match(petWindowSource, /\.pet-shell[\s\S]*?-webkit-app-region: no-drag; cursor: grab;/, "pet dragging must avoid Electron draggable regions so right-click context menus work.");
assert.match(petPreloadSource, /openpets:pet-hit-test/, "pet preload must report visible pet and bubble hit testing for passthrough.");
assert.match(petPreloadSource, /openpets:pet-ready/, "pet preload must report readiness after installing mouse handlers.");
assert.match(petPreloadSource, /openpets:pet-drag-start/, "pet preload must start controlled pet dragging from the sprite.");
assert.match(petWindowSource, /function installPetContextMenu/, "pet windows must install a native right-click context menu.");
assert.match(petWindowSource, /webContents\.on\("context-menu"/, "pet context menu must be handled in the Electron main process.");
assert.match(petWindowSource, /Menu\.buildFromTemplate/, "pet context menu must use a small native Electron menu.");
assert.doesNotMatch(petPreloadSource, /setIgnoreMouseEvents/, "pet preload must not call Electron window APIs directly.");
const agentPetControllerSource = readFileSync(join(appDir, "src", "agent-pet-controller.ts"), "utf8");
const localIpcSource = readFileSync(join(appDir, "src", "local-ipc.ts"), "utf8");
assert.match(agentPetControllerSource, /dismissedAgentPets = new Set<string>/, "agent pets must remember manual close while leases remain active.");
assert.match(agentPetControllerSource, /dismissAgentPetForActiveLease/, "agent pet context-menu close must dismiss the pet for the active lease.");
assert.match(agentPetControllerSource, /dismissedAgentPets\.has\(petId\)/, "dismissed agent pets must not reopen on later same-lease reactions.");
assert.match(agentPetControllerSource, /function clearAgentPetLeaseState/, "agent pet lease cleanup must clear dismissal, timers, and hidden transient state.");
assert.match(localIpcSource, /handleLastExplicitLease/, "agent pet dismissal must clear when the explicit lease group ends.");
assert.match(localIpcSource, /clearAgentPetLeaseState\(petId\)/, "last explicit lease cleanup must reset dismissed agent pet state.");
assert.match(localIpcSource, /reason: applied\.reason/, "IPC responses must report dismissed explicit pet events as not shown.");
assert.match(updateCheckerSource, /alvinunreal\/openpets/, "GitHub release notice must check the public OpenPets repository.");
assert.match(updateCheckerSource, /api\.github\.com\/repos\/\$\{githubRepository\}\/releases\/latest/, "update checker must use GitHub latest release API.");
assert.match(updateCheckerSource, /shell\.openExternal\(url\)/, "update action must open the GitHub release page externally.");
assert.match(traySource, /Update available:/, "tray menu must surface available updates.");
assert.match(windowsSource, /openpets:check-for-updates/, "settings window must be able to trigger update checks.");
assert.match(windowsSource, /openpets:open-update-release-page/, "settings window must be able to open the release page.");
assert.match(windowsSource, /id="check-for-updates"/, "settings UI must include a Check for updates button.");
assert.match(windowsSource, /id="open-update-release"/, "settings UI must include an Open release button.");
assert.match(preloadSource, /checkForUpdates/, "settings preload must expose update checks.");
assert.match(preloadSource, /\{ label: "Thinking", state: "thinking" \}/, "Pet Manager mini previews must use a non-idle thinking/review state because the hero already shows idle.");
assert.match(preloadSource, /\{ label: "Happy", state: "happy" \}/, "Pet Manager mini previews must request the happy/jumping row.");
assert.match(preloadSource, /\{ label: "Wave", state: "wave" \}/, "Pet Manager mini previews must request the waving row.");
assert.doesNotMatch(preloadSource, /\{ label: "Idle", state: "idle" \}/, "Pet Manager mini previews must not duplicate the hero idle preview.");
assert.match(preloadSource, /pm-mini-sprite[\s\S]*animated: true/, "Pet Manager mini state previews must animate spritesheet states.");
assert.match(preloadSource, /pm-sprite-state-\$\{state\}/, "Pet Manager sprite frames must apply state-specific row classes.");
assert.match(windowsSource, /pm-sprite-state-thinking \{ background-position: 0 100%; \}/, "Pet Manager thinking preview must use universal spritesheet row 8.");
assert.match(windowsSource, /pm-sprite-state-wave \{ background-position: 0 37\.5%; \}/, "Pet Manager wave preview must use universal spritesheet row 3.");
assert.match(windowsSource, /pm-sprite-state-happy \{ background-position: 0 50%; \}/, "Pet Manager happy preview must use universal spritesheet row 4.");
assert.match(windowsSource, /pm-sprite-state-thinking\.pm-animate-sprite \{ animation: pm-sprite-thinking 1\.55s steps\(6\) infinite; \}/, "Pet Manager thinking preview must animate the 6-frame review row at a calm speed.");
assert.match(windowsSource, /pm-sprite-state-wave\.pm-animate-sprite \{ animation: pm-sprite-wave 1\.25s steps\(4\) infinite; \}/, "Pet Manager wave preview must animate the 4-frame waving row at a calm speed.");
assert.match(windowsSource, /pm-sprite-state-happy\.pm-animate-sprite \{ animation: pm-sprite-happy 1\.35s steps\(5\) infinite; \}/, "Pet Manager happy preview must animate the 5-frame jumping row at a calm speed.");
assert.match(windowsSource, /@keyframes pm-sprite-thinking/, "Pet Manager must define thinking row animation keyframes.");
assert.match(windowsSource, /@keyframes pm-sprite-wave/, "Pet Manager must define wave row animation keyframes.");
assert.match(windowsSource, /@keyframes pm-sprite-happy/, "Pet Manager must define happy row animation keyframes.");
assert.match(petWindowSource, /max-width:\s*min\(220px/, "very long message bubbles must stay capped within the tight pet window.");
assert.match(petWindowSource, /-webkit-line-clamp:\s*8/, "very long message bubbles must allow enough visible lines.");
assert.match(petWindowSource, /createSpriteStateCss\("\.sprite"\)/, "built-in sprite CSS must react to reaction state.");
assert.match(petWindowSource, /createSpriteStateCss\("\.installed-sprite"\)/, "installed sprite CSS must react to reaction state.");
assert.match(petWindowSource, /html\[data-motion-state=\"\$\{motion\}\"\] \$\{selector\}/, "sprite CSS must let drag motion override reaction state.");
assert.match(petWindowSource, /\.sprite, \.installed-sprite, \.bubble/, "reduced-motion CSS must include built-in and installed sprites.");
assert.match(petWindowSource, /function createAgentPetWindow[\s\S]*?installMotionStatePublisher\(window\)/, "agent pet windows must publish motion state so dragged non-default pets run.");
assert.match(petWindowSource, /loadExplicitPetContent[\s\S]*?state\.preferences\.petScale/, "explicit agent pet windows must use the saved pet scale preference.");
assert.match(mappingDoc, /\| 3 \| `waving` \| `waving`, Claude `Notification`\. \|/, "mapping docs must describe waving animation row and notification mapping.");
assert.doesNotMatch(mappingDoc, /bubble-only|currently \*\*bubble states\*\*/i, "mapping docs must not describe reactions as bubble-only.");
for (const reaction of allowedReactions) {
  const pool = reactionMessagePools[reaction];
  assert.ok(pool.length >= 8, `reaction message pool must include clear variants for: ${reaction}`);
  for (const message of pool) {
    assert.match(message, /^[A-Z]/, `reaction message must start uppercase: ${message}`);
    assert.doesNotMatch(message, /[\r\n]/, `reaction message must be single-line: ${message}`);
    assert.ok(message.length <= 36, `reaction message must stay bubble-friendly: ${message}`);
  }
}
assert.equal(pickReactionMessage("success", () => 0), reactionMessagePools.success[0], "reaction message picking must be deterministic when random is injected.");
const agentSetupHtmlSource = windowsSource.match(/function createAgentSetupHtml[\s\S]*?function createSettingsHtml/)?.[0] ?? "";
assert.match(windowsSource, /onboarding-logo\.webp/, "onboarding greeting must reference the bundled OpenPets logo asset.");
assert.match(windowsSource, /onboarding-pets\.webp/, "onboarding greeting must reference the bundled pet scene asset.");
assert.ok(windowsSource.includes(`content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'"`), "onboarding image CSP must stay data-only for embedded packaged assets.");
assert.doesNotMatch(windowsSource, /data-default-pet-sprite-src|createAssetDataUrl\("default-pet-spritesheet\.webp"/, "Pet Manager must not embed the large default spritesheet into the task-window data URL.");
assert.match(windowsSource, /default-pet-thumbnail\.png/, "Pet Manager must use the small bundled default pet thumbnail for built-in preview.");
assert.ok(windowsSource.includes(`content="default-src 'none'; img-src data: https://openpets.dev openpets-codex:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'"`), "Pet Manager image CSP must stay scoped to data URLs, openpets.dev catalog previews, and the Codex spritesheet protocol.");
assert.match(windowsSource, /petManagerWindowWidth\s*=\s*1160/, "Pet Manager should use the approved wider 1160px default window width.");
assert.match(windowsSource, /petManagerWindowHeight\s*=\s*780/, "Pet Manager should use the approved taller 780px default window height.");
assert.match(agentSetupHtmlSource, /content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'"/, "Agent Setup image CSP must stay data-only for the bundled logo asset.");
assert.match(windowsSource, /integrations\/claude\.svg/, "Agent Setup integrations hub must use bundled integration SVG assets.");
assert.match(windowsSource, /integration-opencode-status/, "Agent Setup must show an enabled OpenCode integration card.");
assert.match(windowsSource, /opencode-detail-view/, "Agent Setup must include an OpenCode detail pane.");
assert.match(windowsSource, /integrations\/pi\.svg/, "Agent Setup integrations hub must use the bundled Pi SVG asset.");
assert.match(windowsSource, /integration-pi-status/, "Agent Setup must show a Pi integration card.");
assert.match(windowsSource, /pi-detail-view/, "Agent Setup must include a Pi manual setup detail pane.");
assert.match(windowsSource, /Desktop OpenCode setup is global/, "OpenCode desktop setup must clearly warn that it is global.");
assert.match(preloadSource, /opencode-install/, "Agent Setup preload must bind OpenCode install actions.");
assert.match(preloadSource, /setIconButtonContent\(opencodeInstall, "spinner", "Installing…"\)/, "OpenCode integration-card install button must show a loading spinner.");
assert.match(preloadSource, /opencode-remove/, "Agent Setup preload must bind OpenCode remove actions.");
assert.match(preloadSource, /opencode-copy-config/, "Agent Setup preload must bind OpenCode copy-preview actions.");
assert.match(preloadSource, /opencodePreview/, "Agent Setup preload must render OpenCode previews.");
assert.match(preloadSource, /integration-pi-configure/, "Agent Setup preload must bind the Pi integration card.");
assert.match(preloadSource, /pi-copy-global-install/, "Agent Setup preload must bind Pi copy commands.");
assert.match(preloadSource, /cleanupConfigPaths/, "OpenCode preview must disclose stale overlay cleanup config paths.");
assert.match(preloadSource, /configPreview/, "OpenCode preview copy must use the prepared config preview shape.");
assert.match(agentSetupHtmlSource, /integration-cursor-status/, "Agent Setup must show an enabled Cursor integration card.");
assert.match(agentSetupHtmlSource, /cursor-detail-view/, "Agent Setup must include a Cursor detail pane.");
assert.match(preloadSource, /cursor-install/, "Agent Setup preload must bind Cursor install actions.");
assert.match(preloadSource, /cursor-replace/, "Agent Setup preload must bind Cursor replace actions.");
assert.match(preloadSource, /cursor-remove/, "Agent Setup preload must bind Cursor remove actions.");
assert.match(preloadSource, /cursor-copy-preview/, "Agent Setup preload must bind Cursor copy-preview actions.");
assert.match(agentSetupHtmlSource, /cursor-rules-preview/, "Agent Setup must show a Cursor project rules preview.");
assert.match(agentSetupHtmlSource, /Desktop does not write project rules/, "Desktop Cursor rules UI must be preview/copy only.");
assert.match(preloadSource, /cursor-copy-rules/, "Agent Setup preload must bind Cursor rules copy actions.");
assert.doesNotMatch(agentSetupSource, /planCursorRules|executeCursorRules|cursor-rules-install|cursor-rules-remove/, "Desktop must not write Cursor project rules without a reviewed project picker.");
assert.match(preloadSource, /updateCursorIntegration/, "Agent Setup preload must render Cursor integration.");
assert.match(preloadSource, /cursorStatus/, "Agent Setup preload must check Cursor status.");
assert.match(preloadSource, /cursorPreview/, "Agent Setup preload must render Cursor preview.");
assert.doesNotMatch(agentSetupSource, /JSON\.parse\(prepared\.configWrite\.content\)/, "OpenCode desktop preview must parse JSONC planned config safely, not JSON.parse.");
assert.doesNotMatch(agentSetupHtmlSource, /https?:\/\//, "Agent Setup must not allow or reference remote integration assets.");
assert.match(windowsSource, /agentSetupWindowWidth\s*=\s*1160/, "Agent Setup should use the approved wider 1160px default window width.");
assert.match(windowsSource, /agentSetupWindowHeight\s*=\s*780/, "Agent Setup should use the approved taller 780px default window height.");
assert.match(windowsSource, /refreshDefaultPetContent\(\);\s*refreshAgentPetContent\(\);/, "pet scale preference changes must refresh default and agent pet windows.");
assert.ok(existsSync(join(appDir, "scripts", "clean-package-output.cjs")), "package output cleanup helper must exist.");
assert.ok(existsSync(join(distDir, "main.js")), "desktop main build output must exist before packaging checks run.");
assert.ok(existsSync(join(repoRoot, "packages", "claude", "dist", "index.js")), "@open-pets/claude must be built before packaging.");
assert.ok(existsSync(join(repoRoot, "packages", "client", "dist", "index.js")), "@open-pets/client must be built before packaging.");
assert.ok(existsSync(join(repoRoot, "packages", "mcp", "dist", "index.js")), "@open-pets/mcp must be built before packaging.");
assert.ok(existsSync(join(repoRoot, "packages", "cli", "dist", "index.js")), "@open-pets/cli must be built before packaging.");
assert.ok(existsSync(join(repoRoot, "packages", "opencode", "dist", "plugin.js")), "@open-pets/opencode plugin must be built before packaging.");
assert.ok(existsSync(join(repoRoot, "packages", "agent-events", "dist", "index.js")), "@open-pets/agent-events must be built before packaging.");

if (process.argv.includes("--output")) {
  checkPackageOutput();
} else {
  checkCleanupHelper();
}

console.error("Packaging contract validation passed.");

function checkPackageOutput(): void {
  const outputDir = join(appDir, "dist-electron");
  assert.ok(existsSync(outputDir), "dist-electron output must exist after packaging.");
  assertNoForbiddenOutput(outputDir);
  assertNoEscapingSymlinks(outputDir);

  const appResourceDir = findPackagedAppResourceDir(outputDir);
  assert.ok(appResourceDir, "packaged app resources directory was not found.");
  assert.ok(existsSync(join(appResourceDir, "app.asar")), "packaged app.asar is missing.");
  const appContents = join(appResourceDir, "app.asar.unpacked");
  assert.ok(existsSync(appContents), "packaged app.asar.unpacked resources are missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "claude", "dist", "index.js")), "packaged @open-pets/claude runtime is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "claude", "dist", "cli.js")), "packaged @open-pets/claude CLI runtime is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "claude", "package.json")), "packaged @open-pets/claude package metadata is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "client", "dist", "index.js")), "packaged @open-pets/client runtime is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "client", "package.json")), "packaged @open-pets/client package metadata is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "mcp", "dist", "index.js")), "packaged @open-pets/mcp runtime is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "mcp", "package.json")), "packaged @open-pets/mcp package metadata is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "cli", "dist", "index.js")), "packaged @open-pets/cli runtime is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "opencode", "dist", "plugin.js")), "packaged @open-pets/opencode plugin runtime is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "opencode", "package.json")), "packaged @open-pets/opencode package metadata is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "cursor", "dist", "index.js")), "packaged @open-pets/cursor runtime is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "cursor", "package.json")), "packaged @open-pets/cursor package metadata is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@open-pets", "agent-events", "dist", "index.js")), "packaged @open-pets/agent-events runtime is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@modelcontextprotocol", "sdk")), "packaged MCP SDK runtime dependency is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "zod", "index.cjs")), "packaged zod runtime dependency is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "yauzl", "index.js")), "packaged yauzl runtime dependency is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "yauzl", "fd-slicer.js")), "packaged yauzl fd-slicer helper is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "buffer-crc32", "index.js")), "packaged yauzl transitive dependency buffer-crc32 is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "pend", "index.js")), "packaged yauzl transitive dependency pend is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "sharp", "lib", "index.js")), "packaged sharp runtime is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@img", "sharp-win32-x64", "lib", "sharp-win32-x64.node")), "packaged Windows x64 sharp native binary is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@img", "sharp-linux-x64", "lib", "sharp-linux-x64.node")), "packaged Linux x64 sharp native binary is missing.");
  assert.ok(existsSync(join(appContents, "node_modules", "@img", "sharp-darwin-x64", "lib", "sharp-darwin-x64.node")), "packaged macOS x64 sharp native binary is missing.");
  assertRegularNonSymlink(join(appContents, "node_modules", "@open-pets", "mcp", "dist", "index.js"));
  assertRegularNonSymlink(join(appContents, "node_modules", "@open-pets", "cli", "dist", "index.js"));
  assertRegularNonSymlink(join(appContents, "node_modules", "@open-pets", "opencode", "dist", "plugin.js"));
  assertRegularNonSymlink(join(appContents, "node_modules", "@open-pets", "claude", "dist", "cli.js"));
  assertCommandSmoke(appContents);
}

function findPackagedAppResourceDir(outputDir: string): string | null {
  const candidates: string[] = [];
  collectDirectories(outputDir, candidates, 4);

  for (const dir of candidates) {
    if (existsSync(join(dir, "app.asar")) || existsSync(join(dir, "app", "dist", "main.js"))) {
      return dir;
    }
  }

  return null;
}

function collectDirectories(dir: string, result: string[], depth: number): void {
  if (depth < 0 || !existsSync(dir)) return;
  result.push(dir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) collectDirectories(join(dir, entry.name), result, depth - 1);
  }
}

function assertNoForbiddenOutput(outputDir: string): void {
  const forbiddenSegments = new Set(["v1", "web", ".env", ".claude"]);
  for (const path of walk(outputDir)) {
    const rel = relative(outputDir, path);
    const segments = rel.split(/[\\/]/g);
    assert.ok(!segments.includes("docs") || !segments.includes("phases"), `package output must not include phase docs: ${rel}`);
    for (const segment of segments) {
      assert.ok(!forbiddenSegments.has(segment) && !segment.startsWith(".env"), `package output contains forbidden path segment: ${rel}`);
    }
  }
}

function assertNoEscapingSymlinks(outputDir: string): void {
  const outputReal = realpathSync(outputDir);
  for (const path of walk(outputDir)) {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) continue;
    const target = realpathSync(path);
    assert.ok(isInside(outputReal, target), `package output symlink escapes package directory: ${relative(outputDir, path)} -> ${target}`);
  }
}

function walk(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    result.push(path);
    if (entry.isDirectory()) {
      result.push(...walk(path));
    }
  }
  return result;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function checkCleanupHelper(): void {
  const sentinel = join(appDir, "dist-electron", ".openpets-clean-sentinel");
  mkdirSync(dirname(sentinel), { recursive: true });
  writeFileSync(sentinel, "stale", "utf8");
  const result = spawnSync(process.execPath, [join(appDir, "scripts", "clean-package-output.cjs")], { cwd: appDir, encoding: "utf8" });
  assert.equal(result.status, 0, `cleanup helper failed: ${result.stderr || result.stdout}`);
  assert.ok(!existsSync(sentinel), "cleanup helper did not remove stale package output sentinel.");
}

function assertRegularNonSymlink(path: string): void {
  assert.ok(!lstatSync(path).isSymbolicLink(), `packaged command file must not be a symlink: ${path}`);
  assert.ok(lstatSync(path).isFile(), `packaged command file must be regular: ${path}`);
}

function assertNonEmptyFile(path: string, message: string): void {
  assert.ok(existsSync(path), message);
  const stat = lstatSync(path);
  assert.ok(stat.isFile(), message);
  assert.ok(stat.size > 0, message);
}

function assertSafeBundledSvg(path: string, message: string): void {
  assertNonEmptyFile(path, message);
  const source = readFileSync(path, "utf8");
  assert.doesNotMatch(source, /<script\b/i, `${message}: script tags are not allowed.`);
  assert.doesNotMatch(source, /\son[a-z]+\s*=/i, `${message}: event attributes are not allowed.`);
  assert.doesNotMatch(source, /(?:href|xlink:href)\s*=\s*["'](?:https?:|file:|javascript:)/i, `${message}: external or script hrefs are not allowed.`);
  assert.doesNotMatch(source.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/gi, ""), /https?:\/\//i, `${message}: remote references are not allowed.`);
}

function assertCommandSmoke(appContents: string): void {
  const mcpEntry = join(appContents, "node_modules", "@open-pets", "mcp", "dist", "index.js");
  const mcp = spawnSync(process.execPath, [mcpEntry, "--version"], { encoding: "utf8" });
  assert.equal(mcp.status, 0, `packaged MCP command smoke failed: ${mcp.stderr || mcp.stdout}`);

  const hookEntry = join(appContents, "node_modules", "@open-pets", "claude", "dist", "cli.js");
  const hook = spawnSync(process.execPath, [hookEntry, "hook", "--openpets-managed"], {
    input: JSON.stringify({ hook_event_name: "Notification", message: "safe" }),
    encoding: "utf8",
    env: { ...process.env, OPENPETS_DISCOVERY_FILE: join(appContents, "missing-ipc.json") },
  });
  assert.equal(hook.status, 0, `packaged Claude hook command smoke failed: ${hook.stderr || hook.stdout}`);
  assert.equal(hook.stdout, "");

  const opencodePlugin = join(appContents, "node_modules", "@open-pets", "opencode", "dist", "plugin.js");
  const plugin = spawnSync(process.execPath, ["--input-type=module", "--eval", `const mod = await import(${JSON.stringify(`file://${opencodePlugin}`)}); if (!mod.default?.server || !mod.default?.id) process.exit(2);`], { encoding: "utf8" });
  assert.equal(plugin.status, 0, `packaged OpenCode plugin smoke failed: ${plugin.stderr || plugin.stdout}`);
}
