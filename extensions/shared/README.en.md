# CocosMCP · Creator {{major}}

Free, open-source AI tooling for Cocos Creator. Connect an MCP client to the editor, project assets and development runtime through a local bridge.

- **Author:** iefoam@foxmail.com
- **License:** MIT
- **Package version:** {{version}}
- **Build:** {{buildId}}
- **Package built at (UTC):** {{builtAt}}

## Capabilities

- Inspect and edit scenes, nodes, components and prefabs through supported operations.
- Query project assets; preview resource organization plans before applying changes.
- Inspect bridge logs, connection state and available capabilities in the dockable control center.
- Connect development runtimes for supported inspection, debugging and preview workflows.
- Use stdio or authenticated Streamable HTTP with compatible MCP clients.

## Features by exact Creator version

Documentation baseline: 2026-09-18. This package is for **Creator {{major}}**; the other column does not grant cross-version support.

| Area | Creator 2.4.15 | Creator 3.8.8 |
| --- | --- | --- |
| Editor/assets | Scene/node/component/Prefab edits, AssetDB, directory organization, dependencies and undo | Core editing and assets, plus native console and version-matched editor messages |
| UI/preview | Declarative UI, structural plans, reference guards, five control adapters with native input tests, managed preview/logs | Declarative UI, layout/event checks, managed preview/logs and mouse/keyboard/touch input |
| Animation/physics | curveData, bounded Tweens, Spine/DragonBones cache/event/mixing adapters, Tilemap, collisions, forces/joints and Box contacts | Native tracks, Spine/Tilemap/physics tools and separate animation-graph/IK/CCT adapters |
| Rendering/resources | Camera coordinates, 2D pixel sampling, owned GPU cleanup, material overrides, resource snapshots/trends | Effect compilation/variants, RenderTexture Shader previews, geometry, sorting, probes and resource handles |
| Gameplay/builds | 2.x templates remain pending; recorded game-build environment failures | 13 editable templates with partial gameplay acceptance; CLI jobs and artifact inspection |

Native acceptance is fixture-specific. The 2.4.15 line has up to 112 editor and 99 runtime endpoints; these are not all-native-verified counts or the default tool-list length. Additional joints, Prefab repair, font/atlas quality, loading traces, single stepping and other work remain pending. The 3.8.8 post-processing and skinning paths also retain limitations. Neither line claims all platforms or all engine functionality.

## Getting started

1. Install the extension into your Creator project and enable it in Extension Manager.
2. Open **CocosMCP → 打开控制中心 (Open Control Center)**. Menu order: **About CocosMCP → Open Control Center → Check for Updates**, with dedicated about/update views. Bridge start/stop controls are inside the control center. English and Simplified Chinese are supported.
3. Make Node.js 24 or later available. When installing from source, use the CocosMCP installer to record the Node.js executable path.
4. Start the bridge and MCP service, then configure your MCP client using the connection settings shown in the control center.
5. Inspect available capabilities before requesting changes. Reload the extension after an update and restart the MCP service.

## Compatibility and platforms

This package targets **Creator {{major}}.x**. Operation support varies by editor version; a declared version range does not mean every feature has been tested on every version.

Local native-editor records cover **macOS / Apple Silicon with Creator 2.4.15 and 3.8.8**, using separate test projects and feature scopes. Windows, Intel macOS and other Creator versions require separate validation. Linux CI builds and automated tests do not establish native Creator compatibility. Game export targets are separate from the editor host platform.

Creator 3.8.8's local extension scanner reads author, version, editor range, `logo.png` and the README matching the editor language. It does not supply **Release Date** or **Support Platforms** to the manager header; those fields may remain “-” for a locally installed package. The timestamp above is a package build time, not a Cocos Store publication date.

## Links and feedback

- [Source and full installation guide](https://github.com/iEfoam/CocosMcp)
- [Version support and acceptance boundaries](https://github.com/iEfoam/CocosMcp/blob/main/docs/version-support.md)
- [Feature documentation](https://github.com/iEfoam/CocosMcp/blob/main/docs/feature-reference.md)
- [Report an issue](https://github.com/iEfoam/CocosMcp/issues)
- Contact: **iefoam@foxmail.com**

CocosMCP is MIT-licensed and has no CocosMCP account or tool-call quota. Your AI client's own terms and usage limits still apply. Development bridge verification does not imply production, device or GPU acceptance.
