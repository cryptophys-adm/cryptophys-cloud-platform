import { summarize } from "./summary.ts";

export const APP_JS = String.raw`"use strict";
${summarize.toString()}
function $(id){return document.getElementById(id);}
function clear(node){while(node.firstChild)node.removeChild(node.firstChild);}
function el(tag,props,children){
  var node=document.createElement(tag);
  var p=props||{};
  Object.keys(p).forEach(function(k){
    var v=p[k];
    if(v===undefined||v===null||v===false)return;
    if(k==="text")node.textContent=String(v);
    else if(k==="class")node.className=String(v);
    else if(k==="click"||k==="change"||k==="input"||k==="keydown")node.addEventListener(k,v);
    else if(["value","checked","disabled","hidden","href","download","target","rel","type","id","name","rows","min","max","maxLength","title","colSpan","autocomplete"].indexOf(k)>=0)node[k]=v;
    else if(k==="role"||k.indexOf("aria-")===0)node.setAttribute(k,String(v));
  });
  (children||[]).forEach(function(child){
    if(child===undefined||child===null||child===false)return;
    node.appendChild(typeof child==="string"?document.createTextNode(child):child);
  });
  return node;
}
function api(path){
  return fetch(path,{credentials:"same-origin"}).then(function(response){
    if(!response.ok){
      return response.json().catch(function(){return {};}).then(function(body){
        throw new Error("GET "+path+": "+response.status+" "+(body.error||"error"));
      });
    }
    return response.json();
  });
}
function banner(message){
  var node=$("banner");
  node.hidden=false;
  node.textContent=message;
}
function row(label,value){
  return el("div",{class:"data-row"},[
    el("dt",{text:label}),
    el("dd",{text:String(value)})
  ]);
}
function tile(title,href,description,newTab){
  var linkProps={href:href,text:title};
  if(newTab){linkProps.target="_blank";linkProps.rel="noopener noreferrer";}
  return el("section",{class:"card tile"},[
    el("h3",{},[el("a",linkProps)]),
    el("p",{class:"muted",text:description})
  ]);
}
function render(body){
  var result=summarize(body);
  var content=$("content");
  clear(content);

  var status=el("section",{class:"card"},[
    el("h2",{text:"Platform status"}),
    el("dl",{},[
      row("Agents",result.agents),
      row("Drift",result.drift),
      row("Agent reports 24 h · critical",result.critical),
      row("Agent reports 24 h · warning",result.warning),
      row("Agent reports 24 h · info",result.info),
      row("Latest critical reports",result.latestCritical),
      row("Open recovery proposals",result.plans)
    ])
  ]);
  if(Array.isArray(result.driftIds)&&result.driftIds.length){
    var list=el("ul",{class:"drift-list","aria-label":"Drifted services"});
    result.driftIds.forEach(function(id){list.appendChild(el("li",{text:id}));});
    status.appendChild(el("h3",{text:"Drifted services"}));
    status.appendChild(list);
  }
  status.appendChild(el("p",{},[
    el("a",{href:"https://console.cryptophys.work/#/recovery",text:"Review in Console"})
  ]));
  content.appendChild(status);

  content.appendChild(el("section",{class:"card"},[
    el("h2",{text:"XAUUSD (display only)"}),
    el("dl",{},[
      row("Decision",result.xauusd.decision),
      row("Confidence",result.xauusd.confidence),
      row("Candle key",result.xauusd.candle_key),
      row("Decided at",result.xauusd.decided_at)
    ])
  ]));

  content.appendChild(el("div",{class:"tile-grid"},[
    tile("Console","https://console.cryptophys.work","Operator console: agents, recovery, registry, policy, audit, deploy.",false),
    tile("Nexus","https://nexus.cryptophys.work","XAUUSD room. Opens in a new tab.",true)
  ]));
}
async function load(){
  var refresh=$("refresh");
  if(refresh)refresh.disabled=true;
  try{
    var who=await api("/api/whoami");
    $("actor").textContent=String(who.actor||"unknown");
    $("approver").hidden=!who.approver;
    var body=await api("/api/platform/v1/overview");
    render(body);
    $("banner").hidden=true;
  }catch(error){
    banner(String(error&&error.message?error.message:error));
  }finally{
    if(refresh)refresh.disabled=false;
  }
}
var refresh=$("refresh");
if(refresh)refresh.addEventListener("click",load);
load();
`;
