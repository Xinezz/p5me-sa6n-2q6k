// JavaScript Quest test suite.
// Runs the page's own script in Node with a minimal DOM stub, and runs learner code in real
// worker threads so the sandbox's 2-second kill switch is exercised for real.
// Usage: node tests/quest.test.js [path/to/index.html]
"use strict";
const fs = require("fs");
const path = require("path");
const { Worker: NodeWorker } = require("worker_threads");

const file = process.argv[2] || path.join(__dirname, "..", "index.html");
const html = fs.readFileSync(file, "utf8");
const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));

// ---- Minimal browser stubs ----
const el = () => new Proxy({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, addEventListener() {}, insertAdjacentHTML() {}, setAttribute() {}, appendChild() {} },
  { get: (t, k) => k in t ? t[k] : (k === "querySelector" ? () => el() : k === "querySelectorAll" ? () => [] : undefined), set: (t, k, v) => (t[k] = v, true) });
const mem = new Map();
global.document = { querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, createElement: () => el() };
global.window = { scrollTo() {} };
global.matchMedia = () => ({ matches: false });
global.localStorage = { getItem: k => mem.has(k) ? mem.get(k) : null, setItem: (k, v) => mem.set(k, String(v)) };
global.Blob = class { constructor(p) { this.src = p.join(""); } };
global.URL = { createObjectURL: b => b.src };
// Browser Worker API on top of Node worker_threads
global.Worker = class {
  constructor(src) {
    const shim = "const { parentPort } = require('worker_threads'); const self = { postMessage: d => parentPort.postMessage(d) }; parentPort.on('message', d => self.onmessage({ data: d }));\n";
    this.w = new NodeWorker(shim + src, { eval: true });
    this.w.on("message", d => this.onmessage && this.onmessage({ data: d }));
    this.w.on("error", e => this.onerror && this.onerror({ message: e.message, preventDefault() {} }));
  }
  postMessage(d) { this.w.postMessage(d); }
  terminate() { this.w.terminate(); }
};

