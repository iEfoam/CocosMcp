<p align="center">
  <img src="docs/assets/readme-hero.svg" alt="CocosMCP — Connect AI to Cocos Creator" width="100%">
</p>

<h1 align="center">CocosMCP</h1>

<p align="center">
  A free, MIT-licensed MCP implementation for Cocos Creator 2.x and 3.x.<br>
  Connect AI clients to your editor, project assets, and development runtime.
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#supported-features-by-creator-version">Version support</a> ·
  <a href="#mcp-feature-overview">Features</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="#verification-and-safety">Verification &amp; safety</a>
</p>

<p align="center">
  <img src="docs/assets/codex.svg" width="20" height="20" alt="Code icon">
  <strong>Implemented entirely with Codex.</strong><br>
  All first-party code in this project is implemented using Codex. Third-party software and dependencies retain their own authorship and licenses.
</p>

---

## Why CocosMCP?

Work with scenes, nodes, components, assets, and runtime objects through structured MCP tools. CocosMCP runs locally, requires no CocosMCP account, and imposes no tool-call quotas. Your AI client's own requirements and limits still apply.

The repository includes separate Creator 2.x and 3.x extensions, a standalone MCP service, a capability catalog, and a development runtime bridge. Registered operations span **54 functional modules**; registration, implementation, and verification are reported separately, so coverage is not a claim that every feature is complete.

See the [Creator 2.4.15 implementation and acceptance record](docs/creator2-implementation.md) (Chinese) for the independent test project, native coverage, and remaining limitations.

## MCP feature overview

A compact overview of implemented MCP entry points. Exact version support, prerequisites, and verification levels are documented in the version table below and the [feature reference](docs/feature-reference.md).

| Editor & assets | Runtime & interaction | Workflows & diagnostics |
| --- | --- | --- |
| **Scenes**<br>Create, open, save, inspect hierarchy | **Object inspection**<br>Hierarchy, properties, object handles | **Projects & instances**<br>Projects, editors, runtime sessions |
| **Nodes**<br>Create, duplicate, reparent, delete, transform | **Runtime controls**<br>Pause, resume, inspect state | **Capability discovery**<br>Search, schemas, versions, coverage |
| **Components**<br>Find types, add, configure, reset | **Controls & input**<br>Control actions, mouse, keyboard, touch | **Workflow orchestration**<br>Validate plans, sequence steps, bind results |
| **Asset operations**<br>Query, import, save, move, resolve UUIDs | **Animation & actions**<br>Playback, track sampling, Tweens (2.x) | **Preview & captures**<br>Start/stop, screenshots, viewport checks |
| **Asset organization**<br>Locate folders, preview plans, apply moves | **Skeleton animation**<br>Spine playback/skins, DragonBones (2.x) | **Logs & diagnostics**<br>Bridge, preview, native console (3.x) |
| **Prefabs**<br>Create, instantiate, apply, revert | **Maps & physics**<br>Read/edit tiles, raycasts, contact queries | **Performance sampling**<br>Frame times, P99, budgets, render metrics |
| **UI composition**<br>Declarative creation, updates, layout/events | **Cameras & rendering**<br>Coordinate conversion, visibility, diagnostics | **Build jobs**<br>Start, status, logs, list, cancel |
| **Materials & Shaders**<br>Properties, macros, backups, native compile (3.x) | **Media & particles**<br>Audio/video playback, basic particle controls | **Artifact checks**<br>Build files, sizes, content hashes |
| **Clips & templates**<br>Edit clips/keyframes, component templates (3.x) | **Runtime assets**<br>Load, preload, release references, inspect Bundles | **Recovery queries**<br>Operation results, workflow progress, build records |
| **Scene & reference checks**<br>Snapshot diffs, missing components, dependencies | **Events & tasks**<br>Subscriptions, bounded sampling, poll/cancel tasks | **Visual & layout checks**<br>UI geometry, bounds, Shader preview comparisons |

