/* Front-end tests: tile -> history-table drill-down, chart zoom/pan, the
   today/yesterday tile figures, and the battery excursion count.

   Follows the repo convention: extract the <script> block from index.html and
   eval it against minimal DOM stubs. Plain Node (v22+), no deps, no runner.

     node tests/frontend.test.js                 # defaults to public/index.html
     node tests/frontend.test.js path/to.html    # or point it elsewhere

   Exits non-zero if any assertion fails.

   Two stub requirements that are easy to get wrong:
     - document.createTextNode is needed as well as createElement; the chart
       legend builder uses it, and without it buildCharts throws.
     - getElementById must resolve cards created at runtime (see the `id`
       setter on FakeEl). Without that, every tile assertion reads through a
       null card and silently PASSES. */
"use strict";
const fs = require("fs");
const path = require("path");

const TARGET = process.argv[2] || path.join(__dirname, "..", "public", "index.html");
const HTML = fs.readFileSync(TARGET, "utf8");
const SRC = /<script[^>]*>([\s\S]*)<\/script>/.exec(HTML)[1];

let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond){ pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + String(extra) : "")); }
}
function near(a, b, tol){ return Math.abs(a - b) <= tol; }

/* ---------------------------------------------------------------- DOM stubs */
class FakeEl {
  constructor(tag){
    this.tagName = (tag || "div").toUpperCase();
    this.children = [];
    this.style = {};
    this.attrs = {};
    this._html = "";
    this.textContent = "";
    this.scrollTop = 0;
    this.options = [];
    this.clientWidth = 600;
    this.clientHeight = 210;
    this._q = new Map();
    this._on = new Map();
    const cls = new Set();
    this.classList = {
      add: (...c) => c.forEach(x => cls.add(x)),
      remove: (...c) => c.forEach(x => cls.delete(x)),
      toggle: (c, f) => { if (f === undefined) f = !cls.has(c); f ? cls.add(c) : cls.delete(c); return f; },
      contains: (c) => cls.has(c)
    };
    this._cls = cls;
  }
  set className(v){ this._cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => this._cls.add(c)); }
  get className(){ return [...this._cls].join(" "); }
  /* register dynamically created cards so getElementById can find them */
  set id(v){ this._id = v; byId.set(v, this); }
  get id(){ return this._id; }
  set innerHTML(v){ this._html = String(v); this.children = []; this._q.clear(); }
  get innerHTML(){ return this._html; }
  appendChild(c){ this.children.push(c); return c; }
  setAttribute(k, v){ this.attrs[k] = String(v); }
  getAttribute(k){ return this.attrs[k]; }
  focus(){}
  click(){}
  setPointerCapture(){}
  getBoundingClientRect(){ return {left:0, top:0, width:this.clientWidth, height:this.clientHeight}; }
  getContext(){
    const noop = () => {};
    return {
      setTransform:noop, clearRect:noop, fillText:noop, beginPath:noop, moveTo:noop,
      lineTo:noop, stroke:noop, fill:noop, closePath:noop, rect:noop, clip:noop,
      save:noop, restore:noop, fillRect:noop, measureText:() => ({width:10}),
      font:"", fillStyle:"", strokeStyle:"", lineWidth:1, lineJoin:"", lineCap:"",
      textAlign:"", textBaseline:"", globalAlpha:1
    };
  }
  addEventListener(type, fn){
    if (!this._on.has(type)) this._on.set(type, []);
    this._on.get(type).push(fn);
  }
  fire(type, ev){ (this._on.get(type) || []).forEach(fn => fn(ev)); }
  /* selectors aren't parsed: hand back a stable stub per selector so the
     production code can read/write through it without crashing */
  querySelector(sel){
    const kids = this.children.filter(c => c.tagName === sel.toUpperCase());
    if (kids.length) return kids[0];
    if (!this._q.has(sel)) this._q.set(sel, new FakeEl("div"));
    return this._q.get(sel);
  }
  querySelectorAll(sel){
    const kids = this.children.filter(c => c.tagName === sel.toUpperCase());
    return kids.length ? kids : [];
  }
}

