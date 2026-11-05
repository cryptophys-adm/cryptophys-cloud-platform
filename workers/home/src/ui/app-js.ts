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
    else node.setAttribute(k,String(v));
  });
  (children||[]).forEach(function(c){
    if(c===undefined||c===null||c===false)return;
    node.appendChild(typeof c==="string"?document.createTextNode(c):c);
  });
  return node;
}
function api(path){
  return fetch(path,{credentials:"same-origin"}).then(function(r){if(!r.ok)throw new Error(path+": "+r.status+" error");return r.json();});
}
function banner(msg){var b=$("banner");b.hidden=false;b.textContent=msg;}
async function load(){
  try{
    var who=await api("/api/whoami");
    $("actor").textContent=who.actor;
    if(who.approver)$("approver").hidden=false;
    var o=await api("/api/platform/v1/overview");
    var main=$("main");
    clear(main);
    var agents=el("p",{text:"Agents: "+(o.agents_enabled?"running":"stopped (kill switch)")});
    main.appendChild(agents);
    var drifted=(o.services||[]).filter(function(s){return s.drifted;});
    var drift=el("p",{text:"Drift: "+drifted.length});
    main.appendChild(drift);
    if(drifted.length>0){
      var ul=el("ul",{});
      drifted.forEach(function(s){var li=el("li",{text:s.service_id+(s.persistent?" (persistent)":"")});ul.appendChild(li);});
      main.appendChild(ul);
    }
    var ar=o.agent_reports_24h||{counts:{critical:0,warning:0,info:0},latest_attention:[]};
    var reports=el("p",{text:"Agent reports 24h: critical "+ar.counts.critical+" warning "+ar.counts.warning+" info "+ar.counts.info+" latest "+(ar.latest_attention||[]).length});
    main.appendChild(reports);
    var plans=el("p",{});
    var link=el("a",{href:"https://console.cryptophys.work/#/recovery",text:"Review in Console"});
    plans.appendChild(document.createTextNode("Open recovery proposals: "+((o.open_agent_plans||[]).length)+" "));
    plans.appendChild(link);
    main.appendChild(plans);
    var xl=o.xauusd_latest;
    var xtext="XAUUSD: ";
    if(xl&&xl.error)xtext+="unavailable";
    else if(!xl)xtext+="none";
    else xtext+=xl.decision+" "+xl.confidence+" "+xl.candle_key+" "+xl.decided_at;
    main.appendChild(el("p",{text:xtext}));
    main.appendChild(el("a",{href:"https://console.cryptophys.work",text:"Console"}));
    main.appendChild(el("a",{href:"https://nexus.cryptophys.work",target:"_blank",rel:"noopener noreferrer",text:"Nexus"}));
  }catch(e){banner(String(e.message||e));}
}
$("refresh").addEventListener("click",load);
load();
`;