Find entry points with `cocos_capability_search` / `cocos_capability_describe`, then call them through `cocos_capability_execute`. Workflows and builds also provide dedicated MCP tools.

## Supported features by Creator version

The exact adaptation baselines are **Creator 2.4.15** and **Creator 3.8.8**. This table describes implemented scope. Native evidence covers specific fixtures and parameters; it does not certify every feature, platform, or the entire engine. Other 2.x / 3.x versions do not inherit this support automatically.

| Feature | Creator 2.4.15 | Creator 3.8.8 |
| --- | --- | --- |
| Editor & assets | Scenes, nodes, components, Prefabs, undo/redo, AssetDB, organization, dependencies/users | Comparable core editing, plus native console queries and version-matched editor messages |
| UI & references | Declarative creation/updates, structural plans, scene/saved-file reference audits and deletion guards | Declarative creation/updates and layout/event checks; 2.x-specific structural/audit endpoints are not shared automatically |
| Controls & preview | Five semantic control adapters with real drag/click/text event tests; windows, captures, logs and sizing | Windows, captures, logs, mouse/keyboard/touch and viewport checks; native menu interaction records |
| Animation & actions | curveData editing/recovery; bounded sequential/parallel/repeated Tweens with cancellation and lifecycle checks | Native tracks, animation controls and animation-graph inspection; excludes 2.x-specific Tween task endpoints |
| Skeletons | Spine/DragonBones structure, cache boundaries, event tasks, real-time mixing and cleanup with native records | Spine playback/queues/skins/attachments and track sampling; does not inherit the 2.x cache/event/mixing evidence |
| Maps & physics | Orthogonal/isometric Tilemaps, ordinary collisions, body forces, joint inspection and Box contact tracing/cleanup | Tilemap and physics query/contact tools, subject to backend checks; separate native 3D CCT route records |
| Camera & rendering | 2D/3D coordinates, masks, 2D Graphics/Mask offscreen pixels and owned GPU-object deletion | Geometry/arrays/render settings, Shader RenderTexture previews, debug drawing, sorting, probes and IK |
| Shaders & materials | Effect source/backups, material properties/macros and runtime override recovery; no 3.x compiler | Native Effect compilation, dependency fingerprints, material instances, macro variants and preview comparisons |
| Resource lifecycle | Load/release, Bundle inspection, snapshots/diffs and multi-scene trends | Load/release and Bundle inspection; the 2.x snapshot/trend endpoints are not declared for 3.x |
| Gameplay templates | 2.x templates are not delivered yet | 13 editable templates, including controllers, cameras, virtual lists, dialogue and pools; not all gameplay paths accepted |
| Media & diagnostics | Basic audio/video/particle controls and UI/Label/atlas/Graphics diagnostics | Media, particles and performance/render diagnostics; platform experience and GPU performance need separate evidence |
| Workflows & builds | Local workflows and CLI jobs; recorded game-build environment failures remain | Local workflows, CLI jobs and artifact checks; signing, devices, SDKs and publication require separate acceptance |

As of 2026-09-18, 2.4.15 explicitly wires up to **112 editor + 99 runtime endpoints**; the catalog contains **246 entries applicable to major version 3**. These are wiring/catalog counts, not current availability, native pass counts, or the default MCP tool-list length. The latest code regression passed **249 tests**. This expansion was accepted in an independent 2.4.15 project and has not been synced to Texas.

**Still incomplete:** additional 2.4.15 joints, Prefab differences/repair, image/font/atlas quality workflows, loading traces, TMX persistence, 2.x templates, material pipeline controls, focus/grid, single stepping/Scheduler, and other tracked work. The 2.4.15 game build still has recorded `exportSimpleProject` and FBX converter failures; building the plugin does not prove game export succeeds. The 3.8.8 post-processing and skinning paths also retain explicit limitations.

See the [version support matrix](docs/version-support.md), [2.4.15 adaptation record](docs/creator2-implementation.md), and [full acceptance tracker](docs/creator2-expansion-tracker.md) for details and evidence (Chinese).

## Capabilities

