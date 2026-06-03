# Stem Output Router

Slopsmith plugin groundwork for routing individual stems and future stem submixes to different audio outputs.

This pass enumerates:

- Browser audio output devices from `navigator.mediaDevices.enumerateDevices()`
- Browser output chooser support through `navigator.mediaDevices.selectAudioOutput()`
- Browser media-element routing support through `HTMLMediaElement.setSinkId()`
- Slopsmith/native output APIs if the host exposes a compatible list method
- Active stem gain nodes from the Stems plugin via `window.stems.getState()`
- Playback channel pairs and mono channels exposed by the active Web Audio output destination
- A full-volume `metronome` source generated from Slopsmith's beat grid

When the Stems plugin is active on a stem-backed `.sloppak`, this plugin can detach selected stem gain nodes from the normal Stems master mix and route them through a `ChannelMergerNode` to stereo playback pairs such as 1/2, 3/4, 5/6, and 7/8, or to mono playback channels such as 1, 2, 3, and 4.

The Slopsmith metronome source defaults to muted, emits a two-channel signal before channel routing, and uses full volume for this plugin's routed click. Route it to a playback pair or mono channel and click **Apply Routing** to hear click pulses on song beats.

The plugin also adds a compact **Routes** control to Slopsmith's player controls so routes can be edited while a song is playing.

Browser device APIs expose output devices, not reliable physical channel counts. Multichannel routing only works when the current browser/Electron audio destination exposes the Focusrite Scarlett as a multichannel endpoint. If only stereo is exposed, configure the Scarlett as the system/default output and check the Focusrite driver/control panel.

If Chromium reports only stereo even when the Scarlett is the default Windows output, use **Channel mode** in the plugin panel to force 4/6/8-channel routing as a hardware test. If the Scarlett meters still only show 1/2, Slopsmith's browser runtime is being given a stereo endpoint and true channel routing will need a native/ASIO-capable audio backend or a Stems plugin routing hook.

Releasing routing disconnects this plugin's routing graph. Because the current Stems plugin does not expose its master bus, reload the song to fully restore the original Stems plugin graph after applying routes.

## Files

- `plugin.json` registers the plugin script and settings/screen HTML.
- `settings.html` provides the plugin panel root.
- `screen.js` enumerates outputs, detects active stems, and applies stereo-pair or mono-channel routing.
