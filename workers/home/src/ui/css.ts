export const APP_CSS = `*{box-sizing:border-box}
:root{--bg:#0f1419;--card:#171d24;--border:#2a323c;--text:#e6e6e6;--muted:#8b96a3;--link:#9ecbff}
body{display:grid;grid-template-columns:220px 1fr;grid-template-rows:auto 1fr;min-height:100vh;margin:0;font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);overflow-wrap:anywhere}
header{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:10px 16px;border-bottom:1px solid var(--border)}
h1{font-size:18px;margin:0;flex:1 1 auto}
h2{font-size:15px;margin:0 0 12px}
h3{font-size:13px;margin:0 0 6px;color:#b4bec9}
nav{grid-column:1;grid-row:2;display:flex;flex-direction:column;align-items:stretch;gap:4px;padding:12px;border-right:1px solid var(--border)}
nav a{color:var(--link);padding:6px 10px;border-radius:4px;text-decoration:none;border:1px solid transparent}
nav a[aria-current="page"]{border-color:#3b82c4;background:#16222e}
nav a:hover{background:#16222e}
.nav-group{display:flex;flex-direction:column;gap:2px}
.nav-group small{padding:0 10px}
.disabled,.muted{color:var(--muted)}
.disabled{padding:6px 10px}
main{grid-column:2;grid-row:2;min-width:0;padding:16px;max-width:1100px}
.card{background:var(--card);border:1px solid var(--border);border-radius:6px;padding:14px;margin-bottom:14px;max-width:100%}
.data-row{display:grid;grid-template-columns:minmax(150px,220px) minmax(0,1fr);gap:8px;padding:5px 0;border-bottom:1px solid var(--border)}
.data-row:last-child{border-bottom:0}
dt{color:var(--muted);font-size:12px}
dd{margin:0;overflow-wrap:anywhere}
.drift-list{margin:8px 0;padding-left:22px}
.tile-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.tile{margin:0}
.tile h3 a{color:var(--link)}
a{color:var(--link)}
button{font:inherit;color:#e6e6e6;background:#232c37;border:1px solid #3a4553;border-radius:4px;padding:6px 12px;cursor:pointer;margin-bottom:14px}
button:hover:not(:disabled){background:#2d3947}
button:disabled{opacity:.5;cursor:not-allowed}
.banner{margin:0 0 14px;padding:8px 12px;border-radius:6px;border:1px solid #8e3b36;background:#2a1715;color:#ff7b72}
[hidden]{display:none!important}
a:focus-visible,button:focus-visible{outline:3px solid #f2cc60;outline-offset:2px}
@media (max-width:720px){body{display:block}nav{flex-direction:row;flex-wrap:wrap;border-right:0;border-bottom:1px solid var(--border)}main{max-width:none}}
@media (max-width:480px){.tile-grid{grid-template-columns:1fr}.data-row{grid-template-columns:minmax(0,1fr)}}
@media (max-width:360px){body{font-size:14px}}
`;
