const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "..", "src", "text-formatting.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const moduleRecord = { exports: {} };
const runModule = vm.runInThisContext(`(function (exports, require, module) {${compiled}\n})`, {
  filename: sourcePath,
});
runModule(moduleRecord.exports, require, moduleRecord);

const { formatRussianCount, russianCountForm } = moduleRecord.exports;
const forms = ["вакансия распознана", "вакансии распознаны", "вакансий распознано"];

assert.equal(russianCountForm(1, ...forms), forms[0]);
assert.equal(russianCountForm(0, ...forms), forms[2]);
assert.equal(russianCountForm(2, ...forms), forms[1]);
assert.equal(russianCountForm(4, ...forms), forms[1]);
assert.equal(russianCountForm(5, ...forms), forms[2]);
assert.equal(russianCountForm(11, ...forms), forms[2]);
assert.equal(russianCountForm(14, ...forms), forms[2]);
assert.equal(russianCountForm(21, ...forms), forms[0]);
assert.equal(russianCountForm(24, ...forms), forms[1]);
assert.equal(russianCountForm(111, ...forms), forms[2]);
assert.equal(formatRussianCount(2, "задача", "задачи", "задач"), "2 задачи");

console.log("PASS: Russian count forms for units, few, many, and teen exceptions.");
