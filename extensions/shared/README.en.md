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

## Getting started

1. Install the extension into your Creator project and enable it in Extension Manager.
2. Open **CocosMCP → 打开控制中心 (Open Control Center)**. The control center supports English and Simplified Chinese.
3. Make Node.js 24 or later available. When installing from source, use the CocosMCP installer to record the Node.js executable path.
4. Start the bridge and MCP service, then configure your MCP client using the connection settings shown in the control center.
5. Inspect available capabilities before requesting changes. Reload the extension after an update and restart the MCP service.

## Compatibility and platforms

This package targets **Creator {{major}}.x**. Operation support varies by editor version; a declared version range does not mean every feature has been tested on every version.

Local development and native-editor checks use **macOS / Apple Silicon and Creator 3.8.8**. Windows, Intel macOS and other Creator versions require separate validation. Linux CI builds and automated tests do not establish native Creator compatibility. Game export targets are separate from the editor host platform.

Creator 3.8.8's local extension scanner reads author, version, editor range, `logo.png` and the README matching the editor language. It does not supply **Release Date** or **Support Platforms** to the manager header; those fields may remain “-” for a locally installed package. The timestamp above is a package build time, not a Cocos Store publication date.

## Links and feedback

- [Source and full installation guide](https://github.com/iEfoam/CocosMcp)
- [Feature documentation](https://github.com/iEfoam/CocosMcp/blob/main/docs/feature-reference.md)
- [Report an issue](https://github.com/iEfoam/CocosMcp/issues)
- Contact: **iefoam@foxmail.com**

CocosMCP is MIT-licensed and has no CocosMCP account or tool-call quota. Your AI client's own terms and usage limits still apply. Development bridge verification does not imply production, device or GPU acceptance.