// The test body is stringified and run in the page script's scope, so it must be self-contained.
const tests = async () => {
  let failures = 0, passes = 0;
  const ok = (cond, name, detail) => { if (cond) passes++; else { failures++; console.log("FAIL  " + name + (detail ? "\n      " + detail : "")); } };
  const strip = s => String(s || "").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"');
  const NL = "\n";
  // 1. Every challenge: model solution passes, starter code does not
  for (const L of LESSONS) {
    const C = L.challenge;
    const ev = await evaluate(C.solution, C);
    ok(ev.allOk, L.id + ": challenge solution passes", ev.allOk ? "" : strip(failMessage(ev, C)));
    const st = await evaluate(C.starter, C);
    ok(!st.allOk, L.id + ": challenge starter does not pass by itself");
    ok(C.why.length === C.solution.split(NL).length, L.id + ": one review explanation per solution line");
    ok(L.example.lines.length === L.example.code.split(NL).length, L.id + ": one explanation per example line");
  }
  // 2. Every drill: solution passes, starter has blanks or fails, hints get more specific
  for (const L of LESSONS) {
    for (const [k, D] of (L.drills || []).entries()) {
      const name = L.id + " drill " + (k + 1);
      const ev = await evaluate(D.solution, D);
      ok(ev.allOk, name + ": solution passes", ev.allOk ? "" : strip(failMessage(ev, D)));
      ok(!/___/.test(D.solution), name + ": solution has no blanks");
      if (!/___/.test(D.starter)) { const st = await evaluate(D.starter, D); ok(!st.allOk, name + ": starter does not pass by itself"); }
      ok(D.hints.length >= 2, name + ": at least two progressive hints");
    }
  }
  // 2b. Typical beginner mistakes are rejected with a specific explanation
  const drill = (id, k) => LESSONS.find(l => l.id === id).drills[k];
  const mistakes = [
    ["vars", 0, "let fuel = 30;\nconsole.log(30);", /Print the variable itself/],
    ["arrays", 0, "console.log(planets[2]);", /third element/],
    ["return", 0, "function triple(n) {\n  console.log(n * 3);\n}", /return/],
    ["while", 1, "while (robot.atGoal()) {\n  robot.move();\n}", /forget the/],
    ["bool", 1, "const wasteful = isDay || lightsOn;\nconsole.log(wasteful);", /\|\|/],
    ["func", 0, 'function beep() {\n  console.log("Beep!");\n}', /never called/],
    ["log", 0, "console.log(\"ready\");", /capital/]
  ];
  for (const [id, k, code, re] of mistakes) {
    const D = drill(id, k), ev = await evaluate(code, D), msg = strip(failMessage(ev, D));
    ok(!ev.allOk && re.test(msg), id + " drill " + (k + 1) + ": common mistake gets a specific message", msg);
  }
  const constAssign = await evaluate('if (fuel = 0) {\n  console.log("EMPTY");\n}', drill("if", 1));
  ok(!constAssign.allOk && constAssign.firstErr >= 0 && /const/.test(explainError(constAssign.runs[constAssign.firstErr].error)), "if drill: = instead of === is caught and explained");

  // 3. Predictions and step-through traces match what the code really prints
  for (const L of LESSONS) {
    const p = await runOnce({ code: L.predict.code });
    ok(p.logs.join(NL) === L.predict.answer, L.id + ": predict answer matches real output", JSON.stringify(p.logs));
    const t = await runOnce({ code: L.trace.code });
    const tout = L.trace.steps.filter(s => s.o !== undefined).map(s => s.o);
    ok(t.logs.join(NL) === tout.join(NL), L.id + ": trace output matches real output", JSON.stringify(t.logs));
  }
  // 4. Sandbox safety and error reporting
  const inf = await runOnce({ code: "while (true) {}" });
  ok(inf.error && inf.error.name === "Timeout", "infinite loop is stopped by the 2-second kill switch");
  const flood = await runOnce({ code: "for (let i = 0; i < 1e6; i++) console.log(i);" });
  ok(flood.error && /300 lines/.test(flood.error.message), "runaway output is capped");
  const robotLoop = await runOnce({ code: "while (true) { robot.turnLeft(); }", map: corridor(3), dir: 1 });
  ok(robotLoop.error && robotLoop.error.name === "RobotError", "robot action budget stops endless robot loops");
  const e1 = await runOnce({ code: "let a = 1;" + NL + "console.log(b);", pre: "const z = 2;" });
  ok(e1.error && e1.error.line === 2 && /not defined/.test(e1.error.message), "runtime error reports the right line", JSON.stringify(e1.error));
  const e2 = await runOnce({ code: "let a = 1;" + NL + 'console.log("hi);' + NL + "let c = 3;" });
  ok(e2.error && e2.error.line === 2, "unclosed string reports the right line", JSON.stringify(e2.error));
  const e3 = await runOnce({ code: "if (true) {" + NL + "  console.log(1);" });
  ok(e3.error && /end of input/.test(e3.error.message), "missing } is explained as unexpected end of input", JSON.stringify(e3.error));
  const e4 = await runOnce({ code: "let t = 1;", pre: "const t = 5;" });
  ok(e4.error && /already been declared/.test(e4.error.message) && e4.error.line === 1, "redeclaring a given variable is caught", JSON.stringify(e4.error));
  ok(/infinite loop/.test(explainError({ name: "Timeout", message: "" })), "timeout explanation mentions infinite loops");
  ok(/case-sensitive/.test(explainError({ name: "ReferenceError", message: "Console is not defined" })), "capitalised console gets a case-sensitivity tip");
  const sb = await runOnce({ code: "console.log(typeof document, typeof localStorage, typeof window);" });
  ok(sb.logs[0] === "undefined undefined undefined", "learner code cannot reach the page, storage or window", sb.logs[0]);
  // 5. Progress persistence and gating
  const L1 = LESSONS[0];
  ok(!drillsDone(L1), "lesson 1 challenge starts locked behind drills");
  store.drills[L1.id] = [true]; ok(!drillsDone(L1), "one drill passed is not enough");
  store.drills[L1.id] = [true, true]; save();
  const saved = JSON.parse(localStorage.getItem(STORE_KEY));
  ok(saved.drills.log[0] === true && saved.drills.log[1] === true, "drill progress is saved to storage");
  ok(drillsDone(L1), "passing every drill unlocks the challenge");
  store.drills = {}; store.done.vars = { stars: 2, code: "" };
  ok(drillsDone(LESSONS[1]), "lessons repaired before drills existed stay unlocked");
  ok(unlocked(2) && !unlocked(3), "next lesson unlocks only after the previous repair");

  // 5b. Save codes
  const sample = freshStore();
  sample.done.log = { stars: 3, code: 'console.log("SYSTEM ONLINE");', hints: 0, attempts: 1, revealed: false, at: 1 };
  sample.done.vars = { stars: 2, code: "const doorCode = 4721; // ünïcödé ✓", hints: 1, attempts: 3, revealed: false, at: 2 };
  sample.drills.log = [true, true]; sample.drafts["vars:c"] = "let pilot = \"Zoë\";";
  const codeStr = makeSaveCode(sample);
  ok(/^JSQ1\.[A-Za-z0-9+/=]+\.[a-z0-9]+$/.test(codeStr), "save code has the JSQ1.<data>.<check> shape");
  const back = readSaveCode("  " + codeStr.slice(0, 20) + "\n" + codeStr.slice(20) + "  ");
  ok(back.ok && back.store.done.log.stars === 3 && back.store.done.vars.code === sample.done.vars.code && back.store.drafts["vars:c"] === sample.drafts["vars:c"] && back.store.drills.log[1] === true,
    "save code round-trips progress, drafts and non-English text (even with spaces or line breaks pasted in)", JSON.stringify(back.error || ""));
  ok(!readSaveCode(codeStr.slice(0, -3)).ok, "a truncated save code is rejected");
  const parts = codeStr.split(".");
  const flipped = parts[1].slice(0, 10) + (parts[1][10] === "A" ? "B" : "A") + parts[1].slice(11);
  ok(!readSaveCode([parts[0], flipped, parts[2]].join(".")).ok, "an edited save code fails the check");
  ok(/start with/.test(readSaveCode("hello").error || ""), "random text gets a 'save codes start with JSQ1' message");
  const evilBody = b64encode(JSON.stringify({ v: 1, done: { log: { stars: 99, code: 5 }, hacked: { stars: 3 } }, drills: { log: [true, "yes", true, true] }, drafts: { "__proto__:c": "x", "log:p": "ok" }, stats: { "bad key!": 4 } }));
  const evil = readSaveCode(SAVE_PREFIX + "." + evilBody + "." + hashStr(evilBody));
  ok(evil.ok && evil.store.done.log.stars === 3 && evil.store.done.log.code === "" && !evil.store.done.hacked && evil.store.drills.log.length === 2 && evil.store.drills.log[1] === false &&
    Object.keys(evil.store.drafts).join() === "log:p" && !("bad key!" in evil.store.stats), "loaded saves are cleaned: unknown lessons dropped, stars clamped, junk types removed", JSON.stringify(evil.store));
  ok(/^\d+\.\d+\.\d+$/.test(APP_VERSION), "app version is a semantic version number");
  ok(SYMBOLS.every(s => typeof s[0] === "string" && s[0].length && s[1]), "every symbol-bar button has text and a spoken label");

  // 6. Pixel sprites are well-formed
  for (const [name, s] of Object.entries(SPRITES)) {
    const w = s.rows[0].length;
    ok(s.rows.every(r => r.length === w), "sprite " + name + ": every row is the same width", s.rows.map(r => r.length).join(","));
    ok(s.rows.every(r => [...r].every(ch => ch === "." || PAL[ch])), "sprite " + name + ": only palette colours");
    const o = outlined(s.rows);
    ok(o.length === s.rows.length + 2 && o.every(r => r.length === w + 2), "sprite " + name + ": outline pass pads by one pixel");
  }
  ok(WORLD_ICONS.length === WORLDS.length && WORLD_ICONS.every(n => SPRITES[n]), "every sector has an icon sprite");
  ok(spriteURL("robot") === "" && pxImg("robot") === "", "sprites degrade to nothing when canvas is unavailable");

  console.log("\n" + passes + " passed, " + failures + " failed");
  process.exit(failures ? 1 : 0);
};
new Function(script + "\n;(" + tests.toString() + ")();")();
