# Champion Council Extension - Setup Guide

## Quick Start

### 1. Install Dependencies

```bash
# Install Node.js dependencies for the extension
npm install

# Install Python dependencies for the MCP server
pip install torch sentence-transformers huggingface-hub numpy mcp fastmcp
```

### 2. Compile TypeScript

```bash
npm run compile
```

Or watch mode for development:
```bash
npm run watch
```

### 3. Test the Extension

**Option A: Debug Mode (F5)**
1. Open this folder in VS Code
2. Press `F5` to launch Extension Development Host
3. In the new window, press `Ctrl+Shift+P`
4. Run: "Champion: Open Council Panel"

**Option B: Package and Install**
```bash
# Install vsce if you don't have it
npm install -g @vscode/vsce

# Package extension
npx vsce package

# Install the .vsix file
code --install-extension champion-council-0.1.0.vsix
```

## Project Structure

```
vscode-extension/
├── champion_gen8.py          # Python MCP server (10MB monolith)
├── package.json              # Extension manifest + settings schema
├── tsconfig.json             # TypeScript config
├── src/
│   ├── extension.ts          # Main extension entry point
│   ├── mcpServer.ts          # MCP server manager (JSON-RPC client)
│   └── webview/
│       └── panel.ts          # WebView panel controller
├── out/                      # Compiled JavaScript (gitignored)
└── node_modules/             # Dependencies (gitignored)
```

## Development Workflow

### 1. Make Changes to TypeScript

Edit files in `src/`:
- `extension.ts` - Add new commands, modify activation
- `mcpServer.ts` - Change MCP communication logic
- `webview/panel.ts` - Modify WebView UI/behavior

### 2. Compile

```bash
npm run compile
```

Or use watch mode (auto-recompiles on save):
```bash
npm run watch
```

### 3. Test Changes

**If using F5 debug mode:**
- Press `Ctrl+R` in the Extension Development Host window to reload

**If packaged:**
- Recompile: `npm run compile`
- Repackage: `npx vsce package`
- Reinstall: `code --install-extension champion-council-0.1.0.vsix --force`

### 4. Check Logs

**Extension Logs:**
- In Extension Development Host: `Help → Toggle Developer Tools → Console`

**Python MCP Server Logs:**
- Look for `.mcp_server.log` in the extension directory
- Or check stderr output in VS Code Output panel

## Customizing the Extension

### Add New VS Code Commands

1. Edit `package.json` → `contributes.commands`:
   ```json
   {
     "command": "champion.myNewCommand",
     "title": "Champion: My New Command"
   }
   ```

2. Register handler in `src/extension.ts`:
   ```typescript
   context.subscriptions.push(
       vscode.commands.registerCommand('champion.myNewCommand', async () => {
           const result = await mcpManager.callTool('tool_name', { args });
           vscode.window.showInformationMessage(result);
       })
   );
   ```

3. Recompile and test

### Add New Settings

1. Edit `package.json` → `contributes.configuration.properties`:
   ```json
   "champion.myNewSetting": {
       "type": "boolean",
       "default": true,
       "description": "Enable my feature"
   }
   ```

2. Read setting in TypeScript:
   ```typescript
   const config = vscode.workspace.getConfiguration('champion');
   const myValue = config.get('myNewSetting', true);
   ```

3. Recompile and test

### Modify WebView UI

Edit `src/webview/panel.ts` → `getHtmlContent()`:
- HTML structure
- CSS styles (uses VS Code theme variables)
- JavaScript for interactivity

All changes are inline in the `getHtmlContent()` method.

### Add New MCP Tool Calls

Call any of the 100+ tools from the Python server:

```typescript
const result = await mcpManager.callTool('tool_name', {
    arg1: 'value1',
    arg2: 123
});
```

Available tools (see `champion_gen8.py` line 2460-2610 for full list):
- `plug_model`, `unplug_slot`, `list_slots`
- `bag_get`, `bag_put`, `bag_search`
- `hub_search`, `hub_download`, `hub_info`
- `vast_search`, `vast_rent`, `vast_connect`
- `workflow_execute`, `council_broadcast`, etc.

## Testing MCP Integration

### Test with Windsurf

1. Install extension in Windsurf (same as VS Code)
2. Ensure MCP server is running (check status bar)
3. Ask Cascade to use Champion tools:
   ```
   "Search HuggingFace for embedding models using the champion tools"
   "Plug BAAI/bge-small-en into slot 1"
   "Show me the council status"
   ```

### Test Manually (stdio mode)

Run the Python server directly:

```bash
python champion_gen8.py --mcp
```

This starts MCP server in stdio mode. You can send JSON-RPC requests:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
```

Press Ctrl+C to stop.

### Test Manually (HTTP mode)

```bash
python champion_gen8.py --mcp-remote
```

Server runs on `http://localhost:8765`. Test with curl:

```bash
curl http://localhost:8765/sse
```

## Troubleshooting

### "Cannot find module" errors

```bash
npm install
```

### TypeScript compilation errors

```bash
# Clean build
rm -rf out/
npm run compile
```

### Extension not loading

1. Check `package.json` → `main` points to `./out/extension.js`
2. Ensure `out/extension.js` exists after compilation
3. Check for errors in Extension Development Host console

### MCP server not starting

1. Test Python manually:
   ```bash
   python champion_gen8.py --mcp
   ```
2. Check dependencies:
   ```bash
   pip list | grep -E "torch|mcp|sentence"
   ```
3. Check Python path in settings:
   ```
   Settings → Champion → Python Path
   ```

### WebView not rendering

1. Check browser console in Extension Development Host
2. Look for CSP (Content Security Policy) errors
3. Ensure webview HTML is valid

## Publishing

### Prepare for Publishing

1. Update version in `package.json`
2. Update `README.md` with any new features
3. Test thoroughly in clean environment
4. Add icon: `resources/icon.png` (128x128)

### Package

```bash
npx vsce package
```

Creates `champion-council-X.Y.Z.vsix`

### Publish to VS Code Marketplace

```bash
# Get publisher access token from https://dev.azure.com
npx vsce login <publisher>

# Publish
npx vsce publish
```

Or manually upload `.vsix` at:
https://marketplace.visualstudio.com/manage

## Next Steps

- [ ] Add icon (`resources/icon.svg`)
- [ ] Add unit tests (`src/test/`)
- [ ] Add CI/CD pipeline (GitHub Actions)
- [ ] Add telemetry (optional)
- [ ] Optimize bundle size (webpack)
- [ ] Add i18n support (localization)

## Resources

- [VS Code Extension API](https://code.visualstudio.com/api)
- [MCP Protocol Spec](https://spec.modelcontextprotocol.io/)
- [FastMCP Docs](https://github.com/jlowin/fastmcp)
- [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
