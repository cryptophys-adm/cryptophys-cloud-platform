export const APP_CSS = `* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; background: #0f1419; color: #e6e6e6; overflow-wrap: anywhere; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 16px; border-bottom: 1px solid #2a323c; }
h1 { font-size: 18px; margin: 0; flex: 1 1 auto; }
h2 { font-size: 15px; margin: 0 0 8px; }
h3 { font-size: 13px; margin: 12px 0 6px; color: #b4bec9; }
nav { display: flex; flex-wrap: wrap; gap: 4px 6px; padding: 8px 16px; border-bottom: 1px solid #2a323c; }
nav a { color: #9ecbff; padding: 6px 10px; border-radius: 4px; text-decoration: none; border: 1px solid transparent; }
nav a[aria-current="page"] { border-color: #3b82c4; background: #16222e; }
a { color: #9ecbff; }
main { padding: 16px; max-width: 1100px; }
.card { background: #171d24; border: 1px solid #2a323c; border-radius: 6px; padding: 14px; margin-bottom: 14px; max-width: 100%; }
.muted { color: #8b96a3; }
.badge { background: #2d6a4f; color: #fff; border-radius: 10px; padding: 2px 8px; font-size: 12px; }
.banner { display: flex; gap: 10px; align-items: center; margin: 10px 16px; padding: 8px 12px; border-radius: 6px; border: 1px solid #8e3b36; background: #2a1715; }
.notice { margin: 10px 16px; padding: 8px 12px; border-radius: 6px; border: 1px solid #2d6a4f; background: #14261e; }
.error { color: #ff7b72; }
.warn { color: #f2cc60; }
dt { color: #8b96a3; font-size: 12px; margin-top: 8px; }
dd { margin: 0; }
[hidden] { display: none !important; }
button { font: inherit; color: #e6e6e6; background: #232c37; border: 1px solid #3a4553; border-radius: 4px; padding: 6px 12px; cursor: pointer; }
button:hover:not(:disabled) { background: #2d3947; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
button.danger { border-color: #8e3b36; }
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid #f2cc60; outline-offset: 2px; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; margin: 8px 0; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #b4bec9; min-width: 0; max-width: 100%; }
.check { flex-direction: row; align-items: center; gap: 8px; }
input, select, textarea { font: inherit; color: #e6e6e6; background: #0f1419; border: 1px solid #3a4553; border-radius: 4px; padding: 6px 8px; max-width: 100%; }
textarea { width: 100%; min-height: 80px; }
.scroll { overflow-x: auto; max-width: 100%; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #2a323c; vertical-align: top; }
th { color: #8b96a3; font-weight: 600; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #0f1419; border: 1px solid #2a323c; border-radius: 4px; padding: 8px; margin: 6px 0; max-width: 100%; }
.overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.7); display: flex; align-items: center; justify-content: center; padding: 12px; z-index: 10; }
.modal { background: #171d24; border: 1px solid #3a4553; border-radius: 6px; padding: 16px; width: 100%; max-width: 480px; max-height: 100%; overflow-y: auto; }
.phrase { font-family: ui-monospace, monospace; background: #0f1419; padding: 2px 6px; border-radius: 3px; }
`;
