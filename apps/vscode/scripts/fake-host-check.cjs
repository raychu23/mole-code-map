// Runs the BUNDLED extension (dist/extension.cjs of a staged package) against a fake `vscode` module, to check what the panel is told:
//   node scripts/fake-host-check.cjs <workspace> <extension dir with dist/> [fake node version]   env: TARGET=<file> SRC=<srcDir> NOTS=1 MOLE_STATE_DIR=<dir>
// Prints the messages posted to the webview (state + message). Used for: Node-too-old message, repos without a src folder.
// (Written by the T9 independent reviewer; kept as a regression harness.)
const Module = require('module');
const posted = []; let msgHandler; const logs = [];
const Uri = { file: (p) => ({ fsPath: p, scheme: 'file', path: p }), joinPath: (b, ...s) => ({ fsPath: require('path').join(b.fsPath, ...s), scheme: 'file' }) };
const root = process.argv[2], extPath = process.argv[3], fakeNode = process.argv[4];
const panel = { webview: { postMessage: async (m) => { posted.push(m); return true; }, onDidReceiveMessage: (h) => { msgHandler = h; }, asWebviewUri: (u) => u, options: {}, html: '' }, onDidDispose() {}, reveal() {}, viewColumn: 2 };
class TabInputWebview {}
const vscode = {
  Uri, ViewColumn: { One: 1, Two: 2 }, TabInputWebview, Range: class {},
  window: { createOutputChannel: () => ({ appendLine: (l) => logs.push(l) }), registerWebviewPanelSerializer: () => ({ dispose() {} }), onDidChangeActiveTextEditor: () => ({ dispose() {} }), tabGroups: { all: [] }, createWebviewPanel: () => panel, activeTextEditor: { document: { uri: Uri.file(root + '/' + (process.env.TARGET || 'src/main.ts')) } }, showTextDocument: async () => ({}) },
  workspace: { workspaceFolders: [{ uri: Uri.file(root) }], findFiles: async () => (process.env.NOTS ? [] : [Uri.file(root + '/src/main.ts')]), getConfiguration: () => ({ get: (k, d) => (k === 'idleMinutes' ? 30 : (k === 'srcDir' ? process.env.SRC : d)) }) },
  commands: { registerCommand: (n, f) => { vscode.cmds[n] = f; return { dispose() {} }; }, executeCommand: async () => {} }, cmds: {},
};
const orig = Module._load; Module._load = function (r, ...a) { return r === 'vscode' ? vscode : orig.call(this, r, ...a); };
if (fakeNode) Object.defineProperty(process.versions, 'node', { value: fakeNode });
const ext = require(extPath + '/dist/extension.cjs');
(async () => {
  await ext.activate({ subscriptions: [], extensionPath: extPath, extensionUri: Uri.file(extPath) });
  await new Promise((r) => setTimeout(r, 2500)); // autoOpen at 1500ms
  if (msgHandler) msgHandler({ type: 'ready' });
  await vscode.cmds['mole.openMap']?.();
  if (msgHandler) msgHandler({ type: 'ready' });
  await new Promise((r) => setTimeout(r, 4000));
  console.log('NODE', process.versions.node, '\nPOSTED', JSON.stringify(posted.map((m) => ({ type: m.type, state: m.map?.state, message: m.map?.message }))), '\nOUTPUT', JSON.stringify(logs));
  process.exit(0);
})().catch((e) => { console.log('ERR', e); process.exit(1); });
