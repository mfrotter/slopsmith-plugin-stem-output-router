(function () {
  "use strict";

  if (window.slopsmithStemOutputRouter && window.slopsmithStemOutputRouter.__loaded) {
    return;
  }

  const PLUGIN_ID = "stem-output-router";
  const ROOT_SELECTOR = "[data-stem-output-router-root]";
  const STORAGE_KEY = "slopsmith.stemOutputRouter.selectedOutputId";
  const ROUTES_KEY = "slopsmith.stemOutputRouter.routes";
  const CHANNELS_KEY = "slopsmith.stemOutputRouter.manualChannels";
  const STYLE_ID = "stem-output-router-style";
  const PLAYER_CONTROL_ID = "stem-output-router-player-control";
  const MAIN_MIX_ROUTE = "main";
  const MUTE_ROUTE = "mute";
  const METRONOME_ID = "metronome";
  const ROUTED_METRONOME_VOLUME = 1;

  const state = {
    browserOutputs: [],
    hostOutputs: [],
    stems: [],
    routes: loadRouteMap(),
    manualChannels: loadManualChannels(),
    autoPlaybackChannels: 0,
    playbackChannels: 0,
    routingActive: false,
    pendingChanges: false,
    routingWarning: "",
    selectedOutputId: safeStorageGet(STORAGE_KEY) || "",
    capabilities: {
      enumerateDevices: false,
      selectAudioOutput: false,
      mediaElementSinkId: false,
      audioContextSinkId: false,
      hostOutputApi: false,
      channelCounts: false
    },
    busy: false,
    status: "idle",
    error: ""
  };

  let routingGraph = null;
  let testToneContext = null;
  let metronomeState = null;
  let routingShouldResume = false;
  let deferredApplyGeneration = 0;
  let routingRestoreWindowHooksInstalled = false;
  let routingRestoreBusHooksInstalled = false;
  let routingRestoreBusHookRetryTimer = null;
  let routingRestoreBusHookAttempts = 0;

  function safeStorageGet(key) {
    try {
      return window.localStorage ? window.localStorage.getItem(key) : "";
    } catch (_error) {
      return "";
    }
  }

  function safeStorageSet(key, value) {
    try {
      if (window.localStorage) {
        window.localStorage.setItem(key, value);
      }
    } catch (_error) {
      // Local storage may be disabled in locked-down WebViews.
    }
  }

  function loadRouteMap() {
    try {
      const raw = window.localStorage ? window.localStorage.getItem(ROUTES_KEY) : "";
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  function saveRouteMap() {
    try {
      if (window.localStorage) {
        window.localStorage.setItem(ROUTES_KEY, JSON.stringify(state.routes));
      }
    } catch (_error) {
      // Local storage may be disabled in locked-down WebViews.
    }
  }

  function loadManualChannels() {
    const value = Number(safeStorageGet(CHANNELS_KEY));
    return Number.isInteger(value) && value >= 0 ? value : 0;
  }

  function saveManualChannels(value) {
    state.manualChannels = value;
    safeStorageSet(CHANNELS_KEY, String(value));
  }

  function installStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .stem-output-router {
        color: var(--text-color, #e5e7eb);
        display: flex;
        flex-direction: column;
        gap: 16px;
        max-width: 980px;
        width: 100%;
      }
      .stem-output-router * {
        box-sizing: border-box;
      }
      .stem-output-router__header {
        align-items: flex-start;
        display: flex;
        gap: 16px;
        justify-content: space-between;
      }
      .stem-output-router h2,
      .stem-output-router h3,
      .stem-output-router p {
        margin: 0;
      }
      .stem-output-router h2 {
        font-size: 20px;
        font-weight: 700;
        line-height: 1.25;
      }
      .stem-output-router h3 {
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .stem-output-router p,
      .stem-output-router__muted {
        color: var(--muted-text-color, #9ca3af);
        font-size: 13px;
        line-height: 1.45;
      }
      .stem-output-router__actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-end;
      }
      .stem-output-router button {
        align-items: center;
        background: var(--button-bg, #1f2937);
        border: 1px solid var(--border-color, #374151);
        border-radius: 6px;
        color: inherit;
        cursor: pointer;
        display: inline-flex;
        font: inherit;
        font-size: 13px;
        font-weight: 650;
        min-height: 34px;
        padding: 6px 10px;
      }
      .stem-output-router button:hover {
        background: var(--button-hover-bg, #374151);
      }
      .stem-output-router button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }
      .stem-output-router__button-sentinel {
        display: none;
      }
      .stem-output-router__status {
        display: grid;
        gap: 8px;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      }
      .stem-output-router__badge,
      .stem-output-router__empty,
      .stem-output-router__device {
        background: var(--panel-bg, rgba(17, 24, 39, 0.72));
        border: 1px solid var(--border-color, #374151);
        border-radius: 8px;
      }
      .stem-output-router__badge {
        min-height: 58px;
        padding: 10px 12px;
      }
      .stem-output-router__badge strong {
        display: block;
        font-size: 13px;
        line-height: 1.25;
      }
      .stem-output-router__badge span {
        color: var(--muted-text-color, #9ca3af);
        display: block;
        font-size: 12px;
        line-height: 1.35;
        margin-top: 3px;
      }
      .stem-output-router__section {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .stem-output-router__list {
        display: grid;
        gap: 8px;
      }
      .stem-output-router__empty,
      .stem-output-router__device {
        padding: 12px;
      }
      .stem-output-router__device {
        display: grid;
        gap: 8px;
        grid-template-columns: minmax(0, 1fr) auto;
      }
      .stem-output-router__route {
        align-items: center;
        display: grid;
        gap: 10px;
        grid-template-columns: minmax(120px, 1fr) minmax(150px, 220px);
      }
      .stem-output-router__device-title {
        font-size: 14px;
        font-weight: 700;
        line-height: 1.3;
        overflow-wrap: anywhere;
      }
      .stem-output-router__route label {
        font-size: 14px;
        font-weight: 700;
        line-height: 1.3;
        overflow-wrap: anywhere;
      }
      .stem-output-router select {
        background: var(--button-bg, #1f2937);
        border: 1px solid var(--border-color, #374151);
        border-radius: 6px;
        color: inherit;
        font: inherit;
        font-size: 13px;
        min-height: 34px;
        padding: 6px 8px;
        width: 100%;
      }
      .stem-output-router__device-meta {
        color: var(--muted-text-color, #9ca3af);
        display: flex;
        flex-wrap: wrap;
        font-size: 12px;
        gap: 6px 10px;
      }
      .stem-output-router__note {
        background: rgba(234, 179, 8, 0.10);
        border: 1px solid rgba(234, 179, 8, 0.35);
        border-radius: 8px;
        color: #fde68a;
        font-size: 13px;
        line-height: 1.45;
        padding: 10px 12px;
      }
      .stem-output-router__pill {
        align-self: start;
        border: 1px solid var(--border-color, #374151);
        border-radius: 999px;
        color: var(--muted-text-color, #9ca3af);
        font-size: 12px;
        font-weight: 700;
        padding: 3px 8px;
        white-space: nowrap;
      }
      .stem-output-router__pill--selected {
        border-color: #22c55e;
        color: #86efac;
      }
      .stem-output-router-player {
        align-items: center;
        display: inline-flex;
        flex: 0 0 auto;
        bottom: 76px;
        margin: 0;
        position: fixed;
        right: 14px;
        z-index: 10001;
      }
      .stem-output-router-player__toggle {
        background: rgba(20, 184, 166, 0.18);
        border: 1px solid rgba(45, 212, 191, 0.35);
        border-radius: 6px;
        color: #99f6e4;
        cursor: pointer;
        font: inherit;
        font-size: 11px;
        line-height: 1.2;
        min-height: 28px;
        padding: 5px 8px;
        white-space: nowrap;
      }
      .stem-output-router-player__toggle:hover {
        background: rgba(20, 184, 166, 0.28);
      }
      .stem-output-router-player-panel {
        background: rgba(3, 7, 18, 0.98);
        border: 1px solid rgba(148, 163, 184, 0.35);
        border-radius: 8px;
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
        bottom: 116px;
        left: 12px;
        margin-left: auto;
        margin-right: auto;
        max-height: calc(100vh - 104px);
        max-width: 680px;
        min-width: 0;
        overflow: auto;
        padding: 12px;
        position: fixed;
        right: 12px;
        width: auto;
        z-index: 10000;
      }
      .stem-output-router-player-panel[data-open="false"] {
        display: none;
      }
      .stem-output-router-player-panel .stem-output-router {
        max-width: none;
      }
      .stem-output-router-player-panel .stem-output-router__status {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      @media (max-width: 640px) {
        .stem-output-router__header,
        .stem-output-router__device,
        .stem-output-router__route {
          grid-template-columns: 1fr;
        }
        .stem-output-router__header {
          flex-direction: column;
        }
        .stem-output-router__actions {
          justify-content: flex-start;
          width: 100%;
        }
        .stem-output-router-player-panel {
          bottom: 104px;
          left: 10px;
          right: 10px;
        }
        .stem-output-router-player {
          bottom: 66px;
          right: 10px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function truncateId(value) {
    if (!value) {
      return "unavailable";
    }
    if (value === "default" || value === "communications") {
      return value;
    }
    return value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
  }

  function normalizeOutput(device, source) {
    const id = String(device.deviceId || device.id || device.uid || device.name || "");
    const label = String(device.label || device.name || device.displayName || "");
    const groupId = String(device.groupId || device.group || "");
    const channels = Number(device.channels || device.channelCount || device.outputChannels || 0);
    return {
      id,
      label,
      groupId,
      channels: Number.isFinite(channels) && channels > 0 ? channels : 0,
      source,
      raw: device
    };
  }

  function mediaDevices() {
    return navigator.mediaDevices || null;
  }

  function updateCapabilities() {
    const devices = mediaDevices();
    state.capabilities.enumerateDevices = Boolean(devices && devices.enumerateDevices);
    state.capabilities.selectAudioOutput = Boolean(devices && devices.selectAudioOutput);
    state.capabilities.mediaElementSinkId = "setSinkId" in HTMLMediaElement.prototype;
    state.capabilities.audioContextSinkId = Boolean(window.AudioContext && "setSinkId" in AudioContext.prototype);
    state.capabilities.channelCounts = state.hostOutputs.some((output) => output.channels > 0);
  }

  function normalizeStem(stem) {
    const id = String(stem && stem.id ? stem.id : "");
    const gain = stem && stem.gain && typeof stem.gain.connect === "function" ? stem.gain : null;
    return {
      id,
      label: id || "stem",
      gain,
      context: gain ? gain.context : null,
      routed: state.routes[id] || MAIN_MIX_ROUTE
    };
  }

  function getStemApiState() {
    const api = window.stems;
    if (!api || typeof api.getState !== "function") {
      return [];
    }
    try {
      return api.getState();
    } catch (_error) {
      return [];
    }
  }

  function getHighwayApi() {
    return window.highway || window._slopsmithHighway || null;
  }

  function getSongTime() {
    const audio = document.getElementById("audio");
    if (audio && Number.isFinite(Number(audio.currentTime))) {
      return Math.max(0, Number(audio.currentTime));
    }
    const highway = getHighwayApi();
    if (highway && typeof highway.getCurrentTime === "function") {
      const time = Number(highway.getCurrentTime());
      return Number.isFinite(time) ? Math.max(0, time) : 0;
    }
    return 0;
  }

  function isSongPlaying() {
    const audio = document.getElementById("audio");
    if (audio && typeof audio.paused === "boolean") {
      return !audio.paused;
    }
    return false;
  }

  function getBeatGrid() {
    const highway = getHighwayApi();
    if (!highway || typeof highway.getBeats !== "function") {
      return [];
    }
    try {
      const beats = highway.getBeats();
      return Array.isArray(beats) ? beats : [];
    } catch (_error) {
      return [];
    }
  }

  function getRoutedMetronomeVolume() {
    return ROUTED_METRONOME_VOLUME;
  }

  function setStereoNode(node) {
    if (!node) {
      return node;
    }
    setDiscrete(node);
    try {
      node.channelCountMode = "explicit";
    } catch (_error) {
      // Some node implementations keep this read-only.
    }
    try {
      node.channelCount = 2;
    } catch (_error) {
      // Some node implementations keep this read-only.
    }
    return node;
  }

  function disposeMetronome() {
    if (!metronomeState) {
      return;
    }
    if (metronomeState.timer) {
      clearInterval(metronomeState.timer);
    }
    disconnectNode(metronomeState.output);
    metronomeState = null;
  }

  function createMetronomeStem(context) {
    if (!context) {
      return null;
    }
    if (metronomeState && metronomeState.context !== context) {
      disposeMetronome();
    }
    if (!metronomeState) {
      const output = setStereoNode(context.createGain());
      output.gain.value = 1;
      metronomeState = {
        context,
        output,
        timer: null,
        scheduledBeatKeys: new Set(),
        lastSongTime: -1
      };
      state.routes[METRONOME_ID] = state.routes[METRONOME_ID] || MUTE_ROUTE;
    }
    return {
      id: METRONOME_ID,
      label: "Slopsmith metronome",
      gain: metronomeState.output,
      context,
      routed: state.routes[METRONOME_ID] || MUTE_ROUTE,
      metronome: true
    };
  }

  function scheduleMetronomeClick(beat, when) {
    if (!metronomeState) {
      return;
    }
    const volume = getRoutedMetronomeVolume();
    if (volume <= 0) {
      return;
    }
    const context = metronomeState.context;
    const osc = context.createOscillator();
    const env = setDiscrete(context.createGain());
    const stereo = setStereoNode(context.createChannelMerger(2));
    const isMeasure = Number(beat.measure) >= 0;
    osc.frequency.value = isMeasure ? 1500 : 1000;
    osc.type = "sine";
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(volume, when + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
    osc.connect(env);
    env.connect(stereo, 0, 0);
    env.connect(stereo, 0, 1);
    stereo.connect(metronomeState.output);
    osc.start(when);
    osc.stop(when + 0.08);
    osc.onended = () => {
      disconnectNode(osc);
      disconnectNode(env);
      disconnectNode(stereo);
    };
  }

  function tickMetronomeScheduler() {
    if (!metronomeState || !isSongPlaying()) {
      return;
    }
    const beats = getBeatGrid();
    if (!beats.length) {
      return;
    }
    const context = metronomeState.context;
    const songTime = getSongTime();
    if (songTime < metronomeState.lastSongTime - 0.25) {
      metronomeState.scheduledBeatKeys.clear();
    }
    metronomeState.lastSongTime = songTime;

    const lookahead = 0.18;
    const start = songTime - 0.015;
    const end = songTime + lookahead;
    for (let i = 0; i < beats.length; i += 1) {
      const beat = beats[i];
      const beatTime = Number(beat.time);
      if (!Number.isFinite(beatTime) || beatTime < start || beatTime > end) {
        continue;
      }
      const key = `${i}:${beatTime.toFixed(3)}`;
      if (metronomeState.scheduledBeatKeys.has(key)) {
        continue;
      }
      metronomeState.scheduledBeatKeys.add(key);
      const when = context.currentTime + Math.max(0.005, beatTime - songTime);
      scheduleMetronomeClick(beat, when);
    }

    if (metronomeState.scheduledBeatKeys.size > 512) {
      metronomeState.scheduledBeatKeys = new Set(Array.from(metronomeState.scheduledBeatKeys).slice(-256));
    }
  }

  function ensureMetronomeScheduler() {
    if (!metronomeState || metronomeState.timer) {
      return;
    }
    metronomeState.timer = setInterval(tickMetronomeScheduler, 40);
  }

  function refreshStemState() {
    const realStems = getStemApiState()
      .map(normalizeStem)
      .filter((stem) => stem.id && stem.gain && stem.context);
    const contextStem = realStems.find((stem) => stem.context);
    const metronomeStem = createMetronomeStem(contextStem ? contextStem.context : null);
    state.stems = metronomeStem ? realStems.concat(metronomeStem) : realStems;
    if (metronomeStem) {
      ensureMetronomeScheduler();
    }
    const context = getRoutingContext();
    state.autoPlaybackChannels = detectPlaybackChannels(context);
    state.playbackChannels = state.manualChannels || state.autoPlaybackChannels;
    if (state.manualChannels && state.manualChannels > state.autoPlaybackChannels) {
      state.routingWarning = `Using manual ${state.manualChannels}-channel routing. Chromium reports ${state.autoPlaybackChannels || "unknown"} channels, so verify the Scarlett output meters before relying on this.`;
    } else if (state.playbackChannels < 3) {
      state.routingWarning = "Only stereo playback is exposed. Set the Scarlett as the system/default output and confirm the driver exposes a multichannel endpoint to Chromium.";
    } else {
      state.routingWarning = "";
    }
  }

  function getRoutingContext() {
    const routedStem = state.stems.find((stem) => stem.context);
    return routedStem ? routedStem.context : null;
  }

  function detectPlaybackChannels(context) {
    if (!context || !context.destination) {
      return 0;
    }
    const destination = context.destination;
    const max = Number(destination.maxChannelCount || 0);
    const current = Number(destination.channelCount || 0);
    const detected = Math.max(max, current, 2);
    return Number.isFinite(detected) && detected > 0 ? Math.floor(detected) : 0;
  }

  function routeOptions() {
    const options = [
      { value: MAIN_MIX_ROUTE, label: "Main mix / Playback 1/2" },
      { value: MUTE_ROUTE, label: "Mute test (zero gain)" }
    ];
    const channels = Math.max(0, state.playbackChannels);
    for (let channel = 1; channel <= channels; channel += 2) {
      const right = channel + 1;
      if (right <= channels) {
        options.push({ value: `${channel}-${right}`, label: `Playback ${channel}/${right} stereo` });
      }
    }
    for (let channel = 1; channel <= channels; channel += 1) {
      options.push({ value: `${channel}`, label: `Playback ${channel} mono` });
    }
    return options;
  }

  function parseRoute(route) {
    if (!route || route === MAIN_MIX_ROUTE || route === MUTE_ROUTE) {
      return null;
    }
    const parts = String(route).split("-").map((part) => Number(part));
    if (!parts.every((part) => Number.isInteger(part) && part > 0)) {
      return null;
    }
    return parts.map((part) => part - 1);
  }

  function setDestinationChannels(context, channels) {
    if (!context || !context.destination || channels <= 0) {
      return;
    }
    try {
      context.destination.channelInterpretation = "discrete";
    } catch (_error) {
      // Some destinations keep interpretation read-only.
    }
    try {
      context.destination.channelCountMode = "explicit";
    } catch (_error) {
      // Some AudioDestinationNode implementations keep this read-only.
    }
    try {
      context.destination.channelCount = channels;
    } catch (_error) {
      // Chromium throws if the selected output cannot expose this many channels.
    }
  }

  function setDiscrete(node) {
    if (!node) {
      return node;
    }
    try {
      node.channelInterpretation = "discrete";
    } catch (_error) {
      // Older node implementations may not allow changing this.
    }
    return node;
  }

  function disconnectNode(node) {
    try {
      node.disconnect();
    } catch (_error) {
      // Disconnect can throw when no connections exist.
    }
  }

  function getTestContext() {
    const routingContext = getRoutingContext();
    if (routingContext) {
      return routingContext;
    }
    if (!testToneContext) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) {
        return null;
      }
      testToneContext = new AC();
    }
    return testToneContext;
  }

  function playChannelTest(routeValue) {
    const route = parseRoute(routeValue);
    const context = getTestContext();
    if (!route || !context) {
      state.error = "No audio context is available for channel testing.";
      renderAll();
      return;
    }

    const channels = Math.max(state.playbackChannels || 0, ...route.map((index) => index + 1));
    setDestinationChannels(context, channels);
    try {
      if (context.state === "suspended" && typeof context.resume === "function") {
        context.resume().catch(() => {});
      }
    } catch (_error) {
      // Resume can fail outside a user gesture on some runtimes.
    }

    const osc = context.createOscillator();
    const gain = setDiscrete(context.createGain());
    const merger = setDiscrete(context.createChannelMerger(channels));
    osc.frequency.value = 880;
    gain.gain.value = 0.18;
    osc.connect(gain);
    route.forEach((channelIndex) => {
      gain.connect(merger, 0, channelIndex);
    });
    merger.connect(context.destination);
    osc.start();
    osc.stop(context.currentTime + 0.7);
    osc.onended = () => {
      disconnectNode(osc);
      disconnectNode(gain);
      disconnectNode(merger);
    };
  }

  function disposeRoutingGraph() {
    if (routingGraph) {
      for (const node of routingGraph.createdNodes) {
        disconnectNode(node);
      }
      routingGraph = null;
    }
  }

  function releaseRouting() {
    routingShouldResume = false;
    cancelDeferredApplyRouting();
    state.error = "Reload the song to restore the original Stems plugin master graph.";
    state.status = state.routingActive ? "Routing remains active" : "Routing released";
    renderAll();
  }

  function hardReleaseRoutingForReload() {
    disposeRoutingGraph();
    state.routingActive = false;
    routingShouldResume = false;
    cancelDeferredApplyRouting();
    state.status = "Routing released";
    state.error = "";
  }

  function applyRouting(options) {
    const applyOptions = options || {};
    refreshStemState();
    const context = getRoutingContext();
    const hasAssignedRoute = state.routingActive || state.stems.some((stem) => (
      state.routes[stem.id] === MUTE_ROUTE || parseRoute(state.routes[stem.id])
    ));
    const routedStems = state.stems.map((stem) => ({
      stem,
      mute: state.routes[stem.id] === MUTE_ROUTE,
      route: parseRoute(state.routes[stem.id]) || [0, 1]
    }));

    if (!context || !state.stems.length || !hasAssignedRoute) {
      state.error = "Load a stem-backed song with the Stems plugin active, then assign at least one stem to a playback channel pair.";
      state.status = "Routing unavailable";
      renderAll();
      return false;
    }

    disposeRoutingGraph();
    const channels = Math.max(state.playbackChannels, ...routedStems.flatMap((entry) => entry.route).map((index) => index + 1));
    setDestinationChannels(context, channels);

    const merger = setDiscrete(context.createChannelMerger(channels));
    const createdNodes = [merger];
    for (const entry of routedStems) {
      disconnectNode(entry.stem.gain);
      const splitter = setDiscrete(context.createChannelSplitter(2));
      createdNodes.push(splitter);
      if (entry.mute) {
        const muteGain = setDiscrete(context.createGain());
        muteGain.gain.value = 0;
        createdNodes.push(muteGain);
        entry.stem.gain.connect(muteGain);
        muteGain.connect(splitter);
      } else {
        entry.stem.gain.connect(splitter);
      }
      if (entry.route.length > 1) {
        splitter.connect(merger, 0, entry.route[0]);
        splitter.connect(merger, 1, entry.route[1]);
      } else {
        const leftFold = setDiscrete(context.createGain());
        const rightFold = setDiscrete(context.createGain());
        leftFold.gain.value = 0.5;
        rightFold.gain.value = 0.5;
        createdNodes.push(leftFold, rightFold);
        splitter.connect(leftFold, 0);
        splitter.connect(rightFold, 1);
        leftFold.connect(merger, 0, entry.route[0]);
        rightFold.connect(merger, 0, entry.route[0]);
      }
    }

    merger.connect(context.destination);
    routingGraph = { context, createdNodes };
    state.routingActive = true;
    if (!applyOptions.deferred) {
      routingShouldResume = true;
    }
    state.pendingChanges = false;
    state.status = applyOptions.deferred ? "Routing restored" : "Routing active";
    state.error = "";
    renderAll();
    return true;
  }

  function sameStemRefs(left, right) {
    if (!left || !right || left.length !== right.length) {
      return false;
    }
    for (let i = 0; i < left.length; i += 1) {
      if (left[i].id !== right[i].id || left[i].gain !== right[i].gain) {
        return false;
      }
    }
    return true;
  }

  function currentRealRoutableStems() {
    return state.stems.filter((stem) => stem.id !== METRONOME_ID && stem.gain && stem.context);
  }

  function tryDeferredApplyRouting(generation, attempt, previousStems, stableCount) {
    if (generation !== deferredApplyGeneration || !routingShouldResume) {
      return;
    }

    refreshStemState();
    const realStems = currentRealRoutableStems();
    const context = getRoutingContext();
    const hasReadyGraph = Boolean(context && realStems.length && state.playbackChannels >= 2);
    const nextStableCount = hasReadyGraph && sameStemRefs(previousStems, realStems) ? stableCount + 1 : 0;

    if (hasReadyGraph && nextStableCount >= 3) {
      applyRouting({ deferred: true });
      return;
    }

    if (attempt >= 30) {
      state.status = "Routing restore waiting";
      state.error = "Stems were not ready for automatic routing restore. Click Apply Routing after the song finishes loading.";
      renderAll();
      return;
    }

    setTimeout(() => {
      tryDeferredApplyRouting(generation, attempt + 1, realStems, nextStableCount);
    }, 200);
  }

  function scheduleDeferredApplyRouting() {
    if (!routingShouldResume) {
      return;
    }
    deferredApplyGeneration += 1;
    const generation = deferredApplyGeneration;
    setTimeout(() => {
      tryDeferredApplyRouting(generation, 0, null, 0);
    }, 250);
  }

  function cancelDeferredApplyRouting() {
    deferredApplyGeneration += 1;
  }

  function addSlopsmithListener(eventName, handler) {
    const slopsmith = window.slopsmith;
    if (!slopsmith || typeof slopsmith.on !== "function") {
      return false;
    }
    try {
      slopsmith.on(eventName, handler);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function installRoutingRestoreHooks() {
    if (!routingRestoreWindowHooksInstalled) {
      window.addEventListener("song:loading", cancelDeferredApplyRouting);
      window.addEventListener("song:unloaded", cancelDeferredApplyRouting);
      window.addEventListener("song:closed", cancelDeferredApplyRouting);
      window.addEventListener("song:loaded", scheduleDeferredApplyRouting);
      window.addEventListener("song:ready", scheduleDeferredApplyRouting);
      window.addEventListener("stems:ready", scheduleDeferredApplyRouting);
      routingRestoreWindowHooksInstalled = true;
    }

    if (!routingRestoreBusHooksInstalled) {
      const installedLoading = addSlopsmithListener("song:loading", cancelDeferredApplyRouting);
      const installedUnloaded = addSlopsmithListener("song:unloaded", cancelDeferredApplyRouting);
      const installedClosed = addSlopsmithListener("song:closed", cancelDeferredApplyRouting);
      const installedLoaded = addSlopsmithListener("song:loaded", scheduleDeferredApplyRouting);
      const installedReady = addSlopsmithListener("song:ready", scheduleDeferredApplyRouting);
      const installedStemsReady = addSlopsmithListener("stems:ready", scheduleDeferredApplyRouting);
      routingRestoreBusHooksInstalled = (
        installedLoading ||
        installedUnloaded ||
        installedClosed ||
        installedLoaded ||
        installedReady ||
        installedStemsReady
      );
    }

    if (!routingRestoreBusHooksInstalled && !routingRestoreBusHookRetryTimer && routingRestoreBusHookAttempts < 20) {
      routingRestoreBusHookAttempts += 1;
      routingRestoreBusHookRetryTimer = setTimeout(() => {
        routingRestoreBusHookRetryTimer = null;
        installRoutingRestoreHooks();
      }, 500);
    }
  }

  async function getBrowserOutputs() {
    const devices = mediaDevices();
    if (!devices || !devices.enumerateDevices) {
      return [];
    }
    const allDevices = await devices.enumerateDevices();
    return allDevices
      .filter((device) => device.kind === "audiooutput")
      .map((device) => normalizeOutput(device, "browser"));
  }

  async function callMaybe(api, methodNames) {
    for (const methodName of methodNames) {
      if (api && typeof api[methodName] === "function") {
        const result = await api[methodName]();
        if (Array.isArray(result)) {
          return result;
        }
        if (result && Array.isArray(result.outputs)) {
          return result.outputs;
        }
        if (result && Array.isArray(result.devices)) {
          return result.devices;
        }
        if (result && Array.isArray(result.channels)) {
          return result.channels;
        }
        return [];
      }
    }
    return null;
  }

  async function getHostOutputs() {
    const slopsmith = window.slopsmith || {};
    const candidates = [
      slopsmith.audio,
      slopsmith.audioSession,
      slopsmith.capabilities && slopsmith.capabilities.audio,
      slopsmith.nativeAudio
    ];
    const methods = [
      "listOutputChannels",
      "listOutputDevices",
      "getOutputChannels",
      "getOutputDevices"
    ];

    for (const api of candidates) {
      const outputs = await callMaybe(api, methods);
      if (outputs) {
        state.capabilities.hostOutputApi = true;
        return outputs.map((output) => normalizeOutput(output, "host"));
      }
    }

    state.capabilities.hostOutputApi = false;
    return [];
  }

  async function refresh() {
    state.busy = true;
    state.error = "";
    state.status = "Scanning outputs";
    renderAll();

    try {
      const browserOutputs = await getBrowserOutputs();
      const hostOutputs = await getHostOutputs();
      state.browserOutputs = browserOutputs;
      state.hostOutputs = hostOutputs;
      refreshStemState();
      updateCapabilities();
      state.status = "Ready";
    } catch (error) {
      state.error = error && error.message ? error.message : String(error);
      state.status = "Scan failed";
      updateCapabilities();
    } finally {
      state.busy = false;
      renderAll();
    }
  }

  async function requestLabels() {
    const devices = mediaDevices();
    if (!devices || !devices.getUserMedia) {
      state.error = "Microphone permission is unavailable in this browser context.";
      renderAll();
      return;
    }

    state.busy = true;
    state.status = "Requesting labels";
    state.error = "";
    renderAll();

    try {
      const stream = await devices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      await refresh();
    } catch (error) {
      state.error = error && error.message ? error.message : String(error);
      state.status = "Label request failed";
      state.busy = false;
      renderAll();
    }
  }

  async function chooseOutput() {
    const devices = mediaDevices();
    if (!devices || !devices.selectAudioOutput) {
      state.error = "selectAudioOutput is not available in this browser.";
      renderAll();
      return;
    }

    state.busy = true;
    state.status = "Choosing output";
    state.error = "";
    renderAll();

    try {
      const output = await devices.selectAudioOutput();
      const normalized = normalizeOutput(output, "browser");
      state.selectedOutputId = normalized.id;
      safeStorageSet(STORAGE_KEY, state.selectedOutputId);
      await refresh();
    } catch (error) {
      state.error = error && error.message ? error.message : String(error);
      state.status = "Output chooser closed";
      state.busy = false;
      renderAll();
    }
  }

  function makeBadge(title, value) {
    const badge = document.createElement("div");
    badge.className = "stem-output-router__badge";
    const strong = document.createElement("strong");
    strong.textContent = title;
    const span = document.createElement("span");
    span.textContent = value;
    badge.append(strong, span);
    return badge;
  }

  function renderStatus(root) {
    const status = root.querySelector("[data-stem-output-router-status]");
    if (!status) {
      return;
    }
    status.replaceChildren(
      makeBadge("Routable sources", state.stems.length ? `${state.stems.length} active` : "No active sources"),
      makeBadge("Playback channels", state.manualChannels ? `${state.playbackChannels} forced` : (state.playbackChannels ? `${state.playbackChannels} exposed` : "Unknown")),
      makeBadge("Routing", state.pendingChanges ? "Changes pending" : (state.routingActive ? "Active" : "Released")),
      makeBadge("Browser outputs", state.capabilities.enumerateDevices ? `${state.browserOutputs.length} detected` : "Not supported"),
      makeBadge("Output chooser", state.capabilities.selectAudioOutput ? "Available" : "Unavailable")
    );
  }

  function renderDevice(output) {
    const item = document.createElement("div");
    item.className = "stem-output-router__device";

    const body = document.createElement("div");
    const title = document.createElement("div");
    title.className = "stem-output-router__device-title";
    title.textContent = output.label || "Unlabeled audio output";

    const meta = document.createElement("div");
    meta.className = "stem-output-router__device-meta";
    const id = document.createElement("span");
    id.textContent = `id: ${truncateId(output.id)}`;
    const group = document.createElement("span");
    group.textContent = `group: ${truncateId(output.groupId)}`;
    const channels = document.createElement("span");
    channels.textContent = output.channels ? `channels: ${output.channels}` : "channels: unavailable";
    meta.append(id, group, channels);
    body.append(title, meta);

    const pill = document.createElement("div");
    const isSelected = output.id && output.id === state.selectedOutputId;
    pill.className = `stem-output-router__pill${isSelected ? " stem-output-router__pill--selected" : ""}`;
    pill.textContent = isSelected ? "Selected" : output.source;
    item.append(body, pill);
    return item;
  }

  function renderList(root, selector, outputs, emptyText) {
    const list = root.querySelector(selector);
    if (!list) {
      return;
    }
    if (!outputs.length) {
      const empty = document.createElement("div");
      empty.className = "stem-output-router__empty stem-output-router__muted";
      empty.textContent = emptyText;
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...outputs.map(renderDevice));
  }

  function renderChannels(root) {
    const list = root.querySelector("[data-stem-output-router-channel-list]");
    if (!list) {
      return;
    }

    const children = [];
    const overrideRow = document.createElement("div");
    overrideRow.className = "stem-output-router__device stem-output-router__route";
    const overrideLabel = document.createElement("label");
    const overrideId = `${PLUGIN_ID}-manual-channels`;
    overrideLabel.setAttribute("for", overrideId);
    overrideLabel.textContent = "Channel mode";
    const overrideSelect = document.createElement("select");
    overrideSelect.id = overrideId;
    overrideSelect.dataset.channelOverride = "true";
    [
      { value: "0", label: `Auto (${state.autoPlaybackChannels || "unknown"})` },
      { value: "2", label: "Force 2 channels" },
      { value: "4", label: "Force 4 channels" },
      { value: "6", label: "Force 6 channels" },
      { value: "8", label: "Force 8 channels" },
      { value: "10", label: "Force 10 channels" },
      { value: "12", label: "Force 12 channels" },
      { value: "16", label: "Force 16 channels" }
    ].forEach((option) => {
      const opt = document.createElement("option");
      opt.value = option.value;
      opt.textContent = option.label;
      overrideSelect.appendChild(opt);
    });
    overrideSelect.value = String(state.manualChannels || 0);
    overrideRow.append(overrideLabel, overrideSelect);
    children.push(overrideRow);

    if (state.routingWarning) {
      const warning = document.createElement("div");
      warning.className = "stem-output-router__note";
      warning.textContent = state.routingWarning;
      children.push(warning);
    }

    const testNote = document.createElement("div");
    testNote.className = "stem-output-router__note";
    testNote.textContent = "Use Test on Playback 3/4 before routing stems. If Focusrite Control does not show the tone on 3/4, this Slopsmith audio runtime cannot reach those hardware channels.";
    children.push(testNote);

    const options = routeOptions().filter((option) => option.value !== MAIN_MIX_ROUTE);
    if (!options.length) {
      const empty = document.createElement("div");
      empty.className = "stem-output-router__empty stem-output-router__muted";
      empty.textContent = "No playback channels are available yet. Load a stem-backed song with the Stems plugin active.";
      children.push(empty);
    } else {
      children.push(...options.map((option) => {
        const item = document.createElement("div");
        item.className = "stem-output-router__device";
        const body = document.createElement("div");
        const title = document.createElement("div");
        title.className = "stem-output-router__device-title";
        title.textContent = option.label;
        const meta = document.createElement("div");
        meta.className = "stem-output-router__device-meta";
        meta.textContent = "Routed through the active Web Audio output destination.";
        body.append(title, meta);
        const testButton = document.createElement("button");
        testButton.type = "button";
        testButton.dataset.action = "test-channel";
        testButton.dataset.testRoute = option.value;
        testButton.textContent = "Test";
        item.append(body, testButton);
        return item;
      }));
    }

    list.replaceChildren(...children);
  }

  function renderRoutes(root) {
    const list = root.querySelector("[data-stem-output-router-route-list]");
    if (!list) {
      return;
    }

    if (!state.stems.length) {
      const empty = document.createElement("div");
      empty.className = "stem-output-router__empty stem-output-router__muted";
      empty.textContent = "Load a .sloppak song and activate the Stems plugin to route vocals, guitars, bass, drums, piano, other, or the Slopsmith metronome.";
      list.replaceChildren(empty);
      return;
    }

    const options = routeOptions();
    const rows = state.stems.map((stem) => {
      const row = document.createElement("div");
      row.className = "stem-output-router__device stem-output-router__route";

      const label = document.createElement("label");
      const selectId = `${PLUGIN_ID}-${stem.id.replace(/[^a-z0-9_-]/gi, "-")}`;
      label.setAttribute("for", selectId);
      label.textContent = stem.label;

      const select = document.createElement("select");
      select.id = selectId;
      select.dataset.routeStemId = stem.id;
      for (const option of options) {
        const opt = document.createElement("option");
        opt.value = option.value;
        opt.textContent = option.label;
        select.appendChild(opt);
      }
      select.value = state.routes[stem.id] || MAIN_MIX_ROUTE;
      row.append(label, select);
      return row;
    });

    const note = document.createElement("div");
    note.className = "stem-output-router__note";
    note.textContent = "Apply Routing sends active stems plus the Slopsmith metronome through this plugin's channel graph. The routed metronome source uses full volume. Mute test uses a silent gain path. Reload the song to fully restore the Stems plugin graph.";
    list.replaceChildren(note, ...rows);
  }

  function renderRoot(root) {
    const summary = root.querySelector("[data-stem-output-router-summary]");
    if (summary) {
      const stemCount = state.stems.length;
      const channelCount = state.playbackChannels || 0;
      const suffix = state.error ? `: ${state.error}` : "";
      summary.textContent = `${state.status}. Stems ${stemCount}, playback channels ${channelCount}, auto ${state.autoPlaybackChannels || "unknown"}${suffix}`;
    }

    const refreshButton = root.querySelector('[data-action="refresh"]');
    const labelsButton = root.querySelector('[data-action="request-labels"]');
    const chooseButton = root.querySelector('[data-action="choose-output"]');
    const applyButton = root.querySelector('[data-action="apply-routing"]');
    const releaseButton = root.querySelector('[data-action="release-routing"]');
    if (refreshButton) {
      refreshButton.disabled = state.busy;
    }
    if (labelsButton) {
      labelsButton.disabled = state.busy || !mediaDevices() || !mediaDevices().getUserMedia;
    }
    if (chooseButton) {
      chooseButton.disabled = state.busy || !mediaDevices() || !mediaDevices().selectAudioOutput;
    }
    if (applyButton) {
      applyButton.disabled = state.busy || !state.stems.length || state.playbackChannels < 2;
    }
    if (releaseButton) {
      releaseButton.disabled = state.busy || !state.routingActive;
    }

    renderStatus(root);
    renderRoutes(root);
    renderChannels(root);
    renderList(
      root,
      "[data-stem-output-router-browser-list]",
      state.browserOutputs,
      state.capabilities.enumerateDevices ? "No browser audio outputs were reported." : "Browser device enumeration is unavailable."
    );
  }

  function renderAll() {
    document.querySelectorAll(ROOT_SELECTOR).forEach(renderRoot);
  }

  function bindRoot(root) {
    if (root.dataset.stemOutputRouterBound === "true") {
      return;
    }
    root.dataset.stemOutputRouterBound = "true";
    root.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
      if (!target) {
        return;
      }
      const action = target.getAttribute("data-action");
      if (action === "refresh") {
        refresh();
      } else if (action === "request-labels") {
        requestLabels();
      } else if (action === "choose-output") {
        chooseOutput();
      } else if (action === "apply-routing") {
        applyRouting();
      } else if (action === "release-routing") {
        releaseRouting();
      } else if (action === "test-channel") {
        playChannelTest(target.getAttribute("data-test-route") || "");
      }
    });
    root.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLSelectElement)) {
        return;
      }
      if (target.dataset.channelOverride === "true") {
        const channels = Number(target.value);
        saveManualChannels(Number.isInteger(channels) && channels >= 0 ? channels : 0);
        refreshStemState();
        state.pendingChanges = state.routingActive;
        renderAll();
        return;
      }
      if (!target.dataset.routeStemId) {
        return;
      }
      state.routes[target.dataset.routeStemId] = target.value;
      saveRouteMap();
      state.pendingChanges = state.routingActive;
      renderAll();
    });
    renderRoot(root);
  }

  function createPlayerRouterControl() {
    const host = document.createElement("div");
    host.id = PLAYER_CONTROL_ID;
    host.className = "stem-output-router-player";
    host.dataset.open = "false";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "stem-output-router-player__toggle";
    toggle.textContent = "Routes";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", `${PLAYER_CONTROL_ID}-panel`);

    toggle.addEventListener("click", () => {
      const nextOpen = host.dataset.open !== "true";
      const panel = document.getElementById(`${PLAYER_CONTROL_ID}-panel`);
      host.dataset.open = nextOpen ? "true" : "false";
      if (panel) {
        panel.dataset.open = nextOpen ? "true" : "false";
      }
      toggle.setAttribute("aria-expanded", nextOpen ? "true" : "false");
      if (nextOpen) {
        refresh();
      }
    });

    host.appendChild(toggle);
    return host;
  }

  function createPlayerRouterPanel() {
    const panel = document.createElement("div");
    panel.id = `${PLAYER_CONTROL_ID}-panel`;
    panel.className = "stem-output-router-player-panel";
    panel.dataset.open = "false";

    const root = document.createElement("section");
    root.className = "stem-output-router";
    root.setAttribute("data-stem-output-router-root", "");
    root.innerHTML = `
      <header class="stem-output-router__header">
        <div>
          <h2>Stem Routes</h2>
          <p data-stem-output-router-summary>Scanning stems...</p>
        </div>
        <div class="stem-output-router__actions">
          <button type="button" data-action="apply-routing">Apply Routing</button>
          <button type="button" data-action="refresh">Refresh</button>
          <span class="stem-output-router__button-sentinel" aria-hidden="true"></span>
        </div>
      </header>
      <div class="stem-output-router__status" data-stem-output-router-status></div>
      <div class="stem-output-router__section">
        <h3>Stem Routes</h3>
        <div class="stem-output-router__list" data-stem-output-router-route-list></div>
      </div>
      <div class="stem-output-router__section">
        <h3>Playback Channels</h3>
        <div class="stem-output-router__list" data-stem-output-router-channel-list></div>
      </div>
    `;

    panel.appendChild(root);
    return panel;
  }

  function mountPlayerRouterPanel() {
    if (!document.body || document.getElementById(`${PLAYER_CONTROL_ID}-panel`)) {
      return;
    }
    document.body.appendChild(createPlayerRouterPanel());
  }

  function mountPlayerRouterControl() {
    if (document.getElementById(PLAYER_CONTROL_ID)) {
      return;
    }
    if (!document.body) {
      return;
    }
    const host = createPlayerRouterControl();
    document.body.appendChild(host);
  }

  function mountExistingRoots() {
    installStyle();
    installRoutingRestoreHooks();
    mountPlayerRouterPanel();
    mountPlayerRouterControl();
    document.querySelectorAll(ROOT_SELECTOR).forEach(bindRoot);
  }

  function startObserver() {
    const observer = new MutationObserver(() => {
      mountExistingRoots();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function boot() {
    mountExistingRoots();
    startObserver();
    updateCapabilities();
    renderAll();
  }

  window.slopsmithStemOutputRouter = {
    __loaded: true,
    refresh,
    applyRouting,
    releaseRouting,
    getState() {
      return {
        browserOutputs: state.browserOutputs,
        hostOutputs: state.hostOutputs,
        stems: state.stems.map((stem) => ({
          id: stem.id,
          label: stem.label,
          routed: state.routes[stem.id] || MAIN_MIX_ROUTE
        })),
        routes: Object.assign({}, state.routes),
        manualChannels: state.manualChannels,
        autoPlaybackChannels: state.autoPlaybackChannels,
        playbackChannels: state.playbackChannels,
        routingActive: state.routingActive,
        pendingChanges: state.pendingChanges,
        routingWarning: state.routingWarning,
        capabilities: Object.assign({}, state.capabilities),
        selectedOutputId: state.selectedOutputId,
        busy: state.busy,
        status: state.status,
        error: state.error
      };
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