const byId = new Map();
for (const id of ["station-name","station-sub","station-sel","status-pill","status-txt",
                  "cards","charts","range-btns","stream-head","stream-charts","btn-pause",
                  "btn-csv","err-banner","nl-src","nl-buf","nl-poll","nl-next","obs-age",
                  "drill","drill-title","drill-close","drill-csv","drill-ranges",
                  "drill-body","drill-tbl","drill-note","compass-needle","precip-asof"]){
  byId.set(id, new FakeEl("div"));
}
byId.get("drill-tbl").tagName = "TABLE";

const docListeners = new Map();
global.document = {
  getElementById: (id) => byId.get(id) || null,
  createElement: (t) => new FakeEl(t),
  createTextNode: (t) => { const e = new FakeEl("#text"); e.textContent = t; return e; },
  addEventListener: (type, fn) => {
    if (!docListeners.has(type)) docListeners.set(type, []);
    docListeners.get(type).push(fn);
  },
  body: { style:{} },
  title: ""
};
function fireDoc(type, ev){ (docListeners.get(type) || []).forEach(fn => fn(ev)); }

const location = { pathname:"/", search:"", hash:"" };
const winListeners = new Map();
global.window = {
  devicePixelRatio: 1,
  addEventListener: (type, fn) => {
    if (!winListeners.has(type)) winListeners.set(type, []);
    winListeners.get(type).push(fn);
  }
};
function fireWin(type){ (winListeners.get(type) || []).forEach(fn => fn({})); }

global.location = location;
global.history = {
  pushState(state, title, url){
    const u = String(url || "");
    location.hash = u.startsWith("#") ? u : "";
  }
};
global.ResizeObserver = class { observe(){} disconnect(){} };
global.URL = { createObjectURL: () => "blob:test", revokeObjectURL(){} };
global.setInterval = () => 0;              // keep timers from running the poll loop
global.setTimeout  = () => 0;
global.clearTimeout = () => {};

/* -------------------------------------------------------------- canned API */
function makeData(n){
  const fields = [
    {name:"Temp", units:"Deg F"}, {name:"RH", units:"%"},
    {name:"WindSpeed", units:"mph"}, {name:"WindMax", units:"mph"},
    {name:"WindDir", units:"Â°"}, {name:"SolarRad", units:"W/m^2"},
    {name:"Precip", units:"in"}, {name:"BatVoltMin", units:"V"}
  ];
  const now = Date.now(), pad = (x) => String(x).padStart(2, "0");
  const data = [];
  for (let i = n - 1; i >= 0; i--){
    const t = new Date(now - i * 60000);
    const s = t.getFullYear() + "-" + pad(t.getMonth()+1) + "-" + pad(t.getDate()) +
              "T" + pad(t.getHours()) + ":" + pad(t.getMinutes()) + ":00";
    data.push({
      time: s,
      no: Math.floor(t.getTime() / 60000),
      // one deliberate NAN to exercise the bad-value path
      vals: [ i === 5 ? "NAN" : 70 + (i % 10), 50, 5, 9, 180, 400,
              (i % 20 === 0 ? 0.01 : 0), 13.2 ]
    });
  }
  return {head:{environment:{stationName:"Broadway Weather", scan_sec:60}, fields}, data};
}
const N_RECORDS = 400;
global.fetch = async (u) => {
  let body;
  if (u.includes("/stations"))    body = [{id:"WWG-1006", name:"Broadway Weather"}];
  else if (u.includes("/precip")) body = {today:0.1, yesterday:0, week:0.3, month:1, ytd:9, units:"in", asOf:"2026-08-28T10:00"};
  else if (u.includes("/stream")) body = {gauges:[]};
  else if (u.includes("last=1"))  body = makeData(1);
  else                            body = makeData(N_RECORDS);
  return {ok:true, status:200, statusText:"OK", json: async () => body};
};

