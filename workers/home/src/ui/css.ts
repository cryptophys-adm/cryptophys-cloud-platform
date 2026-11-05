export const APP_CSS = `:root{--bg:#0b1020;--card:#121a33;--border:#2a3558;--text:#e6eaf2;}
body{font-family:system-ui,sans-serif;margin:0;background:var(--bg);color:var(--text);}
nav{display:flex;gap:8px;padding:8px;border-bottom:1px solid var(--border);}
main{padding:12px;}
.card{background:var(--card);border:1px solid var(--border);padding:8px;margin:8px 0;}
a,button{color:#9bbcff;}
button:focus,a:focus{outline:2px solid #9bbcff;}
@media (max-width:720px){nav{flex-direction:row;flex-wrap:wrap;}}
@media (max-width:360px){body{font-size:14px;}}
`;
