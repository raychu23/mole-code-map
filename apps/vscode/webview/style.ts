// Theme-aware CSS: uses VS Code's colour variables so the panel matches whatever theme the editor has.
export const CSS = `
html, body { height: 100%; margin: 0; padding: 0; }
body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); font-size: 12px; overflow: hidden; }
#app { display: flex; flex-direction: column; height: 100%; }
.head { display: flex; align-items: center; gap: 6px; padding: 8px 12px 4px; }
.titles { flex: 1; min-width: 0; }
.head .title { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.head .sub { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 1px; }
.chip { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ccc); border: 1px solid var(--vscode-editorWidget-border, #555); border-radius: 11px; padding: 2px 10px; font: inherit; cursor: pointer; }
.chip:hover { background: var(--vscode-button-secondaryHoverBackground); }
.chip.on { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); border-color: var(--vscode-inputValidation-errorBorder, #be1100); color: var(--vscode-editor-foreground); }
.legend { display: flex; gap: 12px; padding: 0 12px 6px; color: var(--vscode-descriptionForeground); font-size: 11px; }
.legend .l::before { content: ''; display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.legend .caller::before { background: var(--c-caller); } .legend .own::before { background: var(--c-own); }
.legend .callee::before { background: var(--c-callee); } .legend .imp::before { background: var(--c-imp); }
#stage { flex: 1; overflow: auto; padding: 4px 8px 16px; }
:root { --c-caller: var(--vscode-charts-blue, #3794ff); --c-own: var(--vscode-charts-green, #89d185); --c-callee: var(--vscode-charts-orange, #d18616); --c-imp: var(--vscode-charts-purple, #b180d7); --c-impact: var(--vscode-charts-red, #f14c4c); }
svg.map { display: block; margin: 0 auto; max-width: 100%; height: auto; }
.node rect { fill: var(--vscode-editorWidget-background, #252526); stroke: var(--vscode-editorWidget-border, #454545); stroke-width: 1; }
.node { cursor: pointer; }
.node:hover rect { stroke: var(--vscode-focusBorder); stroke-width: 1.5; }
.node .label { fill: var(--vscode-editor-foreground); font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); }
.node .badge { fill: var(--vscode-descriptionForeground); font-size: 9px; text-transform: uppercase; letter-spacing: .04em; }
.role-focus rect { fill: var(--vscode-list-activeSelectionBackground, #094771); stroke: var(--vscode-focusBorder); stroke-width: 1.5; }
.role-focus .label { font-weight: 700; fill: var(--vscode-list-activeSelectionForeground, #fff); }
.role-own rect { stroke: var(--c-own); } .role-caller rect, .role-importer rect, .role-container rect { stroke: var(--c-caller); } .role-callee rect { stroke: var(--c-callee); } .role-imported rect { stroke: var(--c-imp); }
.role-importer rect { stroke: var(--c-imp); }
.edge { fill: none; stroke: var(--vscode-descriptionForeground); opacity: .55; }
.edge.imports { stroke-dasharray: 4 3; stroke: var(--c-imp); }
.edge:hover { opacity: 1; }
.arrowhead { fill: var(--vscode-descriptionForeground); } .arrowhead.imports { fill: var(--c-imp); }
.rail { fill: none; stroke: var(--c-own); opacity: .5; stroke-width: 1.2; }
.more rect { fill: none; stroke: var(--vscode-descriptionForeground); stroke-dasharray: 3 3; opacity: .7; }
.more text { fill: var(--vscode-descriptionForeground); font-size: 11px; }
svg.impact-mode .node:not(.impacted):not(.role-focus) { opacity: .3; }
svg.impact-mode .edge:not(.impacted) { opacity: .12; }
svg.impact-mode .node.impacted rect { stroke: var(--c-impact); stroke-width: 2; }
svg.impact-mode .edge.impacted { stroke: var(--c-impact); opacity: .9; }
.empty { margin: 64px auto 0; max-width: 360px; text-align: center; }
.empty .title { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
.empty .hint { color: var(--vscode-descriptionForeground); line-height: 1.5; }
.empty.index-unavailable .title { color: var(--vscode-errorForeground); }
`;