/* ------------------------------------------------------------------- run it */
const api = new Function(SRC +
  "\nreturn {CONFIG,Store,UI,Drill,MiniChart,PARAM_VIEWS,RANGES,syncDrillFromHash," +
  "dayStats,countBelow,BATT_DIP_V};")();
const {CONFIG, Store, UI, Drill, PARAM_VIEWS, RANGES, syncDrillFromHash,
       dayStats, countBelow, BATT_DIP_V} = api;

(async function main(){
  for (let i = 0; i < 50; i++) await Promise.resolve();   // let initialLoad settle

  console.log("\nbuffer / roles");
  ok("records buffered", Store.rows.length === N_RECORDS, Store.rows.length);
  ok("roles detected", ["airTemp","rh","wsAvg","wsMax","windDir","solar","rain","battV"]
      .every(r => Store.roles[r] !== undefined), JSON.stringify(Store.roles));

  console.log("\nclickable tiles");
  const tile = byId.get("cards").children.find(c => c.attrs.id === "card-airTemp" || c._cls.has("linked"));
  const linked = byId.get("cards").children.filter(c => c._cls.has("linked"));
  ok("tiles are linked", linked.length >= 5, "linked=" + linked.length);
  ok("linked tile is a button", linked.every(c => c.attrs.role === "button"));
  ok("linked tile is focusable", linked.every(c => c.attrs.tabindex === "0"));
  ok("the two rain tiles are merged into one",
     byId.get("cards").children.filter(c => c._cls.has("precip")).length === 1 &&
     document.getElementById("card-rain") === null);
  ok("merged precip tile links to rain history",
     byId.get("cards").children.filter(c => c._cls.has("precip")).every(c => c._cls.has("linked")));
  ok("stats tiles carry today/yest rows",
     ["card-airTemp","card-rh","card-wind","card-solar"]
       .every(id => document.getElementById(id) && document.getElementById(id)._cls.has("has-stats")));

  console.log("\ndrill-down open/close");
  Drill.open("airTemp");
  ok("overlay opens", byId.get("drill")._cls.has("open"));
  ok("hash is deep-linkable", location.hash === "#param=airTemp", location.hash);
  ok("title set", byId.get("drill-title").textContent === "Air Temperature");
  ok("body scroll locked", document.body.style.overflow === "hidden");
  const head1 = byId.get("drill-tbl").querySelector("thead").innerHTML;
  ok("header has units", head1.includes("Deg F"), head1);

  Drill.range = RANGES.find(r => r.label === "1H");
  Drill.render(true);
  let bodyHtml = byId.get("drill-tbl").querySelector("tbody").innerHTML;
  const rowCount = (bodyHtml.match(/<tr>/g) || []).length;
  ok("1H range trims rows", rowCount > 50 && rowCount <= 62, "rows=" + rowCount);
  ok("NAN rendered as NAN", bodyHtml.includes("NAN"));

  console.log("\nrow cap + show all");
  CONFIG.drillRows = 10;
  Drill.range = RANGES.find(r => r.label === "24H");
  Drill.showAll = false;
  Drill.render(true);
  let capped = (byId.get("drill-tbl").querySelector("tbody").innerHTML.match(/<tr>/g) || []).length;
  ok("render capped at drillRows", capped === 10, "rows=" + capped);
  const noteTxt = byId.get("drill-note").children.map(c => c.textContent).join(" ");
  ok("note reports truncation", /showing 10 of 400/.test(noteTxt), noteTxt);
  const moreBtn = byId.get("drill-note").children.find(c => c.tagName === "BUTTON");
  ok("show-all button offered", !!moreBtn);
  if (moreBtn){
    moreBtn.onclick();
    capped = (byId.get("drill-tbl").querySelector("tbody").innerHTML.match(/<tr>/g) || []).length;
    ok("show all renders everything", capped === 400, "rows=" + capped);
  }
  CONFIG.drillRows = 2000;

  console.log("\nwind is multi-column");
  Drill.open("wind");
  const windHead = byId.get("drill-tbl").querySelector("thead").innerHTML;
  ok("wind shows speed/gust/direction",
     windHead.includes("Speed") && windHead.includes("Gust") && windHead.includes("Direction"), windHead);
  ok("direction gets a compass point",
     /\b(N|NNE|NE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)\b/
       .test(byId.get("drill-tbl").querySelector("tbody").innerHTML));

  console.log("\nclose paths");
  fireDoc("keydown", {key:"Escape"});
  ok("Escape closes", Drill.param === null && !byId.get("drill")._cls.has("open"));
  ok("hash cleared on close", location.hash === "", location.hash);
  ok("scroll unlocked", document.body.style.overflow === "");

  location.hash = "#param=rh";
  syncDrillFromHash();
  ok("deep link opens from hash", Drill.param === "rh");
  location.hash = "";
  syncDrillFromHash();
  ok("back button closes", Drill.param === null);

  console.log("\nchart zoom / pan");
  const chart = UI.charts[0];
  const rows = Store.windowRows(UI.activeRange.hours);
  chart.draw(rows);
  ok("starts unzoomed", chart.view === null);
  const full = chart._full.slice();
  const fullSpan = full[1] - full[0];

  chart.zoomAt(0.5, 0.5);
  ok("zoom in halves the span", chart.view && near(chart.view[1] - chart.view[0], fullSpan/2, 1000),
     chart.view && (chart.view[1] - chart.view[0]));
  ok("zoom stays inside the data", chart.view[0] >= full[0] - 1 && chart.view[1] <= full[1] + 1);

  const spanBefore = chart.view[1] - chart.view[0];
  chart.draw(rows);
  ok("zoom survives a redraw (live poll)", chart.view && near(chart.view[1]-chart.view[0], spanBefore, 2));

  chart.panPx(1e7);                        // slam left far past the start
  ok("pan clamps at the left edge", near(chart.view[0], full[0], 2), chart.view[0] - full[0]);
  chart.panPx(-1e7);                       // slam right past the end
  ok("pan clamps at the right edge", near(chart.view[1], full[1], 2), chart.view[1] - full[1]);

  chart.zoomAt(0.5, 1000);                 // zoom way out
  ok("zooming past full extent clears the zoom", chart.view === null);

  chart.zoomAt(0.5, 1e-9);                 // zoom way in
  const tightest = chart.view[1] - chart.view[0];
  ok("min zoom span enforced", near(tightest, 60000, 1), tightest);

  chart.resetZoom();
  ok("reset clears zoom", chart.view === null);

  console.log("\nwheel + drag gestures");
  const cv = chart.cv;
  let prevented = false;
  cv.fire("wheel", {deltaY:-100, clientX:300, shiftKey:false, preventDefault(){ prevented = true; }});
  ok("wheel zooms in", chart.view !== null);
  ok("wheel prevents page scroll", prevented);

  const zoomedSpan = chart.view[1] - chart.view[0];
  const t0Before = chart.view[0];
  cv.fire("pointerdown", {pointerId:1, clientX:300});
  ok("drag sets grabbing cursor", cv._cls.has("dragging"));
  cv.fire("pointermove", {pointerId:1, clientX:260});
  ok("drag pans the window", chart.view[0] > t0Before, chart.view[0] - t0Before);
  ok("drag preserves the span", near(chart.view[1]-chart.view[0], zoomedSpan, 2));
  cv.fire("pointerup", {pointerId:1});
  ok("pointerup releases cursor", !cv._cls.has("dragging"));

  cv.fire("dblclick", {});
  ok("double-click resets", chart.view === null);

  cv.fire("wheel", {deltaY:-200, clientX:300, shiftKey:false, preventDefault(){}});
  const panT0 = chart.view[0];
  cv.fire("wheel", {deltaY:100, clientX:300, shiftKey:true, preventDefault(){}});
  ok("shift+wheel pans instead of zooming", chart.view[0] !== panT0);

  console.log("\npinch zoom");
  chart.resetZoom();
  cv.fire("wheel", {deltaY:-300, clientX:300, shiftKey:false, preventDefault(){}});
  const beforePinch = chart.view[1] - chart.view[0];
  cv.fire("pointerdown", {pointerId:1, clientX:200});
  cv.fire("pointerdown", {pointerId:2, clientX:400});
  cv.fire("pointermove", {pointerId:2, clientX:500});   // fingers spread => zoom in
  ok("pinch out zooms in", chart.view[1] - chart.view[0] < beforePinch,
     (chart.view[1]-chart.view[0]) + " vs " + beforePinch);
  cv.fire("pointerup", {pointerId:1});
  cv.fire("pointerup", {pointerId:2});

  console.log("\nno-data chart");
  chart.view = [0, 1];
  chart.draw([]);
  ok("empty rows clear zoom state", chart.view === null && chart._full === null);

  /* ---- today / yesterday statistics ------------------------------------ */
  console.log("\nday statistics");
  const base = new Date();
  const mkRow = (dayOff, h, m, vals) => {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - dayOff, h, m, 0);
    return {t:d, no: Math.floor(d.getTime()/60000), vals};
  };
  // vals: [Temp, RH, WindSpeed, WindMax, WindDir, SolarRad, Precip, BatVoltMin]
  Store.rows = [
    mkRow(1,  0, 0, [ 20, 10, 9, 22,  10,   0, 0.50, 13]),  // yesterday 00:00
    mkRow(1,  6, 0, [ 40, 20, 2,  5,  90,  50, 0.10, 13]),
    mkRow(1, 18, 0, [ 70, 90, 8, 20, 270, 700, 0.20, 13]),
    mkRow(0,  0, 0, [999,  5, 1,  2,  10,   0, 0.50, 13]),  // MIDNIGHT -> yesterday
    mkRow(0,  1, 0, [ 50, 30, 4,  9, 180, 100, 0.01, 13]),
    mkRow(0, 12, 0, [ 80, 60, 6, 15, 200, 900, 0.02, 13])
  ];
  const [tday, yday] = dayStats(["airTemp","rh","wsAvg","wsMax","solar","rain"]);

  ok("today min/max", tday.airTemp.min === 50 && tday.airTemp.max === 80,
     tday.airTemp.min + "/" + tday.airTemp.max);
  ok("today excludes the midnight record", tday.airTemp.n === 2, tday.airTemp.n);
  ok("midnight record lands on yesterday", yday.airTemp.max === 999, yday.airTemp.max);
  ok("yesterday min/max", yday.airTemp.min === 40 && yday.airTemp.max === 999,
     yday.airTemp.min + "/" + yday.airTemp.max);
  // the row stamped yesterday 00:00 belongs to the day BEFORE yesterday,
  // so it must not appear in either bucket
  ok("yesterday's own midnight row is excluded",
     yday.airTemp.n === 3 && yday.wsMax.max !== 22 && yday.airTemp.min !== 20,
     "n=" + yday.airTemp.n);
  ok("rain totals per day",
     near(tday.rain.sum, 0.03, 1e-9) && near(yday.rain.sum, 0.80, 1e-9),
     tday.rain.sum + " / " + yday.rain.sum);
  ok("wind peak uses the gust channel", tday.wsMax.max === 15 && yday.wsMax.max === 20,
     tday.wsMax.max + "/" + yday.wsMax.max);
  ok("wind average uses the avg channel", near(tday.wsAvg.avg, 5, 1e-9),
     tday.wsAvg.avg);
  ok("solar max/avg", tday.solar.max === 900 && near(tday.solar.avg, 500, 1e-9),
     tday.solar.max + "/" + tday.solar.avg);

  console.log("\nstats rendered onto tiles");
  UI.updateCards();
  const read = (cardId, sel) => {
    const c = document.getElementById(cardId);
    return c ? c.querySelector(sel).textContent : "(no card)";
  };
  ok("temp tile today row", read("card-airTemp",".sv-today") === "50.0 / 80.0",
     read("card-airTemp",".sv-today"));
  ok("temp tile yesterday row", read("card-airTemp",".sv-yest") === "40.0 / 999.0",
     read("card-airTemp",".sv-yest"));
  ok("rh tile rows", read("card-rh",".sv-today") === "30 / 60", read("card-rh",".sv-today"));
  ok("wind tile gust/avg", read("card-wind",".sv-today") === "15.0 / 5.0",
     read("card-wind",".sv-today"));
  ok("solar tile max/avg", read("card-solar",".sv-today") === "900 / 500",
     read("card-solar",".sv-today"));
  ok("precip headline is today's calendar total", read("card-precip",".v") === "0.03",
     read("card-precip",".v"));

  ok("empty day renders --", (() => {
    Store.rows = [mkRow(1, 6, 0, [40,20,2,5,90,50,0.1,13])];   // yesterday only
    const [t2] = dayStats(["airTemp"]);
    UI.updateCards();
    return read("card-airTemp",".sv-today") === "--" && t2.airTemp.n === 0;
  })(), read("card-airTemp",".sv-today"));

  /* ---- battery excursions below 12 V ----------------------------------- */
  console.log("\nbattery low-voltage count");
  // vals index 7 is BatVoltMin; build a 24 h window minute by minute
  const battRows = (volts) => volts.map((v, i) => {
    const d = new Date(Date.now() - (volts.length - i) * 60000);
    return {t:d, no: Math.floor(d.getTime()/60000), vals:[70,50,5,9,180,400,0,v]};
  });
  CONFIG.scanIntervalSec = 60;

  Store.rows = battRows([13, 13, 13]);
  ok("no count when healthy", countBelow("battV", 24, BATT_DIP_V) === 0);

  Store.rows = battRows([13, 11.8, 11.7, 13, 13, 11.5, 13]);
  ok("counts separate excursions", countBelow("battV", 24, BATT_DIP_V) === 2,
     countBelow("battV", 24, BATT_DIP_V));

  Store.rows = battRows([13, 11.8, 11.7, 11.6, 13]);
  ok("a long excursion counts once", countBelow("battV", 24, BATT_DIP_V) === 1);

  Store.rows = battRows([13, 11.8, "NAN", 11.7, 13]);
  ok("a NAN gap does not split an excursion", countBelow("battV", 24, BATT_DIP_V) === 1,
     countBelow("battV", 24, BATT_DIP_V));

  Store.rows = battRows([11.9, 11.9]);
  ok("an excursion still open at the end counts", countBelow("battV", 24, BATT_DIP_V) === 1);

  Store.rows = battRows([13, 12, 12.0, 13]);
  ok("exactly 12 V does not count", countBelow("battV", 24, BATT_DIP_V) === 0);

  console.log("\nbattery tile rendering");
  Store.rows = battRows([13, 11.8, 11.7, 13, 11.5, 13]);
  UI.updateCards();
  ok("tile shows the count", read("card-battV",".sv-count") === "2", read("card-battV",".sv-count"));
  ok("time row is gone", document.getElementById("card-battV").innerHTML.indexOf("sv-time") === -1);
  ok("amber border while recovered but dipped",
     document.getElementById("card-battV").style.borderTopColor === "var(--wwg-elevated-amber)",
     document.getElementById("card-battV").style.borderTopColor);

  Store.rows = battRows([13, 11.2]);           // currently below the LOW line
  UI.updateCards();
  ok("rust border while currently low",
     document.getElementById("card-battV").style.borderTopColor === "var(--wwg-critical-rust)",
     document.getElementById("card-battV").style.borderTopColor);

  Store.rows = battRows([13, 13]);             // fully recovered
  UI.updateCards();
  ok("border clears once recovered",
     document.getElementById("card-battV").style.borderTopColor === "",
     "'" + document.getElementById("card-battV").style.borderTopColor + "'");
  ok("zero excursions renders 0", read("card-battV",".sv-count") === "0",
     read("card-battV",".sv-count"));

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();

