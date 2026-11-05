export const APP_JS = String.raw`"use strict";
function $(id){return document.getElementById(id);}
function clear(n){while(n.firstChild)n.removeChild(n.firstChild);}
function el(tag,props,children){
  var node=document.createElement(tag);
  var p=props||{};
  Object.keys(p).forEach(function(k){
    var v=p[k];
    if(v===undefined||v===null||v===false)return;
    if(k==="text")node.textContent=String(v);
    else if(k==="class")node.className=String(v);
    else if(k==="for")node.htmlFor=String(v);
    else if(k==="click"||k==="change"||k==="input"||k==="keydown")node.addEventListener(k,v);
    else if(["value","checked","disabled","hidden","href","download","target","rel","type","id","name","rows","min","max","maxLength","title","colSpan","autocomplete"].indexOf(k)>=0)node[k]=v;
    else if(k==="role"||k.indexOf("aria-")===0)node.setAttribute(k,String(v));
  });
  (children||[]).forEach(function(c){
    if(c===undefined||c===null||c===false)return;
    node.appendChild(typeof c==="string"?document.createTextNode(c):c);
  });
  return node;
}
function fmt(v){if(v===undefined||v===null)return "unknown";return typeof v==="string"?v:JSON.stringify(v);}
function api(path){
  return fetch(path,{credentials:"same-origin"}).then(function(r){
    if(!r.ok){return r.json().catch(function(){return {};}).then(function(b){throw new Error("GET "+path+": "+r.status+" "+(b.error||"error"));});}
    return r.json();
  });
}
function banner(msg){var b=$("banner");b.hidden=false;b.textContent=msg;}
function val(v){return (v===undefined||v===null)?"unknown":v;}
async function load(){
  try{
    var who=await api("/api/whoami");
    $("actor").textContent=who.actor;
    if(who.approver)$("approver").hidden=false;
    var body=await api("/api/platform/v1/overview");
    var o=(body&&body.overview)||{};
    var main=$("main");
    clear(main);
    // nav active
    var homeNav=$("nav-home");
    if(homeNav)homeNav.setAttribute("aria-current","page");

    var agentsText="Agents: "+(typeof o.agents_enabled==="boolean"?(o.agents_enabled?"running":"stopped (kill switch)"):"unknown");
    main.appendChild(el("p",{text:agentsText}));

    var drifted=Array.isArray(o.services)?o.services.filter(function(s){return s&&s.drifted;}):[];
    var driftLine=el("p",{text:"Drift: "+(Array.isArray(o.services)?drifted.length:"unknown")});
    main.appendChild(driftLine);
    if(drifted.length>0){
      var ul=el("ul",{});
      drifted.forEach(function(s){ul.appendChild(el("li",{text:s.service_id+(s.persistent?" (persistent)":"")}));});
      main.appendChild(ul);
    }

    var ar=o.agent_reports_24h||{};
    var counts=(ar&&ar.counts)||{};
    var latestCritical=Array.isArray(ar.latest_critical)?ar.latest_critical:[];
    var reports=el("p",{text:"Agent reports 24h: critical "+val(counts.critical)+" warning "+val(counts.warning)+" info "+val(counts.info)+" latest_critical "+latestCritical.length});
    main.appendChild(reports);

    var plans=o.open_agent_plans||[];
    var planCount=Array.isArray(plans)?plans.length:"unknown";
    var planP=el("p",{});
    planP.appendChild(document.createTextNode("Open recovery proposals: "+planCount+" "));
    planP.appendChild(el("a",{href:"https://console.cryptophys.work/#/recovery",text:"Review in Console"}));
    main.appendChild(planP);

    var xl=o.xauusd_latest;
    var box=el("div",{});
    box.appendChild(el("p",{text:"XAUUSD decision: "+(xl&&xl.error?"unavailable":(xl?xl.decision:"none"))}));
    box.appendChild(el("p",{text:"XAUUSD confidence: "+(xl&&xl.error?"unavailable":(xl?xl.confidence:"none"))}));
    box.appendChild(el("p",{text:"XAUUSD candle_key: "+(xl&&xl.error?"unavailable":(xl?xl.candle_key:"none"))}));
    box.appendChild(el("p",{text:"XAUUSD decided_at: "+(xl&&xl.error?"unavailable":(xl?xl.decided_at:"none"))}));
    main.appendChild(box);

    main.appendChild(el("a",{href:"https://console.cryptophys.work",text:"Console tile: operator console"}));
    main.appendChild(el("a",{href:"https://nexus.cryptophys.work",target:"_blank",rel:"noopener noreferrer",text:"Nexus tile: XAUUSD room"}));
    main.appendChild(el("button",{type:"button",id:"refresh",text:"Refresh",click:load}));
  }catch(e){banner(String(e&&e.message?e.message:e));}
}
var refreshBtn=document.getElementById("refresh");
if(refreshBtn)refreshBtn.addEventListener("click",load);
load();
`;