- **Local MCP transports:** stdio and authenticated Streamable HTTP.
- **Dockable control center:** project and editor instance information, capabilities, bridge logs, runtime state, and bridge start/stop controls. The panel supports Simplified Chinese and English, defaults to Chinese, and saves the preference per project. Logs retain their original text and support copying errors.
- **Inspectable changes:** `scene.snapshot` and `scene.diff` provide baselines and recursive `added`, `removed`, and `changed` path records for nodes, components, properties, and arrays.
- **Recoverable status:** workflow status and build-job indexes persist under the target project's `.codex-work/cache/cocos-mcp/`. A build still running at service restart is marked as failed with unknown state instead of permanently blocking the project.
- **Operation tracking:** explicit `operationId` values support in-process idempotent reuse; query completed results with `cocos_operation_query`. Audit logs record operation metadata only.
- **Source discovery:** generate editor-message/type candidates from Creator source or ASAR, or an `engine-capabilities.json` catalog from engine source. Candidates remain `source-only` until separately verified.

Version support is operation-specific. Inspect `creator2Operations`, `creator3Operations`, and each capability's verification evidence before use; unsupported versions are rejected before execution. See the [feature reference](docs/feature-reference.md) and [Shader guide](docs/shader-development.md).

## Quick start

### 1. Install and build

Use **Node.js 24+**, **pnpm 11** (the repository pins the exact version in `package.json`), and an existing Cocos Creator project.

```bash
pnpm install
pnpm check
```

`pnpm check` runs type checking → build → tests → build; the final build embeds matching test evidence. Project configuration keeps build and test output under `.codex-work/`.

### 2. Install the editor extension

Use your own project and editor paths. This example targets Creator 3.8.8 on macOS:

```bash
pnpm start install \
  --project /path/to/my-cocos-project \
  --creator /Applications/Cocos/Creator/3.8.8/CocosCreator.app
```

| Editor | Extension location in the target project |
| --- | --- |
| Creator 2.x | `packages/cocos-mcp-creator2/` |
| Creator 3.x | `extensions/cocos-mcp-creator3/` |

The installer backs up an existing extension of the same name. Open the project in Creator, load the extension, and use **CocosMCP → Open Control Center** (打开控制中心). The menu order is **About CocosMCP → Open Control Center → Check for Updates**. About and updates have dedicated views; bridge start/stop controls live inside the control center. The MCP service discovers protected instance descriptors and routes requests by project, editor version, and instance ID.

### 3. Check the connection and start MCP

```bash
# Inspect the environment, editor instances, and module coverage.
pnpm start doctor --project /path/to/my-cocos-project

# Start stdio transport for an MCP client.
pnpm start serve --project /path/to/my-cocos-project

# Or start local Streamable HTTP on an automatically assigned port.
pnpm start serve --project /path/to/my-cocos-project --transport http --port 0
```

HTTP binds only to `127.0.0.1`, requires a Bearer token, and rejects non-local Host/Origin values. The token is stored in the target project's `.codex-work/cache/cocos-mcp/mcp-http-token`.

For client configuration and troubleshooting, see the [user guide](docs/user-guide.md) (Chinese).

## Plan a workflow

Pass a sequence like this to `cocos_workflow_plan`, replacing the scene URL with an existing scene in your project (`.scene` for Creator 3, `.fire` for Creator 2):

```json
{
  "projectId": "<project-id>",
  "steps": [
    { "capabilityId": "scene.open", "params": { "uuid": "db://assets/main.scene" } },
    { "capabilityId": "node.create", "params": { "name": "LoginPanel" } },
    { "capabilityId": "scene.save", "params": {} }
  ]
}
```

Planning checks parameters, versions, risks, and side effects. Use `cocos_workflow_execute` after the plan is valid and any required authorization is in place. Execution stops on failure by default and returns completed steps and compensation hints. There is no universal rollback: use each capability's `rollback` guidance. Query persisted progress with `cocos_workflow_status` after a service restart.

Steps support `paramRefs` for earlier results, `runtimeRef` for explicit preview session binding, and read-only `waitFor` conditions. Workflow IDs cannot be replayed. Keyboard input defaults to canvas focus; frame profiling reports warmup, P99, render dimensions and optional P95 budgets. Frame timeouts include game/Director pause states and never automatically resume the game. See the [reliability and performance guide](docs/mcp-reliability-and-performance.md) (Chinese).

## Verification and safety

The `verification` field describes the evidence behind a capability:

| Level | Evidence |
| --- | --- |
| `source-only` | Discovered from source, declarations, or ASAR analysis only |
| `unverified` | Registered without completed automated verification |
| `contract-tested` | Parameter and protocol contract tests passed |
| `adapter-tested` | Mock editor/runtime adapter tests passed |
| `editor-verified` | Verified in a real Creator editor project |
| `runtime-verified` | Verified in a real development runtime |
| `device-verified` | Verified on the target device or platform |

`cocos_coverage` reports registered, implemented, planned, and verified counts separately. Automated checks cover schemas, path safety, the capability catalog, and runtime policies. Passing `pnpm check` does **not** establish complete Creator 2.4.15/3.8.8 editor, device, platform SDK, or GPU acceptance; those require corresponding real-environment checks.

The runtime bridge is restricted to loopback connections and development builds. Property paths, method paths, and argument counts are validated; dangerous host entry points are rejected. Project-code execution and arbitrary editor-message calls require the explicit startup flag `--allow-project-code`.

Before creating assets, query `asset.location` and reuse the returned directory. For asset organization, review `asset.organize.plan` and apply it with the same parameters and `planHash`; existing asset moves must use AssetDB to preserve metadata. See [asset organization](docs/asset-organization.md).

## Development

```bash
# Rebuild the service, extensions, and runtime bridges.
pnpm build

# Discover Creator editor-message and type candidates.
pnpm start catalog --project /path/to/project --creator /Applications/Cocos/Creator/3.8.8/CocosCreator.app

# Analyze engine source and generate engine-capabilities.json.
pnpm start catalog --project /path/to/project --engine /path/to/cocos-engine
```

Build output:

```text
.codex-work/build/
├── server/cli.mjs
├── extensions/creator2/
├── extensions/creator3/
└── runtime/
```

## Documentation

The detailed guides below are currently written in Chinese. Both README editions cover the same version support and setup flow. Local reports under `.codex-work/` are ignored by Git; linked guides provide reproduction scripts and evidence boundaries.

| Guide | Contents |
| --- | --- |
| [Version support](docs/version-support.md) · [Creator 2 acceptance](docs/creator2-expansion-tracker.md) | Exact-version feature matrix, native evidence and remaining scope |
| [User guide](docs/user-guide.md) | Installation, startup, client configuration, and examples |
| [Feature reference](docs/feature-reference.md) | Capabilities by domain and version limits |
| [2D development](docs/2d-development.md) · [Delivery & verification](docs/2d-implementation.md) | SpriteFrame, animation, UI, physics, Spine, Tilemap, and 13 editable gameplay templates for Creator 3.8.8 |
| [Implementation & acceptance](docs/implementation-guide.md) | Architecture, version differences, safety, and real-environment checks |
| [Scene production & preview](docs/scene-production.md) | Creator 3.8.8 geometry, arrays, rendering, preview windows, and screenshots |
| [Shader development](docs/shader-development.md) | Native Effect compilation, materials, and validation boundaries |
| [Asset organization](docs/asset-organization.md) | Directory reuse, organization plans, and guarded asset moves |
| [Proposal](docs/cocos-mcp-proposal.md) · [Roadmap](docs/capability-roadmap.md) | Project scope and phased implementation |
| [Verification checklist](docs/capability-verification.md) · [Implementation notes](docs/roadmap-implementation.md) | Completion evidence, added capabilities, and examples |

## License

First-party code is licensed under **MIT**. Cocos Creator, the engine, Spine, DragonBones, platform SDKs, and other third-party dependencies remain subject to their respective licenses.
